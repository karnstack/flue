package daemon

import (
	"slices"
	"testing"

	"github.com/karnstack/flue/internal/session"
	"github.com/karnstack/flue/internal/wire"
)

// TestWelcomeAnnouncesMultiplex pins the capability the web client
// feature-detects the split and scratch affordances on. Dropping it from the
// welcome silently hides both from every client, which is why it is a test
// and not just a literal in conn.go.
func TestWelcomeAnnouncesMultiplex(t *testing.T) {
	ts, _ := newTestServer(t)
	c := dial(t, ts)

	readUntil(t, c, func(msg any, _ []byte) bool {
		w, ok := msg.(wire.Welcome)
		if !ok {
			return false
		}
		if !slices.Contains(w.Caps, "multiplex") {
			t.Fatalf("welcome caps = %v, want to contain %q", w.Caps, "multiplex")
		}
		return true
	})
}

// TestSpawnCarriesGroupAndEphemeralOverTheWire: the optional spawn fields
// reach the registry, and the session list hands them back — which is how a
// group view learns its members and a list knows what to fold away.
func TestSpawnCarriesGroupAndEphemeralOverTheWire(t *testing.T) {
	ts, reg := newTestServer(t)
	anchor, err := reg.Spawn(session.SpawnOpts{Cmd: []string{"sleep", "2"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer anchor.Close()

	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Spawn{
		Cmd: []string{"sleep", "2"}, Cols: 80, Rows: 24,
		Group: anchor.ID(), Ephemeral: true, ReqID: 5,
	})

	var spawned string
	readUntil(t, c, func(msg any, _ []byte) bool {
		a, ok := msg.(wire.Attached)
		if !ok || a.ReqID != 5 {
			return false
		}
		spawned = a.ID
		return true
	})

	s, ok := reg.Get(spawned)
	if !ok {
		t.Fatalf("spawned session %q not in the registry", spawned)
	}
	defer s.Close()
	info := s.Info()
	if info.Group != anchor.ID() {
		t.Errorf("Group = %q, want %q", info.Group, anchor.ID())
	}
	if !info.Ephemeral {
		t.Error("Ephemeral = false, want true")
	}

	// And the list reports what the spawn declared.
	writeControl(t, c, wire.List{})
	readUntil(t, c, func(msg any, _ []byte) bool {
		l, ok := msg.(wire.Sessions)
		if !ok {
			return false
		}
		for _, row := range l.Sessions {
			if row.ID == spawned {
				if row.Group != anchor.ID() || !row.Ephemeral {
					t.Errorf("listed row group=%q ephemeral=%v, want %q true",
						row.Group, row.Ephemeral, anchor.ID())
				}
				return true
			}
		}
		return false
	})
}

// TestUpdateClearsEphemeralOverTheWire is the wire half of the keep
// affordance: an update carrying ephemeral=false promotes the scratch, and
// one carrying no ephemeral field leaves the flag alone.
func TestUpdateClearsEphemeralOverTheWire(t *testing.T) {
	ts, reg := newTestServer(t)
	anchor, err := reg.Spawn(session.SpawnOpts{Cmd: []string{"sleep", "2"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer anchor.Close()
	scratch, err := reg.Spawn(session.SpawnOpts{
		Cmd: []string{"sleep", "2"}, Cols: 80, Rows: 24,
		Group: anchor.ID(), Ephemeral: true,
	})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer scratch.Close()

	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})

	// An edit about something else must not touch the flag.
	name := "kept name"
	writeControl(t, c, wire.Update{ID: scratch.ID(), Name: &name})
	readUntil(t, c, func(msg any, _ []byte) bool { _, ok := msg.(wire.Sessions); return ok })
	if info := scratch.Info(); !info.Ephemeral || info.Name != name {
		t.Fatalf("after a name edit: ephemeral=%v name=%q, want true %q", info.Ephemeral, info.Name, name)
	}

	kept := false
	writeControl(t, c, wire.Update{ID: scratch.ID(), Ephemeral: &kept})
	readUntil(t, c, func(msg any, _ []byte) bool { _, ok := msg.(wire.Sessions); return ok })
	if info := scratch.Info(); info.Ephemeral {
		t.Fatal("Ephemeral still true after the clearing update")
	}
}
