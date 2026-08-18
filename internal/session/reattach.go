package session

import (
	"os"
	"path/filepath"
)

// ReattachHolders walks the holders root a previous daemon left behind and
// rebuilds a registry entry for every holder still alive: dial the socket,
// hello, and the session is back under its old id with its ring intact —
// nothing was ever lost, because nothing lived in the old daemon.
//
// A directory whose holder cannot be dialed is swept: the holder is gone
// (machine reboot, self-reap, a crash), so the socket answers nothing and
// the identity record describes a session that no longer runs. Sweeping is
// safe precisely because the revival state lives elsewhere — a holder that
// went down to SIGTERM wrote its snapshot into the snapshots directory, and
// the caller's revive pass picks that up after this one.
//
// It runs before anything serves, so the registry lock discipline is not
// under pressure here; it still takes r.mu per insert like every other path.
func ReattachHolders(r *Registry, root string) (reattached, swept int) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return 0, 0
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dir := filepath.Join(root, e.Name())
		rec, err := LoadIdentity(dir)
		if err != nil {
			_ = os.RemoveAll(dir)
			swept++
			continue
		}
		rem, err := DialRemote(dir, rec, r.clock)
		if err != nil {
			_ = os.RemoveAll(dir)
			swept++
			continue
		}
		r.mu.Lock()
		r.sessions[rem.ID()] = rem
		r.mu.Unlock()
		reattached++
	}
	return reattached, swept
}
