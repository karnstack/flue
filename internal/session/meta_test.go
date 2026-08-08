package session

import (
	"errors"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// TestSpawnStampsCreatedAtAndEmptyTags pins the two fields a session is born
// with rather than given. CreatedAt comes from the registry's clock, so it is
// the one timestamp a session can never be talked out of — LastActive moves
// with every keystroke, and a list sorted by it reshuffles under the reader's
// cursor. Tags start as an empty slice and not as nil, because nil marshals
// to JSON null and every client would then have to guard a field that is
// never meaningfully absent.
func TestSpawnStampsCreatedAtAndEmptyTags(t *testing.T) {
	now := time.Now()
	r := NewRegistry(func() time.Time { return now })
	s := spawnRunning(t, r)

	info := s.Info()
	if !info.CreatedAt.Equal(now) {
		t.Errorf("CreatedAt = %v, want the registry clock's %v", info.CreatedAt, now)
	}
	if info.Tags == nil {
		t.Error("Tags = nil, want an empty slice: nil serialises as JSON null")
	}
	if len(info.Tags) != 0 {
		t.Errorf("Tags = %v, want empty", info.Tags)
	}
	if info.Name != "" {
		t.Errorf("Name = %q, want empty until a human names it", info.Name)
	}
	if info.Pinned {
		t.Error("Pinned = true, want false")
	}
}

// TestApplyMetaPartialUpdate is the whole point of MetaPatch: a nil field
// means "leave this alone", so two clients editing different fields of the
// same session cannot clobber each other by round-tripping stale values.
//
// Every field is seeded with a non-zero value before the first single-field
// patch, and that ordering is the test rather than a preamble to it. Patch a
// session whose tags are empty and whose pin is false and "left alone" and
// "cleared" produce the same snapshot, so the assertion holds just as well
// against an ApplyMeta that zeroes every field it was not given.
//
// The clock advances on every reading for the same reason. LastActive must
// not move — naming a session is not activity in it — but against a clock
// frozen at one value, an ApplyMeta that stamped LastActive would stamp it
// with exactly the value the assertion compares against and pass.
func TestApplyMetaPartialUpdate(t *testing.T) {
	epoch := time.Now()
	var ticks atomic.Int64
	r := NewRegistry(func() time.Time {
		return epoch.Add(time.Duration(ticks.Add(1)) * time.Second)
	})
	s := spawnRunning(t, r)

	seedName, seedTags, seedPinned := "seed", []string{"prod", "web"}, true
	s.ApplyMeta(MetaPatch{Name: &seedName, Tags: &seedTags, Pinned: &seedPinned})
	before := s.Info()

	// Name only: tags and pin must survive, and each patch moves its field to
	// a value the seed did not have, so applying it is observable too.
	name := "deploy"
	got := s.ApplyMeta(MetaPatch{Name: &name})
	if got.Name != "deploy" {
		t.Errorf("Name = %q, want %q", got.Name, "deploy")
	}
	if !slices.Equal(got.Tags, []string{"prod", "web"}) {
		t.Errorf("Tags = %#v after a name-only patch, want the seeded pair", got.Tags)
	}
	if !got.Pinned {
		t.Error("Pinned = false after a name-only patch, want the seeded true")
	}
	if !got.CreatedAt.Equal(before.CreatedAt) {
		t.Errorf("CreatedAt = %v, want the unchanged %v", got.CreatedAt, before.CreatedAt)
	}
	if !got.LastActive.Equal(before.LastActive) {
		t.Errorf("LastActive = %v, want the unchanged %v: a rename is not activity",
			got.LastActive, before.LastActive)
	}
	if got.ID != before.ID || got.Cwd != before.Cwd || got.State != before.State {
		t.Errorf("patch disturbed identity or state: %+v, was %+v", got, before)
	}

	// Pin only, and unpinning rather than pinning — against a seed of false
	// the write and the accidental zeroing would again be the same outcome.
	pinned := false
	got = s.ApplyMeta(MetaPatch{Pinned: &pinned})
	if got.Pinned {
		t.Error("Pinned = true after a patch setting it false")
	}
	if got.Name != "deploy" {
		t.Errorf("Name = %q after a pin-only patch, want the earlier %q", got.Name, "deploy")
	}
	if !slices.Equal(got.Tags, []string{"prod", "web"}) {
		t.Errorf("Tags = %#v after a pin-only patch, want the seeded pair", got.Tags)
	}

	// Tags only.
	tags := []string{"api"}
	got = s.ApplyMeta(MetaPatch{Tags: &tags})
	if !slices.Equal(got.Tags, []string{"api"}) {
		t.Errorf("Tags = %#v, want [api]", got.Tags)
	}
	if got.Name != "deploy" {
		t.Errorf("Name = %q after a tags-only patch, want the earlier %q", got.Name, "deploy")
	}
	if got.Pinned {
		t.Error("Pinned = true after a tags-only patch, want the earlier false")
	}
	if !got.LastActive.Equal(before.LastActive) {
		t.Errorf("LastActive = %v, want the unchanged %v", got.LastActive, before.LastActive)
	}

	// The returned snapshot is not a courtesy copy of the patch: it is what
	// the next reader sees, which is what lets a caller answer a client
	// without a second round trip through Info.
	live := s.Info()
	if live.Name != got.Name || live.Pinned != got.Pinned || !slices.Equal(live.Tags, got.Tags) {
		t.Errorf("Info() = %+v, want it to agree with ApplyMeta's %+v", live, got)
	}
}

// TestApplyMetaNormalizesTags fixes the shape tags are stored in, once, at the
// edge — so that filtering, grouping and equality downstream never have to
// wonder whether " prod" and "prod" are the same tag. The cases run in order
// against one session on purpose: each patch replaces the whole set, so a
// later case clearing what an earlier one wrote is part of what is asserted.
func TestApplyMetaNormalizesTags(t *testing.T) {
	r := NewRegistry(time.Now)
	s := spawnRunning(t, r)

	cases := []struct {
		name string
		in   []string
		want []string
	}{
		{"trims, drops empties, dedupes and sorts", []string{" b ", "a", "b", ""}, []string{"a", "b"}},
		{"blank-only input clears the set", []string{"  ", "\t", ""}, []string{}},
		{"repopulates", []string{"prod", "web"}, []string{"prod", "web"}},
		{"a nil slice clears rather than nils", nil, []string{}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			in := c.in
			got := s.ApplyMeta(MetaPatch{Tags: &in}).Tags
			if got == nil {
				t.Fatal("Tags = nil, want an empty slice")
			}
			if !slices.Equal(got, c.want) {
				t.Fatalf("Tags = %#v, want %#v", got, c.want)
			}
			// No spare capacity, so a consumer that appends to the snapshot
			// gets a new array instead of writing into the one the session is
			// still handing to every other reader.
			if cap(got) != len(got) {
				t.Fatalf("cap(Tags) = %d, len = %d: the snapshot shares room to append into",
					cap(got), len(got))
			}
		})
	}
}

