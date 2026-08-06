# Follow-ups

Carried out of the local-terminal build, triaged by a whole-branch review. Ranked
roughly by value, not by size. Items 7–9 are the same exercise for the
crypto+pairing milestone, items 10–13 for the relay, item 14 for the SaaS
control plane's browser leg, and item 15 for what its kill switch does and does
not reach.

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

  **Half done** — the relay origin, which is the one reachable from the internet,
  no longer carries them: `daemon.RelayCSP` is `LocalCSP` without that clause,
  and the two are composed from a shared head and tail so the rest cannot drift.
  The daemon's own origin still carries the wildcards, because `'self'` really
  does not cover `ws://127.0.0.1:7717` from an `http://127.0.0.1:7717` page —
  narrowing it needs the port, which the daemon knows and this constant does not.

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

Part 2's first plan — `cfrelay`, the relay substrate — has now landed, and the
items it closed are marked inline below with the commit that closed them. The
unmarked ones still stand, and the first bullet got worse rather than better:
see §11.

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

  **Still open, and now live rather than latent** — the wiring task pointed the
  QR at the relay deliberately, because a phone that is not on this LAN cannot
  open `http://127.0.0.1:7717`. §11 is the whole accounting.
- `registerDeviceConn` has two latent races (`internal/daemon/server.go:778`): a
  connection that flaps can leave its predecessor's entry behind, and a revoke
  landing mid-handshake is undone by the registration that follows it. Neither is
  reachable while nothing calls it — `cfrelay` is its first caller, so the
  "still in `s.conns`" guard wants to exist before that does. `dropConn`
  (`server.go:801`) also leaves a stale `*conn` in the backing array's tail.

  **Done** (`717fe7d`) — the relay transport is that first caller, so this went
  live with it. Registration is one hold of `connMu`, a late `registerDeviceConn`
  refuses a conn that has already left, and `dropConn` clears the vacated tail
  slot.
- Store errors reach clients verbatim: `err.Error()` on `devices_unavailable` and
  `revoke_failed` (`internal/daemon/conn.go:437,507,512`) carries the
  `devices.json` path, which discloses `$HOME` and the username to any paired
  device. It matches what the rest of the file already does; sanitize the whole
  set at once rather than one call site.

  **Done** (`717fe7d`) — the registry's own errors go to the log; the socket
  carries the fact and not the path.
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

  **Half done** (`4a951e1`, with `a0fbea9` reserving 403 for the daemon's own
  verdict end to end) — `spent` is now exactly `res.status === REFUSED_STATUS`,
  so a 503, a 504, a 429 and the relay's own refusals all leave the window open
  and offer a retry. The audit-line half is untouched: a provenance 403 at an
  exempt path still logs nothing.
- `Device.LastSeen` is written once, at pairing (`internal/crypto/devices.go`), and
  never updated, so the Devices screen's "Last seen" column is truthful only
  until `cfrelay` lands — nothing over `local` connects as a device. Part 2 must
  add `DeviceStore.UpdateLastSeen` and call it on connect; writing that method
  now would be one with no caller.

  **Done** (`717fe7d`) — `DeviceStore.UpdateLastSeen` exists and `ServeConn`
  calls it, which is the caller this was waiting for. The column is true.
- `loadIdentity` failing is fatal to `serve` (`cmd/flue/main.go:170`). Degrading
  to an empty `Identity` — pairing off, shells still up — is the friendlier shape
  for a keystore that got chmod'd wrong.
- A revoked device retries forever when the close carries no reason: `sendFinal`
  drops the `revoked` frame on the `errConnBacklogged` path
  (`internal/daemon/conn.go:231`), leaving a bare close the client reconnects
  from. Only reachable once a device holds a real connection — part 2.
