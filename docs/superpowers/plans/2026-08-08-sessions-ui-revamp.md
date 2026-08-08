# Sessions UI Revamp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Linear-style sessions table aggregating every paired machine, with naming, tagging, pinning, live cwd, grouping/sorting/search, bulk actions, saved views, and a shared page header.

**Architecture:** Daemon grows session metadata (`name`/`tags`/`pinned`/`createdAt`), a live-cwd read, one new wire message `update`, and per-session JSON meta persistence. The web app grows a `FleetClient` that opens one `FlueClient` per paired machine and merges their session lists, plus a rewritten sessions route built from pure view-model functions.

**Tech Stack:** Go daemon (`internal/session`, `internal/wire`, `internal/daemon`), React 19 + TS + Tailwind v4 + shadcn (radix-nova, zinc/teal), TanStack Router, vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-08-08-sessions-ui-revamp-design.md` — read it first.

## Global Constraints

- Neutral is zinc, accent is teal; teal only on active nav, focus rings, and the single primary button per screen (`web/src/styles.css:87-102`).
- Dark mode is `prefers-color-scheme` only. Never introduce `.dark` class or `@custom-variant dark`; `web/src/styles.build.test.ts` fails the build if shadcn re-adds it.
- Tailwind class strings must be literal and hyphenated inside `className`/`cn(...)` — never assembled from constants (`web/src/styles.css:52-85` explains; `styles.build.test.ts` enforces).
- Sentence case for all headings/labels ("New session", not "New Session"). Existing tests assert this.
- No new mutating HTTP endpoints; mutations are WebSocket-only (`internal/daemon/server.go` methodPolicy + `TestNoStateChangeIsReachableByGET`).
- Wire changes must update the shared golden fixture `testdata/wire/control.json` and `spec/protocol.md`; Go and TS codec suites both decode the fixture.
- Match house comment style: comments explain constraints and reasoning, not mechanics. Don't strip existing comments.
- Commit after every task. Commit messages: conventional commits, subject ≤ 50 chars, trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Test commands: Go `go test ./internal/...`; web `cd web && pnpm test` (targeted: `pnpm test -- src/path/file.test.ts`); everything `make test` (needs `make web` first for embed).

---

## Phase 1 — daemon metadata + live cwd

### Task 0: Worktree setup + baseline

**Files:** none (setup only)

- [ ] **Step 1: Install web deps**

Run: `cd web && pnpm install`

- [ ] **Step 2: Baseline tests**

Run: `go test ./internal/... && cd web && pnpm test`
Expected: all pass. If not, STOP and report — dirty baseline.

### Task 1: session.Info metadata fields + ApplyMeta

**Files:**
- Modify: `internal/session/session.go` (Info struct ~line 53, Session methods)
- Modify: `internal/session/registry.go` (`start` seeds fields ~line 179; new `UpdateMeta`)
- Test: `internal/session/meta_test.go` (create)

**Interfaces (later tasks rely on these exactly):**

```go
// session.go additions to Info:
Name      string    `json:"name"`
Tags      []string  `json:"tags"`
Pinned    bool      `json:"pinned"`
CreatedAt time.Time `json:"createdAt"`

// MetaPatch is a partial update: nil means "leave unchanged".
type MetaPatch struct {
	Name   *string
	Tags   *[]string
	Pinned *bool
}

func (s *Session) ApplyMeta(p MetaPatch) Info      // normalizes tags, returns fresh snapshot
func normalizeTags(tags []string) []string          // trim, drop empties, dedupe, sort; never nil

