# flue relay protocol

The relay is a Cloudflare Worker (one Durable Object per daemon) that bridges a
daemon's single outbound socket to any number of browser tabs. It forwards bytes
and nothing else: it holds no Noise keys, reads no terminal traffic, and cannot
tell one keystroke from another.

This document defines the two sockets that meet at the relay and the framing on
each. It does **not** redefine the wire protocol — `spec/protocol.md` is
unchanged and travels inside, encrypted. The relay is a transport for it.

```
daemon  ---- wss /daemon ---->  Worker + Durable Object  <---- wss /client ----  browser
        [4B channel][payload]                            [payload]
           |                                                            |
           +--------- Noise IK: browser initiator, daemon responder ----+
                      inside: [1B kind][wire protocol bytes]
```

Three layers stack, outermost first:

| Layer | Bytes | Who reads it |
|---|---|---|
| Channel framing | `[4-byte big-endian channel][payload]` | daemon and relay |
| Noise IK | handshake messages, then transport ciphertexts | daemon and browser |
| Kind framing | `[1 byte kind][wire protocol bytes]` | daemon and browser |

## The daemon leg

The daemon dials `wss://<relay>/daemon` **outbound** — nothing listens on the
user's machine for the relay's sake — and every message on that socket is a
**binary** WebSocket frame laid out as:

```
[4 bytes channel, big-endian][payload]
```

A frame that is exactly a header is well formed and carries an empty payload.
A frame shorter than four bytes is a protocol error.

Channel `0` is the control channel (below). Channels `1` and up each carry one
browser's Noise session, opaque to the daemon's framing layer. The Durable
Object assigns ids from its own storage, so they survive hibernation and daemon
reconnects, and it never reuses one within a DO's lifetime.

## The browser leg

The browser opens `wss://<relay>/client` and sends **no channel header**. The
Worker knows which channel that socket is from the socket itself, and wraps and
unwraps on the browser's behalf: it prefixes the header on the way to the
daemon and strips it on the way back. A browser therefore sends bare handshake
messages and bare ciphertexts, and the channel id never appears in client code
above the relay adapter.

## The control channel (channel 0)

Every payload on channel `0` is a single JSON object with a `type`
discriminator, one object per frame.

| type | direction | fields | meaning |
|---|---|---|---|
| `open` | relay → daemon | `channel`, `origin` | a browser connected and was assigned this channel |
| `closed` | relay → daemon | `channel` | that browser went away |
| `close` | daemon → relay | `channel` | close that browser's socket |
| `pair` | relay → daemon | `id`, `origin`, `body` | an HTTP `POST /api/pair` arrived |
| `pairResult` | daemon → relay | `id`, `status`, `body` | the answer to write to that HTTP request |

`origin` is the Worker's **own** origin (`https://relay.example`). It is
announced rather than assumed so the daemon can check it against the relay it
dialled: a relay announcing a foreign origin is misconfigured or lying, and the
daemon refuses the channel.

`pair.body` is the browser's JSON **verbatim** — the daemon's own `/api/pair`
handler parses those bytes, so the relay must not reshape them. `pairResult`
carries the HTTP status and the response body the Worker writes back, and `id`
correlates the two: pairing is the one part of the ceremony that is an HTTP
request rather than a WebSocket message (`spec/protocol.md`, Pairing), and the
relay has to carry it without understanding it.

## Channels 1 and up

The first two payloads on a channel are the **Noise IK** handshake — browser
initiator → daemon responder → browser — relayed opaquely. Every payload after
them is exactly one Noise transport ciphertext. The relay forwards all of them
without inspection; it has no key with which it could do otherwise. The
handshake is the one already used for local pairing — `Noise_IK_25519_ChaChaPoly_SHA256`,
pinned by `testdata/noise/ik.json` — and the relay changes none of it.

A browser whose static key the daemon does not recognise is not attached: the
daemon answers with control `close` on that channel. Pairing first is what
makes a device known.

### Inside a decrypted payload

```
[1 byte kind][wire protocol bytes]

0x00  text    a JSON control message
0x01  binary  a wire-protocol binary frame
```

The wire protocol distinguishes text frames from binary ones and gets that
distinction from the WebSocket for free on the local transport. Through the
relay every message is one binary WebSocket frame of ciphertext, so the
distinction would be lost. This byte carries it, and the layer above the relay
reads the same `(text, data)` pair it reads locally. An empty payload, or any
kind byte other than `0x00` or `0x01`, is a protocol error.

## Keepalive

Either leg may send the **text** frame `flue-ping`; the Cloudflare edge answers
`flue-pong` from the Durable Object's auto-response, without waking it. No leg
ever has to answer a ping itself — the edge does, so neither the daemon nor a
browser sees one — and a received `flue-pong` is dropped silently. Neither
string ever carries a channel header: they are text frames, and everything
channel-framed is binary. Any other text frame on either socket is a protocol
error.

This is the one place the relay adds something `spec/protocol.md` says does not
exist ("WebSocket ping/pong frames only. There is no application-level ping").
That rule still holds for the local transport. Hibernation is why it does not
hold here: a hibernating DO must be able to answer liveness without being woken,
and `setWebSocketAutoResponse` matches a text request against a text response.
An application-level ping is what buys an idle terminal a sleeping,
almost-free Durable Object.

## Auth

The daemon's upgrade request carries `Authorization: Bearer <daemon secret>` —
the Worker's deploy-time secret when self-hosting, an account-scoped token
under flue.sh. A browser upgrade carries **nothing**.

That is deliberate: Noise is the confidentiality boundary, and a browser
credential would add none — an attacker who could open a channel still cannot
complete an IK handshake against a daemon that has not paired their key, and one
who could complete it would not have needed the credential. What an
unauthenticated `/client` does expose is denial of service, so the Durable
Object bounds it directly: a cap on concurrent channels and a deadline on
completing the handshake, after which the channel is closed.

## Conformance

`testdata/relay/frames.json` pins both framings as base64, generated from
`internal/relaywire` and walked by the Go, Worker and web test suites — the same
role `testdata/noise/ik.json` plays for the handshake and
`testdata/wire/control.json` for the wire protocol. It has two arrays:

- `channelFrames` — `{name, channel, payloadB64, encodedB64}`: an implementation
  must encode `(channel, payload)` to exactly `encoded`, and decode `encoded`
  back to that pair. The cases include an empty payload and channel
  `4294967295`, which a decoder that shifts rather than reading an unsigned
  32-bit integer gets wrong.
- `plainFrames` — `{name, text, dataB64, encodedB64}`: the same contract for the
  kind byte, including empty data and multi-byte UTF-8.

Regenerate with `go test ./internal/relaywire/ -update`; the committed file is
the artifact, and every case in it is asserted on every ordinary test run.
