package relay

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// fakeDirectory is the Worker's fleet directory leg, in process: the three
// shapes of `/directory` on one URL, content-addressed the way
// relay/src/directory.ts is, with the same refusals for the same reasons.
//
// It models the *protocol*, not the class — bearer on the write and the
// socket, none required on the read, blobs stored under the hex SHA-256 of
// their own bytes, standard base64 with padding on the way out, one binary
// message of exactly the blob on every push — so a test against it is a test
// against the contract part A shipped. Where a test needs the relay to
// misbehave (serve a truncated set, hand out a blob nobody signed, answer 507)
// it sets a field rather than being handed a different fake: the daemon must
// not be able to tell the two apart until it checks a signature.
type fakeDirectory struct {
	ts     *httptest.Server
	secret string

	// full makes every PUT answer 507, the way a directory at MAX_ENTRIES
	// does. tooLarge does the same with 413.
	full     bool
	tooLarge bool
	// truncate, when positive, is how many entries a GET will answer with,
	// however many are stored — a hostile or broken relay serving a partial
	// set.
	truncate int
	// hideAll makes GET answer an empty set while the store keeps everything,
	// which is the strongest thing a relay can do to this leg.
	hideAll bool

	mu sync.Mutex
	// blobs is the store, keyed by digest, in insertion order.
	order []string
	blobs map[string][]byte
	// puts is every blob the daemon offered, in order, duplicates included:
	// what a test asserts publishing on.
	puts [][]byte
	// gets counts reads that were answered with a body; notModified counts the
	// ones answered 304 because the caller already had this set.
	gets        int
	notModified int
	ifNoneMatch []string
	auths       []string
	socks       []*websocket.Conn
}

func newFakeDirectory(t *testing.T, secret string) *fakeDirectory {
	t.Helper()
	d := &fakeDirectory{secret: secret, blobs: map[string][]byte{}}
	mux := http.NewServeMux()
	mux.HandleFunc("/directory", d.serve)
	d.ts = httptest.NewServer(mux)
	t.Cleanup(func() {
		d.closeSockets()
		d.ts.Close()
	})
	return d
}

// URL is the address relay.json would hold: the bare host, ws:// because
// httptest serves plain HTTP. NewDirectory derives both the socket URL and the
// HTTP one from it, which is the property that keeps a fleet's certificates
// going to the host the daemon leg dials.
func (d *fakeDirectory) URL() string {
	return "ws" + strings.TrimPrefix(d.ts.URL, "http")
}

