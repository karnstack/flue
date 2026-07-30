# Follow-ups

Carried out of the local-terminal build, triaged by a whole-branch review. Ranked
roughly by value, not by size.

## Done

Shipped on this branch. Kept here rather than deleted, so the review that found
them still reads.

### 1. `reqId` on `attached` and `error`

Four places leaned on "one connection answers in order", because a reply named no
request: the client's `owed` counter, the sessions route's `refuseNext`, that
route's own counter, and the terminal's `not_found` heuristic. Ordering was
genuinely guaranteed — the daemon handles frames serially on one read loop and
everything leaves through a single FIFO outbox — so none of the four was
reachable-wrong. They were fragile rather than broken.

**Done** — a `reqId` now rides `wire.Attach`, `wire.Spawn`, `wire.Attached`, and
`wire.Error` alike (the last mattered: `not_found` is delivered as an error, so a
field on `attached` alone would have left that fourth site a heuristic). The
daemon echoes it on the reply that answers the request; the client settles attach
and spawn replies by `reqId`, not arrival order. The sessions route's `owed`
counter and `refuseNext`, and the terminal's `not_found` heuristic, are retired.

### 2. Device-query reinjection on a fresh attach

Every mount attached with `lastSeq = 0` and replayed the whole ring. That
scrollback contains the shell's own DA / DECRQM / OSC 11 probe replies, and xterm
answered them again — into the shell's stdin. Reproduced 4/4: reload, reopen,
route navigation, and the second mirroring tab. A socket *reconnect* was
unaffected, since the client advances its plan to `max(planned, lastSeq)` on
teardown.

**Done** — `attached` now carries a `head` field, computed as `sub.StartSeq +
len(sub.Backlog)` in `conn.go`. The client mutes `onData` until it has consumed
that many bytes, advancing the count when the parser finishes rather than when
the frame arrives, and guarding the counter with the attachment's epoch. Landed
in one commit with the wire fixture, the TypeScript types, and
`spec/protocol.md`.

### 3. Docs that were not true

- ~~`README.md` Setup says `flue enable`. The CLI knows `serve`, `open`, `status`,
  `help` — `flue enable` exits 2.~~ **Done** — `flue enable` and `flue disable`
  are real subcommands now; `enable` installs the login service, starts the
  daemon, and opens the UI.
- ~~`usage()` says `flue open` spawns a session. It builds a URL and opens
  `/`.~~ **Done** — `flue open <path>` spawns a session in that directory; the
  claim and the behaviour match.
- ~~`flue open <path>` puts `?cwd=` in that URL and nothing reads it, so it lands
  on an empty session list rather than a shell in that directory.~~ **Done** —
  the web app reads `?cwd=` on mount and spawns the session there.
- ~~The spec's adapter table describes local auth as "token file + Origin +
  Host".~~ **Done** — the table names all four checks and calls out
  `Sec-Fetch-Site` as the one doing the real work against a co-resident loopback
  origin.

### 4. The spec requires an audit log that does not exist

The security section lists "every attach, pairing, revocation, and rejection is
logged with the resolved peer identity" under "the controls below are
requirements", and there was no logging anywhere in `internal/` — not one call
site.

**Done** — `internal/daemon` now logs, via `slog`, every attach, detach, auth
rejection, and mint rejection, each with the peer. That includes the
`Sec-Fetch-Site` rejection on the websocket upgrade, which runs after
`checkAuth` has already accepted the token and was a fourth auth-decision site
the first pass missed. Pairing and revocation log nothing because they have no
code yet — remote access is still designed, not built.

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
