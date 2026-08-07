# OSS-only Phases 2–5: One Relay, Many Machines — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One relay Worker per Cloudflare account fronts many machines — id-routed hubs, `flue relay join`, a machine picker in the web UI, and docs that describe it.

**Architecture:** Spec is `docs/superpowers/specs/2026-08-07-flue-oss-only-design.md` (read its "Architecture" section before any task). Machine id in the path selects the Durable Object; hub internals never change. The machine list lives in the browser (pairing records), never on a server. Each task lands green on main before the next starts.

**Tech Stack:** Go 1.26, TypeScript (Workers + React 19), vitest 4, pnpm via mise (`mise exec --` when the shell lacks activation).

## Global Constraints

- Every task ends with the touched package's `pnpm test`/`go test ./...` AND `make lint` green, then a commit. Repo commit style: narrative subjects (`fix(web): a channel that flaps…`), `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer, no other AI attribution.
- pnpm always, never npm/npx. Node is mise-pinned; prefix with `mise exec --` if `node --version` ≠ 24.x.
- **Machine id format (spec-fixed):** lowercase slug, regex `^[a-z0-9][a-z0-9-]{0,62}$`, minted as `<hostname sanitized to the regex, truncated to 24>-<4 random lowercase hex>`. Display name is free text ≤ 64 runes, never in a URL path.
- **Paths (spec-fixed):** `wss /daemon/<machine-id>` (Bearer DAEMON_SECRET), `wss /client/<machine-id>` (credential-less), `POST /api/pair/<machine-id>`. No id-less compatibility routes — pre-release.
- Hub logic (`relay/src/hub.ts`) is not modified by any task.
- Per-device key pinning (`web/src/crypto/keys.ts`, `savePinnedDaemonKeyFor`/`loadPinnedDaemonKeyFor`) is the storage for machine keys — do not add a parallel key store.
- Do not touch the client backoff timings in `web/src/client/client.ts` or its tests.

---

### Task 1: Relay routes by machine id

**Files:**
- Modify: `relay/src/index.ts` (router), `relay/wrangler.jsonc` (`run_worker_first`), `relay/test/routing.test.ts`, `relay/test/harness.ts`, `relay/test/hub.test.ts`, `relay/test/pair.test.ts`, `relay/test/frame.test.ts` (only if it dials paths)

**Interfaces:**
- Consumes: current `fetch` router (`/daemon`, `/client`, `/api/pair`), `authorizeDaemon(req, env): boolean`.
- Produces: `machineIdFrom(pathname: string, prefix: string): string | null` exported from `relay/src/index.ts` — returns the id when the path is exactly `<prefix>/<id>` and the id matches `^[a-z0-9][a-z0-9-]{0,62}$`, else null. Router: `/daemon/<id>` → authorize then `env.HUB.get(env.HUB.idFromName(id)).fetch(req)`; `/client/<id>` same without auth; `POST /api/pair/<id>` same without auth; everything else → `env.ASSETS.fetch(req)`. A bad or missing id on those prefixes → `404` JSON `{"error":"no such machine"}` (not a fall-through to assets).

- [ ] **Step 1: Write the failing router tests** — in `relay/test/routing.test.ts`: `/daemon/alpha-1a2b` with the bearer upgrades (101 via hub); `/daemon` alone and `/daemon/UPPER` and `/daemon/a/b` answer 404; `/client/alpha-1a2b` reaches a hub; **isolation**: dial a daemon to `/daemon/alpha-1a2b`, then `GET /client/beta-9f8e` with Upgrade — expect the *offline* answer (no daemon on that hub), proving `beta-9f8e` did not land on alpha's DO; unit-test `machineIdFrom` on: valid, empty, uppercase, 65-char, trailing-slash, embedded-slash.
- [ ] **Step 2: Run to verify failures** — `cd relay && pnpm vitest run test/routing.test.ts`; expect the new cases to fail against the id-less router.
- [ ] **Step 3: Implement the router** — per Produces above; update `wrangler.jsonc` `run_worker_first` to `["/daemon/*", "/client/*", "/api/*"]`.
- [ ] **Step 4: Update the harness** — `relay/test/harness.ts` `dial(stub, path)` callers currently pass `/daemon` and `/client`; route the whole suite through one exported `MACHINE = 'test-machine-0a1b'` constant so hub/pair tests dial `/daemon/${MACHINE}` etc. Grep for literal `'/daemon'`/`'/client'`/`'/api/pair'` across `relay/test/` and update every dial.
- [ ] **Step 5: Full relay suite green** — `pnpm test && pnpm lint`.
- [ ] **Step 6: Commit** — subject: `feat(relay): a machine id in the path picks the hub`.

