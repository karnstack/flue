package wire

import (
	"encoding/json"
	"fmt"

	"github.com/karnstack/flue/internal/session"
)

// Client -> server control messages.

type Hello struct {
	Ver  string   `json:"ver"`
	Caps []string `json:"caps,omitempty"`
}

type List struct{}

type Spawn struct {
	Cwd  string   `json:"cwd,omitempty"`
	Cmd  []string `json:"cmd,omitempty"`
	Cols uint16   `json:"cols"`
	Rows uint16   `json:"rows"`
	// ReqID correlates this request with the attached or error answering it.
	// Client-chosen; zero means the client asked for no correlation.
	ReqID uint64 `json:"reqId,omitempty"`
	// Group links the new session under an anchor session — a split pane, or a
	// tab in the anchor's group. Optional and additive: a daemon from before
	// the field ignores it, and the session simply spawns ungrouped.
	Group string `json:"group,omitempty"`
	// Ephemeral marks a scratch terminal: hidden by clients, reaped fast once
	// exited, and closed by the daemon when the Group parent ends. Optional
	// and additive like Group.
	Ephemeral bool `json:"ephemeral,omitempty"`
}

type Attach struct {
	ID      string `json:"id"`
	LastSeq uint64 `json:"lastSeq"`
	// ReqID correlates this request with the attached or error answering it.
	ReqID uint64 `json:"reqId,omitempty"`
}

type Detach struct {
	Ref uint32 `json:"ref"`
}

type Resize struct {
	Ref     uint32 `json:"ref"`
	Cols    uint16 `json:"cols"`
	Rows    uint16 `json:"rows"`
	Primary bool   `json:"primary"`
}

type Signal struct {
	Ref uint32 `json:"ref"`
	Sig string `json:"sig"`
}

// CloseSession ends a session, addressed one of two ways.
//
// Ref is the original spelling: an attachment handle, for a view that is
// looking at the session it is closing. ID arrived with the all-machines
// sessions list, which closes rows it never attached to — attaching first
// just to earn a ref would cost a subscribe, a backlog replay and a detach,
// all to deliver one verb. A message carries one address or the other; when
// both appear, the ref wins and the id is ignored, so the ref semantics are
// exactly what they always were.
//
// Both fields are omitempty because each is absent in the other's message.
// Zero is no loss to either: refs are numbered from 1, so ref 0 never names
// an attachment, and an empty id never names a session.
//
// No reply on success, by either address. The session's end announces itself:
// attached views get exit, and the list sees state "exited" on its next poll.
// An id the daemon does not hold is answered with error{not_found}, exactly
// as update answers it, and a ref this connection does not hold with
// error{bad_ref}.
type CloseSession struct {
	Ref uint32 `json:"ref,omitempty"`
	ID  string `json:"id,omitempty"`
}

// Update edits the metadata a human owns on a session — its name, its tags,
// whether it is pinned. Nothing the program inside the session says can reach
// these fields, and nothing here touches what that program says.
//
// Partial, and partial by construction: a field this message does not carry is
// a field the edit leaves alone. Two views on one session is the ordinary case,
// so a message that had to restate every field would undo whatever the other
// view changed since this one last read.
//
// Tags is a pointer to a slice for the one distinction a plain []string cannot
// keep: "the user removed the last tag" arrives as `[]` and "this edit is not
// about tags" arrives as nothing, and both decode to a nil slice. The shape
// mirrors session.MetaPatch field for field, so the daemon can hand the patch
// straight to the registry rather than rebuild it — a translation being exactly
// where that distinction would go missing.
//
// Answered by a fresh sessions to the connection that asked, or by
// error{not_found}. Only that connection: nothing broadcasts the edit, so a
// second browser sees it on its next list rather than the instant it lands.
type Update struct {
	ID     string    `json:"id"`
	Name   *string   `json:"name,omitempty"`
	Tags   *[]string `json:"tags,omitempty"`
	Pinned *bool     `json:"pinned,omitempty"`
	// Ephemeral exists for one edit: clearing it keeps a scratch terminal,
	// promoting it to an ordinary member of its group. A pointer for the same
	// reason the others are — absent means this edit is not about it.
	Ephemeral *bool `json:"ephemeral,omitempty"`
}

