import { encodeBinary, FRAME_OUTPUT, type Attached, type SizeChanged } from '@/client/protocol'
import { FlueClient, type SocketLike } from '@/client/client'

const utf8 = new TextEncoder()

/**
 * A scriptable stand-in for WebSocket.
 *
 * Two behaviours are modelled deliberately, because FlueClient copes with both
 * and a laxer double would hide it: `send` throws while the socket is still
 * connecting, exactly as a real WebSocket raises InvalidStateError, and
 * `close` reports at most once.
 */
export class FakeSocket implements SocketLike {
  sent: Array<string | ArrayBuffer> = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((data: string | ArrayBuffer) => void) | null = null

  opened = false
  shut = false

  send(data: string | ArrayBuffer) {
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

  emitControl(msg: unknown) {
    this.onmessage?.(JSON.stringify(msg))
  }

  emitOutput(ref: number, body: string) {
    this.onmessage?.(encodeBinary(FRAME_OUTPUT, ref, utf8.encode(body)))
  }

  control(): Array<Record<string, unknown>> {
    return this.sent
      .filter((s): s is string => typeof s === 'string')
      .map((s) => JSON.parse(s) as Record<string, unknown>)
  }

  ofType(type: string): Array<Record<string, unknown>> {
    return this.control().filter((m) => m.type === type)
  }

  /** Every input frame's payload, decoded. */
  input(): Array<{ ref: number; text: string }> {
    return this.sent
      .filter((s): s is ArrayBuffer => typeof s !== 'string')
      .map((buf) => {
        const view = new DataView(buf)
        return {
          ref: view.getUint32(1, false),
          text: new TextDecoder().decode(new Uint8Array(buf, 5)),
        }
      })
  }
}

export function fakeClient() {
  const sockets: FakeSocket[] = []
  const client = new FlueClient('ws://127.0.0.1:7717/ws', () => {
    const s = new FakeSocket()
    sockets.push(s)
    return s
  })
  return { client, sockets, last: () => sockets[sockets.length - 1]! }
}

/** A complete `attached`, so a caller only names the fields it cares about.
 *  `head` defaults to `seq` — the fresh-spawn shape, in which nothing is
 *  muted — so only replay tests say otherwise. */
export function attached(over: Partial<Attached> & { ref: number; id: string }): Attached {
  const seq = over.seq ?? 0
  return {
    type: 'attached',
    cols: 80,
    rows: 24,
    title: '',
    seq,
    head: seq,
    truncated: false,
    primary: true,
    ...over,
  }
}

/** A complete `sizeChanged`, likewise. */
export function sizeChanged(over: Partial<SizeChanged> & { ref: number }): SizeChanged {
  return { type: 'sizeChanged', cols: 80, rows: 24, primary: true, ...over }
}
