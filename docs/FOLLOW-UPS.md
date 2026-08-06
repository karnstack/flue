# Follow-ups

Carried out of the local-terminal build, triaged by a whole-branch review. Ranked
roughly by value, not by size. Items 7–9 are the same exercise for the
crypto+pairing milestone, and item 10 for the relay's daemon leg.

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
the first pass missed. Pairing and revocation logged nothing at the time because
they had no code yet; the crypto+pairing milestone below closed that half —
`pairing.go` and `conn.go` now log every pair, every refusal, and every
revocation with the device.

### 5. `loginShell` before the login-service task

`registry.go`'s "passwd entry" fallback was a `HomeDir != ""` guard around a
hardcoded `/bin/zsh`, so a bash or fish user got zsh. It only ran when `$SHELL`
was unset — which is exactly the launchd and systemd path the README advertises.

**Done** — the fallback now reads the real user database (`dscl` on macOS,
`getent` elsewhere) and refuses empty or relative entries. Sessions also get
`SHELL=` filled in when the daemon itself has none, so programs inside the
terminal see a login shell under the login service too.

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

## Crypto and pairing

Carried out of the crypto+pairing milestone (Noise IK, the device registry, the
local pairing ceremony, the Devices screen and `/pair`). Part 2 is the relay —
`cfrelay` — and most of what follows is aimed at the moment it lands.

### 7. Scope deliberately left out

- **The typed-phrase fallback (`warm-otter-4821`) is part 2.** It needs a
  wordlist shared by both implementations, and — unlike the QR — it cannot carry
  the daemon's 32-byte static key, so its trust model is a separate design
  conversation rather than a missing function. Over `local` the copyable pair URL
  covers the same need, which is why deferring it costs nothing yet.
- **The device-conn registry has no local members.** `registerDeviceConn`
  (`internal/daemon/server.go:778`) and `s.deviceConns` are built and tested, but
  a loopback connection authenticates by session token and never acquires a
  device identity, so nothing keys a conn by device until `cfrelay` is the thing
  opening them. Revocation closes zero live connections today; the tests reach
  `registerDeviceConn` directly to prove the mechanism.
- **Any authenticated connection may revoke, by design.** The spec draws no
  privileged split — pairing *is* the boundary, and a device that got through it
  is trusted to unpair others. Reviewed and ruled on rather than overlooked.

### 8. Worth a second look before or during part 2

- **The pairing pin is only as trustworthy as the code that reads it.** The QR now
  carries the daemon's static key (`?k=`, `internal/daemon/conn.go`), and `/pair`
  pins that key and rejects a `POST /api/pair` answer whose `daemonPub` differs
  (`web/src/routes/pair.tsx`) — which closes the TOFU hole against anyone who can
  see the POST but not the page bundle. It does **not** close a malicious relay
  that serves `/pair` itself: that relay ships the JS that reads `k`, so it can
  pin its own key and the check is a no-op against it. `conn.go` builds the URL
  from `c.origin`, which follows whatever origin the relay presents once `cfrelay`
  lands. Part 2 must keep the pairing page out of relay control — point the QR at
  the daemon's own origin (relay carries only the tunnel, never the `/pair` HTML),
  ship a native/installed pairing client, or integrity-pin the bundle by something
  the relay cannot rewrite. Until one of those exists, the `k`-in-QR work is a
  necessary prerequisite, not a finished defence.
- `registerDeviceConn` has two latent races (`internal/daemon/server.go:778`): a
  connection that flaps can leave its predecessor's entry behind, and a revoke
  landing mid-handshake is undone by the registration that follows it. Neither is
  reachable while nothing calls it — `cfrelay` is its first caller, so the
  "still in `s.conns`" guard wants to exist before that does. `dropConn`
  (`server.go:801`) also leaves a stale `*conn` in the backing array's tail.
- Store errors reach clients verbatim: `err.Error()` on `devices_unavailable` and
  `revoke_failed` (`internal/daemon/conn.go:437,507,512`) carries the
  `devices.json` path, which discloses `$HOME` and the username to any paired
  device. It matches what the rest of the file already does; sanitize the whole
  set at once rather than one call site.
