import { afterEach, describe, expect, it, vi } from 'vitest'
import { x25519 } from '@noble/curves/ed25519.js'
import vectors from '../../../testdata/noise/ik.json'
import { FlueClient } from '@/client/client'
import type { NoiseChannel } from '@/crypto/noise'
import { responderHandshake } from '@/testing/noise-daemon'
import { decodePlain, encodePlain } from './frame'
import { RELAY_PING, RELAY_PONG, relaySocket, type RawSocket, type RelayIdentity } from './socket'

const unhex = (s: string) => new Uint8Array((s.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)))
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const utf8 = new TextEncoder()
const decode = (b: Uint8Array) => new TextDecoder().decode(b)

const buffer = (b: Uint8Array): ArrayBuffer => {
  const out = new ArrayBuffer(b.byteLength)
  new Uint8Array(out).set(b)
  return out
}

const asBytes = (d: string | ArrayBuffer | Uint8Array): Uint8Array =>
  typeof d === 'string' ? utf8.encode(d) : d instanceof Uint8Array ? d : new Uint8Array(d)

/**
 * A scriptable stand-in for the raw WebSocket under the relay socket. Two
 * behaviours are modelled deliberately, as `FakeSocket` models them for
 * FlueClient: `send` throws while the socket is still connecting, exactly as a
 * real WebSocket raises InvalidStateError, and `close` reports at most once.
 */
class FakeRaw implements RawSocket {
  sent: Array<string | ArrayBuffer | Uint8Array> = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((data: string | ArrayBuffer) => void) | null = null

  opened = false
  shut = false

  send(data: string | ArrayBuffer | Uint8Array) {
    if (!this.opened) throw new Error('InvalidStateError: the socket is still connecting')
    if (this.shut) return
    this.sent.push(data)
  }

  close() {
    if (this.shut) return
    this.shut = true
    this.onclose?.()
  }

  open() {
    this.opened = true
    this.onopen?.()
  }

  /** Every binary message the client sent, in order. */
  binary(): Uint8Array[] {
    return this.sent.filter((d) => typeof d !== 'string').map(asBytes)
  }

  /** Every text message the client sent, in order. */
  text(): string[] {
    return this.sent.filter((d): d is string => typeof d === 'string')
  }

  deliver(bytes: Uint8Array) {
    this.onmessage?.(buffer(bytes))
  }

  deliverText(s: string) {
    this.onmessage?.(s)
  }
}

/**
 * The daemon at the far end of the relay: a real Noise responder reading what
 * the socket under test actually sent. Nonces advance in order on both sides,
 * so it consumes the client's ciphertexts in the order they were sent.
 */
class FakeDaemon {
  private readonly hs
  private channel: NoiseChannel | null = null
  private at = 0

  constructor(staticPriv: Uint8Array, ephemeralPriv?: Uint8Array) {
    this.hs = responderHandshake(staticPriv, ephemeralPriv)
  }

  /** Read message A off the wire and answer message B; returns the device key. */
  handshake(raw: FakeRaw): Uint8Array {
    const peer = this.hs.readMessageA(this.take(raw))
    const { msg, channel } = this.hs.messageB()
    this.channel = channel
    raw.deliver(msg)
    return peer
  }

  /** The next wire-protocol frame the client sent, decrypted and unframed. */
  read(raw: FakeRaw): { text: boolean; data: Uint8Array } {
    return decodePlain(this.channel!.open(this.take(raw)))
  }

  sendText(raw: FakeRaw, s: string) {
    raw.deliver(this.channel!.seal(encodePlain(true, utf8.encode(s))))
  }

  sendBinary(raw: FakeRaw, data: Uint8Array) {
    raw.deliver(this.channel!.seal(encodePlain(false, data)))
  }

  /** Seal bytes that are not a well-formed plain frame. */
  sendSealed(raw: FakeRaw, plain: Uint8Array) {
    raw.deliver(this.channel!.seal(plain))
  }

  private take(raw: FakeRaw): Uint8Array {
    const frames = raw.binary()
    const next = frames[this.at]
    if (!next) throw new Error(`the client has sent only ${frames.length} binary messages`)
    this.at++
    return next
  }
}

