# flue wire protocol

Transport is a WebSocket. **Text frames carry JSON control messages; binary
frames carry data.** There is no additional framing layer.

## Binary frames

```
[1 byte type][4 bytes ref, big-endian][payload]

0x00  output      daemon -> client
0x01  input       client -> daemon
0x02  file chunk  daemon -> client
```

`ref` is a `uint32` assigned by the daemon at attach time, so keystrokes do
not carry session IDs.

A `0x02` frame's `ref` is a read's handle rather than an attachment's, minted
from the same counter. A client routes on the frame type, not on the ref.

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
| `close` | `ref` *or* `id` | end the session |
| `update` | `id`, `name?`, `tags[]?`, `pinned?` | edit a session's human-owned metadata |
| `peek` | `id`, `bytes?`, `reqId?` | read the tail of a session's scrollback without attaching |
| `stat` | `id`, `paths[]`, `reqId?` | ask whether paths exist, relative to a session |
| `read` | `id`, `path`, `reqId?` | start reading one |
| `cancel` | `ref` | abandon a read in flight |
| `devices` | — | list the paired devices |
| `revoke` | `deviceId` | unpair a device and cut its connections |
| `pairStart` | — | enter pairing mode |
| `pairCancel` | — | leave pairing mode, invalidating the token |

### Server to client

| type | fields | meaning |
|---|---|---|
| `welcome` | `daemonId`, `host`, `ver`, `caps[]`, `relay?` | answers `hello` |
| `sessions` | `sessions[]` | answers `list`, and answers `update` on the connection that sent it |
| `attached` | `ref`, `id`, `cols`, `rows`, `title`, `seq`, `head`, `truncated`, `primary`, `reqId?` | answers `attach` or `spawn` |
| `exit` | `ref`, `code` | the session's process ended |
| `sizeChanged` | `ref`, `cols`, `rows`, `primary` | the PTY's dimensions changed |
| `error` | `code`, `msg`, `reqId?` | a request failed, or a stream did |
| `preview` | `id`, `data`, `cols`, `rows`, `reqId?` | answers `peek` |
| `stats` | `entries[]`, `reqId?` | answers `stat` |
| `file` | `ref`, `path`, `size`, `mime`, `kind`, `truncated?`, `reqId?` | answers `read`; content follows as `0x02` frames |
| `eof` | `ref` | that read has sent every byte |
| `deviceList` | `devices[]` | answers `devices`, and is broadcast after a pairing or a `revoke` |
| `pairing` | `token`, `url`, `daemonPub`, `expiresAt` | answers `pairStart` |
| `revoked` | `reason` | this device was unpaired; the connection is about to close |

### Sizing

Every attached view sends `resize` with the cells that fit its own pane. The
daemon records one desired size per attachment and keeps the PTY at the fit
of the **most recently active** view — activity being an input frame, a size
report, a signal, or the attach itself. It recomputes when a report lands,
when activity moves between views, and when an attachment ends, broadcasting
the result as `sizeChanged`. A view whose fit is below the broadcast size
renders the full screen scaled down; one whose fit is at or above it renders
the grid one-to-one. One pty has one grid, so someone must be chosen, and it
is the view being used: picking up the phone reshapes the session to the
phone as soon as it reports, and the laptop's next keystroke reshapes it
back — an idle view's report is never lost, only waiting.

A report carrying a zero `cols` or `rows` is refused with `error{bad_size}`. It
is not a very small view but a broken measurement — a pane sized before layout,
a tab the browser has put to sleep — and one client sending it would otherwise
collapse the grid every other view is reading. A refused report counts as
neither activity nor a recorded desire.

`primary` marks exactly one attachment per session — first attacher, most
recently active promoted when it leaves — and governs one thing: which
emulator answers device queries (DA, DSR, OSC color) arriving in the
broadcast output. It has no effect on dimensions.

Each record of `deviceList.devices[]` carries `id`, `label`, `pairedAt` and
`lastSeen`. Both timestamps are unix **seconds**, not the RFC 3339 strings
`sessions[]` uses.