- ~~Any local process can burn an open pairing window by guessing wrong once. That
  is the intended shape of burn-on-wrong-guess and it is bounded by the two-minute
  TTL, but it is worth knowing before the ceremony is driven from anywhere else.~~
  **Done** — "anywhere else" arrived: the relay makes `POST /api/pair` reachable
  from the internet without a credential, so burn-on-wrong-guess handed anyone a
  way to cancel every window the user opens, forever. `pairingState.redeem` now
  spends a window only on the presentation that pairs a device, or on the TTL.
  The bound it gave up was never worth anything against 32 bytes of
  `crypto/rand`.

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

Carried out of `cfrelay`: the daemon leg (`internal/transport/relay` — the Worker
socket, the channel layer, the pairing bridge) and the guided deploy that stands
one up. Reviewed and deliberately not fixed in that milestone, because the fix is
a design change rather than a patch.

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

The service worker is **not** one of the options, and `docs/faq.md` used to imply
it was. `web/src/lib/sw-strategy.ts` is network-first for navigations and fetches
hash-named assets on a cache miss, so a normal load takes whatever `index.html`
the origin serves and then the bundle that document names. Pinning would mean
refusing to run a bundle whose digest changed — a different worker, and one that
has to be right about updates or it bricks the app offline. The FAQ now says
plainly that the PWA is an offline cache and a speed-up rather than a defence.

The other half of the same problem *is* fixed: the loopback QR that started this
work — Pair, over a `local`-only daemon, printing a `127.0.0.1` URL no other
device could follow — is gone (`791b07d`). The Devices screen now holds the Pair
button shut, with an explainer, unless the relay is connected or the page itself
is served from a relay origin, and re-evaluates on every welcome.

### 12. `flue relay setup` — the self-host deploy

Carried out of the guided setup flow (`cmd/flue/relay.go`, `internal/cloudflare`).
The secret-dropping deploy that a review found here is fixed — script uploads now
send `keep_bindings: ["secret_text"]`, and the subdomain step runs before the
secret so the only thing after it is a local file write. What is left:

- **The deploy is configured twice and nothing enforces it.** `relay/wrangler.jsonc`
  is what `wrangler deploy` reads during development; `cmd/flue/relay.go` is what a
  user's `flue relay setup` sends. Both name the script (`flue-relay`), the
  compatibility date, the Durable Object class and binding (`DaemonHub`/`HUB`), the
  assets binding, and the run-worker-first paths — and `internal/cloudflare` holds
  the migration tag (`v1`) as a third copy. They agree today, checked by hand and
  noted in a comment over the constants, but a change to either side ships a
  developer and a user running different relays, silently. A test that parses the
  `.jsonc` and compares would close it; the extension permits comments that
  `encoding/json` chokes on, so it needs a tolerant reader or a stripped copy.

  One twin *is* enforced now, and it shows the shape the rest wants: the
  `_headers` document exists as `relay/public/_headers` for wrangler and as
  `relayAssetHeaders` for setup, and `TestRelayAssetHeadersMatchTheWranglerCopy`
  reads the file and compares. That was easy only because the copy is a plain
  file rather than a key inside the `.jsonc`.
- **Re-running setup against a *different* account orphans the old relay.** The
  account is chosen fresh on every run, and nothing looks at what the previous run
  deployed. Pick account B the second time and account A is left holding a live
  `flue-relay` Worker — deployed, subdomain enabled, and still holding a valid
  `DAEMON_SECRET`, because the new run's secret goes to B. It serves whoever reaches
  its workers.dev host until someone deletes it by hand in the dashboard. There is
  no `flue relay teardown`, and the daemon stops dialling A the moment `relay.json`
  is rewritten, so nothing on this machine will ever mention it again. Setup could
  at minimum record the account it deployed into and say something when the next run
  picks a different one.
- Smaller, from the same review, deliberately not coded: the token prompt and the
  account menu go to stdout rather than stderr, so `flue relay setup > log` hides
  the questions and looks like a hang; `✓ reachable at …` is what setup prints
  after Cloudflare accepts `enabled: true`, which is not the same as the host
  answering — nothing fetches it, and a fresh subdomain can lag; and `relayLine()`
  (`cmd/flue/main.go`) reports only the relay's `url`, never its `origin`, which is
  the address a user would open in a browser.