// Peek asks for the tail of a session's scrollback without attaching to it.
//
// It exists for the sessions list, which wants to show what a row is doing
// without becoming a subscriber to it. An attach would work and is the wrong
// shape: it costs a ref, a backlog replay, a delivery channel and a detach per
// row, and a list hovering over twenty sessions would leave twenty
// subscriptions behind it. This is a read and nothing else — no ref is minted,
// no stream starts, and the session's LastActive is not touched, because
// looking at a preview is not activity inside the session.
//
// Bytes caps how much of the tail is returned. Zero means the daemon's own
// default; anything above PeekMaxBytes is clamped to it rather than refused,
// since a client asking for too much wants as much as it can have.
//
// Answered by preview, or by error{not_found} for an id the daemon does not
// hold. ReqID correlates the two, because a list peeks at many rows at once
// and the answers arrive in whatever order the daemon reaches them.
type Peek struct {
	ID    string `json:"id"`
	Bytes int    `json:"bytes,omitempty"`
	// ReqID correlates this request with the preview or error answering it.
	ReqID uint64 `json:"reqId,omitempty"`
}

// Preview answers peek with raw terminal output — escape sequences and all,
// exactly as the ring holds them.
//
// Raw rather than rendered, because rendering is the client's job and it
// already owns a terminal emulator. A daemon that flattened this to text would
// have to make every decision an emulator makes — wrapping at which width,
// what a cursor move means, which of two overwrites won — and would make them
// differently from the emulator the same client uses to draw the session for
// real.
//
// Data is base64 on the wire, as encoding/json carries every []byte. It is the
// *tail*, so it will usually begin mid-escape-sequence; a consumer must expect
// to discard a partial sequence at the front rather than treat it as content.
type Preview struct {
	ID string `json:"id"`
	// Data is the raw tail of the session's scrollback.
	Data []byte `json:"data"`
	// Cols and Rows are the dimensions the bytes were drawn at, so a consumer
	// that replays them into an emulator can size it the way the session is.
	Cols uint16 `json:"cols"`
	Rows uint16 `json:"rows"`
	// ReqID echoes the reqId of the peek this answers.
	ReqID uint64 `json:"reqId,omitempty"`
}

// MarshalJSON writes an empty tail as "" rather than null.
//
// encoding/json carries a nil []byte as null, and a session that has produced
// no output at all is reached by the ordinary path rather than an exotic one.
// The client declares the field a string it base64-decodes, so null would
// throw on exactly the sessions that have least to show.
func (p Preview) MarshalJSON() ([]byte, error) {
	// The alias sheds this method, so json.Marshal below does not recurse.
	type alias Preview
	if p.Data == nil {
		p.Data = []byte{}
	}
	return json.Marshal(alias(p))
}

// Stat asks whether paths exist, resolved against a session's working
// directory.
//
// Plural because of who asks. The terminal underlines a path only once it is
// known to be real, and a hovered line carries several candidates: a message
// per candidate would be a round trip per candidate, on a link where the
// round trip is the cost. One message per hovered line is the shape the
// caller actually has.
//
// Paths are echoed back in Stats.Entries in the order they were asked about,
// so a client matches answers to the text it matched them from.
type Stat struct {
	ID    string   `json:"id"`
	Paths []string `json:"paths"`
	// ReqID correlates this request with the stats or error answering it.
	ReqID uint64 `json:"reqId,omitempty"`
}

// PathEntry is what one path turned out to be.
//
// Path is what was asked, not what it resolved to. Resolution is the daemon's
// (a leading ~, a relative path against the session's cwd, symlinks), and the
// client has no way to reproduce it — but it does need to know which of the
// candidates it sent this answers.
//
// A path that does not exist, or cannot be resolved at all, is Exists false
// with the rest left at zero. There is deliberately no error for it: "no" is
// the ordinary answer here, not a failure.
type PathEntry struct {
	Path   string `json:"path"`
	Exists bool   `json:"exists"`
	// Kind is "file", "dir" or "other". Empty when Exists is false.
	Kind string `json:"kind,omitempty"`
	// Size is bytes, and Mtime unix seconds — the same unit deviceList uses,
	// rather than the RFC 3339 strings sessions[] carries.
	Size  int64 `json:"size,omitempty"`
	Mtime int64 `json:"mtime,omitempty"`
}