`welcome.relay`, when present, is `{status, origin?}` — the state of the
daemon's relay leg at the moment this connection was accepted. `status` is
`connecting` while the daemon is dialling, and `connected` once the socket is
up, in which case `origin` is the https origin the relay serves browsers on. A
daemon with no relay configured omits the field entirely rather than sending
`off`. It is not a stream: nothing pushes an update when the relay reconnects,
so a client learns the current state from the `welcome` of its next connection.

### Closing

`close` ends a session, addressed one of two ways. `ref` is an attachment
handle, for a view that is looking at the session it closes. `id` is the
attach-free form for the sessions list, which acts on rows it never attached
to — attaching first just to earn a ref would cost a subscribe, a backlog
replay and a detach to deliver one verb. A message carries one address or the
other; when both appear the non-zero `ref` wins and `id` is ignored, so the
ref semantics are exactly what they always were.

There is **no reply on success**, by either address. The session's end
announces itself: every attached view is sent `exit`, and a list poll sees
`state: "exited"` on its next `sessions`. A client closing from a list it is
not attached through therefore learns the close landed the same way it learns
everything else about the set — by asking again. Failures are answered: an
`id` the daemon does not hold with `error{not_found}` (exactly as `update`
answers one — a list acting on a row that has just been reaped is ordinary),
and a `ref` the connection does not hold with `error{bad_ref}`.

### Metadata

`update` edits what a human owns on a session — `name`, `tags[]`, `pinned` —
and nothing else. It is addressed by `id` rather than by `ref`, because naming a
session is not something you have to be attached to do. `title` is not editable:
it is scraped from the session's own output and overwritten whenever the program
inside says something new, which is why `name` exists beside it. A UI shows
`name` when there is one and falls back to `title`.

The edit is **partial**. A field the message does not carry is a field it leaves
alone, so `{"type":"update","id":"s1","pinned":true}` pins a session without
touching its name or its tags, and two views editing different fields of the
same session cannot undo each other. That makes an empty value and an absent one
different instructions:

- `"tags": []` clears every tag; no `tags` key leaves the tags as they were.
- `"name": ""` clears the name; no `name` key leaves the name as it was.

Tags are normalised by the daemon on the way in — trimmed, empties dropped,
duplicates collapsed, sorted — so the list a later `sessions` reports is not
always the list that was sent, and a client should render what came back rather
than what it typed. Comparison is exact: `Prod` and `prod` are two tags.

An `update` that lands is answered by a fresh `sessions` to the requesting
connection only; other clients converge on their next `list` poll. One naming
a session that does not exist is answered by `error{not_found}`. Editing
metadata is not activity in the session: `lastActive` does not move, so tidying
a list cannot reorder the list being tidied.

### Previews

`peek` answers the question a list cannot: not what a session is called, but
what it is *doing*. It returns the tail of the session's scrollback — raw, with
every escape sequence in it — and nothing else happens: no `ref` is minted, no
stream starts, and the connection is not subscribed to anything. That is the
whole reason it exists beside `attach`, which would do the same job at the cost
of a ref, a backlog replay, a delivery channel and a `detach` per row; a list
hovering twenty sessions would leave twenty subscriptions behind it.

`bytes` caps the answer. Absent means the daemon's default; anything above its
ceiling is **clamped rather than refused**, because a client asking for more
than it may have wants as much as it can get, and an error there would blank a
preview over a number nobody chose deliberately.

`preview.data` is base64 (as every `[]byte` is on this wire) and is empty —
`""`, never `null` — for a session that has drawn nothing. It is the *tail*, so
it will usually begin partway through an escape sequence: a consumer must
expect to discard a partial sequence at the front rather than read it as
content. `cols` and `rows` are the dimensions the bytes were drawn at, so a
consumer replaying them into an emulator can size it the way the session is.

Rendering is deliberately left to the client, which already owns a terminal
emulator. A daemon that flattened this to text would have to make every
decision an emulator makes — wrapping at which width, what a cursor move means,
which of two overwrites won — and would make them differently from the emulator
the same client uses to draw the session for real.

Peeking is not activity in the session. `lastActive` does not move, which
matters more than it sounds: the sessions list orders by that stamp by default,
so a preview that counted as activity would sort the row under the reader's
pointer to the top of the list underneath it. An `id` the daemon does not hold
is answered with `error{not_found}`, correlated by `reqId` — a list peeks at
many rows at once and the refusals have to find their own askers.