### 13. Left standing by the relay substrate

Found while building `cfrelay` and deliberately not fixed in it: three want a
number or a front-end that does not exist yet, one is a logging line that only
matters once someone is reading the logs, and one is release infrastructure a
documented promise depends on.

- **No per-session output rate cap.** The Durable Object bounds concurrency —
  64 channels, a 30 s handshake deadline, 8 parked pairings, a 4 KiB pairing
  body — and bounds nothing about *rate*. A session streaming continuously
  (`yes`, `tail -f` on a firehose) pins the object active and floods
  invocations, which is the one abuse vector that converts directly into a bill
  (`docs/RELAY.md`, the cost model). The cap wants a real number — the
  99th-percentile session's frame rate, so ordinary interactive use never
  touches it — which is what the month of counters in the same document is for.
  Distinct from §10, which is the daemon's own outbound queue rather than the
  relay's.
- **`POST /api/pair` is credential-less and internet-reachable, and nothing
  rate limits it.** It has to be credential-less — the device presenting a
  pairing token is by definition a device holding no credential — and the
  Durable Object bounds what one caller can *hold* (8 parked attempts, a 4 KiB
  body, a 10 s deadline) rather than how fast they can arrive. A wrong token no
  longer costs the user anything, so a flood buys an attacker nothing but noise
  in the daemon's log and requests against the Worker's daily allowance. That
  last part is the residue: a determined stranger who knows the workers.dev host
  can spend a self-hosted relay's free tier without ever pairing anything. The
  fix is operator-side rather than in this repo — a **Cloudflare Rate Limiting
  rule on `/api/pair`** in the dashboard, which is free on every plan and is
  where a rate this code cannot see belongs. `docs/RELAY.md` says so under fair
  use. Doing it in the Worker instead would mean per-IP state in the Durable
  Object, which is a hibernation cost paid on every request to save one the edge
  can refuse for nothing.
- **The browser leg has no auth, and the SaaS needs one.**
  `authorizeClient` (`relay/src/index.ts`) returns `true` and `hubIdFor` returns
  `idFromName('hub')` — correct for self-hosting, where one daemon owns the
  Worker and Noise is the confidentiality boundary. A multi-tenant relay has to
  verify a signed token on `/client` and route to the right hub by account and
  daemon id. The seam is deliberately in place and the implementation is Plan 2.
- ~~**Relay-served assets carry none of the daemon's security headers.** The
  daemon wraps every response in `securityHeaders`
  (`internal/daemon/server.go`) — `Referrer-Policy: no-referrer` and a CSP with
  `script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`. The
  Worker serves the *same bundle* through `env.ASSETS.fetch(req)` with neither.~~

  **Done.** More than defence in depth, as it turned out: `web/src/crypto/keys.ts`
  names that CSP as the compensating control for holding a raw private key in
  IndexedDB, and the origin missing it was the internet-facing one.

  The "cheap fix" above is a trap worth recording. A `_headers` file dropped
  into the assets directory is **not** uploaded as an asset — wrangler strips it
  out of the manifest and sends its *contents* as a string in the script
  metadata's `assets.config._headers`. Doing the obvious thing would have
  published a public `/_headers` document that Cloudflare never reads and that
  applied to nothing. So `flue relay setup` sends that field
  (`cloudflare.DeployInput.AssetHeaders`, built from `daemon.RelayCSP` in
  `cmd/flue/relay.go`), `relay/public/_headers` is the real file `wrangler dev`
  needs — there is no `wrangler.jsonc` key for this — and a test pins the two
  byte for byte. `webAssets` now also skips a stray `_headers`/`_redirects`
  rather than publishing one. The policy applies to asset-router responses
  *including* the ones the Worker asks for through `env.ASSETS.fetch`, which
  `relay/test/routing.test.ts` checks on both paths.

  The one edit for a relay origin was made: `RelayCSP` drops `connect-src`'s
  loopback wildcards, since the relay's own socket is a same-origin `wss://`.
  The field is absent from Cloudflare's published multipart-metadata reference,
  which documents only `html_handling` and `not_found_handling`; it is what
  every `wrangler deploy` sends, which is as attested as this API gets.