// Stats answers stat, one entry per path asked about, in order.
type Stats struct {
	Entries []PathEntry `json:"entries"`
	// ReqID echoes the reqId of the stat this answers.
	ReqID uint64 `json:"reqId,omitempty"`
}

// MarshalJSON writes an empty list as [] rather than null, for the reason
// Sessions and DeviceList do: the client declares the field an array, and the
// zero value is exactly the path that would otherwise ship null.
func (s Stats) MarshalJSON() ([]byte, error) {
	// The alias sheds this method, so json.Marshal below does not recurse.
	type alias Stats
	if s.Entries == nil {
		s.Entries = []PathEntry{}
	}
	return json.Marshal(alias(s))
}

// Read starts reading one file, resolved against a session's working
// directory the way Stat resolves one.
//
// Answered by file, which mints the ref the content arrives under, or by an
// error naming why not. The reply is not the content: a file is streamed as
// FrameFile chunks under that ref and terminated by eof, because a WebSocket
// message is capped at 1 MiB by the relay and because a multi-megabyte frame
// would sit in front of the next keystroke.
type Read struct {
	ID   string `json:"id"`
	Path string `json:"path"`
	// ReqID correlates this request with the file or error answering it.
	ReqID uint64 `json:"reqId,omitempty"`
}

// File answers read: the stream is open and these are its terms.
//
// Ref is the handle every chunk carries, minted from the same counter
// attachments use — a read is structurally an attachment, and sharing the
// counter means the connection gains a kind of entry rather than a second
// numbering scheme.
//
// Path is the *resolved* path, unlike PathEntry.Path. A symlink means the file
// you get is not always the path you clicked, and the reader should be told
// what it actually opened.
type File struct {
	Ref  uint32 `json:"ref"`
	Path string `json:"path"`
	// Size is the file's real size, which is not always how much is sent: see
	// Truncated.
	Size int64 `json:"size"`
	// Mime is sniffed from the content, never from the extension.
	Mime string `json:"mime"`
	// Kind is "text" or "image". Anything else is refused rather than sent,
	// because a client has nothing useful to do with it.
	Kind string `json:"kind"`
	// Truncated says the file is longer than this daemon will send and only
	// its head is coming. Reported rather than hidden: a viewer that showed
	// 8 MiB of a 40 MiB file in silence would be lying about the file.
	Truncated bool `json:"truncated,omitempty"`
	// ReqID echoes the reqId of the read this answers.
	ReqID uint64 `json:"reqId,omitempty"`
}

// Eof says every byte of a read has been sent. It is the only way a client
// knows a stream ended rather than stalled.
type Eof struct {
	Ref uint32 `json:"ref"`
}

// Cancel abandons a read in flight — a viewer closed before its file finished
// arriving.
//
// Addressed by ref rather than by reqId, because the ref is what the daemon
// holds state under. A client that closed before its file arrived has no ref
// yet; it remembers the reqId as abandoned and cancels once the ref lands,
// exactly as it already does for an attach whose view went away mid-flight.
type Cancel struct {
	Ref uint32 `json:"ref"`
}

// Devices asks for the paired-device list.
type Devices struct{}

// Revoke removes a paired device. The daemon answers the requester with a
// fresh deviceList, and the revoked device's own connections with revoked.
type Revoke struct {
	DeviceID string `json:"deviceId"`
}

// PairStart enters pairing mode and is answered by pairing.
type PairStart struct{}

// PairCancel leaves pairing mode, invalidating any outstanding token.
type PairCancel struct{}

// Server -> client control messages.

