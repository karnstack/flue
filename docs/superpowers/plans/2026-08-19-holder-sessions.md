# Holder Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sessions run under per-session holder processes so daemon restart, update, or crash never kills a running session.

**Architecture:** The existing `session.Session` engine (pty, ring, pump, supervise) moves unchanged into a tiny `flue _holder` process, one per session. The daemon talks to holders over unix sockets via a frozen v1 protocol and consumes sessions through a new `Handle` interface, with a `Remote` client implementing it. Reboots keep the existing snapshot/revive path, now fed by holders on SIGTERM.

**Tech Stack:** Go, unix sockets, launchd/systemd user units. No new dependencies.

**Spec:** docs/superpowers/specs/2026-08-19-holder-sessions-design.md

## Global Constraints

- pnpm only for web/ (untouched here); Go work verified with `go test ./...`.
- main is protected; each PR lands via `gh pr create`, stacked: PR N+1 based on PR N's branch.
- Branch names: `holder-1-handle` .. `holder-5-ux`.
- Protocol is v1 and frozen small: hello, spawn, write, resize, signal, tail, close + events exit/title/active.
- Engine behavior (drain rules, pgid signalling, Sub semantics) must not change; engine tests stay untouched.
- Existing wire protocol to web clients unchanged.
- Comment style: match the codebase's discursive comments; explain constraints, not mechanics.

---

### Task 1 (PR1): Handle interface, daemon consumes it

**Files:**
- Create: `internal/session/handle.go`
- Modify: `internal/session/registry.go` (map stores `handle`; `Get`/`List`/`Spawn`/`Revive` return/hold `Handle`)
- Modify: `internal/session/snapshot.go` (`Registry.Snapshots` type-asserts `*Session`)
- Modify: `internal/daemon/conn.go`, `internal/daemon/server.go` (`*session.Session` -> `session.Handle`)
- Test: existing suites are the guard; plus `internal/session/handle_test.go` compile-time assertion

**Interfaces (Produces):**

```go
// internal/session/handle.go
type Handle interface {
    ID() string
    Info() Info
    ApplyMeta(MetaPatch) Info
    Tail(n int) (data []byte, cols, rows uint16)
    Write(p []byte) error
    Resize(cols, rows uint16) error
    Signal(sig os.Signal) error
    Subscribe(fromSeq uint64) *Sub
    Unsubscribe(*Sub)
    Close() error
}

// registry-internal, same file:
type handle interface {
    Handle
    exitStatus() (exited bool, at time.Time, ephemeral bool)
    groupID() string
}
var _ handle = (*Session)(nil)
```

- [ ] Compile-time assertion test, run `go test ./internal/session/` (fails: no Handle)
- [ ] Add handle.go; registry `sessions map[string]handle`; `Get(id) (Handle, bool)`; `List() []Handle`; `Spawn`/`start`/`Revive` return `Handle`; `Reap` iterates `handle`
- [ ] `Snapshots()`: `for _, h := range r.List() { s, ok := h.(*Session); if !ok { continue }; ... }`
- [ ] daemon: replace `*session.Session` types in `attachment`, `attachTo`, `awaitExit`, list building
- [ ] `go test ./...` green; commit `refactor(session): daemon consumes sessions through a Handle interface`

### Task 2 (PR2): holdwire framing + messages

**Files:**
- Create: `internal/holdwire/frame.go`, `internal/holdwire/msg.go`
- Test: `internal/holdwire/frame_test.go`

**Interfaces (Produces):**

```go
const Proto = 1
const (
    TJSON  byte = 1 // control request / response / event
    TChunk byte = 2 // raw output bytes on an attach connection
)
func WriteFrame(w io.Writer, t byte, p []byte) error
func ReadFrame(r io.Reader) (t byte, p []byte, err error) // enforces max frame 8 MiB

type Req struct { ID uint64 `json:"id"`; Verb string `json:"verb"`
    Spawn *SpawnReq `json:"spawn,omitempty"`; Data []byte `json:"data,omitempty"`
    Cols uint16 `json:"cols,omitempty"`; Rows uint16 `json:"rows,omitempty"`
    Sig int `json:"sig,omitempty"`; N int `json:"n,omitempty"`
    FromSeq uint64 `json:"fromSeq,omitempty"` }
type Resp struct { ID uint64 `json:"id"`; Err string `json:"err,omitempty"`
    Hello *Hello `json:"hello,omitempty"`; Data []byte `json:"data,omitempty"`
    Cols uint16 `json:"cols,omitempty"`; Rows uint16 `json:"rows,omitempty"`
    StartSeq uint64 `json:"startSeq,omitempty"`; Truncated bool `json:"truncated,omitempty"` }
type Event struct { Event string `json:"event"`; Code int `json:"code,omitempty"`
    At time.Time `json:"at,omitempty"`; Title string `json:"title,omitempty"` }
type SpawnReq struct { ID string; Run, Argv, Env []string; Cwd string
    Cols, Rows uint16; RingSize int; Preload []byte; Restore session.Info
    Group string; Ephemeral bool }
type Hello struct { Proto int; Version string; Pid int; Info session.Info
    BaseSeq, EndSeq uint64 }
```