- **`channel_closed` says how much, never how long.** The hub logs frames and
  bytes per direction when a channel closes, and `opened` sits in the
  attachment unlogged — so a channel's lifetime has to be reconstructed from
  `wrangler tail` timestamps, and a channel that never closes reports nothing at
  all. Both matter for the cost measurement rather than for correctness: adding
  `opened` (or a computed duration) to the line, and a periodic line for
  long-lived channels, is what makes a month of logs answer the question on its
  own.
- **No release publishes the web bundle's digest.**
  `web/scripts/bundle-hash.mjs` computes a reproducible SHA-256 over
  `web/dist`, and `docs/faq.md` leans on it for the one thing end-to-end
  encryption cannot fix — whether the origin served you the published code.
  `.github/workflows/release.yml` emits no such value, so the check a reader
  can run today only proves *this source builds to this bundle*, never *that
  origin is serving the release*, and the FAQ now says so out loud. The release
  pipeline has to publish the digest as a release asset and, better, attest it
  (`actions/attest-build-provenance` over `web/dist`) so the comparison is
  against something the user did not produce. Two things gate it: the release
  job must run `pnpm hash` on the same tree goreleaser ships, and the digest is
  only known-reproducible on one platform — the lockfile pins per-platform
  native binaries (esbuild, `@tailwindcss/oxide`) and `mise.toml` pins no OS or
  CPU, so a published macOS digest is unfalsifiable from a Linux machine until
  a container-pinned build makes it portable. Publish the platform beside the
  digest at minimum.

## 14. SaaS browser sessions

The gaps between the web client as built — one daemon, one origin, one token
taken once — and a SaaS relay that is one origin fronting many machines.
Tracked here for a dedicated task (Task 15 builds them), not fixed piecemeal:
each one is a small design decision, and two of them need a control-plane
endpoint that does not exist yet.

- **The pinned daemon key is per-origin; a SaaS relay is one origin for many
  machines.** `loadPinnedDaemonKey()` (`web/src/crypto/keys.ts`, read by
  `web/src/relay/mode.ts`) stores exactly ONE pinned daemon static key per
  origin — the right shape for a self-hosted relay, where the origin *is* the
  machine. On the SaaS relay every device shares `app.flue.sh`, so opening a
  session for device B builds the Noise IK handshake against device A's pinned
  static key: `readMessageB` throws, `shutdown()` reports an ordinary close,
  and FlueClient reconnects into the same failure forever — a silent loop with
  no UI. Fix direction: the control plane already stores each device's
  `publicKey` (the devices table), so "open a session" must hand the browser
  the TARGET device's public key — in the fragment alongside the channel
  token, or via a fetch — and the web client must pin per-device (keyed by
  device id), not per-origin.
- **SaaS pairing sends no bearer.** `web/src/routes/pair.tsx` POSTs
  `/api/pair` with only a `Content-Type` header, and the SaaS relay now
  requires `Authorization: Bearer <client token>` — so SaaS pairing 401s, and
  because 401 is not `REFUSED_STATUS` the page renders the raw refusal rather
  than the refusal copy. Possibly moot: SaaS enrollment is `flue enable` and
  device authorization, not the QR pair flow — but if `/pair` stays reachable
  on the SaaS origin it must either carry the bearer or say why it cannot.
- **The channel token lives 60 seconds and is captured once.** `main.tsx`
  reads the client token from the fragment destructively (`takeChannelToken`
  scrubs as it reads) and every reconnect through the socket factory presents
  that same token. It is good for 60 seconds, so the first reconnect past a
  minute — a laptop lid, a train tunnel — is refused, and the tab dies into an
  endless silent reconnect loop. Fix direction: a control-plane endpoint the
  tab calls before each (re)dial to re-mint a fresh client token for the
  device; the web client refreshes on reconnect instead of reusing the
  captured token.