---

### Task 2: The daemon dials its id; `flue relay join` exists

**Files:**
- Modify: `internal/config/relay.go` (+test), `internal/transport/relay/relay.go` (dial URL; +test), `cmd/flue/relay.go` (setup: mint id/name, print join line; join subcommand registration), `cmd/flue/main.go` (usage + dispatch), `internal/daemon` welcome payload (`RelayInfo` — find via `grep -rn 'RelayInfo' internal/ web/src/client/protocol.ts`)
- Create: nothing new — join lives in `cmd/flue/relay.go`

**Interfaces:**
- Consumes: Task 1's `/daemon/<id>` route; `config.Relay{URL, Origin, Secret}`.
- Produces:
  - `config.Relay` gains `MachineID string \`json:"machine_id"\`` and `MachineName string \`json:"machine_name"\``.
  - `config.MintMachineID(hostname string, rand io.Reader) string` — the Global Constraints format; unit-tested for the regex, truncation, and sanitation (spaces/dots → `-`, everything else dropped, lowercased).
  - Transport: `relay.Config` gains `MachineID string`; `New` refuses an empty one (`ErrIncompleteConfig`: "no machine id"); the dial URL becomes `<cfg.URL host>/daemon/<id>` — the URL in relay.json stays the bare origin-shaped `wss://…` WITHOUT the path; the transport appends `/daemon/<id>` itself. Migration note for setup: it previously stored `…/daemon` — setup now writes the bare `wss://<host>` and join does the same.
  - `flue relay setup`: after deploy, mints id+name (name = raw hostname), saves them in relay.json, and prints exactly one line the user copies to other machines: `flue relay join wss://<host> --secret <secret>`.
  - `flue relay join <url> --secret <s> [--name <label>]`: no Cloudflare API calls; validates the URL is `wss://` or `https://` (normalize https→wss), derives Origin the way setup does, mints a fresh id, writes relay.json 0600. Errors on missing url/secret name the flag.
  - Daemon welcome: `RelayInfo` (Go and `web/src/client/protocol.ts`) gains `machineId` and `machineName` strings, filled from relay.json when a relay is configured — the web pair-URL builder (Task 3) reads them.
- [ ] **Step 1: Failing tests** — config: round-trip with the two new fields; `MintMachineID("Karn's MacBook Pro.local", fixedRand)` pins an exact expected slug. Transport: `New` with no MachineID errors; the fake-server test asserts the dial path is `/daemon/<id>`. relay cmd: join writes a relay.json whose fields match; setup's printed join line contains the exact url+secret (existing setup tests show the fake CF server pattern — extend them).
- [ ] **Step 2: Run, verify failures.**
- [ ] **Step 3: Implement** per Produces.
- [ ] **Step 4: `go test ./... && make lint` green** (web lint included — protocol.ts changed).
- [ ] **Step 5: Commit** — subject: `feat(flue): machines join the relay by name`.

---

### Task 3: The web UI picks a machine

**Files:**
- Create: `web/src/relay/machines.ts` (+ `machines.test.ts`) — pairing records
- Modify: `web/src/relay/socket.ts` (+test: client URL carries id), `web/src/main.tsx` (relay boot: selected machine → identity), `web/src/routes/pair.tsx` (+test: id in URL, record saved), `web/src/routes/unpaired.tsx` → becomes/feeds the picker (check `grep -rn 'unpaired' web/src`), router registration for a `/machines` picker route, and the daemon-side pair-URL builder (find via `grep -rn 'pairing' web/src/routes/devices.tsx` — it builds the QR link from `RelayInfo`)