// TestUpdateMetaUnknownID covers the registry's half of the contract. A
// client editing a session that has just been reaped is ordinary rather than
// exceptional, so the caller needs a sentinel it can turn into a polite
// answer instead of an error string it has to match on.
func TestUpdateMetaUnknownID(t *testing.T) {
	r := NewRegistry(time.Now)
	name := "ghost"
	info, err := r.UpdateMeta("nope", MetaPatch{Name: &name})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("UpdateMeta(unknown) error = %v, want ErrNotFound", err)
	}
	if info.ID != "" {
		t.Errorf("UpdateMeta(unknown) info = %+v, want the zero Info", info)
	}
}

// TestUpdateMetaAppliesToTheSession is the path every wire-level edit will
// take: look the session up, patch it, hand back the snapshot to broadcast.
func TestUpdateMetaAppliesToTheSession(t *testing.T) {
	r := NewRegistry(time.Now)
	s := spawnRunning(t, r)

	name, tags, pinned := "api", []string{"web", "prod"}, true
	got, err := r.UpdateMeta(s.ID(), MetaPatch{Name: &name, Tags: &tags, Pinned: &pinned})
	if err != nil {
		t.Fatalf("UpdateMeta: %v", err)
	}
	if got.ID != s.ID() {
		t.Errorf("ID = %q, want %q", got.ID, s.ID())
	}
	if got.Name != "api" || !got.Pinned {
		t.Errorf("got %+v, want name %q and pinned", got, "api")
	}
	if !slices.Equal(got.Tags, []string{"prod", "web"}) {
		t.Errorf("Tags = %#v, want them sorted", got.Tags)
	}
	if live := s.Info(); live.Name != "api" || !live.Pinned {
		t.Errorf("Info() = %+v, want UpdateMeta's edit visible on the session", live)
	}
}