const DEVICE_PRIV = unhex(vectors.initiatorStaticPriv)
const DAEMON_PRIV = unhex(vectors.responderStaticPriv)

function harness(opts: { origin?: string; daemonPriv?: Uint8Array; pin?: Uint8Array } = {}) {
  const daemonPriv = opts.daemonPriv ?? DAEMON_PRIV
  const identity: RelayIdentity = {
    deviceKey: { privateKey: DEVICE_PRIV, publicKey: x25519.getPublicKey(DEVICE_PRIV) },
    daemonPub: opts.pin ?? x25519.getPublicKey(daemonPriv),
  }
  const urls: string[] = []
  const raws: FakeRaw[] = []
  const sock = relaySocket(opts.origin ?? 'https://relay.example', identity, (url) => {
    urls.push(url)
    const raw = new FakeRaw()
    raws.push(raw)
    return raw
  })
  const got: Array<string | ArrayBuffer> = []
  let opens = 0
  let closes = 0
  sock.onopen = () => void opens++
  sock.onclose = () => void closes++
  sock.onmessage = (d) => void got.push(d)

  return {
    sock,
    identity,
    urls,
    got,
    raw: raws[0]!,
    daemon: new FakeDaemon(daemonPriv),
    opens: () => opens,
    closes: () => closes,
  }
}

/** A harness whose handshake has completed: the socket is end-to-end open. */
function connected(opts: Parameters<typeof harness>[0] = {}) {
  const h = harness(opts)
  h.raw.open()
  h.daemon.handshake(h.raw)
  return h
}

afterEach(() => {
  vi.useRealTimers()
})

describe('the fake daemon', () => {
  // The double is a second implementation of the responder, so it is held to
  // the same cross-language vectors the initiator is. Without this, a test
  // that passes proves only that the two halves agree with each other.
  it('reproduces the pinned message B and transport ciphertexts', () => {
    const hs = responderHandshake(DAEMON_PRIV, unhex(vectors.responderEphemeralPriv))
    expect(hex(hs.readMessageA(unhex(vectors.msg1)))).toBe(vectors.initiatorStaticPub)
    const { msg, channel } = hs.messageB()
    expect(hex(msg)).toBe(vectors.msg2)

    for (const m of vectors.transport) {
      if (m.dir === 'r2i') {
        expect(hex(channel.seal(unhex(m.plaintext)))).toBe(m.ciphertext)
      } else {
        expect(hex(channel.open(unhex(m.ciphertext)))).toBe(m.plaintext)
      }
    }
  })
})

describe('opening the relay socket', () => {
  it('dials /client on the origin, over wss', () => {
    expect(harness().urls).toEqual(['wss://relay.example/client'])
  })

  it('dials ws for an http origin, so a dev relay works', () => {
    expect(harness({ origin: 'http://127.0.0.1:8787' }).urls).toEqual([
      'ws://127.0.0.1:8787/client',
    ])
  })

  it('sends a bare message A — no channel header, the Worker adds that', () => {
    const h = harness()
    h.raw.open()

    const sent = h.raw.binary()
    expect(sent).toHaveLength(1)
    // 32 ephemeral + 32 static + 16 tag + 16 tag: the handshake message and
    // nothing in front of it.
    expect(sent[0]!.byteLength).toBe(96)
    expect(hex(h.daemon.handshake(h.raw))).toBe(hex(h.identity.deviceKey.publicKey))
  })

  it('fires onopen only once the handshake has completed', () => {
    const h = harness()
    h.raw.open()
    expect(h.opens()).toBe(0) // the transport is up; the channel is not

    h.daemon.handshake(h.raw)
    expect(h.opens()).toBe(1)
    expect(h.closes()).toBe(0)
  })

  it('refuses to send before the handshake completes', () => {
    const h = harness()
    h.raw.open()
    // FlueClient never does this — it sends nothing before onopen — so a throw
    // is a bug surfaced rather than a case to handle.
    expect(() => h.sock.send('{"type":"list"}')).toThrow()
    expect(h.raw.binary()).toHaveLength(1) // message A, and nothing after it
  })
})