type Welcome struct {
	DaemonID string   `json:"daemonId"`
	Host     string   `json:"host"`
	Ver      string   `json:"ver"`
	Caps     []string `json:"caps,omitempty"`
	// Relay is how this daemon is reachable from outside the machine, or nil
	// when it is not configured for a relay at all. See RelayInfo.
	Relay *RelayInfo `json:"relay,omitempty"`

	// FleetCert is this device's own fleet certificate — the signed blob it
	// presents to every *other* machine in the fleet to be admitted without a
	// second ceremony (spec/fleet-trust.md, rule 2) — or empty when there is
	// none to give.
	//
	// It rides the welcome because this connection is the one place the cert
	// can be handed over privately and to the right device at once: the socket
	// is inside Noise, so the relay carries ciphertext, and the far end has
	// already proved it holds the key the cert names. The alternative this
	// replaced was publishing every device cert to the credential-less
	// `GET /directory` and letting the browser find its own — which worked, and
	// put every device's public key and human label in a document anybody on
	// the internet could read, and spent one of the directory's 512 permanent
	// entries on every pairing ceremony ever performed.
	//
	// Empty for a loopback connection (no device identity to hand one to), for
	// a daemon with no fleet key, and for a device paired before the fleet key
	// existed. A client that gets none keeps whatever it already had.
	FleetCert []byte `json:"fleetCert,omitempty"`

	// FleetPub is the fleet's Ed25519 *public* key — what every certificate in
	// the fleet verifies under — or empty on a daemon that holds none.
	//
	// It rides the welcome for the reason FleetCert does, one level up. A
	// browser pins this key from the QR at pairing time and from nowhere else,
	// which was right and was also final: a browser that paired while its
	// machine held no fleet key pinned nothing, and nothing afterwards could
	// give it one, so it saw the single machine it paired with until somebody
	// ran the ceremony again. The certificate had the same problem and this
	// field is the same answer.
	//
	// Handing it over here is not trust-on-first-use, because of who is
	// speaking. A relayed connection is a Noise IK session the browser opened
	// against a static key it pinned out of band, so a key that arrives on it
	// is an authenticated statement from a party the browser already trusts,
	// not an assertion from an unknown peer: a hostile relay cannot forge the
	// session, and a daemon that could lie about this already holds the fleet
	// seed (it is in relay.json on every machine) and can therefore already
	// mint a certificate for any key it likes. The condition is enforced on the
	// receiving side, which is the only side that knows how it learned the
	// static key it is talking to: web/src/fleet/fleet.ts, adoptFleetKey, keeps
	// this only from a machine whose daemon key this browser pinned itself.
	//
	// The public half only, and never the seed. The seed rides the join line
	// between machines; a browser holding it could mint certificates for the
	// fleet, which is the one thing the layering in spec/fleet-trust.md exists
	// to keep out of a tab's reach.
	FleetPub []byte `json:"fleetPub,omitempty"`
}

// RelayInfo is the state of the daemon's relay leg.
//
// It rides the welcome because a client needs it to decide what to render the
// moment it is greeted — a QR that names an address a phone can reach, an
// honest "remote access is down" — and the connection's own opening frame is
// when it needs it. It also rides RelayState, which is how a daemon whose relay
// leg changed under a tab that was already open says so.
//
// A pointer on Welcome, so "no relay configured" is an absent field rather than
// an object saying "off". The client's type is a union of the three statuses,
// and a fourth state — present but empty — is one neither side has a meaning
// for. RelayState is a value, because a push has no field to omit and "off" is
// exactly what it exists to be able to say.
type RelayInfo struct {
	// Status is "connecting" while the daemon is dialling and "connected" once
	// the socket is up. "off" is a daemon with no relay: on a welcome it is
	// never sent — the whole field is omitted instead — but on a RelayState it
	// is spelled out, because a push that said nothing would say nothing.
	Status string `json:"status"`
	// Origin is the https origin the relay serves browsers on — the address a
	// pairing URL names while the relay is up. Empty unless Status is
	// "connected", because a socket that is not up carries nothing.
	Origin string `json:"origin,omitempty"`
	// MachineID is the slot this daemon holds on the relay — the <id> in the
	// /client/<id> URL a browser opens to reach this machine. It comes from
	// relay.json rather than from the socket, so it is present whenever the
	// relay is configured, connecting and connected alike.
	MachineID string `json:"machineId,omitempty"`
	// MachineName is the machine's human label, free text from the same file.
	// For lists and titles, never for URLs — that is what MachineID is for.
	MachineName string `json:"machineName,omitempty"`
	// NoFleetKey says this daemon is on a relay and cannot sign for its fleet:
	// relay.json carries no fleet key, or one this daemon cannot parse, or no
	// machine id for a certificate to name. A device paired while it is true
	// gets no fleet key pinned and no certificate minted — it reaches this
	// machine and nothing else, for the life of the pairing, because both of
	// those records are written exactly once by the ceremony. So the screen
	// that draws the QR refuses to draw one (routes/devices.tsx), the way it
	// already refuses a QR that could only name loopback.
	//
	// Stated as the fault rather than as a capability, deliberately: absent
	// means "this daemon said nothing about it", which is what an older build
	// on the other end of a relay-served tab says, and that must not read as a
	// refusal. It is also the reason this is a field on the welcome rather than
	// something the client infers — whether a *process* can sign is not
	// visible from any file the browser can see.
	NoFleetKey bool `json:"noFleetKey,omitempty"`
}

