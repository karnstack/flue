# flue goes open-source-only: one UI, one relay, many machines

Date: 2026-08-07
Status: approved (this session), supersedes the SaaS direction of
2026-08-06-flue-cloud-relay-design.md

## The decision

flue is open source, always free, and operates no servers. Remote access runs
through a Cloudflare Worker the user deploys into their own account with the
flue binary. The hosted control plane (app.flue.sh — accounts, invites, login
emails, D1, signed channel tokens) is deleted, not deferred. flue.sh the domain
becomes a landing page with setup instructions, later a setup video, and
nothing else.

This dissolves the two-UI problem that started the conversation: the second UI
existed *for* the SaaS. What remains is one UI artifact with two doors.

## Requirements

1. **One binary.** `flue serve` gives a terminal at localhost with no network
   dependency. Everything beyond localhost lives in the user's own Cloudflare
   account, deployed by the binary (`flue relay setup`), no Node on the
   machine.
2. **One relay worker per account, many machines.** The first machine deploys
   the worker; every later machine joins it under its own machine id. One URL
   fronts all of a user's machines. One Durable Object per machine: the hub,
   its 64-client cap, hibernation economics and channel counters are per
   machine and unchanged.
3. **One UI** — `web/` — served through two doors, byte-identical: embedded in
   the daemon (`//go:embed`, works offline and air-gapped) and served by the
   relay worker (remote browsers, phones). The relay door renders a machine
   picker; the daemon door remains this-machine-only.
4. **The machine list is client-side.** The picker is the browser's pairing
   history (localStorage: machine id, display name, pinned daemon static key).
   There is no server-side registry of machines; the relay stores nothing
   about a machine beyond what its hub already keeps (the channel counter,
   per-socket attachments).
5. **The E2E promise stands and simplifies.** Terminal traffic crossing the
   relay is Noise IK ciphertext the relay holds no key for. With the control
   plane gone there is no party left that could even hold session metadata.
   Per-device key pinning (built in Task 15) is kept: it is exactly what
   one-origin-many-machines requires.
6. **Daemon-leg auth, v1: one `DAEMON_SECRET` per worker**, shared by that
   account's machines. Honest limit, documented in RELAY.md: a compromised
   machine holding the secret can dial a sibling's DO and impersonate its
   daemon leg. It cannot read a sibling's existing sessions (Noise keys are
   per machine), but it can accept new pairings as if it were the sibling.
   The upgrade path — a per-machine secret TOFU'd into each hub's storage on
   first daemon connect — changes no wire format and is deliberately deferred.

## Non-goals (deleted, not deferred)

Accounts, invites, login codes and the email Sender, D1 and its migrations,
signed channel tokens and the relay's SaaS mode, `flue link` and device
authorization, `app/` in its entirety. No telemetry, no billing, ever.

## Architecture

```
flue    Go binary — daemon + CLI: serve, relay setup, relay join, pair, status
web/    the one UI — terminal + machine picker + pairing; two doors
relay/  the Worker — id-routed hubs + serves the UI; deployed by the binary
```

### Relay routing

The worker learns one new thing: a machine id in the path.

```
wss /daemon/<machine-id>    daemon leg, Authorization: Bearer <DAEMON_SECRET>
wss /client/<machine-id>    browser leg, credential-less; Noise is the boundary
     /pair/<machine-id>     the pairing ceremony, parked at the relay as today
GET  /*                     the UI bundle and SPA fallback
```

`idFromName(machine-id)` selects the hub. Hub internals do not change. The
machine id is a stable slug minted at setup/join time (hostname plus a random
suffix); the display name travels in pairing payloads, never in the path.
Pre-release: no compatibility shims for the current id-less paths.

### Setup and join

Only the first machine touches the Cloudflare API.

- `flue relay setup` (machine 1): deploys the worker, mints `DAEMON_SECRET`,
  writes relay.json (origin, secret, machine id, display name), prints the
  join command for other machines:
  `flue relay join wss://flue-relay.<sub>.workers.dev --secret <...>`.
- `flue relay join` (machine N): no CF token, no deploy. Writes relay.json
  with the given origin and secret and a fresh machine id; the daemon dials
  `/daemon/<id>`. Re-running `setup` remains an upsert and re-uploads the
  secret from relay.json when present.

### Pairing and the picker

Pairing is per machine, once per browser profile — that is Noise identity,
not a limitation to engineer around. The QR / pair URL gains the machine id:
`https://<relay>/#pair&d=<machine-id>&code=<one-time>`. A successful pairing
stores `{machine id, name, pinned static key}` under the machine id. The
picker at the relay door renders that list; selecting a machine dials
`/client/<id>` and handshakes against that machine's pinned key. After pairing
machine A, the picker's empty-slot copy points the user at the next machine
("open flue on that machine, tap Pair") — discovery is handled by copy, not
by anyone vouching for keys. Machines could vouch for each other over the
shared secret, and must not: it would silently turn "I paired with A" into
"I trust A with access to B".

Phones never "join" (joining is a daemon act); they pair, one scan per
machine, one time each.

### Sessions view

v1: pick a machine, connect, see that machine's sessions live from its daemon
(attach and replay exactly as today; the daemon is the source of truth). An
all-machines-at-once dashboard is N concurrent clients when someone wants it —
no architecture change, deferred.

## What is deleted

- `app/` — routes, server functions, D1, migrations, tests, wrangler config
- `internal/controlplane/`, `cmd/flue/link.go` and its tests, the flue.sh
  enrolment fields and reachability wording in `internal/config/relay.go`
- relay: `channel-auth.ts`, `RELAY_SIGNING_SECRET` handling, `saas-*.test.ts`,
  the `saas` vitest project (one project remains)
- web: the channel-token refresh path (`/api/relay-token` client), the
  fragment handoff (`takeRelayHandoff`); per-device pinning stays
- docs: `SAAS.md`; FOLLOW-UPS entries that exist only to serve the SaaS
- Makefile `app` / `test-app` targets and their CI wiring
- `site/` **stays**: flue.sh landing page with instructions (pretty pass and
  video later, out of scope here)

## Migration order

Cleanup first; each step lands green on main before the next starts.

1. **The big delete** — everything listed above; suites and CI stay green.
2. **Relay id-routing** — router + updated tests, plus a new isolation test:
   a client on `/client/A` must never reach machine B's hub.
3. **Daemon side** — relay.json gains id and name, the transport dials
   `/daemon/<id>`, `flue relay join` exists, setup prints the join line.
4. **Web** — the picker route over pairing records; pair URLs carry the
   machine id; handoff/refresh remnants deleted.
5. **Docs** — README and RELAY.md rewritten for multi-machine; the release
   gate gains: second machine joins the same worker, the phone pairs both,
   the picker switches between them, the isolation test's claim is exercised
   by hand.

## Testing

The crown jewels — relay hub tests, web terminal/Noise/reconnect suites — are
untouched by design. Go loses only the controlplane tests. New coverage:
router isolation (above), `relay join` (config written, no deploy attempted),
picker records (store, render, select, forget). The manual release gate in
RELAY.md remains the human bar for a real Worker, a real subdomain, and a
phone on cellular.
