# flue wire protocol

Transport is a WebSocket. **Text frames carry JSON control messages; binary
frames carry data.** There is no additional framing layer.

## Binary frames

```
[1 byte type][4 bytes ref, big-endian][payload]

0x00  output  daemon -> client
0x01  input   client -> daemon
```

`ref` is a `uint32` assigned by the daemon at attach time, so keystrokes do
not carry session IDs.

## Control messages

Every control message is a JSON object with a `type` discriminator.

### Client to server

| type | fields | meaning |
|---|---|---|
| `hello` | `ver`, `caps[]` | open the conversation |
| `list` | — | list the daemon's sessions |
| `spawn` | `cwd`, `cmd[]`, `cols`, `rows`, `reqId?` | start a session and attach to it |
| `attach` | `id`, `lastSeq`, `reqId?` | attach to an existing session |
| `detach` | `ref` | release an attachment |
| `resize` | `ref`, `cols`, `rows`, `primary` | report this view's dimensions |
| `signal` | `ref`, `sig` | send a signal to the session's process |
| `close` | `ref` | end the session |
| `devices` | — | list the paired devices |
| `revoke` | `deviceId` | unpair a device and cut its connections |
| `pairStart` | — | enter pairing mode |
| `pairCancel` | — | leave pairing mode, invalidating the token |

### Server to client

| type | fields | meaning |
|---|---|---|
| `welcome` | `daemonId`, `host`, `ver`, `caps[]` | answers `hello` |
| `sessions` | `sessions[]` | answers `list`, and follows any change to the set |
| `attached` | `ref`, `id`, `cols`, `rows`, `title`, `seq`, `head`, `truncated`, `primary`, `reqId?` | answers `attach` or `spawn` |
| `exit` | `ref`, `code` | the session's process ended |
| `sizeChanged` | `ref`, `cols`, `rows`, `primary` | the PTY's dimensions changed |
| `error` | `code`, `msg`, `reqId?` | a request failed, or a stream did |
| `deviceList` | `devices[]` | answers `devices`, and is broadcast after a pairing or a `revoke` |
| `pairing` | `token`, `url`, `daemonPub`, `expiresAt` | answers `pairStart` |
| `revoked` | `reason` | this device was unpaired; the connection is about to close |

Each record of `deviceList.devices[]` carries `id`, `label`, `pairedAt` and
`lastSeen`. Both timestamps are unix **seconds**, not the RFC 3339 strings
`sessions[]` uses.

## Pairing

`pairStart` puts the daemon into pairing mode and is answered by `pairing`,
which carries a token, the daemon's static public key, and an absolute `/pair`
URL on this origin for the second device to open. The token lives **two
minutes** and is **single-use**: `POST /api/pair` spends it and registers the
device, and `pairCancel` — or the deadline, or a completed pairing — ends
pairing mode. The daemon holds at most one outstanding token, so a second
`pairStart` supersedes the first. `revoke` unpairs a device: the revoked
device's own connections get `revoked` and are then closed, and every
connection still open — the requester's included — is handed a fresh
`deviceList`. A completed pairing broadcasts the same, since it lands on an
HTTP request no connected client can see.

The token is 256 bits of randomness encoded as **URL-safe base64, unpadded**
(RFC 4648 §5, no `=`). `pairing.url` splices it into `?t=` with no escaping, so
the encoding has to survive a URL as itself.

`pairing.url` also carries the daemon's static public key in `?k=`, the same 32
bytes in the same URL-safe unpadded base64, spliced in the same way. That is the
pinning: the QR is drawn on a screen the user physically controls and read by a
camera, so it is the one leg of the ceremony an intermediary cannot reach. The
device being paired pins the key from `?k=` and requires the `daemonPub` in the
`200` to equal it, refusing the pairing outright on a mismatch. It never pins the
answer's key, which would be trust-on-first-use over the channel Noise IK exists
to protect, and it refuses to pair at all from a link that carries no `k`.

`POST /api/pair` is the one part of the ceremony that is not a WebSocket
message: the new device posts the token and its own public key there, and the
pairing token — not the session token — is the credential. The request is JSON
`{token, publicKey, label}`, where `publicKey` is the device's 32-byte Noise
static key in **standard** base64; the answer is `200 {deviceId, daemonPub}`,
`daemonPub` likewise standard base64. Every refusal — no window open, wrong
token, expired token, an origin other than the daemon's own, a malformed key —
is the same `403` with the same body, so the endpoint says nothing about
whether a token ever existed. A presented token closes the window whether or
not it was the right one.

## Correlation

`attach` and `spawn` may carry a client-chosen `reqId`. The daemon echoes it
on the reply that answers the request — the `attached` on success, the
`error` on failure (`not_found`, `spawn_failed`). A reply without a `reqId`
answers a request that carried none. Clients match replies by `reqId` rather
than leaning on arrival order.

## Sequencing

The daemon assigns each session a monotonic byte-offset `seq`. On reattach a
client sends its `lastSeq`.

- If `lastSeq` is still within the ring, the daemon replies
  `attached{truncated:false, seq:<lastSeq>}` and streams the delta.
- If it has been evicted, the daemon replies
  `attached{truncated:true, seq:<baseSeq>}`. The client **must reset its
  emulator** before writing the bytes that follow.

`seq` in `attached` is always the seq of the first byte the client is about to
receive.

`head` in `attached` is the offset one past the replayed backlog: every byte
below `head` is history the ring is about to replay, and every byte at or
after it is live output. `head == seq` means the backlog is empty (the
daemon omits the output frame entirely in that case). Clients must not let
emulator-generated replies to replayed bytes — DA, DECRQM, OSC 11 probe
responses — reach the daemon: mute input until `head` bytes have been
consumed.

## Liveness

WebSocket ping/pong frames only. There is no application-level ping.

## Conformance

`testdata/wire/control.json` holds one example of every control message. Both
the Go and the TypeScript implementations decode it in their test suites, so
the two cannot drift.
