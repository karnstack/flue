# Follow-ups

Carried out of the local-terminal build, triaged by a whole-branch review. Ranked
roughly by value, not by size.

## 1. `reqId` on `attached` and `error`

Four places currently lean on "one connection answers in order", because a reply
names no request: the client's `owed` counter, the sessions route's `refuseNext`,
that route's own counter, and the terminal's `not_found` heuristic.

Ordering is genuinely guaranteed today — the daemon handles frames serially on one
read loop and everything leaves through a single FIFO outbox — so none of the four
is reachable-wrong. They are fragile rather than broken.

A correlation id collapses all four into one correct mechanism. **It must go on
`wire.Error` as well as `wire.Attached`**: `not_found` is delivered as an error, so
a field on `attached` alone leaves the fourth site a heuristic.

Do this before anything else grows a second consumer of `attach`.

## 2. Device-query reinjection on a fresh attach

Every mount attaches with `lastSeq = 0` and replays the whole ring. That scrollback
contains the shell's own DA / DECRQM / OSC 11 probe replies, and xterm answers them
again — into the shell's stdin. Reproduced 4/4. It fires on reload, reopen, route
navigation, and the second mirroring tab. A socket *reconnect* is unaffected, since
the client advances its plan to `max(planned, lastSeq)` on teardown.

Fix: a `head` field on `attached`, computed as `sub.StartSeq + len(sub.Backlog)`
from two adjacent lines in `conn.go`. The client mutes `onData` until it has
consumed that many bytes.

`head` beats gating on "the first output frame after `attached`", because the
daemon omits that frame entirely when the backlog is empty — the gate would never
open on a fresh spawn. With `head`, `head === seq` opens it immediately.

Land it in one commit with the wire fixture, the TypeScript types, and
`spec/protocol.md`: the Go round-trip test compares decoded maps, so an untagged
new field fails it.

## 3. Docs that are not true

- `README.md` Setup says `flue enable`. The CLI knows `serve`, `open`, `status`,
  `help` — `flue enable` exits 2.
- `usage()` says `flue open` spawns a session. It builds a URL and opens `/`.
- `flue open <path>` puts `?cwd=` in that URL and nothing reads it, so it lands on
  an empty session list rather than a shell in that directory.
- The spec's adapter table describes local auth as "token file + Origin + Host".
  There are four checks, and `Sec-Fetch-Site` is the one doing the real work
  against a co-resident loopback origin.

## 4. The spec requires an audit log that does not exist

The security section lists "every attach, pairing, revocation, and rejection is
logged with the resolved peer identity" under "the controls below are
requirements". There is no logging anywhere in `internal/` — not one call site.

Either implement minimal auth-failure and attach logging, or strike the
requirement. Do not ship a security spec asserting a control the binary lacks.

## 5. `loginShell` before the login-service task

`registry.go`'s "passwd entry" fallback is a `HomeDir != ""` guard around a
hardcoded `/bin/zsh`, so a bash or fish user gets zsh. It only runs when `$SHELL`
is unset — which is exactly the launchd and systemd path the README advertises.

## 6. Smaller carried items

- `Subscribe(fromSeq > EndSeq)` returns `StartSeq` unclamped. The one place a
  client-supplied number enters server state unchecked.
- `outboxDepth` and `subChanDepth` were each chosen as 256 by different tasks. The
  comment says they "agree"; they compose, so a stalled connection pins roughly
  16 MiB rather than 8.
- `error{code:"lagged"}` has no client handler. Near-unreachable, because the
  outbox fills first — but if it ever fires, the terminal is silently dead.
- Three packages spell the `Sec-Fetch-Site` check three ways, and one reads only
  the first of repeated values. No browser can produce a duplicate, so there is no
  exploit path, but they should agree.
- `handleMint` and `fetchSessions` are the same request shape; `writeTokenAtomically`
  and `WriteRuntime` are the same CreateTemp+Rename.
- `daemon.ReadRuntime` has no production caller. `Emulator.snapshot()` has no
  consumer outside tests. `@xterm/addon-fit` is an unused dependency.
- `Makefile`'s `test-web` has no `web` prerequisite, so it fails on a fresh clone
  and `make -j test` races two pnpm invocations.
- The comment on the handoff exchange claims `no-store` stops CacheStorage. It does
  not — the Cache API ignores `Cache-Control`. The header closes the HTTP-cache
  half, which is the substantive risk; the other half is closed by the entry being
  keyed under the shell URL and `Set-Cookie` being filtered from a `basic` response.
- Light mode: `destructive` is 4.01:1 and `--muted-foreground` on `--muted` is
  4.39:1. Both under AA.
- `connect-src` allows `ws://127.0.0.1:*` and `ws://localhost:*`. `'self'` covers
  the daemon's own socket; the wildcard ports would let an injected script reach
  every loopback service. Defence in depth only, given `script-src 'self'`.

## Things worth knowing before touching this code

**Tailwind scans raw bytes.** Prose in comments, parameter names, and
object-literal keys are all class candidates — `function f(container: Registrar)`
emits `.container`. A bare identifier in a member call is not. Trailing punctuation
decides: `"a CSS transform,"` is safe, `"CSS transform:"` is not. This shipped dead
CSS four times, twice from comments written to warn about it.

`web/src/styles.build.test.ts` guards it by allowlist: every bare single-word rule
in the compiled sheet must be asked for by real markup. `KNOWN_DEAD` is a
shrink-only baseline — reword your code rather than adding to it. If you check by
hand, use a fresh `@tailwindcss/oxide` `Scanner` per file; the instance dedupes
across calls and will tell you a construct is safe when it is not.

**Every web test belongs under `web/src/` named `*.test.ts(x)`**, helpers under
`web/src/testing/`. The `@source not` globs are anchored at `web/src/`, and a test
placed elsewhere compiles its classes into the shipped stylesheet — at which point
a build-output test can manufacture its own evidence.

**`web/dist/` must stay gitignored.** It is the only thing keeping stale build
output out of Tailwind's scan.
