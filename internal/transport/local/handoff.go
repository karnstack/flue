package local

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"time"
)

// HandoffTTL is how long a minted handoff token stays redeemable.
//
// Seconds, not minutes, because flue open launches the browser on the very
// next line: the budget is one process spawn plus a browser's startup-to-first-
// request, not a human's attention span. Ten seconds is comfortable for a cold
// browser start and still short enough that a token found afterwards — in a
// terminal buffer, in a screenshot, in a strace — is inert.
const HandoffTTL = 10 * time.Second

// maxOutstandingHandoffs bounds the in-memory store. Minting is authenticated,
// so this is a bound on accident (a script looping flue open) rather than on
// attack, but an unbounded store fed by a loop is still a defect. When the cap
// is reached the oldest entry is dropped: entries are appended in mint order
// and share one TTL, so index 0 is always the oldest.
const maxOutstandingHandoffs = 32

// HandoffParam is the query parameter flue open puts a handoff token in. The
// session token is never accepted from a URL under any parameter name.
const HandoffParam = "h"

// handoff is one outstanding one-time token.
//
// The store is in memory only: nothing here is written to disk, and this package
// logs nothing at all. The token does reach two of the CLI's terminal writeouts
// — flue serve's startup banner, and flue open's fallback when launching the
// browser failed — and that is a deliberate exception rather than an oversight.
// What lands in scrollback is single-use and dead within HandoffTTL, so it is
// worth nothing by the time anyone reads it; the permanent session token, which
// those lines used to carry, was not.
type handoff struct {
	token   string
	expires time.Time
}

// Mint issues a fresh single-use handoff token.
//
// The caller must have proved it may mint — see CheckMint. Mint itself performs
// no authentication, so it must never be reachable from a handler that has not
// run that check.
func (a *Auth) Mint() (string, error) {
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	tok := hex.EncodeToString(raw[:])

	a.mu.Lock()
	defer a.mu.Unlock()

	now := a.now()
	a.pruneLocked(now)
	for len(a.handoffs) >= maxOutstandingHandoffs {
		a.removeAtLocked(0)
	}
	a.handoffs = append(a.handoffs, handoff{token: tok, expires: now.Add(HandoffTTL)})
	return tok, nil
}

// Redeem spends tok, reporting whether it was a live handoff token.
//
// Single use is enforced by doing the lookup and the removal inside one
// critical section. Two concurrent redemptions of the same token therefore
// serialise: the first removes it, the second scans a store that no longer
// holds it, and exactly one of them can observe true. There is no
// read-then-write window and no compare-and-swap to get wrong.
//
// A presented token is removed whether or not it was still valid. Leaving an
// expired one in place would break the rule that "presented once" implies
// "gone" — and would make it live again if the clock ever moved backwards
// under it (a manual date(1), an NTP step).
//
// The scan compares every entry with crypto/subtle and does not stop at the
// first match, so the work done depends on the store's size rather than on how
// close tok is to anything in it. At a few dozen entries that costs nothing.
func (a *Auth) Redeem(tok string) bool {
	if tok == "" {
		return false
	}

	a.mu.Lock()
	defer a.mu.Unlock()

	now := a.now()
	found := -1
	for i, h := range a.handoffs {
		// The compare is first, so it runs for every entry regardless of
		// whether a match has already been recorded.
		if subtle.ConstantTimeCompare([]byte(h.token), []byte(tok)) == 1 && found < 0 {
			found = i
		}
	}
	if found < 0 {
		a.pruneLocked(now)
		return false
	}

	spent := a.handoffs[found]
	a.removeAtLocked(found)
	a.pruneLocked(now)
	return now.Before(spent.expires)
}

// removeAtLocked deletes entry i, keeping the remaining entries in mint order.
// The caller holds a.mu.
func (a *Auth) removeAtLocked(i int) {
	copy(a.handoffs[i:], a.handoffs[i+1:])
	// Clear the vacated tail slot rather than just re-slicing past it: the
	// backing array outlives the slice header, and leaving a dropped token
	// referenced there would keep a spent secret reachable for no reason.
	a.handoffs[len(a.handoffs)-1] = handoff{}
	a.handoffs = a.handoffs[:len(a.handoffs)-1]
}

// pruneLocked drops expired entries. The caller holds a.mu.
func (a *Auth) pruneLocked(now time.Time) {
	for i := len(a.handoffs) - 1; i >= 0; i-- {
		if !now.Before(a.handoffs[i].expires) {
			a.removeAtLocked(i)
		}
	}
}

// outstanding reports how many handoff tokens the store holds. Tests only.
func (a *Auth) outstanding() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.handoffs)
}
