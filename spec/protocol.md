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

| type | fields |
|---|---|
| `hello` | `ver`, `caps[]` |
| `list` | — |
| `spawn` | `cwd`, `cmd[]`, `cols`, `rows` |
| `attach` | `id`, `lastSeq` |
| `detach` | `ref` |
| `resize` | `ref`, `cols`, `rows`, `primary` |
| `signal` | `ref`, `sig` |
| `close` | `ref` |

### Server to client

| type | fields |
|---|---|
| `welcome` | `daemonId`, `host`, `ver`, `caps[]` |
| `sessions` | `sessions[]` |
| `attached` | `ref`, `id`, `cols`, `rows`, `title`, `seq`, `truncated`, `primary` |
| `exit` | `ref`, `code` |
| `sizeChanged` | `ref`, `cols`, `rows`, `primary` |
| `error` | `code`, `msg` |

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

## Liveness

WebSocket ping/pong frames only. There is no application-level ping.

## Conformance

`testdata/wire/control.json` holds one example of every control message. Both
the Go and the TypeScript implementations decode it in their test suites, so
the two cannot drift.