// RelayState is the relay leg's state pushed to every live connection, sent
// whenever it stops matching what was pushed last.
//
// The welcome alone was not enough, and the gap was not academic. A tab is
// greeted once and then holds that snapshot for as long as its socket lives,
// which on loopback is until it is closed; every relay a daemon gains, loses or
// re-dials underneath it happened after the only frame that ever mentioned one.
// Screens papered over the upgrade half by polling /api/relay/info, and that
// poll knows the transport's status and origin and nothing else — so a tab open
// across a `flue relay setup` learned it had a relay but never which machine it
// was on, and handed out pairing links that named no machine at all.
//
// Wrapped in a struct rather than being the message, so the payload is `relay`
// and reads the same as the field it replaces on the welcome. A client applies
// it over its stored welcome and re-announces that; nothing downstream has to
// know which of the two frames a fact arrived on.
type RelayState struct {
	Relay RelayInfo `json:"relay"`
}

type Sessions struct {
	Sessions []session.Info `json:"sessions"`
}

// MarshalJSON writes an empty list as [] rather than null, for the reason
// DeviceList does below.
//
// "The daemon is running nothing" is reached by building the zero value — the
// one path a nil slice takes to the wire. The field is not optional and the
// client declares it `SessionInfo[]`, so null would throw in every consumer
// that ranges over the list, and would do it on a fresh machine, which is the
// first list anyone sees.
func (s Sessions) MarshalJSON() ([]byte, error) {
	// The alias sheds this method, so json.Marshal below does not recurse.
	type alias Sessions
	if s.Sessions == nil {
		s.Sessions = []session.Info{}
	}
	return json.Marshal(alias(s))
}

type Attached struct {
	Ref       uint32 `json:"ref"`
	ID        string `json:"id"`
	Cols      uint16 `json:"cols"`
	Rows      uint16 `json:"rows"`
	Title     string `json:"title"`
	Seq       uint64 `json:"seq"`
	Truncated bool   `json:"truncated"`
	// Head is the offset one past the replayed backlog: bytes below Head are
	// history, bytes at or after it are live. Head == Seq means no backlog.
	Head    uint64 `json:"head"`
	Primary bool   `json:"primary"`
	// ReqID echoes the reqId of the attach or spawn this answers.
	ReqID uint64 `json:"reqId,omitempty"`
}

type Exit struct {
	Ref  uint32 `json:"ref"`
	Code int    `json:"code"`
}

type SizeChanged struct {
	Ref     uint32 `json:"ref"`
	Cols    uint16 `json:"cols"`
	Rows    uint16 `json:"rows"`
	Primary bool   `json:"primary"`
}

type Error struct {
	Code string `json:"code"`
	Msg  string `json:"msg"`
	// ReqID echoes the reqId of the request this error answers, when it
	// answers one — not_found and spawn_failed do; a lagged stream does not.
	ReqID uint64 `json:"reqId,omitempty"`
}