- [ ] Frame round-trip test incl. size-limit rejection; fails; implement; pass; commit

### Task 3 (PR2): engine constructor holder can call

**Files:**
- Modify: `internal/session/registry.go` (extract resolution + construction)
- Create: `internal/session/child.go`
- Test: `internal/session/child_test.go`

**Interfaces (Produces):**

```go
// ChildConfig is a fully resolved spawn: no login-shell or env decisions left.
type ChildConfig struct {
    ID string; Run []string; Argv []string; Env []string; Cwd string
    Cols, Rows uint16; RingSize int; Preload []byte; Restore Info
    Group string; Ephemeral bool; Clock func() time.Time
}
func StartChild(cfg ChildConfig) (*Session, error)
// ResolveSpawn turns SpawnOpts into a ChildConfig (loginShell, execArgv,
// sessionEnv, cwd fallback, default size/ring) minus ID/Clock.
func ResolveSpawn(opts SpawnOpts) ChildConfig
```

- [ ] Test: StartChild echoes bytes, records Info fields, honors Preload/Restore; fails; implement by moving the body of `registry.start` (registry.start becomes ResolveSpawn+StartChild+map insert); `go test ./internal/session/` green; commit

### Task 4 (PR2): holder server

**Files:**
- Create: `internal/holder/holder.go`, `internal/holder/events.go`
- Test: `internal/holder/holder_test.go` (in-process: Serve on a socket in t.TempDir, dial raw)

**Interfaces (Produces):**

```go
// Serve owns one session for its whole life. dir carries holder.sock.
// ready, when non-nil, receives one byte after listen succeeds.
func Serve(dir string, ready io.WriteCloser) error
```

Behavior: accept loop; first `spawn` wins (second gets Err); control verbs map to engine methods; `attach` switches the connection to streaming (JSON header then TChunk frames fed from a `Sub`); events goroutine polls `Info()` every 250ms and pushes `exit` once, `title` on change, `active` at most once per second; `close` kills via engine Close, replies, exits process. Self-reap: child exited + no control connection for 60min -> remove dir, exit.

- [ ] Test: spawn `sh -c 'printf hi; sleep 60'`, attach from seq 0 sees `hi`, write round-trips, exit event arrives after signal; fails; implement; pass; commit

### Task 5 (PR2): Remote client

**Files:**
- Create: `internal/session/remote.go`
- Test: `internal/session/remote_test.go` (against `holder.Serve` in-process)

**Interfaces (Produces):**

```go
// DialRemote connects to an existing holder and rebuilds a Handle from its
// hello plus the daemon-owned identity record.
func DialRemote(dir string, ident IdentityRecord) (*Remote, error)
// SpawnRemote launches `exe _holder --dir dir`, waits ready, sends spawn.
func SpawnRemote(exe, dir string, cfg ChildConfig) (*Remote, error)
var _ handle = (*Remote)(nil)

type IdentityRecord struct { // session.json
    V int; ID string; Cmd []string; Group string; Ephemeral bool
    CreatedAt time.Time
}
func SaveIdentity(dir string, rec IdentityRecord) error
func LoadIdentity(dir string) (IdentityRecord, error)
```

Remote caches Info from hello + events; `Info()` refreshes cwd via `processCwd(pid)` while running; `ApplyMeta` mutates the cached daemon-owned fields; `Subscribe` opens an attach connection per Sub; `Close` sends close, waits reply (bounded), removes dir. Control-conn loss with holder alive: redial with backoff; holder gone for good -> mark exited (code -1) so Reap retires it.

- [ ] Test: spawn via SpawnRemote (helper builds flue binary once per package into t.TempDir via `go build`), write/echo, Tail, Subscribe backlog+live, Signal, Close removes dir; fails; implement; pass; commit
- [ ] `_holder` subcommand in `cmd/flue/main.go` dispatch: `case "_holder"` -> flag `--dir`, ready pipe on fd 3 when present, `holder.Serve`; commit; push PR2