- `wire.Sessions` marshals a nil slice as `null` while the TypeScript type says
  `SessionInfo[]` (`internal/wire/control.go:80`). Exactly the gap this branch
  closed for `DeviceList` with a `MarshalJSON` (`control.go:143`) — it pre-dates
  the branch, and was left rather than widened mid-milestone.
- `exemptStaticPath` returns true for a bare `/assets`
  (`internal/daemon/server.go:431`), which the doc comment two lines above says
  it does not. Unreachable today because the mux 307s the bare directory first,
  so this is defence in depth — but it is the depth the comment promises.
  `strings.HasPrefix(p, uiAssetPrefix)` closes it.
- `/pair` marks the window `spent: true` on refusals that never reached the
  redeem step — a 503, or a provenance 403 (`web/src/routes/pair.tsx:219-239`).
  The token is still good and the UI says otherwise. Nothing writes an audit line
  for a provenance 403 at an exempt path, either.
- `Device.LastSeen` is written once, at pairing (`internal/crypto/devices.go`), and
  never updated, so the Devices screen's "Last seen" column is truthful only
  until `cfrelay` lands — nothing over `local` connects as a device. Part 2 must
  add `DeviceStore.UpdateLastSeen` and call it on connect; writing that method
  now would be one with no caller.
- `loadIdentity` failing is fatal to `serve` (`cmd/flue/main.go:170`). Degrading
  to an empty `Identity` — pairing off, shells still up — is the friendlier shape
  for a keystore that got chmod'd wrong.
- A revoked device retries forever when the close carries no reason: `sendFinal`
  drops the `revoked` frame on the `errConnBacklogged` path
  (`internal/daemon/conn.go:231`), leaving a bare close the client reconnects
  from. Only reachable once a device holds a real connection — part 2.
- Any local process can burn an open pairing window by guessing wrong once. That
  is the intended shape of burn-on-wrong-guess and it is bounded by the two-minute
  TTL, but it is worth knowing before the ceremony is driven from anywhere else.

### 9. Smaller carried items

- `go.mod` still marks `github.com/flynn/noise` `// indirect` though
  `internal/crypto` imports it directly. `go mod tidy` fixes exactly that, and
  also adds three unrelated `go.sum` lines — left for a dedicated cleanup rather
  than smuggled in behind a docs commit.
- The CreateTemp+rename pattern named twice in item 6 is now five copies —
  `internal/crypto/keys.go:72`, `internal/crypto/devices.go:62`,
  `internal/config/paths.go:85`, `internal/daemon/discover.go:47`,
  `internal/session/snapshot.go:117`. The dedupe was not done inline.
- `internal/crypto/handshake_test.go` is not gofmt-clean (inherited from the task
  brief), and its wrong-pinned-key case spends a fixed five seconds waiting out a
  context where it could signal off the responder's error.
  `internal/crypto/vectors_test.go:64`'s `capture` struct is dead.
- Test gaps noted and not filled: the corrupt-`devices.json` path
  (`internal/crypto/devices.go`); the same-bytes refusal test covers one of three
  refusal shapes and no headers (`internal/daemon/pairing_test.go`); the
  revoked-conn test discards frames after the revoke, so it cannot catch a
  `deviceList` leaking to a revoked device (`internal/daemon/server_test.go`);
  the client's clear-on-flush only pins the first reconnect; and the Devices
  screen has no case for Confirm-while-disconnected, `pairing_unavailable`
  clearing the window, or the Paired column.
- Log wording: `internal/daemon/pairing.go:136` calls the first probe of an
  expired-but-unswept window "wrong token against an open window". The third doc
  bullet on `withProvenance` (`internal/daemon/server.go`) now holds only for
  exempt paths.
- `testdata/wire/control.json` spells `deviceId` as sixteen hex characters;
  `crypto.DeviceID` yields twelve and `deviceIDLen`
  (`internal/daemon/server.go:843`) enforces twelve. `spec/protocol.md` is silent
  on the format either way, and its line 122 — "one example of every control
  message" — is now stale, since three types carry two cases.