// DeviceInfo is one paired device as the wire reports it. Timestamps are unix
// seconds rather than the registry's time.Time, so a client reads them without
// parsing RFC 3339.
type DeviceInfo struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	PairedAt int64  `json:"pairedAt"`
	LastSeen int64  `json:"lastSeen"`
	// PairedOn is the machine that ran the ceremony this device came from —
	// the `pairedOn` of its fleet certificate, read from the signed blob and
	// not from anything the device said about itself.
	//
	// It is here so a Devices screen can tell its two kinds of row apart. A
	// machine on a fleet lists every device it admitted, and it admits two
	// ways: the ones it paired itself, and the ones it took on the fleet's word
	// when they turned up over the relay holding a certificate (rule 2,
	// spec/fleet-trust.md). Those read identically without this — a phone
	// paired on the laptop appears on the desktop looking exactly like a phone
	// paired on the desktop — and they are not identical at all: revoking the
	// second cuts it off every machine in the fleet, permanently.
	//
	// Empty for a device with no certificate (paired before the fleet key
	// existed) and for one whose certificate does not verify under the fleet
	// key this machine holds now. Both mean the same thing to a reader: nothing
	// signed says where this row came from, so it is treated as this machine's
	// own — the conservative direction, since it is the one that does not offer
	// a fleet-wide revoke on the strength of a blob that proved nothing.
	PairedOn string `json:"pairedOn,omitempty"`
}

// DeviceList answers devices, and follows a revoke that succeeded.
type DeviceList struct {
	Devices []DeviceInfo `json:"devices"`
}

// MarshalJSON writes an empty list as [] rather than null.
//
// A nil slice marshals to null by default, and "no devices are paired" is the
// one state a caller reaches by building the zero value — precisely the path
// that would ship null. The field is not optional and the client declares it
// `DeviceInfo[]`, so null would throw in every consumer that ranges over it.
// Normalising here rather than at each call site means no producer can get it
// wrong.
func (d DeviceList) MarshalJSON() ([]byte, error) {
	// The alias sheds this method, so json.Marshal below does not recurse.
	type alias DeviceList
	if d.Devices == nil {
		d.Devices = []DeviceInfo{}
	}
	return json.Marshal(alias(d))
}

// Pairing answers pairStart with the credentials the second device needs.
type Pairing struct {
	Token string `json:"token"`
	// URL is absolute: the /pair page on this origin, carrying the token.
	URL string `json:"url"`
	// DaemonPub is the daemon's static public key, base64.
	DaemonPub string `json:"daemonPub"`
	// ExpiresAt is unix seconds. The token is single-use and short-lived.
	ExpiresAt int64 `json:"expiresAt"`
}

// Revoked goes to the revoked device's own connections just before the daemon
// closes them, so the tab can say why rather than showing a bare disconnect.
type Revoked struct {
	Reason string `json:"reason"`
}

// typeName maps a message value to its wire discriminator.
func typeName(msg any) (string, bool) {
	switch msg.(type) {
	case Hello:
		return "hello", true
	case List:
		return "list", true
	case Spawn:
		return "spawn", true
	case Attach:
		return "attach", true
	case Detach:
		return "detach", true
	case Resize:
		return "resize", true
	case Signal:
		return "signal", true
	case CloseSession:
		return "close", true
	case Update:
		return "update", true
	case Peek:
		return "peek", true
	case Preview:
		return "preview", true
	case Stat:
		return "stat", true
	case Stats:
		return "stats", true
	case Read:
		return "read", true
	case File:
		return "file", true
	case Eof:
		return "eof", true
	case Cancel:
		return "cancel", true
	case Devices:
		return "devices", true
	case Revoke:
		return "revoke", true
	case PairStart:
		return "pairStart", true
	case PairCancel:
		return "pairCancel", true
	case Welcome:
		return "welcome", true
	case Sessions:
		return "sessions", true
	case Attached:
		return "attached", true
	case Exit:
		return "exit", true
	case SizeChanged:
		return "sizeChanged", true
	case Error:
		return "error", true
	case DeviceList:
		return "deviceList", true
	case Pairing:
		return "pairing", true
	case Revoked:
		return "revoked", true
	case RelayState:
		return "relay", true
	}
	return "", false
}