// registry.go:
var ErrNotFound = errors.New("session: not found")
func (r *Registry) UpdateMeta(id string, p MetaPatch) (Info, error) // ErrNotFound on unknown id
```

- [ ] **Step 1: Write failing tests** in `internal/session/meta_test.go`:

```go
func TestSpawnStampsCreatedAtAndEmptyTags(t *testing.T) {
	// Registry with a fixed clock (see clock use in registry_test.go for the
	// house pattern). Spawn; Info().CreatedAt equals the clock's time,
	// Info().Tags is non-nil and empty, Name "" and Pinned false.
}
func TestApplyMetaPartialUpdate(t *testing.T) {
	// ApplyMeta with only Name set changes Name and nothing else; a second
	// call with only Pinned flips Pinned and keeps the Name.
}
func TestApplyMetaNormalizesTags(t *testing.T) {
	// Tags []string{" b ", "a", "b", ""} store as []string{"a", "b"}.
}
func TestUpdateMetaUnknownID(t *testing.T) {
	// Registry.UpdateMeta("nope", ...) returns ErrNotFound.
}
func TestCreatedAtSurvivesConcurrentInfo(t *testing.T) {
	// go vet -race covers this; simple parallel ApplyMeta + Info loop.
}
```

Write real assertions, not the comments above — they describe the behavior.

- [ ] **Step 2: Run, verify FAIL** (`go test ./internal/session/ -run 'Meta|CreatedAt' -v`)
- [ ] **Step 3: Implement.** In `start()` (registry.go ~179) seed `CreatedAt: r.clock()`, `Tags: []string{}` in the Info literal. `ApplyMeta` takes `s.mu`, applies non-nil fields (tags through `normalizeTags`), returns `s.info`. `UpdateMeta` = `Get` + `ApplyMeta`, `ErrNotFound` when absent. `normalizeTags`: `strings.TrimSpace` each, skip empties, dedupe via map, `sort.Strings`, return `[]string{}` for none.
- [ ] **Step 4: Run tests + race** (`go test ./internal/session/ -race`) — PASS
- [ ] **Step 5: Commit** `feat(session): name, tags, pinned, createdAt metadata`

### Task 2: Live cwd

**Files:**
- Create: `internal/session/cwd_linux.go`, `internal/session/cwd_darwin.go`
- Modify: `internal/session/session.go` (`Info()` ~line 153; Session struct field; `start` wiring in registry.go)
- Test: `internal/session/cwd_test.go` (create)

**Interfaces:**

```go
// Both files implement, per platform:
func processCwd(pid int) (string, error)
// Session gains field: cwdOf func(pid int) (string, error)   — set to processCwd in start(); tests may swap per-session before use.
```

`Info()` becomes: read `s.cwdOf(s.pid)` BEFORE taking `s.mu` (house rule: s.mu is never held across a syscall unless it cannot block; keep this one outside for free); under the lock, if the read succeeded and `s.info.State == "running"`, store it in `s.info.Cwd`; return the snapshot. A failed read keeps the previous value — never blanks it. Exited sessions keep last known cwd.

- Linux: `os.Readlink(fmt.Sprintf("/proc/%d/cwd", pid))`.
- Darwin: `proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, ...)` via raw `syscall.Syscall6` on `SYS_PROC_INFO` (no cgo, no new dep — `golang.org/x/sys` is already in go.mod if needed for constants). Verify the constants against xnu's `sys/proc_info.h`: callnum `PROC_INFO_CALL_PIDINFO = 0x2`, flavor `PROC_PIDVNODEPATHINFO = 9`; the result struct's current-dir path is the `vip_path` (1024 bytes) inside the first `vnode_info_path`. Do NOT trust these numbers from this plan — read the header on the machine (`xcrun --show-sdk-path`, then `sys/proc_info.h`) and cite the offsets in a comment. The test below is what proves them.

- [ ] **Step 1: Write failing test** in `cwd_test.go`:

```go
func TestProcessCwdReportsSpawnDir(t *testing.T) {
	// t.TempDir(); spawn a real session with Cwd set to it (the suite already
	// spawns real PTYs — follow session_test.go patterns); poll
	// processCwd(pid) until it equals the temp dir (resolve symlinks with
	// filepath.EvalSymlinks on both sides — /tmp is a symlink on darwin).
}
func TestInfoTracksCd(t *testing.T) {
	// Spawn `sh` in dir A; s.Write([]byte("cd <dirB>\n")); poll s.Info().Cwd
	// until dirB (EvalSymlinks both sides; deadline ~5s).
}
func TestInfoKeepsCwdWhenReadFails(t *testing.T) {
	// Swap s.cwdOf for one returning an error; Info().Cwd unchanged.
}
```

- [ ] **Step 2: Run, verify FAIL** (compile error: processCwd undefined)
- [ ] **Step 3: Implement** both platform files + Info() change + `cwdOf: processCwd` in `start()`.
- [ ] **Step 4: Run** `go test ./internal/session/ -race -run Cwd` — PASS on this darwin machine (linux path exercised in CI).
- [ ] **Step 5: Commit** `feat(session): report the PTY child's live cwd`

### Task 3: Meta persistence files

**Files:**
- Create: `internal/session/meta.go`
- Modify: `internal/session/registry.go` (Registry struct, `UpdateMeta`, `Reap`)
- Modify: `cmd/flue/main.go` (wire the dir; snapshots dir is set up ~line 351 — meta shares `<configDir>/sessions`)
- Test: `internal/session/meta_file_test.go` (create)

**Interfaces:**

```go
// meta.go
type Meta struct {
	V      int      `json:"v"`      // 1
	Name   string   `json:"name"`
	Tags   []string `json:"tags"`
	Pinned bool     `json:"pinned"`
}
func SaveMeta(dir, id string, m Meta) error   // atomic write to <id>.meta.json, 0600 in 0700 dir, temp+rename like writeSnapshot
func LoadMetas(dir string) map[string]Meta    // all *.meta.json; unparseable files deleted and skipped
func DeleteMeta(dir, id string)               // idempotent

// registry.go
func (r *Registry) SetMetaDir(dir string)     // "" (the default) disables persistence — tests and `flue open` without config stay file-free
```

Behavior: `UpdateMeta` flushes `SaveMeta` after a successful `ApplyMeta` when metaDir is set; a write error is logged (bring a `*slog.Logger` in via `SetMetaDir(dir string, log *slog.Logger)` — follow how server.go carries its logger) and the in-memory update stands (spec: durability degrades, function does not). `Reap` calls `DeleteMeta` for each victim after Close. At boot (main.go, after `LoadAndClearSnapshots`/revive): `LoadMetas`, apply each to its revived session via `UpdateMeta`, then `DeleteMeta` any id with no live session (orphans from a crash).

