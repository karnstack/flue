# Sessions UI revamp — design

Date: 2026-08-08
Status: approved (brainstorm with Karn)

## Goal

Make the sessions list the flagship surface of flue: a Linear-style table that
shows every session on every paired machine in one place, with naming, tagging,
pinning, grouping, sorting, search, bulk actions, and saved views. Fix the page
header while we are in there. This is the moat feature for people working from
multiple devices; it has to be powerful and look the part.

## Decisions made during brainstorm

- **All machines, one list.** Client-side fleet layer aggregates every paired
  machine. Daemon federation rejected (new daemon-to-daemon trust surface);
  per-machine-only rejected (half the moat).
- **Grouping is a view option, not a folder entity.** Group rows BY a property
  (machine, state, tag, directory) exactly like Linear. Tags are the manual
  organizing dimension; no first-class "group" CRUD.
- **`cwd` goes live.** Today it is the spawn-time value and never tracks `cd`.
  The daemon will report the PTY child's actual working directory.
- **Metadata persists as JSON files, not sqlite.** Flushed on every update,
  consistent with `devices.json` / `relay.json`. sqlite is overkill for tens of
  sessions and a new dependency for nothing.
- **V1 includes** search/filter bar, bulk multi-select, saved views, and
  pin/favorite — all four extras confirmed in scope.

## 1. Data model and wire protocol

### session.Info gains four fields

```go
Name      string    `json:"name"`      // user-set, "" by default
Tags      []string  `json:"tags"`      // free strings, deduped, sorted
Pinned    bool      `json:"pinned"`
CreatedAt time.Time `json:"createdAt"` // stamped at spawn, RFC3339
```

- `createdAt` is a session fact, not user metadata: stamped once at spawn,
  carried through snapshot so a revived session keeps its original creation
  time. It is the stable sort key `lastActive` cannot be.

- Client display-name resolution: `name || title || basename(cwd)`. The OSC 0/2
  title (TitleScanner) is demoted to fallback; a manual rename always wins.
- `cmd` shown as subtitle under the name.

### Live cwd

- On each `list`, the daemon reads the PTY child's current working directory:
  Linux `readlink /proc/<pid>/cwd`; macOS `proc_pidinfo` with
  `PROC_PIDVNODEPATHINFO`. Both cgo-free, behind a small interface so tests can
  fake it (and darwin CI can be faked while linux CI exercises the real path).
- Exited sessions keep the last known cwd. Failure to read (perm, raced exit)
  keeps the previous value — never blanks it.

### New wire message

- C→S `update {id, name?, tags?, pinned?}` — partial update; an omitted field
  is unchanged. Reply is a fresh `sessions` frame (reuses the existing reply
  path; the 3s poll spreads the change to every other browser). Unknown or
  exited-and-reaped id → existing `error` message.
- No new HTTP endpoint. Mutations stay WebSocket-only, `methodPolicy` and
  `TestNoStateChangeIsReachableByGET` untouched.
- Golden fixture `testdata/wire/control.json` extended; Go and TS codec suites
  both pick it up.
- Fixed in passing: `wire.Sessions` marshals nil as `null` while TS declares
  `SessionInfo[]` (docs/FOLLOW-UPS.md:197). The fleet merge needs the fix.

### Persistence

- Per-session metadata file `<configDir>/sessions/<id>.meta.json` (0600):
  `{v, name, tags, pinned}`. Written on every `update` (crash-safe), loaded at
  boot for revived sessions, deleted when the session is reaped.
- Shutdown snapshots (`snapshot.go`) also carry the fields so a revive is
  self-contained; the meta file is the durability story, the snapshot is the
  transport into the revived session.
- Metadata dies with the session (exit + 10 min retention + reap). No
  standalone tag registry; a tag exists because a live session wears it.

## 2. Fleet layer (web, new)

- `FleetClient` owns one `FlueClient` per source: the loopback daemon plus
  every record in `listMachines()`. Each remote dials its relay slot
  `/client/<machine-id>` with its pinned Noise key, exactly as today's
  single-machine path does.
- Merged output: `Array<SessionInfo & {machineId, machineName}>` plus
  per-machine status `connecting | online | unreachable`. Staggered 3s polls;
  reconnect with backoff per machine.
- Dedup: `welcome.relay` carries the daemon's MachineID. If the loopback
  daemon's id matches a paired relay record, the relay dial is skipped —
  loopback wins.
- The terminal URL's reserved segment becomes real: `/d/$machineId/s/$sessionId`
  routes through the fleet's client for that machine; `local` remains the
  loopback id. The `/machines` picker page stays only for pairing; viewing no
  longer needs it.
- Saved views and table preferences live in localStorage per browser. Known
  limitation: views do not sync across browsers (no single daemon owns a view
  that spans machines). Storage reads are validated the way
  `web/src/relay/machines.ts` validates — corrupt store reads as defaults.
