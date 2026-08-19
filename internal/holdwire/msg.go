package holdwire

import (
	"encoding/json"
	"time"
)

// Req is one request on a control connection, or the attach header on an
// attach connection. Requests are serialized per connection and every one
// is answered; ID ties the reply back when a caller pipelines.
type Req struct {
	ID   uint64 `json:"id"`
	Verb string `json:"verb"` // hello | spawn | write | resize | signal | tail | close | attach

	Spawn *SpawnReq `json:"spawn,omitempty"`
	// Data carries write payloads. encoding/json base64s []byte, which is
	// what keeps arbitrary terminal input inside a JSON frame.
	Data []byte `json:"data,omitempty"`
	Cols uint16 `json:"cols,omitempty"`
	Rows uint16 `json:"rows,omitempty"`
	// Sig is the raw signal number. Daemon and holder are always the same
	// machine and build architecture, so the number is unambiguous.
	Sig int `json:"sig,omitempty"`
	N   int `json:"n,omitempty"`
	// FromSeq is attach's resume point, Sub semantics exactly.
	FromSeq uint64 `json:"fromSeq,omitempty"`
}

// Resp answers one Req. Err is the whole error contract: empty is success,
// anything else is a message for the daemon's log and the caller's error.
type Resp struct {
	ID  uint64 `json:"id"`
	Err string `json:"err,omitempty"`

	Hello *Hello `json:"hello,omitempty"`
	// Data, Cols, Rows answer tail.
	Data []byte `json:"data,omitempty"`
	Cols uint16 `json:"cols,omitempty"`
	Rows uint16 `json:"rows,omitempty"`
	// StartSeq and Truncated head an attach stream, mirroring session.Sub.
	StartSeq  uint64 `json:"startSeq,omitempty"`
	Truncated bool   `json:"truncated,omitempty"`
}

// Event is pushed by the holder on a control connection, unprompted and
// without an ID. exit arrives once; title on every change; active at most
// once per second while output flows, so a list's LastActive ordering stays
// honest without a round trip per chunk.
type Event struct {
	Event string    `json:"event"` // exit | title | active
	Code  int       `json:"code,omitempty"`
	At    time.Time `json:"at,omitempty"`
	Title string    `json:"title,omitempty"`
}

// SpawnReq is a fully resolved spawn: the daemon has already decided the
// login shell, environment and working directory, and the holder execs
// exactly what it is told. Run is what execs; Argv is what Info reports —
// the same split registry.start keeps, for the same reason.
type SpawnReq struct {
	ID       string   `json:"id"`
	Run      []string `json:"run"`
	Argv     []string `json:"argv"`
	Env      []string `json:"env"`
	Cwd      string   `json:"cwd"`
	Cols     uint16   `json:"cols"`
	Rows     uint16   `json:"rows"`
	RingSize int      `json:"ringSize,omitempty"`
	Preload  []byte   `json:"preload,omitempty"`
	// Restore is a session.Info, carried raw: this package sits below the
	// session package (which imports it from the daemon side), so it cannot
	// name the type without a cycle. Both ends marshal the same struct.
	Restore   json.RawMessage `json:"restore,omitempty"`
	Group     string          `json:"group,omitempty"`
	Ephemeral bool            `json:"ephemeral,omitempty"`
}

// Hello is the holder's self-description: enough for a daemon that has just
// started to rebuild its registry entry from the socket alone.
type Hello struct {
	Proto   int    `json:"proto"`
	Version string `json:"version"` // flue version the holder runs
	Pid     int    `json:"pid"`     // the child's pid, 0 before spawn
	// Info is a session.Info, raw for the same reason as SpawnReq.Restore.
	Info    json.RawMessage `json:"info,omitempty"`
	BaseSeq uint64          `json:"baseSeq"`
	EndSeq  uint64          `json:"endSeq"`
}