Note: meta files use the same dir as snapshots (`<id>.meta.json` vs `<id>.json`). `LoadAndClearSnapshots` filters `.json` suffix — it would eat `.meta.json` too. Guard it: skip names ending `.meta.json` there, and add a regression test for that in `meta_file_test.go`.

- [ ] **Step 1: Failing tests** in `meta_file_test.go`: save/load roundtrip; load deletes corrupt file; delete idempotent; `UpdateMeta` writes the file (temp dir registry); `Reap` removes it; `LoadAndClearSnapshots` leaves `.meta.json` files alone; boot-orphan cleanup helper (exported as `func (r *Registry) AdoptMetas(dir string) `— loads, applies to live sessions, deletes orphans; main.go calls this).
- [ ] **Step 2: Run, verify FAIL**
- [ ] **Step 3: Implement** (`writeSnapshot` at snapshot.go:112 is the atomic-write pattern to copy; 0600/0700, temp+rename).
- [ ] **Step 4: Run** `go test ./internal/session/ -race` — PASS
- [ ] **Step 5: Wire main.go**: after the revive loop, `reg.SetMetaDir(dir, logger)` then `reg.AdoptMetas(dir)`. Build: `go build ./...`.
- [ ] **Step 6: Commit** `feat(session): persist metadata as per-session meta files`

### Task 4: Snapshots carry metadata

**Files:**
- Modify: `internal/session/snapshot.go` (Snapshot struct :21, `Snapshot()` :40, `Revive` :76, and `start` param threading in registry.go)
- Test: extend `internal/session/snapshot_test.go`

Snapshot gains `Name string`, `Tags []string`, `Pinned bool`, `CreatedAt time.Time` (json: `name`, `tags`, `pinned`, `createdAt`). `Session.Snapshot()` copies them from `s.info`. `Revive` must put them back: extend `start`'s revival parameters — today `start(opts, id, preload, title)`; change to `start(opts SpawnOpts, id string, preload []byte, restore Info)` where restore carries Title, Name, Tags, Pinned, CreatedAt (zero CreatedAt means "stamp now" — the Spawn path). This removes the growing positional-arg list; `Spawn` passes `Info{}`.

- [ ] **Step 1: Failing test**: snapshot → JSON roundtrip → `Revive` → `Info()` shows same name/tags/pinned/createdAt (and still same id/title; cwd fallback behavior untouched).
- [ ] **Step 2: Run, FAIL**
- [ ] **Step 3: Implement** (struct fields, Snapshot(), start signature, Revive, Spawn call site).
- [ ] **Step 4: Run** `go test ./internal/session/ -race` — PASS
- [ ] **Step 5: Commit** `feat(session): snapshots carry session metadata`

### Task 5: wire.Update + Sessions null fix

**Files:**
- Modify: `internal/wire/control.go`
- Modify: `testdata/wire/control.json` (golden fixture — add entries)
- Modify: `spec/protocol.md` (message table ~lines 22-52; document `update`)
- Test: extend `internal/wire/control_test.go`

**Interfaces:**

```go
// C→S. Partial: nil field means unchanged. Pointer-to-slice so "clear all
// tags" ([]) and "leave tags alone" (absent) stay distinct on the wire.
type Update struct {
	ID     string    `json:"id"`
	Name   *string   `json:"name,omitempty"`
	Tags   *[]string `json:"tags,omitempty"`
	Pinned *bool     `json:"pinned,omitempty"`
}
```

Register in `typeName` (`"update"`), `DecodeControl` (both the switch case and the deref list). Also: give `Sessions` the `DeviceList` treatment — a `MarshalJSON` that writes nil `Sessions` as `[]` (copy the alias pattern at control.go:178, adapt the comment; this closes docs/FOLLOW-UPS.md:197 — delete that entry).

Fixture entries to append (exact JSON the codecs must agree on):

```json
{"type":"update","id":"a1b2c3d4e5f60708","name":"api server"}
{"type":"update","id":"a1b2c3d4e5f60708","tags":["api","feat-x"],"pinned":true}
{"type":"update","id":"a1b2c3d4e5f60708","tags":[]}
```

plus a `sessions` entry whose one session carries the four new Info fields (`"name":"api server","tags":["api"],"pinned":false,"createdAt":"2026-08-08T10:00:00Z"`). Follow the fixture file's existing shape exactly (look at it first — entries pair a name with the JSON).

- [ ] **Step 1: Failing tests**: encode/decode roundtrip for Update (all-fields, name-only, empty-tags — assert `*m.Tags` is empty non-nil); `Sessions{}` marshals with `"sessions":[]`; fixture decode covers new entries.
- [ ] **Step 2: Run, FAIL**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run** `go test ./internal/wire/` — PASS. Then `cd web && pnpm test -- src/client` — the TS fixture test will now FAIL on the unknown `update` type. That failure is Task 7's starting point; note it, don't fix here.
- [ ] **Step 5: Update `spec/protocol.md`** message table + a short `update` section (partial semantics, answered by `sessions` or `error not_found`).
- [ ] **Step 6: Commit** `feat(wire): update message and non-null sessions list`

