# Opening a file the session just named

An agent session says "I wrote the new parser to `internal/wire/binary.go`",
and reading that file means leaving the terminal: another tab, another editor,
another machine if the session is not the one you are sitting at. On a phone
over the relay there is no other window to leave to at all.

This adds one interaction. A path in the terminal underlines when you hover it
and it is real, and clicking it opens the file in a modal over the session,
syntax highlighted. It works the same on loopback and over the relay, because
it rides the same wire the terminal already rides.

## What this is not

It does not write, rename, or delete. It does not diff against git, search
inside a file, or download one. It is a reader, and everything it does is
something the session's own shell could already do with `cat`.

## The constraint that shapes it

Over a relay, the only thing that reaches the daemon is the Noise-wrapped wire
protocol. The relay forwards exactly one piece of HTTP, pairing, and nothing
else (`internal/daemon/relayui.go`, the comment above the relay endpoints).

So a `GET /api/file` would work perfectly on loopback and be invisible from
your phone, which is the case this feature exists for. File reads are wire
messages. `peek` is the precedent and the same reasoning produced it.

Two numbers follow from the relay and bound everything below. A WebSocket
message is capped at 1 MiB in both directions (`relay/src/hub.ts`,
`MAX_CLIENT_MESSAGE`; `internal/daemon/conn.go`, `readLimit`), and file bytes
share one Noise channel with terminal output, so a single large frame would
delay your keystrokes behind it. Content is therefore chunked, which is also
what lets a large file start painting before it has finished arriving.

## The protocol

Three requests and three answers, added to `spec/protocol.md`.

### Client to server

| type | fields | meaning |
|---|---|---|
| `stat` | `id`, `paths[]`, `reqId` | do these paths exist, relative to this session |
| `read` | `id`, `path`, `reqId` | start reading one |
| `cancel` | `ref` | stop a read in flight |

### Server to client

| type | fields | meaning |
|---|---|---|
| `stats` | `reqId`, `entries[]` | answers `stat` |
| `file` | `ref`, `reqId`, `path`, `size`, `mime`, `kind`, `truncated` | answers `read`; `ref` is the stream's handle |
| `eof` | `ref` | every byte has been sent |

Each entry of `stats.entries[]` is `{path, exists, kind, size, mtime}`, in the
order the paths were asked about. `kind` is `file`, `dir`, or `other`. `path`
echoes what was asked rather than what it resolved to, so a client can match
answers to the text it matched them from.

`file.path` is the opposite: the resolved path, after `~` expansion and symlink
resolution. A symlink means the file you get is not always the path you
clicked, and the viewer shows what it actually opened.

`file.mime` is sniffed from content, not from the extension. `kind` is `text`
or `image`; anything else is refused rather than shown as mojibake.

### Content frames

Content rides a new binary frame type in the existing layout:

```
[1 byte type][4 bytes ref, big-endian][payload]

0x00  output      daemon -> client
0x01  input       client -> daemon
0x02  file chunk  daemon -> client
```

Chunks are 32 KiB. That is far under the 1 MiB cap and small enough that a
multi-megabyte read interleaved with terminal output adds only a few
milliseconds to a keystroke's latency.

`ref` comes from the same counter attachments use. A read is structurally an
attachment: a request that mints a handle, streams binary frames under it, and
ends. Sharing the counter means the daemon's routing table gains a kind of
entry rather than a second table, and `cancel{ref}` reads like `detach{ref}`
because it does the same job.

### The exchange

```
browser                                   daemon
  stat{id, paths[], reqId}      ------->  resolve against session cwd, lstat each
       <-------  stats{reqId, entries[]}
  read{id, path, reqId}         ------->  resolve, sniff, open, mint ref
       <-------  file{ref, reqId, size, mime, kind, truncated}
       <-------  0x02 [ref] 32 KiB         (repeated, paced through the ordinary writer)
       <-------  eof{ref}
```

### Why push rather than client-pulled ranges