### Reading files

`stat` and `read` answer the two questions a terminal cannot: is this text a
real path, and what is in it. They exist because an agent session names files
constantly and the reader is often on a device with no other window to open
one in.

Resolution is the daemon's. A leading `~` expands to the daemon user's home, a
relative path resolves against the session's live working directory, and the
result is cleaned; `file.path` reports the resolved path, while each
`stats.entries[].path` echoes the text that was asked about, in the order it
was asked. A relative path that does not exist under the session's cwd is a
miss, with no second attempt against the spawn directory: two resolution rules
would make "opened the wrong file" indistinguishable from "opened the right
one".

`stat` takes up to 32 paths at once, because a client verifies a whole hovered
line rather than one candidate at a time, and a path it cannot resolve is
`exists: false` rather than an error — "no" is the ordinary answer here. Beside
`path` and `exists`, an entry that exists carries `kind` (`file`, `dir` or
`other`), `size` in bytes and `mtime` in unix **seconds**, the unit
`deviceList` uses rather than the RFC 3339 strings `sessions[]` does.

`read` mints a `ref` from the same counter `attach` uses and answers `file`,
after which the content arrives as `0x02` frames under that ref and ends with
`eof`. Chunks are 32 KiB: a WebSocket message is capped at 1 MiB, and file
content shares one socket with the terminal, so a larger frame would sit in
front of the next keystroke. The daemon keeps one chunk in flight at a time for
the same reason.

What may be read is anything the daemon's user can read, and nothing is
written. That is not a widening: a client that can send `read` can already send
`spawn` and run `cat`, and both run as the same user.

Text is sent to 8 MiB, past which `file.truncated` is true, `file.size` remains
the real size, and only the head arrives. An image is refused past 4 MiB rather
than truncated. `file.kind` is `text` or `image`, sniffed from the content and
never from the extension; anything else is refused. Two reads may be open per
connection.

`cancel` abandons a read by `ref`. A ref the daemon does not hold is ignored:
a read finishing and a client cancelling it cross on the wire routinely, and a
race the client cannot avoid should not be an error it has to handle. Every
read is ended and its file closed when the connection drops.

**A cancel stops a stream; it does not un-send one.** Cancelling unparks the
pump wherever it is waiting and closes the file under it, so the read winds
down, but a frame the outbox has already accepted belongs to the writer, which
has no way to drop it again. More than that: the pump parks in selects that
offer progress on one arm — room in the outbox, or the chunk it queued having
been written — and the cancelled read on the other, and a select whose arms are
both ready may take either, so the pump can go round again and queue a further
chunk *after* the cancel was handled. The same is true of `eof`, whose "was this
cancelled" check is check-then-act ahead of the same kind of select.

A client must therefore discard `0x02` frames and an `eof` naming a ref it has
cancelled, rather than treat either as a protocol violation. The ref is enough
to do that unambiguously: refs come from a counter that only ever goes up, so a
cancelled ref never names a later read.

Neither verb is activity in the session: `lastActive` does not move for a `stat`
or a `read`, for the reason a `peek` does not move it — the list orders by that
stamp, and a hover that reordered the list under the pointer would be the hover
losing the row it was aimed at.

Refusals are `not_found`, `is_dir`, `too_large`, `denied`, `bad_path`, `busy`
and `unsupported`, each correlated by `reqId`.

## Pairing

`pairStart` puts the daemon into pairing mode and is answered by `pairing`,
which carries a token, the daemon's static public key, and an absolute `/pair`
URL for the second device to open. That URL names the relay's origin whenever
the daemon has a live relay (`welcome.relay.status == "connected"`) and the
origin the asking connection arrived on otherwise: the QR is read by a phone,
and a phone cannot open the loopback address a local browser is using. The token lives **two
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
whether a token ever existed. The window closes on the presentation that pairs
a device, and otherwise only when its two minutes are up: a wrong token spends
nothing, because this endpoint is reachable without a credential — over a relay,
from the internet — and a window anyone could close on demand is a window the
user could never finish using.

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
