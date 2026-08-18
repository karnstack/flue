# Holder sessions: sessions that outlive the daemon

Date: 2026-08-19
Status: approved direction (option B from the brainstorm), spec for implementation

## Problem

Every flue session is a PTY child of the daemon process. The PTY master fd,
the scrollback ring, and the supervising goroutines all live in daemon
memory. When the daemon restarts (update, crash, `flue restart`), the master
closes, the child gets SIGHUP, and the session dies. Today's mitigation is
snapshot and revive: scrollback is replayed into a fresh shell with a printed
resume hint. The running process is lost.

## Goal

A daemon restart, update, or crash never kills a running session. The promise
to state in release notes: "sessions outlive flue". Machine reboot remains the
one event that ends sessions, and the existing snapshot/revive path remains
the answer for it.

## Design

### Shape

Each session runs under its own tiny holder process. The holder owns exactly
what dies with a process: the PTY master fd, the child (it is the parent, so
it alone can waitpid), the scrollback ring, and the title scanner. The daemon
keeps everything that is policy or metadata: ids, names, tags, groups,
ephemeral reaping, listing, auth, wire protocol to clients, relay.

The holder reuses the existing engine unchanged: `session.Session` (pump,
supervise, ring, title, drain rules) moves process, not shape. The holder is
a thin server that maps protocol verbs onto engine methods. The daemon gains
a client type that implements the same surface the daemon already consumes.

```
before:  client ws -> daemon [Session: pty, ring, pump, supervise]
after:   client ws -> daemon [Remote] -> unix socket -> holder [Session: pty, ring, pump, supervise]
```

### Handle interface

`internal/session` grows an interface covering what `internal/daemon`
consumes today:

```go
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
```

`*Session` already satisfies it. The registry stores Handles; the daemon
depends only on the interface. Registry-internal needs (exitStatus, groupID
for Reap) live on a small unexported companion interface both types satisfy.

### Holder process

- Invocation: `flue _holder --dir <holderDir>` (hidden subcommand, same
  binary). The daemon spawns it detached: setsid, stdio to a log file in the
  holder dir. On daemon exit the holder reparents to init and keeps running.
- Startup: holder listens on `<holderDir>/holder.sock`, then writes a ready
  byte on an inherited pipe so the daemon knows the socket is live. The
  daemon then sends the spawn request (argv to exec, display argv, env, cwd,
  cols/rows, ring size, preload bytes for revive, restore fields) over the
  socket. Holder spawns the child through the existing engine and replies
  with pid and initial state.
- Exit: the holder exits when the daemon sends `close` (Reap victims and
  client closes), or by self-reap: child exited and no daemon connection for
  60 minutes (orphan guard, generous multiple of ExitedRetention). On
  SIGTERM (logout, reboot) the holder writes a snapshot file to the state
  dir, exactly the shape `SaveSnapshots` writes today, then exits. Reboot
  revival therefore keeps working, now fed by holders instead of the daemon.

### Directory layout

`~/.config/flue/holders/<sessionID>/` (0700), containing:

- `holder.sock`: the holder's listener. Path length is checked at spawn
  against the platform socket limit; on overflow spawn fails with a clear
  error.
- `session.json`: daemon-owned identity record written at spawn and updated
  on ephemeral promotion: id, display cmd, group, ephemeral, createdAt. Read
  at reattach so the daemon can rebuild its registry entry without asking
  the holder for daemon-owned facts. The holder never writes it.
- `holder.log`: holder stderr, for diagnostics.

Names and tags stay where they are today (meta files, `AdoptMetas`).

### Protocol

New package `internal/holdwire`: length-prefixed frames over the unix
socket, version byte in the hello. One control connection per holder held
open by the daemon, plus one connection per attach.

Control verbs (JSON payloads): `hello` (proto version, flue version, pid,
live Info fields, ring base/end seq), `spawn`, `write`, `resize`, `signal`,
`tail`, `close`. Requests are serialized on the connection; every request
gets a reply.

Events pushed by the holder on the control connection: `exit` (code, at),
`title` (new title), `active` (lastActive bump, throttled to at most one per
second). The daemon's Remote caches Info from these events, so `List()` with
N sessions costs zero round trips.