// TestCreatedAtSurvivesConcurrentInfo runs the readers and the writers over
// each other so that the race detector can say whether the snapshot Info
// hands out is really a snapshot.
//
// Two things could go wrong and only one of them is about locking. ApplyMeta
// could take s.mu correctly and still hand out a slice it does not own — the
// caller's — and a reader walking that slice while the caller reuses its
// buffer is a data race no lock in this package can see. So the writers below
// scribble over their input the instant ApplyMeta returns.
func TestCreatedAtSurvivesConcurrentInfo(t *testing.T) {
	r := NewRegistry(time.Now)
	s := spawnRunning(t, r)

	created := s.Info().CreatedAt
	if created.IsZero() {
		t.Fatal("CreatedAt is zero, so this test would assert nothing")
	}

	// Each patch names the session and gives it that name as a tag, so every
	// snapshot a reader catches is self-describing: whatever Tags says, Name
	// has to agree with it, and a patch observed half-applied would show up as
	// the two disagreeing.
	const rounds = 300
	writer := func(prefix string) {
		for i := 0; i < rounds; i++ {
			name := prefix + strconv.Itoa(i)
			tags := []string{" " + name + " ", "shared", "shared"}
			pinned := i%2 == 0
			s.ApplyMeta(MetaPatch{Name: &name, Tags: &tags, Pinned: &pinned})
			tags[0] = "clobbered"
		}
	}
	check := func(info Info) bool {
		if !info.CreatedAt.Equal(created) {
			t.Errorf("CreatedAt = %v, want the spawn-time %v", info.CreatedAt, created)
			return false
		}
		if info.Tags == nil {
			t.Error("Tags = nil under concurrent patching")
			return false
		}
		for _, tag := range info.Tags {
			if tag == "clobbered" {
				t.Errorf("Tags = %#v: ApplyMeta kept the caller's slice", info.Tags)
				return false
			}
			if tag != strings.TrimSpace(tag) || tag == "" {
				t.Errorf("Tags = %#v, want every tag normalised", info.Tags)
				return false
			}
		}
		if !slices.IsSorted(info.Tags) {
			t.Errorf("Tags = %#v, want them sorted", info.Tags)
			return false
		}
		return true
	}

	var writers sync.WaitGroup
	writers.Add(2)
	go func() { defer writers.Done(); writer("a") }()
	go func() { defer writers.Done(); writer("b") }()
	written := make(chan struct{})
	go func() { writers.Wait(); close(written) }()

	// The reader runs until the writers are done rather than for a fixed
	// number of turns. A counted loop finishes in microseconds and can easily
	// be over before the first writer is scheduled, which makes the whole
	// exercise pass on a session nobody has patched yet.
	read := make(chan struct{})
	go func() {
		defer close(read)
		saw := 0
		for {
			info := s.Info()
			if !check(info) {
				return
			}
			if info.Name != "" {
				saw++
			}
			select {
			case <-written:
				// One last reading before the guard, because the goroutine
				// can be descheduled anywhere in this loop — on a single
				// processor, reliably between the count above and this
				// select. Without it, "saw nothing" means "lost a scheduling
				// race" as often as it means "the writers never ran", and the
				// test flakes on a session that was patched six hundred times.
				if s.Info().Name != "" {
					saw++
				}
				if saw == 0 {
					t.Error("the reader never caught a patched session, so this proved nothing")
				}
				return
			default:
			}
		}
	}()
	<-read
	writers.Wait()

	// Whichever writer went last, it left the session with its own name and
	// exactly two tags — the duplicate "shared" folded away, the name trimmed.
	final := s.Info()
	if !check(final) {
		return
	}
	if !slices.Equal(final.Tags, []string{final.Name, "shared"}) {
		t.Errorf("final Tags = %#v, want [%q shared]", final.Tags, final.Name)
	}
}