describe('carrying the wire protocol inside the channel', () => {
  it('delivers a sealed control message as a string', () => {
    const h = connected()
    const welcome = '{"type":"welcome","ver":1,"caps":["binary"]}'
    h.daemon.sendText(h.raw, welcome)
    expect(h.got).toEqual([welcome])
  })

  it('seals what the client sends as a kind-0 text frame', () => {
    const h = connected()
    h.sock.send('{"type":"list"}')

    const frame = h.daemon.read(h.raw)
    expect(frame.text).toBe(true)
    expect(decode(frame.data)).toBe('{"type":"list"}')
  })

  it('seals binary as a kind-1 frame, and delivers one as an ArrayBuffer', () => {
    const h = connected()
    const input = new Uint8Array([0, 0, 0, 0, 1, 0x6c, 0x73])
    h.sock.send(buffer(input))

    const frame = h.daemon.read(h.raw)
    expect(frame.text).toBe(false)
    expect(new Uint8Array(frame.data)).toEqual(input)

    const output = new Uint8Array([1, 2, 3, 250])
    h.daemon.sendBinary(h.raw, output)
    expect(h.got).toHaveLength(1)
    const delivered = h.got[0]!
    expect(typeof delivered).not.toBe('string')
    expect(new Uint8Array(delivered as ArrayBuffer)).toEqual(output)
  })

  it('keeps ordering across many frames, so nonces stay in step', () => {
    const h = connected()
    for (let i = 0; i < 5; i++) h.sock.send(`{"type":"list","n":${i}}`)
    for (let i = 0; i < 5; i++) {
      expect(decode(h.daemon.read(h.raw).data)).toBe(`{"type":"list","n":${i}}`)
    }

    for (let i = 0; i < 5; i++) h.daemon.sendText(h.raw, `{"n":${i}}`)
    expect(h.got).toEqual(['{"n":0}', '{"n":1}', '{"n":2}', '{"n":3}', '{"n":4}'])
  })
})

describe('keepalive', () => {
  it('sends flue-ping as plain text every 30 seconds', () => {
    vi.useFakeTimers()
    const h = connected()
    expect(h.raw.text()).toEqual([])

    vi.advanceTimersByTime(30_000)
    expect(h.raw.text()).toEqual([RELAY_PING])
    vi.advanceTimersByTime(30_000)
    expect(h.raw.text()).toEqual([RELAY_PING, RELAY_PING])
    // Never encrypted and never framed: the edge answers it from the Durable
    // Object's auto-response, so only these bytes will do.
    expect(h.raw.binary()).toHaveLength(1)
  })

  it('clears the interval when the socket is closed', () => {
    vi.useFakeTimers()
    const h = connected()
    vi.advanceTimersByTime(30_000)
    expect(vi.getTimerCount()).toBe(1)
    h.sock.close()

    // The count, not the frames the fake recorded: a socket that has stopped
    // accepting sends would hide a timer still firing every 30s for the life
    // of the tab, once per reconnect FlueClient has made.
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(120_000)
    expect(h.raw.text()).toEqual([RELAY_PING])
  })

  it('clears the interval when the underlying socket goes away', () => {
    vi.useFakeTimers()
    const h = connected()
    h.raw.close()

    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(120_000)
    expect(h.raw.text()).toEqual([])
    expect(h.closes()).toBe(1)
  })

  it('clears the interval when a protocol error ends the channel', () => {
    vi.useFakeTimers()
    const h = connected()
    h.raw.deliverText('not a keepalive')

    expect(vi.getTimerCount()).toBe(0)
  })

  it('drops an incoming flue-pong', () => {
    const h = connected()
    h.raw.deliverText(RELAY_PONG)
    expect(h.got).toEqual([])
    expect(h.closes()).toBe(0)
    expect(h.raw.shut).toBe(false)
  })
})

