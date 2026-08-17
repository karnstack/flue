package session

import (
	"testing"
	"time"
)

// TestSpawnCarriesGroupAndEphemeral pins the two new SpawnOpts fields onto
// Info, and — the half that guards every session that exists today — that a
// spawn naming neither reports neither.
func TestSpawnCarriesGroupAndEphemeral(t *testing.T) {
	r := NewRegistry(nil)
	anchor := spawnRunning(t, r)

	member, err := r.Spawn(SpawnOpts{
		Cmd: []string{"sleep", "5"}, Cols: 80, Rows: 24,
		Group: anchor.ID(), Ephemeral: true,
	})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	t.Cleanup(func() { _ = member.Close() })

	info := member.Info()
	if info.Group != anchor.ID() {
		t.Errorf("Group = %q, want %q", info.Group, anchor.ID())
	}
	if !info.Ephemeral {
		t.Error("Ephemeral = false, want true")
	}

	plain := anchor.Info()
	if plain.Group != "" || plain.Ephemeral {
		t.Errorf("plain session carries group=%q ephemeral=%v, want neither", plain.Group, plain.Ephemeral)
	}
}

// TestEphemeralExitedReapedFast pins the retention split: an exited scratch
// terminal leaves the registry after EphemeralRetention, while an ordinary
// exited session beside it waits out the full ExitedRetention.
func TestEphemeralExitedReapedFast(t *testing.T) {
	now := time.Now()
	r := NewRegistry(func() time.Time { return now })

	plain, err := r.Spawn(SpawnOpts{Cmd: []string{"sh", "-c", "exit 0"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	scratch, err := r.Spawn(SpawnOpts{
		Cmd: []string{"sh", "-c", "exit 0"}, Cols: 80, Rows: 24, Ephemeral: true,
	})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	waitExited(t, plain, 5*time.Second)
	waitExited(t, scratch, 5*time.Second)

	now = now.Add(EphemeralRetention + time.Second)
	r.Reap()
	if _, ok := r.Get(scratch.ID()); ok {
		t.Error("ephemeral session still present past EphemeralRetention")
	}
	if _, ok := r.Get(plain.ID()); !ok {
		t.Error("ordinary session reaped on the ephemeral schedule")
	}
}

// TestRunningEphemeralFollowsItsParent is the scratch terminal's lifecycle
// promise: dismissed or not, it runs while its parent runs — the first Reap
// with both alive touches nothing — and it is closed by the sweep once the
// parent has exited, without waiting for the parent to be reaped.
func TestRunningEphemeralFollowsItsParent(t *testing.T) {
	now := time.Now()
	r := NewRegistry(func() time.Time { return now })

	parent, err := r.Spawn(SpawnOpts{Cmd: []string{"sleep", "0.2"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	t.Cleanup(func() { _ = parent.Close() })
	scratch, err := r.Spawn(SpawnOpts{
		Cmd: []string{"sleep", "60"}, Cols: 80, Rows: 24,
		Group: parent.ID(), Ephemeral: true,
	})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	t.Cleanup(func() { _ = scratch.Close() })

	// Both alive: the sweep must leave the scratch running.
	r.Reap()
	if scratch.Info().State != "running" {
		t.Fatal("scratch closed while its parent was still running")
	}

	waitExited(t, parent, 5*time.Second)
	// The parent is exited but not yet reaped — still listable in its
	// retention window — and that alone ends the scratch.
	r.Reap()
	waitExited(t, scratch, 5*time.Second)
}

// TestRunningEphemeralWithoutAParentIsLeftAlone: no group means no lifecycle
// to follow, and the sweep must not guess one.
func TestRunningEphemeralWithoutAParentIsLeftAlone(t *testing.T) {
	r := NewRegistry(nil)
	scratch, err := r.Spawn(SpawnOpts{
		Cmd: []string{"sleep", "60"}, Cols: 80, Rows: 24, Ephemeral: true,
	})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	t.Cleanup(func() { _ = scratch.Close() })

	r.Reap()
	if scratch.Info().State != "running" {
		t.Fatal("ungrouped ephemeral session closed by the sweep")
	}
}

// TestApplyMetaClearsEphemeral is the "keep" affordance: clearing the flag
// promotes a scratch to an ordinary member, after which the parent's exit no
// longer takes it down.
func TestApplyMetaClearsEphemeral(t *testing.T) {
	now := time.Now()
	r := NewRegistry(func() time.Time { return now })

	parent, err := r.Spawn(SpawnOpts{Cmd: []string{"sh", "-c", "exit 0"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	t.Cleanup(func() { _ = parent.Close() })
	scratch, err := r.Spawn(SpawnOpts{
		Cmd: []string{"sleep", "60"}, Cols: 80, Rows: 24,
		Group: parent.ID(), Ephemeral: true,
	})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	t.Cleanup(func() { _ = scratch.Close() })

	kept := false
	info, err := r.UpdateMeta(scratch.ID(), MetaPatch{Ephemeral: &kept})
	if err != nil {
		t.Fatalf("UpdateMeta: %v", err)
	}
	if info.Ephemeral {
		t.Fatal("Ephemeral still true after the clearing patch")
	}
	if info.Group != parent.ID() {
		t.Errorf("Group = %q after the patch, want %q untouched", info.Group, parent.ID())
	}

	waitExited(t, parent, 5*time.Second)
	r.Reap()
	if scratch.Info().State != "running" {
		t.Fatal("a kept session was closed with its parent; promotion did not stick")
	}
}

// TestSnapshotSkipsEphemeralAndCarriesGroup pins the restart story: a split
// member revives as a member because its snapshot names the group, and a
// scratch terminal is not snapshotted at all — its life is bound to a process
// the restart does not preserve.
func TestSnapshotSkipsEphemeralAndCarriesGroup(t *testing.T) {
	r := NewRegistry(nil)
	anchor := spawnRunning(t, r)

	member, err := r.Spawn(SpawnOpts{
		Cmd: []string{"sleep", "5"}, Cols: 80, Rows: 24, Group: anchor.ID(),
	})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	t.Cleanup(func() { _ = member.Close() })
	scratch, err := r.Spawn(SpawnOpts{
		Cmd: []string{"sleep", "5"}, Cols: 80, Rows: 24,
		Group: anchor.ID(), Ephemeral: true,
	})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	t.Cleanup(func() { _ = scratch.Close() })

	if _, ok := scratch.Snapshot(); ok {
		t.Error("an ephemeral session produced a snapshot")
	}
	snap, ok := member.Snapshot()
	if !ok {
		t.Fatal("a grouped member produced no snapshot")
	}
	if snap.Group != anchor.ID() {
		t.Fatalf("snapshot Group = %q, want %q", snap.Group, anchor.ID())
	}

	// And the revival hands the link back.
	_ = member.Close()
	r2 := NewRegistry(nil)
	revived, err := r2.Revive(snap)
	if err != nil {
		t.Fatalf("Revive: %v", err)
	}
	t.Cleanup(func() { _ = revived.Close() })
	if got := revived.Info().Group; got != anchor.ID() {
		t.Errorf("revived Group = %q, want %q", got, anchor.ID())
	}
	if revived.Info().Ephemeral {
		t.Error("revived session reports Ephemeral = true")
	}
}