- Relay untouched. Daemon untouched by aggregation itself.

## 3. UI

```
┌────────────────────────────────────────────────────────────────────┐
│ Sessions                    [ search…  ] [⚙ display] [+ New ▾]     │  ← PageHeader (breadcrumb + actions)
│ [All] [Feature-x] [Work] +                                         │  ← saved views tabs
├────────────────────────────────────────────────────────────────────┤
│ ▾ macbook-pro · 3 running                                   [+]    │  ← group header (collapsible)
│ ☐ ⭐ api-server      ~/code/flue      [feat-x][api]  ● 2m   [⋯]    │
│ ☐    web build       ~/code/flue/web  [feat-x]       ● now  [⋯]    │
│ ▾ home-server · 1 running · 1 exited                               │
│ ☐    migration       ~/srv/db         [ops]          ◌ exited 0    │
├────────────────────────────────────────────────────────────────────┤
│ 2 selected   [Tag] [Pin] [Close]                                   │  ← bulk bar (on selection)
└────────────────────────────────────────────────────────────────────┘
```

- **Columns / display properties** (each toggleable): Name (+ cmd subtitle),
  Directory (mono, middle-truncated), Machine (chip), Tags (chips), State
  (dot + "Running" / "Exited n"), Last active (relative time), Created
  (relative time, off by default). Row actions in a hover `⋯` dropdown: Open,
  Rename, Tags, Pin, Close.
- **Display options popover** (Linear-style): Grouping
  `machine | state | tag | directory | none`; Ordering
  `last active | created | name | directory`; Show exited toggle;
  display-property chips. No sub-grouping in v1.
- **Search bar**: client-side, matches name, title, cwd, tags, machine name.
- **New session**: the header "New ▾" button carries a machine dropdown
  (default: local). The `[+]` on a machine group header spawns directly on that
  machine.
- **Bulk multi-select**: checkbox column; selection bar with Tag / Pin / Close;
  Close confirms when any selected session is running.
- **Pinned**: floats to the top within its group; a "Pinned" pseudo-group when
  ungrouped.
- **Saved views**: `{name, grouping, ordering, search, columns, showExited}` in
  localStorage; tabs above the table; "All" is the built-in default.
- **Rename**: inline edit from the row menu (and double-click on the name).
- **Tag editing**: lightweight combobox — pick from tags currently in use
  across the fleet, or type to create.
- **PageHeader**: new shared component in the AppShell area with a breadcrumb
  slot and an actions slot; replaces the per-route repeated `h1` class strings
  (sessions, devices, placeholder routes). Terminal route stays chrome-less.
- **Reshuffle guard**: `lastActive` is stamped on every byte in either
  direction, so ordering by it would visibly reshuffle every poll. Ordering
  buckets `lastActive` to 30s and tie-breaks directory → id, preserving the
  stable-order rationale documented in `ordered()` (session-table.tsx:12-32).
- **New primitives** via shadcn: `dropdown-menu`, `popover`, `select`,
  `checkbox`, `dialog`, plus the small tag combobox. Watch the guard:
  `styles.build.test.ts` fails the build if shadcn add rewrites `styles.css`
  (e.g. reintroducing `@custom-variant dark`); class strings stay literal and
  hyphenated in `className`.
- Design-system rules hold: zinc neutrals, teal accent spent only on active
  nav / focus / the one primary button ("New"), dark mode via
  `prefers-color-scheme` only.

## 4. Errors and edge cases

- Machine unreachable → its group header shows status and a retry affordance;
  no cached rows in v1; actions for that machine disabled.
- `update` racing a session exit → daemon replies `error`; the row flashes and
  the existing `role="status"` live region announces it.
- Corrupt or unavailable localStorage (private mode) → empty machine list →
  pair CTA; corrupt saved views → default view. Same validated-read pattern as
  `machines.ts`.
- Meta file write failure on `update` → the update still applies in memory; the
  daemon logs the write error (metadata durability degrades, function does not).
- Two browsers renaming concurrently → last write wins; the 3s poll converges
  both.

## 5. Testing

- **Go**: `update` semantics and concurrency; meta file write/load/reap
  lifecycle; snapshot roundtrip with new fields; live-cwd interface (fake on
  darwin, real `/proc` on linux CI); wire codec against the extended golden
  fixture; conn handler for `update`; GET-mutation policy stays green.
- **TS**: protocol decode for new fields and `update`; FleetClient merge,
  dedup, per-machine status, and reconnect with scripted clients;
  grouping/sorting/filtering as pure functions; component tests for table,
  bulk bar, saved views, display options, rename, tag combobox; existing
  `session-table.test.tsx` (12 cases) and `sessions.test.tsx` (~30 cases)
  largely rewritten.

## Out of scope (v1)

- Sub-grouping (Linear's second grouping level).
- Cached rows for unreachable machines.
- Cross-browser sync of saved views.
- Standalone tag registry / tag colors.
- Board view.