### Task 6 (PR3): daemon spawns holder sessions

**Files:**
- Modify: `internal/session/registry.go`, `cmd/flue/main.go`
- Test: `internal/session/registry_holder_test.go`

**Interfaces (Produces):**

```go
// SetHolderSpawning points the registry at the holders root; from then on
// Spawn and Revive run sessions under holders. Empty dir or exe disables.
func (r *Registry) SetHolderSpawning(exe, holdersRoot string)
```

`start()` branches: holder mode -> `ResolveSpawn` + `SaveIdentity` + `SpawnRemote`; else in-process (tests, `FLUE_NO_HOLDER=1`). `cmd/flue` serve path calls `SetHolderSpawning(os.Executable(), config.Dir()+"/holders")` unless `FLUE_NO_HOLDER=1`. Socket path length guard in SpawnRemote with a clear error. UpdateMeta persists Ephemeral flips to session.json for remotes.

- [ ] Registry test: with holder spawning set, Spawn returns a running Remote, echo works, Reap of a closed one removes the dir; fails; implement; pass
- [ ] `go test ./...`; manual: `FLUE_NO_HOLDER=1 flue serve` still spawns in-process; commit; push PR3

### Task 7 (PR4): reattach at boot + holder snapshots + unit hardening

**Files:**
- Create: `internal/session/reattach.go`, test `internal/session/reattach_test.go`
- Modify: `internal/holder/holder.go` (SIGTERM -> snapshot), `cmd/flue/main.go` (boot order), `internal/service/unit.go` + `internal/service/service.go` (unit refresh), tests alongside
- Test: `cmd/flue/restart_e2e_test.go` (guarded by `testing.Short()` skip)

**Interfaces (Produces):**

```go
// ReattachHolders rebuilds registry entries for every live holder under
// root, removes dead holder dirs, and reports what it did for the log.
func ReattachHolders(r *Registry, root string) (reattached, swept int)
```

Boot order in main.go: ReattachHolders -> LoadSnapshots/Revive (ids already reattached are skipped: revive checks `reg.Get(id)` first and clears the file) -> SetMetaDir/AdoptMetas. Holder SIGTERM handler: engine Snapshot + `agentSessionFor` + SaveSnapshots into `config.Dir()/sessions`, then exit; `close` verb path snapshots nothing. Units: systemd adds `KillMode=process`, launchd adds `AbandonProcessGroup`; `EnsureCurrent(runner, exe)` compares installed unit bytes with the template and rewrites + reloads when different, called from serve startup best-effort.

- [ ] Reattach test: spawn remote, drop the Registry (not the holder), fresh Registry + ReattachHolders, same id running, seq continuity, write works; fails; implement; pass
- [ ] Unit golden tests for new template content + EnsureCurrent rewrite logic; implement; pass
- [ ] E2E test: build binary, run daemon on a scratch config dir + port, spawn session, SIGTERM daemon, restart, assert same session id running with pre-restart bytes in Tail; pass
- [ ] `go test ./...`; commit; push PR4

### Task 8 (PR5): UX and docs

**Files:**
- Modify: `cmd/flue/main.go` (`runRestart` copy), `cmd/flue/update.go` (post-update copy), `README.md`, `docs/` note
- Test: adjust `enable_test.go` / `update_test.go` copy assertions

- [ ] `flue restart` prints that sessions keep running (and the legacy hint text goes away only when holders are active: daemon version check via /api). Keep it honest: if `FLUE_NO_HOLDER=1`, old wording.
- [ ] README section "Sessions outlive flue" + release-note blurb ("this is the last update that restarts your sessions").
- [ ] `go test ./...`, `cd web && pnpm vitest run` untouched but run once at the end; commit; push PR5

## Self-Review

- Spec coverage: interface (T1), protocol (T2), engine reuse (T3), holder (T4), remote (T5), default spawn + escape hatch + session.json (T6), reattach + snapshots-on-SIGTERM + units + e2e (T7), messaging/docs (T8). Orphan self-reap in T4; socket length guard in T6; version handshake in T2 Hello.Proto checked in T5 DialRemote.
- Types consistent: ChildConfig produced by ResolveSpawn (T3) consumed by SpawnRemote (T5) and registry (T6); IdentityRecord written T6, read T7 via DialRemote.
- No placeholders: each task carries signatures and concrete test behavior; engine bodies move rather than get rewritten.