// EncodeControl marshals msg and injects its "type" discriminator.
func EncodeControl(msg any) ([]byte, error) {
	name, ok := typeName(msg)
	if !ok {
		return nil, fmt.Errorf("wire: %T is not a control message", msg)
	}
	body, err := json.Marshal(msg)
	if err != nil {
		return nil, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil {
		return nil, err
	}
	fields["type"] = json.RawMessage(`"` + name + `"`)
	return json.Marshal(fields)
}

// DecodeControl parses a control message into its concrete type.
func DecodeControl(b []byte) (any, error) {
	var probe struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(b, &probe); err != nil {
		return nil, err
	}

	into := func(v any) (any, error) {
		if err := json.Unmarshal(b, v); err != nil {
			return nil, err
		}
		return v, nil
	}
	deref := func(v any, err error) (any, error) {
		if err != nil {
			return nil, err
		}
		switch t := v.(type) {
		case *Hello:
			return *t, nil
		case *List:
			return *t, nil
		case *Spawn:
			return *t, nil
		case *Attach:
			return *t, nil
		case *Detach:
			return *t, nil
		case *Resize:
			return *t, nil
		case *Signal:
			return *t, nil
		case *CloseSession:
			return *t, nil
		case *Update:
			return *t, nil
		case *Peek:
			return *t, nil
		case *Preview:
			return *t, nil
		case *Stat:
			return *t, nil
		case *Stats:
			return *t, nil
		case *Read:
			return *t, nil
		case *File:
			return *t, nil
		case *Eof:
			return *t, nil
		case *Cancel:
			return *t, nil
		case *Devices:
			return *t, nil
		case *Revoke:
			return *t, nil
		case *PairStart:
			return *t, nil
		case *PairCancel:
			return *t, nil
		case *Welcome:
			return *t, nil
		case *Sessions:
			return *t, nil
		case *Attached:
			return *t, nil
		case *Exit:
			return *t, nil
		case *SizeChanged:
			return *t, nil
		case *Error:
			return *t, nil
		case *DeviceList:
			return *t, nil
		case *Pairing:
			return *t, nil
		case *Revoked:
			return *t, nil
		case *RelayState:
			return *t, nil
		}
		return nil, fmt.Errorf("wire: unhandled message %T", v)
	}

	switch probe.Type {
	case "hello":
		return deref(into(&Hello{}))
	case "list":
		return deref(into(&List{}))
	case "spawn":
		return deref(into(&Spawn{}))
	case "attach":
		return deref(into(&Attach{}))
	case "detach":
		return deref(into(&Detach{}))
	case "resize":
		return deref(into(&Resize{}))
	case "signal":
		return deref(into(&Signal{}))
	case "close":
		return deref(into(&CloseSession{}))
	case "update":
		return deref(into(&Update{}))
	case "peek":
		return deref(into(&Peek{}))
	case "preview":
		return deref(into(&Preview{}))
	case "stat":
		return deref(into(&Stat{}))
	case "stats":
		return deref(into(&Stats{}))
	case "read":
		return deref(into(&Read{}))
	case "file":
		return deref(into(&File{}))
	case "eof":
		return deref(into(&Eof{}))
	case "cancel":
		return deref(into(&Cancel{}))
	case "devices":
		return deref(into(&Devices{}))
	case "revoke":
		return deref(into(&Revoke{}))
	case "pairStart":
		return deref(into(&PairStart{}))
	case "pairCancel":
		return deref(into(&PairCancel{}))
	case "welcome":
		return deref(into(&Welcome{}))
	case "sessions":
		return deref(into(&Sessions{}))
	case "attached":
		return deref(into(&Attached{}))
	case "exit":
		return deref(into(&Exit{}))
	case "sizeChanged":
		return deref(into(&SizeChanged{}))
	case "error":
		return deref(into(&Error{}))
	case "deviceList":
		return deref(into(&DeviceList{}))
	case "pairing":
		return deref(into(&Pairing{}))
	case "revoked":
		return deref(into(&Revoked{}))
	case "relay":
		return deref(into(&RelayState{}))
	}
	return nil, fmt.Errorf("wire: unknown control message type %q", probe.Type)
}