### Task 6: Daemon handles update

**Files:**
- Modify: `internal/daemon/conn.go` (`handleControl` ~line 401; extract the List body)
- Test: extend `internal/daemon/conn_test.go` (find the existing List/Spawn handler tests and follow their harness)

Extract the `wire.List` case body into `func (c *conn) sendSessions()`, then:

```go
case wire.Update:
	if _, err := c.srv.reg.UpdateMeta(m.ID, session.MetaPatch{
		Name: m.Name, Tags: m.Tags, Pinned: m.Pinned,
	}); err != nil {
		c.sendError("not_found", "no such session")
		return
	}
	c.sendSessions()
```

- [ ] **Step 1: Failing tests**: `update` on a live session answers a `sessions` frame reflecting the change; unknown id answers `error not_found`; a rename is visible to a *second* connection's next `list` (cross-browser sync path).
- [ ] **Step 2: Run, FAIL**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run** `go test ./internal/daemon/ -race` — PASS; full `go test ./internal/...` — PASS
- [ ] **Step 5: Commit** `feat(daemon): apply session metadata updates`

## Phase 2 — TS protocol + client

### Task 7: protocol.ts mirrors

**Files:**
- Modify: `web/src/client/protocol.ts` (SessionInfo :77, ClientMessage union :196)
- Test: the existing fixture test (find it: `grep -rl control.json web/src`) goes green; extend decode assertions.

`SessionInfo` gains `name: string`, `tags: string[]`, `pinned: boolean`, `createdAt: string` (RFC 3339 comment like `lastActive`). New:

```ts
/**
 * Partial metadata update. An absent field is unchanged; `tags: []` clears.
 * Mirrors wire.Update. Answered by a fresh `sessions`, or `error not_found`.
 */
export interface UpdateMsg {
  type: 'update'
  id: string
  name?: string
  tags?: string[]
  pinned?: boolean
}
```

Add to `ClientMessage` union. Update the "All nine fields" comment (thirteen now).

- [ ] **Step 1: Run the fixture test, verify the Task-5 FAIL reproduces**
- [ ] **Step 2: Implement; extend assertions for the new fixture entries**
- [ ] **Step 3: Run** `cd web && pnpm test -- src/client` — PASS
- [ ] **Step 4: Commit** `feat(web): mirror session metadata in the protocol`

### Task 8: FlueClient.update