## 15. What the SaaS kill switch reaches

Carried out of the control plane's abuse controls (`app/src/server/kill-switch.ts`,
the `disabled` flags on `users` and `devices`, `/terms`). Both items are
statements of what the switch actually does, recorded here so nobody has to
rediscover them during an incident. Neither is a bug: the first is a gap with a
known workaround, the second is the intended behaviour written down.

- **Revocation does not reach a channel that is already open.** Both mints
  (`app/src/server/channel-token.ts`) re-read `users.disabled` and
  `devices.disabled` in the same `where` as ownership, so disabling either one
  stops the *next* mint immediately. The relay does not ask: `authorizeToken`
  runs once, at the WebSocket upgrade (`relay/src/index.ts`), and nothing
  re-reads the claims or the database for the life of that connection. So a
  terminal somebody already has open outlives both the revocation and the token
  that opened it — it ends when it is closed, or when the daemon next reconnects
  and its refresh is refused. The bound on "next dial" is the token TTL: 60
  seconds for a browser, 300 for a daemon.

  What an operator does today, and what `/terms` and `kill-switch.ts` both say:
  to end a live session *now*, stop the daemon on the machine. Closing it
  properly needs revocation the relay can hear about, and there are two shapes —
  a hub-side check on a schedule (the Durable Object re-validating its live
  channels against the control plane, which costs a request per channel per
  interval), or a channel that closes when its own token's `exp` passes (free,
  and it converts the TTL from "how stale a *new* dial can be" into "how long a
  live session survives revocation" — which is the property everyone assumes it
  already has). The second is the smaller change and probably the right one.

- **A device revocation is sticky, and un-revoking is an operator action.**
  `devices.id` is sha256(publicKey)[:12], so a machine that re-enrolls lands on
  the row it already had. The mint upsert in `app/src/server/enroll.ts`
  deliberately carries the existing `disabled` value over rather than resetting
  it, because the documented recipe disables a machine while *leaving its owner
  signed in* — and a flag that a re-run of `flue enable` cleared would have made
  the revocation last exactly as long as it took the person it was aimed at to
  reinstall. So: the re-enrolment succeeds (new token, new label, no last-seen,
  and no refusal that would tell whoever holds the machine that this id has been
  singled out), and both mints still refuse it. `enableDevice` — or
  `update devices set disabled = 0` — is the only thing that turns it back on.
  Pinned by `app/test/enroll.test.ts` ("does not clear a revocation when the key
  comes back", plus the enabled-device case beside it).

  Carrying the flag over is only half of it, because it needs a row to carry it
  on. `revokeDevice` (`app/src/server/devices.ts`) therefore states
  `disabled = 0` in the same `where` as ownership: the dashboard's own "remove"
  refuses a machine an operator has switched off, and says so in a sentence
  written for that case rather than the undistinguished "no longer on your
  account" (that machine is on the owner's list, flagged, so there is nothing to
  hide from them — a device that is *not* theirs still gets the one generic
  refusal whether it is disabled or not, or the message becomes an oracle).
  Without that guard the whole switch was one click and one reinstall away from
  being undone: delete the row, run `flue enable`, and the INSERT writes a fresh
  `disabled = 0` with no conflict to carry anything over from. An operator's
  revocation outranks its owner's. Pinned by `app/test/devices.test.ts`
  ("refuses to remove a machine flue has switched off, and says so", plus the
  non-owner case beside it).

  The residue, stated so it is a decision rather than an oversight, and it is now
  only this one: a person whose machine was revoked can generate a *different*
  Noise static key on the same hardware and enroll that, which is a different
  device id and so a new row, since the id follows the key. That is a new device
  by every definition this service has, and stopping it means revoking the
  account rather than the machine — which is what `disableUser` is for. The
  same-key path — delete the row from the dashboard, re-enroll, get a clean flag
  — is closed.

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