**Interfaces:**
- Consumes: Task 2's `RelayInfo.machineId/machineName`; `savePinnedDaemonKeyFor(id, key)` / `loadPinnedDaemonKeyFor(id)`; Task 1's `/client/<id>` and `/api/pair/<id>`.
- Produces:
  - `machines.ts`: `interface MachineRecord { id: string; name: string; pairedAt: number }`; `listMachines(): MachineRecord[]`, `saveMachine(rec)`, `forgetMachine(id)` — localStorage key `flue.machines`, JSON array, corrupt data → `[]`. `forgetMachine` also deletes the pinned key record for that id.
  - Pair URL grows two query params beside the existing token/key: `d=<machine id>` and `n=<display name, encodeURIComponent>`. `pair.tsx` reads them; posts to `/api/pair/${d}` (a missing/invalid `d` renders the expiry-note failure, no post); on success pins under `d` via `savePinnedDaemonKeyFor` and `saveMachine({id: d, name: n || d, pairedAt: Date.now()})`. Self-host single-key `savePinnedDaemonKey` path stays for the daemon-door pair flow (loopback) — branch on `isRelayOrigin()`.
  - `relaySocket(origin, identity, machineId, …)`: `clientUrl` becomes `/client/<machineId>`; machineId is a new required third parameter (tests updated).
  - Boot (`main.tsx`): on a relay origin, the picker route is home when no machine is selected; selecting stores `flue.machine.selected` in sessionStorage and builds the client with that machine's pinned key + id. One machine paired → auto-select it. Zero → picker's empty state (the old unpaired explainer copy, plus "open flue on that machine, tap Pair").
  - Picker route lists `listMachines()` with name, id, a Connect action, and a Forget action (confirm-less; forgetting the selected machine returns to the picker).
- [ ] **Step 1: Failing tests** — `machines.test.ts` (round-trip, corrupt JSON → [], forget removes pin too — stub the key store the way `mode.test.ts` does with `IDBFactory`); `socket.test.ts` URL assertions become `/client/test-machine-0a1b`; `pair.test.tsx`: URL without `d` → failure copy, with `d`+`n` → posts to `/api/pair/<d>`, pins under `d`, record saved; picker: two records render two rows, selecting builds a client against that id (mock via router options), empty state shows pair guidance.
- [ ] **Step 2: Run, verify failures.**
- [ ] **Step 3: Implement.** Follow the repo's shadcn + zinc/teal conventions for the picker (see `web/src/routes/remote.tsx` for card/empty-state idiom; accent only via `--primary`).
- [ ] **Step 4: `pnpm test && pnpm lint` green.**
- [ ] **Step 5: Commit** — subject: `feat(web): the relay door opens on a machine picker`.

---

### Task 4: Docs tell the multi-machine story

**Files:**
- Modify: `README.md`, `docs/RELAY.md`, `docs/faq.md` (only where it describes one-machine relays), `site/` landing copy IF it names commands (grep `flue link|relay setup` under `site/src` — fix strays only)

**Interfaces:**
- Consumes: Tasks 1–3 as shipped (verify claims against the code, not this plan).

- [ ] **Step 1: README** — rewrite the remote-access section: one relay per account, `flue relay setup` on the first machine, the printed `flue relay join` line on the rest, one URL + picker, pairing once per machine per browser. Update the CLI block (add `flue relay join`), the status quote (drop "not yet open" SaaS残 if any), and the layout paragraph if stale. Keep the honest served-code-MITM paragraph as is.
- [ ] **Step 2: RELAY.md** — protocol-in-one-page gains the `<machine-id>` path segment and one-DO-per-machine sentence; "Standing one up" gains the join flow; the **shared-secret honest limit** from the spec (compromised machine can dial a sibling's DO; upgrade path deferred) gets its own short section; the release-gate checklist gains: second machine joins the same Worker, phone pairs both, picker switches between them, and a hand-run isolation check (client path for machine A answered offline when only B's daemon is up).
- [ ] **Step 3: Sweep** — `grep -rn 'flue link\|app\.flue\.sh\|control plane' README.md docs/ site/ spec/ --include='*.md' | grep -v superpowers | grep -v FOLLOW-UPS` must return nothing; `spec/relay-protocol.md` Auth section gains the machine-id path (one paragraph, match its voice).
- [ ] **Step 4: `make lint test` green** (nothing should change, prove it), commit — subject: `docs: the relay fronts every machine you own`.