**Files:**
- Modify: `web/src/client/client.ts` (next to `list()` :384)
- Test: extend `web/src/client/client.test.ts` (follow `list`'s test)

```ts
/** Ask the daemon to update a session's metadata. Answered by `sessions`. */
update(patch: { id: string; name?: string; tags?: string[]; pinned?: boolean }): void
```

Sends `{ type: 'update', ...patch }` via the same send path `list()` uses (buffered/dropped identically when not open — copy list's discipline exactly).

- [ ] **Step 1: Failing test**: `update({id, name})` sends the exact frame; a clear (`tags: []`) keeps the empty array.
- [ ] **Step 2-4: FAIL → implement → PASS** (`pnpm test -- src/client`)
- [ ] **Step 5: Commit** `feat(web): client sends metadata updates`

## Phase 3 — fleet

### Task 9: FleetClient

**Files:**
- Create: `web/src/fleet/fleet.ts`, `web/src/fleet/types.ts`
- Test: `web/src/fleet/fleet.test.ts` (create)

**Interfaces (UI tasks consume these exactly):**

```ts
// types.ts
import type { SessionInfo } from '@/client/protocol'
export type MachineStatus = 'connecting' | 'online' | 'unreachable'
export interface FleetSession extends SessionInfo { machineId: string; machineName: string }
export interface MachineState { id: string; name: string; status: MachineStatus }
export const LOCAL_MACHINE_ID = 'local'

// fleet.ts
export interface FleetSource { id: string; name: string; client: FlueClient }
export class FleetClient {
  constructor(sources: FleetSource[])
  connect(): void
  close(): void
  /** Fires on any change: merged sessions (stamped) + machine statuses. */
  onFleet(cb: (sessions: FleetSession[], machines: MachineState[]) => void): () => void
  clientFor(machineId: string): FlueClient | null
  list(): void                                   // ask every online source
  update(machineId: string, patch: { id: string; name?: string; tags?: string[]; pinned?: boolean }): void
  spawnOn(machineId: string, opts: { cwd?: string; cmd?: string[]; cols: number; rows: number }): number | null
}
export function fleetSources(opts: {
  loopback: boolean                              // serve /ws on this origin?
  relayOrigin: string | null                     // where remote slots dial; null = none known
  wsFactory?: (url: string) => RawSocket         // test seam, as relayBoot's
}): Promise<FleetSource[]>
```

`fleetSources`: when `loopback`, a source `{id: LOCAL_MACHINE_ID, name: hostname-from-welcome-later, client: new FlueClient(daemonSocketUrl())}`. For each `listMachines()` record with a pinned key (`loadPinnedDaemonKeyFor`), when `relayOrigin` is known: `new FlueClient(relayOrigin, (o) => relaySocket(o, identity, record.id, wsFactory))` — exactly `relayBoot`'s construction (`web/src/relay/boot.ts:50-55`). Records without keys are skipped. On a relay-served tab `loopback` is false and `relayOrigin` is `location.origin`; on a loopback tab `relayOrigin` starts null and the fleet learns it from the local daemon's `welcome.relay.origin` — FleetClient re-runs source construction when that welcome arrives (`onWelcome`).

Dedup: when the loopback source's `welcome.relay.machineId` matches a remote record, drop (close) that remote source — loopback wins; its display name becomes `welcome.relay.machineName ?? welcome.host`.

Status: `connecting` until first `onStatus('open')` + welcome; `open` → `online`; `reconnecting`/`closed` → `unreachable`. Merged sessions: per-source latest `onSessions` payload, stamped, concatenated; a source going unreachable drops its rows (spec: no stale cache v1). Polling: FleetClient owns one 3s interval, calls `list()` on every online source, staggered by index*150ms; `use-refetch-on-focus` stays the route's job.

- [ ] **Step 1: Failing tests** (scripted `FlueClient`-shaped fakes — constructor takes sources, so tests inject fakes directly; no sockets): merge stamps machineId/name; a source's fresh `sessions` replaces only its own rows; unreachable drops rows and reports status; dedup closes the relay twin when loopback welcome names it; `update`/`spawnOn` route to the right source's client; `clientFor('nope')` → null; unsubscribe stops callbacks.
- [ ] **Step 2-4: FAIL → implement → PASS** (`pnpm test -- src/fleet`)
- [ ] **Step 5: Commit** `feat(web): fleet client aggregates paired machines`

### Task 10: Fleet provider + terminal routing

**Files:**
- Create: `web/src/fleet/provider.tsx` (`FleetProvider`, `useFleet()` — model on `web/src/client/provider.tsx` exactly: injectable for tests, connect on mount, close on unmount, StrictMode-safe)
- Modify: `web/src/router.tsx` (mount FleetProvider where FlueClientProvider mounts; terminal route :176)
- Modify: `web/src/routes/terminal.tsx` (resolve the machine's client via `useFleet().clientFor($deviceId)`; `local` keeps today's behavior)
- Test: `web/src/fleet/provider.test.tsx` (create), extend `web/src/router.test.tsx`

Terminal behavior: `/d/local/s/<id>` must work exactly as today (existing tests prove it). `/d/<machineId>/s/<id>` for an unknown/keyless machine renders the terminal's existing error/empty treatment with copy `Machine not paired on this browser` — look at how terminal.tsx handles a missing session and match it.

- [ ] **Step 1: Failing tests**: provider builds one fleet, StrictMode double-mount leaves one; terminal with machineId routes through `clientFor`; unknown machine shows the copy above.
- [ ] **Step 2-4: FAIL → implement → PASS**
- [ ] **Step 5: Run full web suite** `pnpm test` — existing terminal/router tests still green.
- [ ] **Step 6: Commit** `feat(web): fleet provider and per-machine terminal routing`

## Phase 4 — UI foundation

### Task 11: shadcn primitives

**Files:**
- Create: `web/src/components/ui/dropdown-menu.tsx`, `popover.tsx`, `select.tsx`, `checkbox.tsx`, `dialog.tsx`
- Test: `pnpm test -- src/styles.build.test.ts` must stay green

- [ ] **Step 1:** `cd web && pnpm dlx shadcn@latest add dropdown-menu popover select checkbox dialog`
- [ ] **Step 2:** `git diff web/src/styles.css web/components.json` — revert ANY change to `styles.css` (the generator likes to re-add `@custom-variant dark`). Only the five component files may land.
- [ ] **Step 3:** Run `pnpm test -- src/styles.build.test.ts` AND `pnpm lint` — PASS
- [ ] **Step 4:** Skim each generated file: zinc/teal tokens only (they inherit semantic vars — fine); remove any `dark:` variant classes the generator produced (grep the five files for `dark:`).
- [ ] **Step 5: Commit** `feat(web): add table interaction primitives`

### Task 12: PageHeader

**Files:**
- Create: `web/src/components/page-header.tsx`
- Modify: `web/src/components/app-shell.tsx` (:35-38 bare bar), `web/src/routes/sessions.tsx` (:205-247 header block), `web/src/routes/devices.tsx` (:597), `web/src/router.tsx` (:127 placeholder)
- Test: `web/src/components/page-header.test.tsx` (create); existing route tests updated in place

**Interface:**

```tsx
export interface Crumb { label: string; to?: string }   // `to` absent = current page
export function PageHeader(props: {
  crumbs: Crumb[]                                        // ["Flue" wordmark is NOT a crumb; first crumb is the section]
  actions?: ReactNode                                    // right-aligned slot
  children?: ReactNode                                   // optional second row (view tabs, search) inside the header block
})
```

Renders inside each route (not AppShell — the `h-14` shell bar keeps only SidebarTrigger/Wordmark; routes own their headers, as today, just via one component). `nav aria-label="Breadcrumb"`, links via TanStack `Link`, separator `/` in `text-muted-foreground`, current crumb `aria-current="page"`. The `h1` styling moves here once — take the exact class string from sessions.tsx:208.

- [ ] **Step 1: Failing tests**: crumbs render as breadcrumb nav with aria-current on the last; actions slot renders; sentence-case heading preserved.
- [ ] **Step 2-4: FAIL → implement → PASS**
- [ ] **Step 5:** Swap sessions/devices/placeholder routes onto PageHeader (sessions keeps its blurb + live region + New session button in `actions` for now — Task 19 reworks it). Run `pnpm test` — update route tests' selectors where the DOM shifted; assertions about copy stay.
- [ ] **Step 6: Commit** `feat(web): shared page header with breadcrumbs`

## Phase 5 — sessions view

### Task 13: View-model + saved views store

**Files:**
- Create: `web/src/sessions/view.ts`, `web/src/sessions/views-store.ts`
- Test: `web/src/sessions/view.test.ts`, `web/src/sessions/views-store.test.ts`

**Interfaces (the table consumes these exactly):**

```ts
// view.ts — pure functions only, no React.
export type Grouping = 'machine' | 'state' | 'tag' | 'directory' | 'none'
export type Ordering = 'lastActive' | 'created' | 'name' | 'directory'
export type ColumnKey = 'name' | 'directory' | 'machine' | 'tags' | 'state' | 'lastActive' | 'created'
export interface ViewConfig {
  grouping: Grouping; ordering: Ordering; search: string
  columns: ColumnKey[]; showExited: boolean
}
export const DEFAULT_VIEW: ViewConfig  // grouping 'machine', ordering 'lastActive', search '', columns all but 'created', showExited true
export interface Group { key: string; label: string; sessions: FleetSession[] }

export function displayName(s: FleetSession): string          // name || title || basename(cwd) || cmd.join(' ')
export function filterSessions(list: FleetSession[], search: string): FleetSession[]
  // case-insensitive substring over displayName, cwd, tags, machineName; '' = all
export function orderSessions(list: FleetSession[], ordering: Ordering): FleetSession[]
  // pinned first always; lastActive bucketed to 30s so churn doesn't reshuffle
  // (Math.floor(Date.parse(lastActive)/30000), descending); ties and the other
  // orderings break by cwd then id — the ordered() contract, kept.
export function groupSessions(list: FleetSession[], grouping: Grouping): Group[]
  // 'tag': one group per tag, session appears in each of its tags, untagged in
  // 'No tag' last. 'directory': group by cwd. 'state': Running before Exited.
  // 'machine': by machineName. 'none': single group, key 'all'.
export function applyView(list: FleetSession[], v: ViewConfig): Group[]
  // filter (+ drop exited when !showExited) → order → group

// views-store.ts — localStorage, validated reads (machines.ts is the pattern).
export interface SavedView extends ViewConfig { name: string }
export function listViews(): SavedView[]
export function saveView(v: SavedView): void      // upsert by name
export function deleteView(name: string): void
```

- [ ] **Step 1: Failing tests** — table-driven over fixtures: displayName fallback chain (4 cases); filter hits each field; pinned-first; 30s bucketing (two sessions 5s apart same bucket → cwd tiebreak; 40s apart → recency); every grouping incl. multi-tag duplication and 'No tag' last; applyView drops exited when told; store roundtrip/corrupt/upsert/delete.
- [ ] **Step 2-4: FAIL → implement → PASS** (`pnpm test -- src/sessions`)
- [ ] **Step 5: Commit** `feat(web): sessions view model and saved views store`

### Task 14: SessionTable rewrite

**Files:**
- Rewrite: `web/src/components/session-table.tsx`
- Rewrite: `web/src/components/session-table.test.tsx`

**Interface:**

```tsx
export function SessionTable(props: {
  groups: Group[]                              // from applyView — table does no math
  columns: ColumnKey[]
  selected: ReadonlySet<string>                // keys `${machineId}/${id}`
  onToggleSelect(key: string): void
  onToggleGroup(groupKey: string): void        // collapse state lives in the route
  collapsed: ReadonlySet<string>
  onOpen(s: FleetSession): void
  onAction(action: RowAction, s: FleetSession): void
  onSpawnIn?(groupKey: string): void           // machine-grouping only: the [+]
}) 
export type RowAction = 'rename' | 'tags' | 'pin' | 'unpin' | 'close'
```

One `<table>`; group header rows are full-width `<tr>` with `<th colSpan>` (button inside toggles collapse, shows `▾/▸`, label, running/exited counts, and the `[+]` when `onSpawnIn` given). Rows: checkbox cell (visible on hover/checked — CSS `group-hover`, no JS), pin star when pinned, then cells per `columns` order. Name cell: displayName + muted mono cmd subtitle. Tags as `Badge` chips. State: today's `StateCell` dot treatment, keep sentence case. Last active/created via a shared `ago()` — lift the private one from devices.tsx:82 into `web/src/lib/time.ts` and reuse in both (touch devices.tsx import only). Row `⋯` is the Task-11 DropdownMenu with the five actions (pin/unpin by state). Keep the existing empty state (terminal card, `$ flue open`) when zero groups. Keep `aria-label` discipline (`Open <name>`).

- [ ] **Step 1: Write the new test file first** — port the still-true cases (not-cards, sentence-case headings, empty state) and add: group rendering + collapse; column toggling hides cells; checkbox toggles call back with composite key; action menu fires onAction; pinned star renders. Old fixed-sort tests die with `ordered()` (the view model owns order now — session-table.tsx:12-32's comment moves to `orderSessions`).
- [ ] **Step 2-4: FAIL → implement → PASS**
- [ ] **Step 5: Commit** `feat(web): linear-style grouped session table`

### Task 15: Row action surfaces

**Files:**
- Create: `web/src/components/rename-dialog.tsx`, `web/src/components/tag-editor.tsx`
- Test: matching `.test.tsx` for each

**Interfaces:**

```tsx
export function RenameDialog(props: {
  open: boolean; initial: string
  onSubmit(name: string): void; onClose(): void   // empty submit = clear name (falls back to title)
})
export function TagEditor(props: {
  open: boolean; current: string[]; known: string[]   // union of tags across fleet
  onSubmit(tags: string[]): void; onClose(): void
})
```

RenameDialog: Task-11 Dialog + existing Input, submit on Enter, autofocus, select-all. TagEditor: Dialog with chip list of `current` (click to remove), text input that adds on Enter, datalist-style suggestions filtered from `known` (a plain filtered list of buttons is fine — no combobox dependency), dedupe/trim client-side (daemon normalizes anyway).

- [ ] **Step 1: Failing tests**: rename submit/clear/escape; tag add/remove/suggest/submit; both close without submit on Escape.
- [ ] **Step 2-4: FAIL → implement → PASS**
- [ ] **Step 5: Commit** `feat(web): rename and tag editing dialogs`

### Task 16: Display options + search

**Files:**
- Create: `web/src/components/display-options.tsx`, `web/src/components/session-search.tsx`
- Test: matching `.test.tsx`

```tsx
export function DisplayOptions(props: { view: ViewConfig; onChange(v: ViewConfig): void })
export function SessionSearch(props: { value: string; onChange(v: string): void })
```

DisplayOptions: Task-11 Popover from an icon Button (outline, `aria-label="Display options"`); inside: Grouping Select, Ordering Select, "Show exited sessions" checkbox, "Display properties" chip row (Badge-styled toggle buttons, one per ColumnKey, pressed state via `aria-pressed`). SessionSearch: Input with search icon, `aria-label="Search sessions"`, debounce 150ms.

- [ ] **Step 1: Failing tests**: each control edits exactly its ViewConfig field; chips reflect/toggle columns; debounce collapses keystrokes (fake timers).
- [ ] **Step 2-4: FAIL → implement → PASS**
- [ ] **Step 5: Commit** `feat(web): display options and session search`

### Task 17: Bulk selection bar

**Files:**
- Create: `web/src/components/bulk-bar.tsx`
- Test: `web/src/components/bulk-bar.test.tsx`

```tsx
export function BulkBar(props: {
  count: number                                  // 0 renders nothing
  onTag(): void; onPin(): void; onClose(): void  // close = confirm dialog INSIDE the bar, fires onClose only on confirm
  anyRunning: boolean                            // running sessions make close destructive → confirm copy names the count
  onClear(): void
})
```

Fixed-position bottom bar (panel surface, inset ring like app-shell), `role="toolbar"`, "N selected", ghost buttons Tag/Pin, destructive-variant Close behind the Task-11 Dialog confirm (`Close N sessions? Running processes will be killed.` — sentence case), X to clear.

- [ ] **Step 1: Failing tests**: hidden at 0; copy pluralizes; close confirms before firing; clear fires.
- [ ] **Step 2-4: FAIL → implement → PASS**
- [ ] **Step 5: Commit** `feat(web): bulk selection bar`

### Task 18: Saved views tabs

**Files:**
- Create: `web/src/components/view-tabs.tsx`
- Test: `web/src/components/view-tabs.test.tsx`

```tsx
export function ViewTabs(props: {
  views: SavedView[]; active: string | null       // null = the built-in "All"
  dirty: boolean                                  // active view's config was edited
  onSelect(name: string | null): void
  onSaveCurrent(name: string): void               // "+" → small Dialog asking a name; also "Update view" when dirty
  onDelete(name: string): void                    // via per-tab context/dropdown
})
```

Tab row under the header: "All" first, then saved views, `aria-pressed` on active, `+` button opens name Dialog; active+dirty shows an "Update" affordance calling `onSaveCurrent(activeName)`; per-tab `⋯` dropdown with Delete.

- [ ] **Step 1: Failing tests**: select/all; save flow captures name; dirty shows update; delete fires.
- [ ] **Step 2-4: FAIL → implement → PASS**
- [ ] **Step 5: Commit** `feat(web): saved view tabs`

### Task 19: SessionsRoute rewire

**Files:**
- Rewrite: `web/src/routes/sessions.tsx`
- Rewrite: `web/src/routes/sessions.test.tsx`
- Modify: `web/src/router.tsx` if the route needs fleet context it doesn't have

The route is the state owner gluing everything: `useFleet()` → `onFleet` into state; ViewConfig state (init from active SavedView or DEFAULT_VIEW; edits mark dirty); selection Set + collapse Set; dialogs' open state (which session is renaming/tagging). Header: `PageHeader crumbs=[{label:'Sessions'}]`, actions = SessionSearch + DisplayOptions + New-session split button (primary "New session" spawns on `local` when present else first online machine; chevron opens a machine DropdownMenu listing online machines) — the ONE filled/teal button. `children` = ViewTabs. Body: `SessionTable groups={applyView(sessions, view)}` + BulkBar + per-machine unreachable notices: when a machine is `unreachable`, a muted row-band under its would-be group: `<name> is unreachable · retry` (retry = that client's `connect()`); when `connecting`, existing Skeleton rows. Wire actions: rename/tags/pin → `fleet.update(machineId, …)`; close → `clientFor(machineId)` close path (attach-free close needs the session's ref-less close — check how exit-overlay closes and reuse: `client.closeSession` takes a ref, so closing from the list must attach-close via a transient attach OR the daemon's close-by-ref only. Look at `closeSession` (client.ts:555) first; if it is ref-bound, add `closeById` to FlueClient + a `close` variant... STOP: it IS ref-bound (wire.CloseSession{Ref}). So: Task 19 includes a small daemon+wire addition — `wire.CloseSession` gains optional `ID string \`json:"id,omitempty"\`` field; conn.go's close case: when `Ref==0 && ID!=""`, resolve by id (`reg.Get` → `Close()`, not_found error otherwise). Fixture entry `{"type":"close","id":"a1b2c3d4e5f60708"}`; protocol.ts `CloseMsg` gains `id?: string`; FlueClient gains `closeById(id: string)`. TDD this slice first (Go wire+conn tests, TS mirror) before the route wiring. Bulk actions loop selected keys → group by machineId → per-session update/closeById.
Keep: `?cwd=` spawn param (sessions.tsx:116), `role="status"` live region announcing spawn/close/errors, `use-refetch-on-focus` → `fleet.list()`.

- [ ] **Step 1: closeById slice first** — failing Go test (close-by-id closes, unknown errors; fixture entry) → implement → TS mirror test → implement → commit `feat: close a session by id`
- [ ] **Step 2: Rewrite `sessions.test.tsx`** against a scripted fleet (inject via FleetProvider's test seam): rows from two machines render under machine groups; rename flow round-trips through fleet.update; search narrows; grouping switch regroups; bulk close confirms then calls closeById per selection; unreachable band + retry; New-session targets a chosen machine; `?cwd=` still spawns; live region announces.
- [ ] **Step 3: FAIL → implement route → PASS** (`pnpm test -- src/routes/sessions`)
- [ ] **Step 4: Full suite** `pnpm test` — PASS
- [ ] **Step 5: Commit** `feat(web): all-machines sessions route`

## Phase 6 — close out

### Task 20: Docs, follow-ups, full check

**Files:**
- Modify: `docs/FOLLOW-UPS.md` (delete the null-sessions entry :197 — fixed in Task 5)
- Modify: `README.md` (sessions feature blurb — one short paragraph, match voice)
- Verify: `spec/protocol.md` already covers `update` + `close`-by-id (Tasks 5, 19)

- [ ] **Step 1:** Docs edits above.
- [ ] **Step 2:** `make test` (builds web+relay embeds, runs Go+web+relay suites) — PASS. `cd web && pnpm lint` — PASS.
- [ ] **Step 3:** Manual smoke: `make run`, open the app, spawn two sessions, rename one, tag both, group by tag, search, pin, bulk close one. `cd` inside a session and watch the directory column follow within ~3s.
- [ ] **Step 4:** Commit `docs: sessions revamp follow-through`
- [ ] **Step 5:** Invoke superpowers:finishing-a-development-branch (merge target: local `main` directly — no PR, per Karn's workflow).

---

## Self-review notes (already applied)

- Spec coverage: every spec section maps to a task — metadata (1), live cwd (2), persistence (3-4), wire (5-6), TS mirror (7-8), fleet (9-10), primitives (11), header (12), view-model+views (13), table (14), row actions (15), display+search (16), bulk (17), tabs (18), route+close-by-id+spawn-target+unreachable (19), docs (20).
- Type consistency: `MetaPatch` pointer fields flow `wire.Update` → `UpdateMeta` unchanged; `FleetSession` key is `${machineId}/${id}` everywhere selection appears; `ViewConfig` field names match `SavedView` extension.
- Known risk called out in-task: darwin proc_info constants must be read from the SDK header, proven by the real-PTY test.