- `secondsLeft` is unclamped (`web/src/routes/devices.tsx:68`), so clock skew can
  paint one negative frame before the window closes. The armed row's
  Confirm/Cancel are `h-7` with `gap-x-1`, the smallest touch target in the app,
  on the one irreversible action. Relative last-seen is frozen between pushes —
  no interval tick.

## Relay carry-forwards

Carried out of the `cfrelay` daemon leg (`internal/transport/relay`): the Worker
socket, the channel layer, and the pairing bridge. Reviewed and deliberately not
fixed in that milestone, because the fix is a design change rather than a patch.

### 10. The outbound path is whole-socket fate-sharing; the inbound path is not

The two directions are bounded on purpose, and only one of them isolates a
browser. **Inbound** is per-channel: every browser gets its own `inboxDepth`
(256) queue, and a channel that will not drain is closed by itself with a
`close{channel}` while every other channel and the socket carry on
(`TestRelayChannelBackpressureClosesOneChannelNotTheSocket` pins exactly that).
**Outbound is shared**: `channelConn.Write` → `socket.enqueue` → one 256-deep
`out` channel for the whole socket, and `enqueue`'s answer to a full queue is
`s.fail(errSocketBacklogged)` — which tears the socket down and 1012s every
browser this machine is carrying.

The trigger is not a hostile peer, it is an ordinary one: a browser attached to a
high-rate session (a `yes`, a build log, a `cat` of something large) can put 256
frames in flight in milliseconds, so a TCP write stall of that length — a
momentarily stalled edge, a wifi handoff, a send buffer that briefly stops
draining — is enough for one session to end everybody's. Nothing upstream absorbs
it: `channelConn.Write` never blocks by design, so the daemon's own per-connection
outbox drains straight through into the shared queue rather than filling first
and closing just that connection the way it does on loopback. The bound that is
hit first is the shared one, and the action it takes is the whole socket.

The fix, when it is worth it, is **per-channel outbound credit** rather than a
deeper shared queue — deepening it only moves the cliff. Give each channel a
small allowance of in-flight frames on the shared outbox, return credit as the
writer drains, and when a channel is over its allowance close *that* channel with
the ordinary `close{channel}` the inbox path already sends. Blocking is available
too, and cheaper to write: `channelConn.Write` is called from that connection's
own writer goroutine, so a bounded wait there applies backpressure to exactly one
browser — but a stalled channel's frames would then sit in the shared queue and
starve the rest, which is why credit is the shape to reach for. Either way
`errSocketBacklogged` goes back to meaning what its comment claims — the relay
has stopped reading — rather than "one browser was briefly noisy". The constant's
doc comment in `relay.go` states the asymmetry so nobody reads `outboxDepth = 256`
as the isolation the inbox gives.

### 11. The pairing page is now served by the relay whenever one is live

Item 8 above asked part 2 to keep `/pair` out of relay control. The wiring task
did the opposite, deliberately: `Server.pairingOrigin` (`internal/daemon/server.go`)
returns the relay's origin whenever the relay is connected, so `pairing.url` —
the QR — names the relay rather than `http://127.0.0.1:7717`. There is no version
of remote pairing where it does not: the device being paired is a phone that is
not on this LAN, and a URL it cannot open is not a ceremony.

What that costs is exactly what item 8 described. The relay ships the JS that
reads `?k=` and compares it to the `daemonPub` in the answer, so a relay that
wanted to could pin its own key and pair *itself* as a device — which is the one
move that would let it read sessions it otherwise only carries as ciphertext.

Two things bound it, neither of which is a fix. The origin comes from
`relay.json` on this machine (`config.LoadRelay`), never from anything the relay
announces, so this is a compromised or hostile *deployed* relay rather than
anyone who can reach one; and pairing still needs a window a user opened, inside
a two-minute single-use token.

The cheapest real mitigation is confirmation rather than isolation: the local UI
already holds `daemonPub`, so showing a short fingerprint of it beside the QR and
having the paired device show what it pinned makes a substituted key something a
user can see. A native pairing client or an integrity-pinned bundle closes it
properly; both are larger than the ceremony they protect.

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