`cancel` is addressed by `ref`, which only exists once `file` has arrived. A
viewer closed before then cannot cancel yet, so it marks the `reqId` abandoned
and sends `cancel` the moment the ref lands. This mirrors how the client
already handles an `attach` whose view went away mid-flight
(`web/src/client/client.ts`, `abandon`).

A client that asked for one range at a time would pace itself for free and need
no `cancel`. It would also cost a round trip per 32 KiB, which over a relay at
50 ms is roughly eight seconds for a 5 MB file. Pushing costs one round trip
and a small amount of per-connection state, an open handle and a ref, which the
connection's own teardown already knows how to release.

## Path resolution

The browser sends the text it matched. The daemon resolves it. That split
matters: only the daemon knows where the session actually is.

1. A leading `~` expands to the daemon user's home.
2. A relative path resolves against the session's live cwd, which
   `session.Info` already refreshes from the kernel on every read
   (`internal/session/session.go`, `Info`).
3. Symlinks resolve, and the result is what `file.path` reports.

A relative path that does not exist under the cwd is a miss. There is no second
attempt against the spawn directory or a guessed project root: two resolution
rules would make "opened the wrong file" and "opened the right one"
indistinguishable from the outside.

## What a read may reach

Any path the daemon user can read. There is no fence, by decision rather than
by omission.

A paired device can already `spawn` a shell in any directory and run `cat`, so
a read message grants no authority that does not already exist, and the daemon
runs as the user in either case. A confinement to the session's subtree would
refuse the paths an agent names most often (`~/.claude/...`, a scratch file in
`/tmp`, a sibling worktree) and each refusal would read as a bug. A deny-list of
secret-looking paths would be theatre against a caller that can `cat` them.

Nothing here writes.

## Limits and failures

| Limit | Value | Why |
|---|---|---|
| Text size | 8 MB | Beyond it, `file` reports the true `size` with `truncated: true` and streams the head |
| Image size | 4 MB | Assembled in memory as a `data:` URL |
| Concurrent reads | 2 per connection | A third is refused with `busy` |
| Paths per `stat` | 32 | One hovered line never has more |

Truncation is reported, not hidden. The viewer says how much of the file it is
showing and how much it is not.

Errors, each correlated by `reqId`: `not_found`, `is_dir`, `too_large`,
`denied`, `bad_path`, `busy` (the concurrency cap), and `unsupported` (a file
that is neither text nor image, and anything that is not a regular file).

Every read is cancelled and its handle closed when the connection drops. A
phone that goes into a pocket mid-read must not leave a file open on the
machine.

## The browser

### Detection behind the emulator seam

`web/src/emulator/types.ts` gains one method:

```ts
detectLinks(detector: LinkDetector | null): void
```

where a detector is `{find(line), verify(candidates), open(candidate)}`.
Emulator-agnostic on purpose: every terminal emulator can underline a range of
text. `xterm.ts` implements it with `registerLinkProvider`, and nothing above
the seam learns that xterm exists, which is the property that file exists to
protect.

### Wrapped lines

xterm hands a link provider a buffer row, and a 90-character path in an
80-column phone view occupies two of them. The provider walks `isWrapped`
backward and forward, assembles the logical line, matches against that, and
maps the ranges back to screen coordinates.

Getting this wrong produces a feature that works on a laptop and silently fails
on a phone, which is the device it matters most on.

### Candidates

`web/src/lib/paths.ts` matches:

- absolute: `/x`, `~/x`
- relative with a separator: `./x`, `../x`, `a/b`
- a bare filename carrying an extension: `CLAUDE.md`

Trailing `.,;:)]}"'` is stripped. An optional `:line[:col]` suffix is captured
and scrolls the viewer to that line.

Matching is deliberately generous, because verification decides the underline.
A regex tuned to avoid false positives would instead produce false negatives,
and a path that refuses to underline is worse than one that briefly does not.

### Verification on hover

Hovering a line sends one `stat` carrying every candidate on it, not one per
candidate. Only paths that came back `exists` underline.