func (d *fakeDirectory) serve(w http.ResponseWriter, r *http.Request) {
	auth := r.Header.Get("Authorization")
	d.mu.Lock()
	d.auths = append(d.auths, auth)
	d.mu.Unlock()
	authorized := auth == "Bearer "+d.secret

	if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		if !authorized {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		d.serveSocket(w, r)
		return
	}
	switch r.Method {
	case http.MethodPut:
		if !authorized {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		d.put(w, r)
	case http.MethodGet:
		d.get(w, r)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (d *fakeDirectory) put(w http.ResponseWriter, r *http.Request) {
	blob, err := io.ReadAll(io.LimitReader(r.Body, maxBlobBytes+1))
	if err != nil {
		http.Error(w, "unreadable", http.StatusBadRequest)
		return
	}
	d.mu.Lock()
	d.puts = append(d.puts, blob)
	full, tooLarge := d.full, d.tooLarge
	d.mu.Unlock()

	switch {
	case len(blob) == 0:
		writeJSONStatus(w, http.StatusBadRequest, map[string]string{"error": "empty blob"})
		return
	case tooLarge || len(blob) > maxBlobBytes:
		writeJSONStatus(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "blob too large"})
		return
	case full:
		writeJSONStatus(w, http.StatusInsufficientStorage, map[string]string{"error": "directory full"})
		return
	}

	key := digestOf(blob)
	d.mu.Lock()
	_, had := d.blobs[key]
	if !had {
		d.blobs[key] = blob
		d.order = append(d.order, key)
	}
	d.mu.Unlock()
	if had {
		// Same bytes, same key: no write, no push. A daemon that re-offers its
		// whole set on every reconnect costs the object nothing.
		writeJSONStatus(w, http.StatusOK, map[string]string{"key": key})
		return
	}
	d.push(blob)
	writeJSONStatus(w, http.StatusCreated, map[string]string{"key": key})
}

// get answers the snapshot, conditionally.
//
// The Worker's ETag is a version counter it bumps on every write (see
// relay/src/directory.ts); this fake hashes the keys it is about to serve
// instead, and the difference is deliberate. A counter is right there because
// only a write changes the answer. Here the answer also changes when a test
// flips `truncate` or `hideAll` to play a hostile relay, and a counter would go
// on claiming the set was unchanged while the body moved underneath. Hashing
// what is served keeps the one promise the daemon leans on — the same tag means
// the same bytes — under a fake whose whole purpose is to misbehave.
func (d *fakeDirectory) get(w http.ResponseWriter, r *http.Request) {
	d.mu.Lock()
	entries := []map[string]any{}
	limit := len(d.order)
	if d.hideAll {
		limit = 0
	} else if d.truncate > 0 && d.truncate < limit {
		limit = d.truncate
	}
	served := d.order[:limit]
	for _, k := range served {
		entries = append(entries, map[string]any{"key": k, "blob": d.blobs[k]})
	}
	etag := `"` + digestOf([]byte(strings.Join(served, ","))) + `"`
	cond := r.Header.Get("If-None-Match")
	d.ifNoneMatch = append(d.ifNoneMatch, cond)
	if cond != "" && cond == etag {
		d.notModified++
		d.mu.Unlock()
		w.Header().Set("ETag", etag)
		w.WriteHeader(http.StatusNotModified)
		return
	}
	d.gets++
	d.mu.Unlock()
	w.Header().Set("ETag", etag)
	// encoding/json writes a []byte as standard base64 with padding, which is
	// the alphabet the Worker's own answer uses.
	writeJSONStatus(w, http.StatusOK, map[string]any{"v": 1, "entries": entries})
}

// reads is what the fake was asked for: bodies served, and reads answered 304
// because the caller already held that set.
func (d *fakeDirectory) reads() (bodies, notModified int) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.gets, d.notModified
}

// serveSocket accepts a push socket and holds it, answering flue-ping the way
// the Cloudflare edge does from the Durable Object's auto-response.
func (d *fakeDirectory) serveSocket(w http.ResponseWriter, r *http.Request) {
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer ws.CloseNow()
	d.mu.Lock()
	d.socks = append(d.socks, ws)
	d.mu.Unlock()
	for {
		typ, data, err := ws.Read(r.Context())
		if err != nil {
			return
		}
		if typ == websocket.MessageText && string(data) == "flue-ping" {
			ctx, cancel := contextWithTimeout(waitFor)
			_ = ws.Write(ctx, websocket.MessageText, []byte("flue-pong"))
			cancel()
		}
	}
}

// push sends one blob, raw, to every socket — no envelope and no key, exactly
// as the Durable Object does.
func (d *fakeDirectory) push(blob []byte) {
	d.mu.Lock()
	socks := append([]*websocket.Conn(nil), d.socks...)
	d.mu.Unlock()
	for _, ws := range socks {
		ctx, cancel := contextWithTimeout(waitFor)
		_ = ws.Write(ctx, websocket.MessageBinary, blob)
		cancel()
	}
}

// store puts a blob into the directory without going through a daemon: what
// some *other* machine in the fleet published, which is the whole point of the
// thing. It pushes, so a connected daemon hears it.
func (d *fakeDirectory) store(blob []byte) {
	key := digestOf(blob)
	d.mu.Lock()
	_, had := d.blobs[key]
	if !had {
		d.blobs[key] = blob
		d.order = append(d.order, key)
	}
	d.mu.Unlock()
	if !had {
		d.push(blob)
	}
}

// published reports whether this exact blob was ever PUT by the daemon.
func (d *fakeDirectory) published(blob []byte) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	want := digestOf(blob)
	for _, p := range d.puts {
		if digestOf(p) == want {
			return true
		}
	}
	return false
}

// awaitPublished waits for the daemon to have offered this blob.
func (d *fakeDirectory) awaitPublished(t *testing.T, blob []byte, what string) {
	t.Helper()
	deadline := time.Now().Add(waitFor)
	for {
		if d.published(blob) {
			return
		}
		if time.Now().After(deadline) {
			d.mu.Lock()
			n := len(d.puts)
			d.mu.Unlock()
			t.Fatalf("the daemon never published %s within %s (%d writes seen)", what, waitFor, n)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// readCount is how many times the daemon has *asked*, which is the question
// every caller of awaitRead is really asking. Bodies and 304s both count: a
// reconnect against an unchanged directory still performed its catch-up read,
// and answering it cheaply is the point of the conditional GET rather than a
// read that did not happen.
func (d *fakeDirectory) readCount() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.gets + d.notModified
}

// awaitRead waits until at least n reads have been answered, which is how a
// test knows the snapshot it staged has been consumed.
func (d *fakeDirectory) awaitRead(t *testing.T, n int) {
	t.Helper()
	deadline := time.Now().Add(waitFor)
	for {
		if d.readCount() >= n {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("the daemon read the directory %d times in %s, want at least %d", d.readCount(), waitFor, n)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (d *fakeDirectory) closeSockets() {
	d.mu.Lock()
	socks := append([]*websocket.Conn(nil), d.socks...)
	d.socks = nil
	d.mu.Unlock()
	for _, ws := range socks {
		_ = ws.CloseNow()
	}
}

// The knobs are set through methods rather than fields: the handler reads them
// on the server's own goroutines, and a test that flips one mid-flight — which
// is exactly how "the relay stops lying" is staged — would otherwise be racing
// them.
func (d *fakeDirectory) setFull(v bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.full = v
}

func (d *fakeDirectory) setTooLarge(v bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.tooLarge = v
}

func (d *fakeDirectory) setServing(truncate int, hideAll bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.truncate, d.hideAll = truncate, hideAll
}

func digestOf(blob []byte) string {
	sum := sha256.Sum256(blob)
	return hex.EncodeToString(sum[:])
}

func writeJSONStatus(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