describe('protocol errors close the socket', () => {
  it('closes on any text frame that is not a pong', () => {
    const h = connected()
    h.raw.deliverText('{"type":"welcome"}')

    expect(h.got).toEqual([])
    expect(h.raw.shut).toBe(true)
    expect(h.closes()).toBe(1)
  })

  it('closes on a ciphertext that does not decrypt', () => {
    const h = connected()
    h.raw.deliver(new Uint8Array(32)) // garbage: no tag of ours will verify

    expect(h.got).toEqual([])
    expect(h.raw.shut).toBe(true)
    expect(h.closes()).toBe(1)
  })

  it('closes on a decrypted payload with no kind byte', () => {
    const h = connected()
    h.daemon.sendSealed(h.raw, new Uint8Array(0))

    expect(h.got).toEqual([])
    expect(h.raw.shut).toBe(true)
    expect(h.closes()).toBe(1)
  })

  it('closes on an unknown kind byte', () => {
    const h = connected()
    h.daemon.sendSealed(h.raw, new Uint8Array([2, 1, 2, 3]))

    expect(h.got).toEqual([])
    expect(h.raw.shut).toBe(true)
    expect(h.closes()).toBe(1)
  })

  it('reports a close exactly once', () => {
    const h = connected()
    h.raw.deliverText('boom')
    h.sock.close()
    h.raw.close()
    expect(h.closes()).toBe(1)
  })
})

describe('a handshake that fails', () => {
  it('never fires onopen when message B does not verify', () => {
    const h = harness()
    h.raw.open()
    h.raw.deliver(new Uint8Array(48)) // the right shape, the wrong bytes

    expect(h.opens()).toBe(0)
    expect(h.got).toEqual([])
    expect(h.raw.shut).toBe(true)
    expect(h.closes()).toBe(1)
  })

  it('closes when the daemon does not hold the pinned key', () => {
    // What a browser pinned to another daemon does: message A is sealed to a
    // key this responder does not hold, so it cannot read it and closes —
    // exactly the shape of a daemon refusing an unknown device.
    const h = harness({ pin: x25519.getPublicKey(unhex(vectors.initiatorStaticPriv)) })
    h.raw.open()
    expect(() => h.daemon.handshake(h.raw)).toThrow()
    h.raw.close()

    expect(h.opens()).toBe(0)
    expect(h.closes()).toBe(1)
  })

  it('closes without onopen when the relay drops the socket first', () => {
    const h = harness()
    h.raw.open()
    h.raw.close() // 1012 daemon gone, before message B ever arrives

    expect(h.opens()).toBe(0)
    expect(h.closes()).toBe(1)
  })
})

describe('under FlueClient', () => {
  it('carries hello and welcome end to end', () => {
    const identity: RelayIdentity = {
      deviceKey: { privateKey: DEVICE_PRIV, publicKey: x25519.getPublicKey(DEVICE_PRIV) },
      daemonPub: x25519.getPublicKey(DAEMON_PRIV),
    }
    const raws: FakeRaw[] = []
    const client = new FlueClient('https://relay.example', (url) =>
      relaySocket(url, identity, () => {
        const raw = new FakeRaw()
        raws.push(raw)
        return raw
      }),
    )
    const statuses: string[] = []
    client.onStatus((s) => statuses.push(s))
    const sessions: unknown[] = []
    client.onSessions((s) => sessions.push(...s))

    client.connect()
    const raw = raws[0]!
    const daemon = new FakeDaemon(DAEMON_PRIV)
    raw.open()
    // Still connecting as far as FlueClient is concerned: open means the
    // channel is up, not the socket.
    expect(statuses).toEqual(['connecting'])
    daemon.handshake(raw)
    expect(statuses).toEqual(['connecting', 'open'])

    const hello = daemon.read(raw)
    expect(hello.text).toBe(true)
    expect(JSON.parse(decode(hello.data))).toMatchObject({ type: 'hello' })

    daemon.sendText(raw, '{"type":"sessions","sessions":[{"id":"s1"}]}')
    expect(sessions).toEqual([{ id: 's1' }])

    client.close()
    expect(raw.shut).toBe(true)
  })
})