Results are cached per session and raw text: 30 seconds for a hit, 2 seconds
for a miss. The short negative lifetime is the case that would otherwise bite.
An agent says it is writing `src/foo.ts`, you hover a moment before it exists,
and a long negative cache leaves that path dead for the rest of the session.

### The viewer

A Radix dialog over the session, in `web/src/files/`.

- Content renders windowed. Monospace means a fixed line height, so this is
  arithmetic rather than a virtualization library.
- Chunks paint as they arrive, so the head of a large file is on screen before
  the tail has been sent.
- The header shows the file name, the resolved directory, the size, and a copy
  button for the path.
- A `:line` suffix scrolls to that line and marks it.

### Highlighting

Shiki, with the JavaScript regex engine (`@shikijs/engine-javascript`) rather
than oniguruma-wasm.

The daemon serves its UI under `script-src 'self'` (`internal/daemon/server.go`,
`cspHead`), and Chrome refuses to compile WebAssembly under that policy without
`wasm-unsafe-eval`. Widening the policy that the daemon's own comment says
exists to stop injected script, in order to colour keywords, is the wrong
trade. The JavaScript engine needs no CSP change.

Grammars load per language as separate chunks, fetched the first time a file of
that type is opened. Tokenizing runs in a worker. Highlighting is capped at
1 MB or 20,000 lines, whichever comes first; larger files render as plain text,
still windowed.

The theme is a light and dark pair chosen to sit with `emulator/palette.ts`, so
a file opened over a terminal does not look like it came from another
application.

### Images

Chunks are assembled into a `data:` URL. The policy already permits it
(`img-src 'self' data:`), and `blob:` would require widening it. This is the
same reasoning as the highlighter engine: the feature bends around the CSP
rather than the CSP around the feature.

### Cache

An in-memory LRU of a few megabytes, keyed by machine, path, size, and mtime.
Reopening a file you just closed costs nothing.

Not IndexedDB. File contents sitting on a paired phone's disk is a durability
question this feature has no reason to open.

## Testing

- `testdata/wire/control.json` gains one example of each new message. Both the
  Go and the TypeScript suites decode that file, so the two implementations
  cannot drift.
- Go, `internal/daemon/file_test.go`: resolution against the live cwd and `~`, a
  symlink pointing out of the tree, a missing path, a directory, an unreadable
  file, truncation at the cap, chunk boundaries, cancel mid-stream, handles
  released when the connection drops, and the concurrency cap.
- Go: content sniffing across text, binary, and image.
- Web: `paths.test.ts` for candidates, punctuation stripping, `:line:col`, and
  wrapped-line assembly. `client.test.ts` for the stat, read, and cancel
  promises and for chunk routing by ref. Viewer tests for windowing, the
  truncation notice, and the image path.
- e2e (`web/e2e`, two daemons and a real Worker): one relayed read of a real
  file. The 1 MiB cap and the chunk pacing only exist for real over the relay,
  so that is the only place they are genuinely proven.
- `spec/protocol.md` is updated as part of phase 1. It is the contract, not a
  description of one.
- Prose in new web sources feeds the Tailwind scanner through
  `styles.build.test.ts`. See the notes at the top of `web/src/styles.css`
  before writing comments in scanned sources.

Commands: `go test ./...`, and in `web/`, `pnpm vitest run` and `pnpm run lint`.

## Build order

Three pull requests, riskiest first, each one shippable on its own.

1. **Wire and daemon.** The three messages, binary type `0x02`, resolution,
   sniffing, the chunk pump, the caps, cancel. No UI at all. Proven by Go tests
   and the conformance file.
2. **Clicking and reading.** Client methods, the `detectLinks` seam, the link
   provider with wrapped-line handling, and a plain-text viewer. The feature
   works end to end here, on loopback and over the relay, at zero bundle cost.
3. **Shiki, images, cache.** The worker, the theme pair, `data:` images, the
   LRU.

Phase 2 is the honest test of whether clicking a path is the right interaction,
and it lands before a byte of highlighter ships.