Attach connections: client sends `attach(fromSeq)`, holder replies with the
backlog header (startSeq, truncated) then streams raw chunks. This maps one
to one onto `Sub` semantics; each daemon-side subscriber gets its own attach
connection. Subscriber counts are small (a few tabs).

Compatibility rule: the protocol is version 1 and deliberately tiny. A newer
daemon must keep speaking version 1 to holders started by older binaries.
The hello carries both proto version and flue version; a proto the daemon
does not know turns into a visible "unreachable holder" error, never a
silent kill.

### Daemon changes

- Spawn: registry spawns a holder by default in the daemon. Escape hatch
  `FLUE_NO_HOLDER=1` keeps the in-process path (also the default for unit
  tests, which keep testing the engine directly).
- Boot: scan the holders dir. For each entry: read `session.json`, dial the
  socket, hello, rebuild a Remote in the registry. Dead socket: remove the
  holder dir; if a snapshot file exists for that id, the existing revive
  path picks it up (now spawning through a fresh holder). Then `AdoptMetas`
  as today.
- Shutdown: the daemon no longer snapshots (it does not own rings). It
  leaves holders running. `SaveSnapshots` moves to the holder's SIGTERM
  path.
- Reap: unchanged policy; victims get `close` over the control connection,
  after which the daemon removes the holder dir.
- cwd: the daemon keeps calling `processCwd(pid)` itself with the child pid
  from the hello. Same-uid works on both platforms.
- Agent hints (`agentSessionFor`): computed by the holder at snapshot time,
  same code, same binary.

### Service units

Without unit changes the feature is dead under systemd: the default
KillMode=control-group kills every process in the unit cgroup on restart,
holders included. Changes:

- systemd user unit gains `KillMode=process`.
- launchd plist gains `AbandonProcessGroup=true` (holders setsid away
  regardless; the key makes the intent explicit and guards edge paths).
- Existing installs: on `flue serve` start and on `flue update`, the daemon
  compares the installed unit file with the current template and rewrites +
  reloads it when they differ. This is the migration path for users already
  running flue; it must land before or with the reattach PR.

### Migration for existing users

The update that delivers this feature is the last one that kills sessions.
No flag day beyond that: after updating, new sessions spawn under holders.
There are no legacy in-process sessions to carry, because the old daemon's
sessions died at that final restart (revived as fresh shells, as today).
Release notes state this plainly.

### What does not change

Wire protocol to clients, web UI, relay, fleet, pairing, meta files, sort
and filter, groups and ephemeral semantics, `Sub` semantics including
truncation and drop-and-reattach, snapshot file format, revive UX for
reboots.

## Testing

- Engine tests: untouched (they exercise `*Session` in process).
- holdwire: frame round-trip and version tests.
- Holder integration: spawn a real holder (test helper builds the binary
  once per package, `go build` into t.TempDir), drive spawn/attach/write/
  resize/signal/close over the socket, assert byte streams and exits.
- Daemon reattach: start registry, spawn holder session, tear down the
  registry (not the holder), build a fresh registry, reattach, assert same
  id, scrollback continuity by seq, working write path.
- Restart end to end: `TestSessionsSurviveDaemonRestart`: real daemon
  process, session with a marker process running, SIGTERM daemon, start new
  daemon, assert same session id lists as running, same child pid, ring
  contains pre-restart output.
- Unit template tests: golden files for the new unit content, refresh logic.
- Existing full suites (`go test ./...`, web vitest) stay green; conn.go
  behavior is interface-mediated and unchanged.

## Rollout (stacked PRs)

1. `Handle` interface extraction; daemon consumes the interface. Pure
   refactor, no behavior change.
2. `internal/holdwire` + holder server + `flue _holder` + `Remote` client,
   with integration tests. Nothing wired into the daemon yet.
3. Daemon spawns holder sessions by default (`FLUE_NO_HOLDER` escape),
   `session.json`, spawn readiness and error paths.
4. Boot reattach, orphan cleanup, holder snapshot-on-SIGTERM, daemon stops
   snapshotting, Reap over Remote, service unit hardening + refresh.
5. UX polish: `flue restart`/`flue update` messaging, docs, release notes.

Each PR keeps `go test ./...` green on its own and lands via review.
