# File peek, phase 1: wire and daemon

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach the daemon to answer "does this path exist" and "send me this
file", over the wire protocol, so a later phase can put a browser in front of
it.

**Architecture:** Three new control messages (`stat`, `read`, `cancel`) and
three answers (`stats`, `file`, `eof`), plus one new binary frame type (`0x02`)
carrying content in 32 KiB chunks. A read mints a `ref` from the same counter
attachments use, so it is structurally an attachment: request, handle, binary
frames, end. No HTTP is added, because the relay forwards no HTTP but pairing,
and this must work from a phone.

**Tech stack:** Go 1.x standard library only (no new dependencies), the
existing `internal/wire` and `internal/daemon` packages, and TypeScript type
declarations in `web/src/client/protocol.ts` so the shared conformance fixture
still decodes on both sides.

**Spec:** `docs/superpowers/specs/2026-08-11-file-peek-design.md`

## Global Constraints

- No new Go dependencies. Everything here is standard library.
- No new HTTP endpoints. Every remote interaction rides the wire protocol.
- Chunk size is exactly 32 KiB (`chunkBytes = 32 << 10`). Text caps at 8 MiB
  (`maxFileBytes = 8 << 20`), images at 4 MiB (`maxImageBytes = 4 << 20`), two
  concurrent reads per connection (`maxReads = 2`), 32 paths per `stat`
  (`maxStatPaths = 32`), 4096 bytes per path (`maxPathLen = 4096`).
- Error codes are exactly: `not_found`, `is_dir`, `too_large`, `denied`,
  `bad_path`, `busy`, `unsupported`. Every one is correlated by `reqId`.
- This phase adds no UI and no client methods. `web/` changes are type
  declarations and fixture assertions only.
- `pnpm` only in `web/`. Never `npm`, `npx`, or `yarn`.
- Prose in web sources feeds the Tailwind scanner via `styles.build.test.ts`.
  This phase only touches `web/src/client/`, which is scanned; keep comments
  free of anything that reads as a utility class.
- Commit after every task. Branch is `feat/file-peek`; `main` is protected and
  everything lands by pull request.

## File Structure

| File | Responsibility |
|---|---|
| `internal/wire/binary.go` (modify) | Add `FrameFile = 0x02` and admit it in `DecodeBinary` |
| `internal/wire/control.go` (modify) | The six new message types, their discriminators, and their decode arms |
| `internal/daemon/file.go` (create) | Path resolution, content classification, the read lifecycle and its chunk pump |
| `internal/daemon/conn.go` (modify) | Dispatch arms, the `reads` map, `frame.sent`, teardown |
| `internal/daemon/file_test.go` (create) | Everything the daemon side promises |
| `internal/wire/wire_test.go` | Unchanged; it reads the fixture, which grows |
| `testdata/wire/control.json` (modify) | One example of each new message |
| `web/src/client/protocol.ts` (modify) | TypeScript mirrors of the six messages |
| `web/src/client/client.test.ts` (modify) | Fixture name list and per-message assertions |
| `spec/protocol.md` (modify) | The contract |

---

### Task 1: A binary frame type for file content

**Files:**
- Modify: `internal/wire/binary.go`
- Test: `internal/wire/wire_test.go`

**Interfaces:**
- Produces: `wire.FrameFile` (a `byte` constant, `0x02`), and `wire.DecodeBinary`
  accepting it.

- [ ] **Step 1: Write the failing test**

Append to `internal/wire/wire_test.go`:

```go
// TestFileFramesRoundTrip pins the third frame type. Content rides the binary
// half rather than a base64 field on a control message: a 32 KiB chunk costs
// 43 KiB as base64 inside JSON, and the client already has a decoder for this
// layout.
func TestFileFramesRoundTrip(t *testing.T) {
	payload := []byte("package main\n")
	frame := EncodeBinary(FrameFile, 9, payload)

	typ, ref, got, err := DecodeBinary(frame)
	if err != nil {
		t.Fatalf("DecodeBinary: %v", err)
	}
	if typ != FrameFile {
		t.Errorf("type = %#x, want %#x", typ, FrameFile)
	}
	if ref != 9 {
		t.Errorf("ref = %d, want 9", ref)
	}
	if string(got) != string(payload) {
		t.Errorf("payload = %q, want %q", got, payload)
	}
}

// TestDecodeBinaryRefusesAnUnknownType keeps the type byte a closed set: a
// frame nobody defined must not decode as one that was.
func TestDecodeBinaryRefusesAnUnknownType(t *testing.T) {
	if _, _, _, err := DecodeBinary([]byte{0x7f, 0, 0, 0, 1}); err == nil {
		t.Fatal("DecodeBinary accepted frame type 0x7f")
	}
}
```

- [ ] **Step 2: Run it and watch it fail**

```
go test ./internal/wire/ -run 'TestFileFrames|TestDecodeBinaryRefuses' -v
```

Expected: compile failure, `undefined: FrameFile`.

- [ ] **Step 3: Add the constant and admit it**

In `internal/wire/binary.go`, extend the constant block and the type check:

```go
// Binary frame types. Layout is [1 byte type][4 bytes ref BE][payload].
const (
	FrameOutput byte = 0x00 // daemon -> client
	FrameInput  byte = 0x01 // client -> daemon
	// FrameFile carries one chunk of a file being read, under the ref the
	// daemon minted for that read. Daemon -> client only: nothing here reads a
	// file the client sends.
	FrameFile byte = 0x02 // daemon -> client
)
```

and in `DecodeBinary`:

```go
	typ = b[0]
	if typ != FrameOutput && typ != FrameInput && typ != FrameFile {
		return 0, 0, nil, fmt.Errorf("wire: unknown frame type %#x", typ)
	}
```

- [ ] **Step 4: Run it and watch it pass**

```
go test ./internal/wire/ -run 'TestFileFrames|TestDecodeBinaryRefuses' -v
```

Expected: PASS, both tests.

- [ ] **Step 5: Commit**

```bash
git add internal/wire/binary.go internal/wire/wire_test.go
git commit -m "wire: a binary frame type for file content"
```

---

### Task 2: The six control messages

**Files:**
- Modify: `internal/wire/control.go`
- Test: `internal/wire/wire_test.go`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces, all in package `wire`:
  - `Stat{ID string; Paths []string; ReqID uint64}` — discriminator `stat`
  - `PathEntry{Path string; Exists bool; Kind string; Size int64; Mtime int64}`
  - `Stats{Entries []PathEntry; ReqID uint64}` — discriminator `stats`
  - `Read{ID, Path string; ReqID uint64}` — discriminator `read`
  - `File{Ref uint32; Path string; Size int64; Mime, Kind string; Truncated bool; ReqID uint64}` — discriminator `file`
  - `Eof{Ref uint32}` — discriminator `eof`
  - `Cancel{Ref uint32}` — discriminator `cancel`

- [ ] **Step 1: Write the failing test**

Append to `internal/wire/wire_test.go`:

```go
// TestStatsEncodesAnEmptyListAsAList follows Sessions and DeviceList: a nil
// slice marshals to null, the client declares the field an array, and "none of
// these paths exist" is reached by building the zero value — precisely the
// path that would ship null.
func TestStatsEncodesAnEmptyListAsAList(t *testing.T) {
	b, err := EncodeControl(Stats{ReqID: 3})
	if err != nil {
		t.Fatalf("EncodeControl: %v", err)
	}
	if !strings.Contains(string(b), `"entries":[]`) {
		t.Errorf("encoded = %s, want an empty entries array", b)
	}
}

// TestFileAndReadRoundTrip pins the read half's discriminators and fields.
func TestFileAndReadRoundTrip(t *testing.T) {
	for _, msg := range []any{
		Stat{ID: "s1", Paths: []string{"internal/wire/binary.go"}, ReqID: 4},
		Read{ID: "s1", Path: "~/notes.md", ReqID: 5},
		Cancel{Ref: 9},
		File{Ref: 9, Path: "/home/karn/notes.md", Size: 120, Mime: "text/plain; charset=utf-8", Kind: "text", ReqID: 5},
		Eof{Ref: 9},
	} {
		b, err := EncodeControl(msg)
		if err != nil {
			t.Fatalf("EncodeControl(%T): %v", msg, err)
		}
		got, err := DecodeControl(b)
		if err != nil {
			t.Fatalf("DecodeControl(%T): %v", msg, err)
		}
		if !reflect.DeepEqual(got, msg) {
			t.Errorf("round trip of %T = %#v, want %#v", msg, got, msg)
		}
	}
}
```

Check the imports at the top of `wire_test.go` and add `reflect` and `strings`
if they are not already there.

- [ ] **Step 2: Run it and watch it fail**

```
go test ./internal/wire/ -run 'TestStatsEncodes|TestFileAndRead' -v
```

Expected: compile failure, `undefined: Stats`.

- [ ] **Step 3: Add the types**

In `internal/wire/control.go`, after the `Peek`/`Preview` pair (they are the
nearest relatives — a request that reads without attaching), add:

```go
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
	ID    string `json:"id"`
	Path  string `json:"path"`
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
```

Then add the discriminators. In `typeName`:

```go
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
```

In `DecodeControl`'s `deref` switch:

```go
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
```

And in `DecodeControl`'s type switch:

```go
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
```

- [ ] **Step 4: Run it and watch it pass**

```
go test ./internal/wire/ -v
```

Expected: PASS, including the pre-existing `TestGoldenControlMessages` (the
fixture has not grown yet, so nothing there changes).

- [ ] **Step 5: Commit**

```bash
git add internal/wire/control.go internal/wire/wire_test.go
git commit -m "wire: stat, read and cancel, and the three answers"
```

---

### Task 3: The conformance fixture, and its TypeScript half

Both suites decode `testdata/wire/control.json`, which is the only thing
stopping the Go and TypeScript definitions from drifting. The TypeScript test
asserts the fixture's case names as an exact ordered list, so the fixture and
that list have to move together or the web suite fails.

**Files:**
- Modify: `testdata/wire/control.json`
- Modify: `web/src/client/protocol.ts`
- Modify: `web/src/client/client.test.ts`

**Interfaces:**
- Consumes: the Go types from Task 2.
- Produces, in `web/src/client/protocol.ts`: `StatMsg`, `ReadMsg`, `CancelMsg`,
  `PathEntry`, `StatsMsg`, `FileMsg`, `EofMsg`, all exported and joined to the
  `ClientMessage` and `ServerMessage` unions.

- [ ] **Step 1: Add the fixture cases**

Append these objects to the end of the array in `testdata/wire/control.json`
(after the last existing case, `revoked`):

```json
  {
    "name": "stat",
    "json": {
      "type": "stat",
      "id": "a1b2c3d4e5f60708",
      "paths": [
        "internal/wire/binary.go",
        "~/notes.md"
      ],
      "reqId": 11
    }
  },
  {
    "name": "stats",
    "json": {
      "type": "stats",
      "entries": [
        {
          "path": "internal/wire/binary.go",
          "exists": true,
          "kind": "file",
          "size": 1204,
          "mtime": 1754870400
        },
        {
          "path": "~/notes.md",
          "exists": false
        }
      ],
      "reqId": 11
    }
  },
  {
    "name": "statsEmpty",
    "json": {
      "type": "stats",
      "entries": [],
      "reqId": 12
    }
  },
  {
    "name": "read",
    "json": {
      "type": "read",
      "id": "a1b2c3d4e5f60708",
      "path": "internal/wire/binary.go",
      "reqId": 13
    }
  },
  {
    "name": "file",
    "json": {
      "type": "file",
      "ref": 4,
      "path": "/home/karn/code/flue/internal/wire/binary.go",
      "size": 1204,
      "mime": "text/plain; charset=utf-8",
      "kind": "text",
      "reqId": 13
    }
  },
  {
    "name": "fileTruncated",
    "json": {
      "type": "file",
      "ref": 5,
      "path": "/home/karn/big.log",
      "size": 41943040,
      "mime": "text/plain; charset=utf-8",
      "kind": "text",
      "truncated": true,
      "reqId": 14
    }
  },
  {
    "name": "eof",
    "json": {
      "type": "eof",
      "ref": 4
    }
  },
  {
    "name": "cancel",
    "json": {
      "type": "cancel",
      "ref": 4
    }
  }
```

- [ ] **Step 2: Run the Go conformance test and watch it pass**

```
go test ./internal/wire/ -run TestGoldenControlMessages -v
```

Expected: PASS. The Go types already exist, so this proves the fixture matches
them field for field. If it fails, the fixture and the struct tags disagree and
the fixture is the thing to check first.

- [ ] **Step 3: Run the web suite and watch it fail**

```
cd web && pnpm vitest run src/client/client.test.ts
```

Expected: FAIL on the "covers every message the protocol defines, and nothing
else" assertion, because the fixture now has eight cases the list does not
name.

- [ ] **Step 4: Declare the TypeScript types**

In `web/src/client/protocol.ts`, after `PeekMsg`, add the three client
messages:

```ts
/**
 * Ask whether paths exist, resolved against a session's working directory.
 *
 * Plural because of who asks: a hovered terminal line carries several
 * candidates, and a message per candidate would be a round trip per candidate.
 * Answered by `stats`, whose entries echo these paths in this order.
 */
export interface StatMsg {
  type: 'stat'
  id: string
  paths: string[]
  reqId?: number
}

/**
 * Start reading one file, resolved the way `stat` resolves a path.
 *
 * Answered by `file`, which mints the ref the content arrives under, or by an
 * error. The content itself is binary frames, not this reply.
 */
export interface ReadMsg {
  type: 'read'
  id: string
  path: string
  reqId?: number
}

/** Abandon a read in flight. Addressed by the ref `file` handed out. */
export interface CancelMsg {
  type: 'cancel'
  ref: number
}
```

Add all three to the `ClientMessage` union:

```ts
export type ClientMessage =
  | HelloMsg
  | ListMsg
  | SpawnMsg
  | AttachMsg
  | DetachMsg
  | ResizeMsg
  | SignalMsg
  | CloseMsg
  | UpdateMsg
  | PeekMsg
  | StatMsg
  | ReadMsg
  | CancelMsg
  | DevicesMsg
  | RevokeMsg
  | PairStartMsg
  | PairCancelMsg
```

Then, beside the other server messages (after `Preview`), add:

```ts
/** What one path turned out to be. `path` echoes what was asked, not what it resolved to. */
export interface PathEntry {
  path: string
  exists: boolean
  kind?: 'file' | 'dir' | 'other'
  size?: number
  mtime?: number
}

/** Answers `stat`, one entry per path asked about, in order. */
export interface StatsMsg {
  type: 'stats'
  entries: PathEntry[]
  reqId?: number
}

/**
 * Answers `read`: the stream is open and these are its terms.
 *
 * `path` is the resolved path, unlike `PathEntry.path`. `size` is the file's
 * real size, which is not always how much arrives — see `truncated`.
 */
export interface FileMsg {
  type: 'file'
  ref: number
  path: string
  size: number
  mime: string
  kind: 'text' | 'image'
  truncated?: boolean
  reqId?: number
}

/** Every byte of a read has been sent. The only way a stream ends rather than stalls. */
export interface EofMsg {
  type: 'eof'
  ref: number
}
```

Add `StatsMsg`, `FileMsg` and `EofMsg` to the `ServerMessage` union, in the
same place relative to `Preview` that they sit in the file.

- [ ] **Step 5: Assert the fixtures in the web suite**

In `web/src/client/client.test.ts`, append the eight names to the ordered list
in the "covers every message the protocol defines, and nothing else" test,
after `'revoked'`:

```ts
      'stat',
      'stats',
      'statsEmpty',
      'read',
      'file',
      'fileTruncated',
      'eof',
      'cancel',
```

Then add these cases at the end of the same `describe` block. Each annotates
the fixture with the interface, which is what makes a renamed field a compile
error rather than a silent drift:

```ts
  it('decodes a stat and the stats answering it', () => {
    const ask: StatMsg = {
      type: 'stat',
      id: 'a1b2c3d4e5f60708',
      paths: ['internal/wire/binary.go', '~/notes.md'],
      reqId: 11,
    }
    expect(fixture('stat')).toStrictEqual(ask)

    // A path that does not exist is `exists: false` and nothing else. Not an
    // error: "no" is the ordinary answer to this question, and the hover that
    // asked it simply does not underline.
    const answer: StatsMsg = {
      type: 'stats',
      entries: [
        {
          path: 'internal/wire/binary.go',
          exists: true,
          kind: 'file',
          size: 1204,
          mtime: 1754870400,
        },
        { path: '~/notes.md', exists: false },
      ],
      reqId: 11,
    }
    expect(fixture('stats')).toStrictEqual(answer)

    // Empty as [] rather than null, for the reason sessions and deviceList
    // are: this side ranges over the field.
    const empty: StatsMsg = { type: 'stats', entries: [], reqId: 12 }
    expect(fixture('statsEmpty')).toStrictEqual(empty)
  })

  it('decodes a read, and the file that opens its stream', () => {
    const ask: ReadMsg = {
      type: 'read',
      id: 'a1b2c3d4e5f60708',
      path: 'internal/wire/binary.go',
      reqId: 13,
    }
    expect(fixture('read')).toStrictEqual(ask)

    // `path` here is the resolved one, unlike the echo in a stats entry.
    const answer: FileMsg = {
      type: 'file',
      ref: 4,
      path: '/home/karn/code/flue/internal/wire/binary.go',
      size: 1204,
      mime: 'text/plain; charset=utf-8',
      kind: 'text',
      reqId: 13,
    }
    expect(fixture('file')).toStrictEqual(answer)

    // `size` stays the file's real size when only its head is coming, so a
    // viewer can say how much it is not showing.
    const cut: FileMsg = {
      type: 'file',
      ref: 5,
      path: '/home/karn/big.log',
      size: 41943040,
      mime: 'text/plain; charset=utf-8',
      kind: 'text',
      truncated: true,
      reqId: 14,
    }
    expect(fixture('fileTruncated')).toStrictEqual(cut)
  })

  it('decodes the end of a stream, and the abandonment of one', () => {
    const done: EofMsg = { type: 'eof', ref: 4 }
    expect(fixture('eof')).toStrictEqual(done)

    const stop: CancelMsg = { type: 'cancel', ref: 4 }
    expect(fixture('cancel')).toStrictEqual(stop)
  })
```

Add `StatMsg`, `ReadMsg`, `CancelMsg`, `StatsMsg`, `FileMsg` and `EofMsg` to
the import from `./protocol` at the top of the test file.

- [ ] **Step 6: Run both suites and watch them pass**

```
go test ./internal/wire/ -v
cd web && pnpm vitest run src/client/client.test.ts && pnpm run lint
```

Expected: PASS in Go; PASS in vitest; `tsc --noEmit` clean. If `lint` reports a
non-exhaustive switch in `client.ts`, the new server messages have landed in a
`switch` that had no `default`. Do not add handling for them in this phase —
that is Task 2 of phase 2. Add them to the existing `default`/ignore path so
an unrecognised message is dropped exactly as it was before.

- [ ] **Step 7: Commit**

```bash
git add testdata/wire/control.json web/src/client/protocol.ts web/src/client/client.test.ts
git commit -m "wire: pin the file messages in the shared conformance fixture"
```

---

### Task 4: Resolving a path against a session

**Files:**
- Create: `internal/daemon/file.go`
- Create: `internal/daemon/file_test.go`

**Interfaces:**
- Produces, in package `daemon`:
  - `resolvePath(raw, cwd, home string) (string, error)`
  - `errBadPath` (an `error` value)
  - The constants `chunkBytes`, `maxFileBytes`, `maxImageBytes`, `maxReads`,
    `maxStatPaths`, `maxPathLen`

- [ ] **Step 1: Write the failing test**

Create `internal/daemon/file_test.go`:

```go
package daemon

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestResolvePathAgainstASession(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{"absolute is itself", "/etc/hosts", "/etc/hosts"},
		{"relative joins the session's cwd", "src/main.go", "/work/repo/src/main.go"},
		{"dot-relative joins it too", "./src/main.go", "/work/repo/src/main.go"},
		{"a parent walk is resolved, not refused", "../other/x.go", "/work/other/x.go"},
		{"tilde is the daemon user's home", "~/notes.md", "/home/karn/notes.md"},
		{"bare tilde is the home itself", "~", "/home/karn"},
		{"surrounding space is not part of the path", "  src/main.go  ", "/work/repo/src/main.go"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := resolvePath(tc.raw, "/work/repo", "/home/karn")
			if err != nil {
				t.Fatalf("resolvePath(%q): %v", tc.raw, err)
			}
			if got != tc.want {
				t.Errorf("resolvePath(%q) = %q, want %q", tc.raw, got, tc.want)
			}
		})
	}
}

// A parent walk is resolved rather than refused because there is nothing to
// refuse it on behalf of: this daemon reads anything its user can read, and a
// connection that reached it can already spawn a shell and cat the same file.
// The rule the test above pins is that the *result* is what gets opened, so
// there is one path in play and not two.

func TestResolvePathRefusesWhatCannotBeAPath(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		cwd  string
		home string
	}{
		{"empty", "", "/work/repo", "/home/karn"},
		{"only space", "   ", "/work/repo", "/home/karn"},
		{"a NUL byte", "src/ma\x00in.go", "/work/repo", "/home/karn"},
		{"longer than any path can be", "/" + strings.Repeat("a", maxPathLen), "/work/repo", "/home/karn"},
		{"relative with no cwd to resolve against", "src/main.go", "", "/home/karn"},
		{"tilde with no home to expand", "~/notes.md", "/work/repo", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got, err := resolvePath(tc.raw, tc.cwd, tc.home); err == nil {
				t.Errorf("resolvePath(%q) = %q, want an error", tc.raw, got)
			}
		})
	}
}

// TestResolvePathCleansTheResult keeps one path in play rather than two: the
// thing opened, the thing reported back, and the thing a client sees must be
// the same string.
func TestResolvePathCleansTheResult(t *testing.T) {
	got, err := resolvePath("src/../src/./main.go", "/work/repo", "/home/karn")
	if err != nil {
		t.Fatalf("resolvePath: %v", err)
	}
	if got != filepath.Clean(got) {
		t.Errorf("resolvePath = %q, which is not clean", got)
	}
	if got != "/work/repo/src/main.go" {
		t.Errorf("resolvePath = %q, want /work/repo/src/main.go", got)
	}
}
```

- [ ] **Step 2: Run it and watch it fail**

```
go test ./internal/daemon/ -run TestResolvePath -v
```

Expected: compile failure, `undefined: resolvePath`.

- [ ] **Step 3: Write it**

Create `internal/daemon/file.go`:

```go
package daemon

import (
	"errors"
	"path/filepath"
	"strings"
)

// Reading a file the session named.
//
// The browser sends the text it matched in the terminal; this file turns that
// text into a path, decides whether it is something a reader can use, and
// streams it. The split is deliberate: only the daemon knows where the session
// actually is, and the resolution rules below are not reproducible from a tab.
//
// What may be read is anything the daemon's user can read. There is no fence,
// by decision rather than omission: a connection that reached this code can
// already spawn a shell in any directory and cat the same file, so a fence
// would refuse the paths an agent names most often — a scratch file in /tmp, a
// transcript under ~/.claude, a sibling worktree — while stopping nothing.
// Nothing here writes.
const (
	// chunkBytes is one content frame. Far under the relay's 1 MiB message cap
	// (relay/src/hub.ts, MAX_CLIENT_MESSAGE), and small enough that a
	// multi-megabyte read never puts more than 32 KiB in front of the next
	// keystroke: file content and terminal output share one socket.
	chunkBytes = 32 << 10

	// maxFileBytes is how much of a text file is sent. Past it the head is
	// streamed and file.truncated says so.
	maxFileBytes = 8 << 20

	// maxImageBytes is the ceiling for an image, which is refused rather than
	// truncated: half a PNG is not a smaller PNG.
	maxImageBytes = 4 << 20

	// maxReads is how many reads one connection may have open at once. The
	// bound is on held file descriptors and on how much of the socket a reader
	// can occupy; two is a viewer and the file it is about to replace.
	maxReads = 2

	// maxStatPaths bounds one stat. A hovered terminal line has nothing like
	// this many candidates on it.
	maxStatPaths = 32

	// maxPathLen is the longest path this will consider. PATH_MAX is 4096 on
	// Linux and 1024 on Darwin; the larger of the two is the right bound for a
	// refusal that exists to stop nonsense rather than to enforce a filesystem
	// limit the filesystem will enforce itself.
	maxPathLen = 4096
)

// errBadPath is every way a string fails to be a path worth resolving. One
// error rather than several: the client's only move is the same in each case,
// and naming which rule was broken tells a caller nothing it can act on.
var errBadPath = errors.New("daemon: not a usable path")

// resolvePath turns the text a client matched in the terminal into an absolute
// path.
//
//   - A leading ~ expands to home, the daemon user's own.
//   - A relative path resolves against cwd, the session's live working
//     directory, which session.Info re-reads from the kernel on every call.
//   - The result is cleaned, so exactly one string is opened, reported and
//     shown.
//
// A relative path that does not exist under cwd is a miss. There is no second
// attempt against the spawn directory or a guessed project root: two
// resolution rules would make "opened the wrong file" indistinguishable from
// "opened the right one" to everyone downstream.
//
// Symlinks are not resolved here. That needs the filesystem, and this function
// is pure so the rules above can be tested without one; the caller resolves
// them when it stats.
func resolvePath(raw, cwd, home string) (string, error) {
	p := strings.TrimSpace(raw)
	if p == "" || len(p) > maxPathLen || strings.ContainsRune(p, 0) {
		return "", errBadPath
	}
	switch {
	case p == "~":
		if home == "" {
			return "", errBadPath
		}
		p = home
	case strings.HasPrefix(p, "~/"):
		if home == "" {
			return "", errBadPath
		}
		p = filepath.Join(home, p[2:])
	case !filepath.IsAbs(p):
		if cwd == "" {
			return "", errBadPath
		}
		p = filepath.Join(cwd, p)
	}
	return filepath.Clean(p), nil
}
```

- [ ] **Step 4: Run it and watch it pass**

```
go test ./internal/daemon/ -run TestResolvePath -v
```

Expected: PASS, all three tests and every subtest.

- [ ] **Step 5: Commit**

```bash
git add internal/daemon/file.go internal/daemon/file_test.go
git commit -m "daemon: resolve a path the way the session sees it"
```

---

### Task 5: Answering stat

**Files:**
- Modify: `internal/daemon/file.go`
- Modify: `internal/daemon/conn.go`
- Modify: `internal/daemon/file_test.go`

**Interfaces:**
- Consumes: `resolvePath` (Task 4), `wire.Stat`/`wire.Stats`/`wire.PathEntry`
  (Task 2).
- Produces: `statEntry(raw, cwd, home string) wire.PathEntry`, and a
  `case wire.Stat:` arm in `conn.handleControl`.

- [ ] **Step 1: Write the failing test**

Append to `internal/daemon/file_test.go`:

```go
// statTree builds a directory with one of each thing stat has to tell apart.
func statTree(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "real.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if err := os.Mkdir(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatalf("Mkdir: %v", err)
	}
	if err := os.Symlink(filepath.Join(dir, "real.txt"), filepath.Join(dir, "link.txt")); err != nil {
		t.Fatalf("Symlink: %v", err)
	}
	return dir
}

func TestStatEntryTellsTheKindsApart(t *testing.T) {
	dir := statTree(t)

	file := statEntry("real.txt", dir, "/home/karn")
	if !file.Exists || file.Kind != "file" {
		t.Errorf("real.txt = %+v, want an existing file", file)
	}
	if file.Size != 5 {
		t.Errorf("real.txt size = %d, want 5", file.Size)
	}
	if file.Mtime == 0 {
		t.Error("real.txt carries no mtime")
	}
	if file.Path != "real.txt" {
		t.Errorf("Path = %q, want the text that was asked about", file.Path)
	}

	// A symlink to a file reads as the file. Following is the whole point: the
	// reader wants what is at the end of it.
	link := statEntry("link.txt", dir, "/home/karn")
	if !link.Exists || link.Kind != "file" {
		t.Errorf("link.txt = %+v, want an existing file", link)
	}

	sub := statEntry("sub", dir, "/home/karn")
	if !sub.Exists || sub.Kind != "dir" {
		t.Errorf("sub = %+v, want an existing dir", sub)
	}

	// Missing is an answer, not a failure. The hover that asked simply does
	// not underline.
	gone := statEntry("nope.txt", dir, "/home/karn")
	if gone.Exists {
		t.Errorf("nope.txt = %+v, want exists false", gone)
	}
	if gone.Kind != "" || gone.Size != 0 {
		t.Errorf("nope.txt = %+v, want nothing beside exists false", gone)
	}

	// So is a string that is not a path at all.
	junk := statEntry("", dir, "/home/karn")
	if junk.Exists {
		t.Errorf("empty path = %+v, want exists false", junk)
	}
}

func TestStatAnswersEveryPathInOrder(t *testing.T) {
	ts, reg := newTestServer(t)
	dir := statTree(t)
	s, err := reg.Spawn(session.SpawnOpts{Cmd: []string{"cat"}, Cwd: dir, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })

	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Stat{ID: s.ID(), Paths: []string{"nope.txt", "real.txt", "sub"}, ReqID: 21})

	readUntil(t, c, func(msg any, _ []byte) bool {
		got, ok := msg.(wire.Stats)
		if !ok {
			return false
		}
		if got.ReqID != 21 {
			t.Fatalf("Stats.ReqID = %d, want 21", got.ReqID)
		}
		if len(got.Entries) != 3 {
			t.Fatalf("Stats.Entries = %+v, want three", got.Entries)
		}
		// In the order asked, so a client can match answers to the text it
		// matched them from without comparing paths it cannot reproduce.
		if got.Entries[0].Path != "nope.txt" || got.Entries[0].Exists {
			t.Errorf("entry 0 = %+v, want nope.txt missing", got.Entries[0])
		}
		if got.Entries[1].Path != "real.txt" || got.Entries[1].Kind != "file" {
			t.Errorf("entry 1 = %+v, want real.txt as a file", got.Entries[1])
		}
		if got.Entries[2].Kind != "dir" {
			t.Errorf("entry 2 = %+v, want sub as a dir", got.Entries[2])
		}
		return true
	})
}

func TestStatRefusesAnUnknownSessionAndTooManyPaths(t *testing.T) {
	ts, reg := newTestServer(t)
	dir := statTree(t)
	s, err := reg.Spawn(session.SpawnOpts{Cmd: []string{"cat"}, Cwd: dir, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })

	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Stat{ID: "nosuchsession", Paths: []string{"real.txt"}, ReqID: 22})
	readUntil(t, c, func(msg any, _ []byte) bool {
		e, ok := msg.(wire.Error)
		if !ok {
			return false
		}
		if e.ReqID != 22 || e.Code != "not_found" {
			t.Fatalf("error = %+v, want not_found for reqId 22", e)
		}
		return true
	})

	many := make([]string, maxStatPaths+1)
	for i := range many {
		many[i] = "real.txt"
	}
	writeControl(t, c, wire.Stat{ID: s.ID(), Paths: many, ReqID: 23})
	readUntil(t, c, func(msg any, _ []byte) bool {
		e, ok := msg.(wire.Error)
		if !ok {
			return false
		}
		if e.ReqID != 23 || e.Code != "bad_path" {
			t.Fatalf("error = %+v, want bad_path for reqId 23", e)
		}
		return true
	})
}
```

Add to `file_test.go`'s imports: `os`, and
`"github.com/karnstack/flue/internal/session"`, and
`"github.com/karnstack/flue/internal/wire"`.

- [ ] **Step 2: Run it and watch it fail**

```
go test ./internal/daemon/ -run TestStat -v
```

Expected: compile failure, `undefined: statEntry`.

- [ ] **Step 3: Write `statEntry`**

Append to `internal/daemon/file.go` (and add `os` and
`"github.com/karnstack/flue/internal/wire"` to its imports):

```go
// statEntry answers one path: does it exist, and what is it.
//
// os.Stat rather than os.Lstat, so a symlink reads as whatever it points at.
// Following is the point — the reader wants the file at the end of the link,
// and a link reported as "other" would refuse to underline a path that opens
// perfectly well.
//
// Every failure is the same answer, exists false: a path that cannot be
// resolved, one that is not there, one in a directory this user cannot search.
// None of them is an error on the wire, because "no" is the ordinary answer to
// this question and the hover that asked it simply does not underline. It is
// also the answer that says least: a caller learns whether a path it already
// named is readable, and nothing about the shape of anything it did not name.
func statEntry(raw, cwd, home string) wire.PathEntry {
	e := wire.PathEntry{Path: raw}
	abs, err := resolvePath(raw, cwd, home)
	if err != nil {
		return e
	}
	fi, err := os.Stat(abs)
	if err != nil {
		return e
	}
	e.Exists = true
	switch {
	case fi.IsDir():
		e.Kind = "dir"
	case fi.Mode().IsRegular():
		e.Kind = "file"
	default:
		e.Kind = "other"
	}
	e.Size = fi.Size()
	e.Mtime = fi.ModTime().Unix()
	return e
}
```

- [ ] **Step 4: Add the dispatch arm**

In `internal/daemon/conn.go`, in `handleControl`, after the `case wire.Peek:`
block:

```go
	case wire.Stat:
		// One message per hovered line rather than one per candidate: the
		// terminal underlines a path only once it is known to be real, and the
		// round trip is the cost on a relayed link.
		s, ok := c.srv.reg.Get(m.ID)
		if !ok {
			c.sendErrorFor(m.ReqID, "not_found", "no such session")
			return
		}
		if len(m.Paths) > maxStatPaths {
			c.sendErrorFor(m.ReqID, "bad_path", "too many paths in one stat")
			return
		}
		home, _ := os.UserHomeDir()
		cwd := s.Info().Cwd
		entries := make([]wire.PathEntry, 0, len(m.Paths))
		for _, p := range m.Paths {
			entries = append(entries, statEntry(p, cwd, home))
		}
		_ = c.sendControl(wire.Stats{Entries: entries, ReqID: m.ReqID})
```

Add `"os"` to `conn.go`'s imports.

- [ ] **Step 5: Run it and watch it pass**

```
go test ./internal/daemon/ -run 'TestResolvePath|TestStat' -v
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/daemon/file.go internal/daemon/file_test.go internal/daemon/conn.go
git commit -m "daemon: answer stat for every path on a hovered line"
```

---

### Task 6: Deciding what a file is

**Files:**
- Modify: `internal/daemon/file.go`
- Modify: `internal/daemon/file_test.go`

**Interfaces:**
- Produces: `classify(head []byte) (kind, mime string, ok bool)`, where `kind`
  is `"text"` or `"image"` and `ok` is false for anything else.

- [ ] **Step 1: Write the failing test**

Append to `internal/daemon/file_test.go`:

```go
func TestClassifyAcceptsTextAndImagesAndNothingElse(t *testing.T) {
	png := []byte("\x89PNG\r\n\x1a\n" + strings.Repeat("\x00", 32))

	cases := []struct {
		name string
		head []byte
		kind string
		ok   bool
	}{
		{"go source", []byte("package main\n\nfunc main() {}\n"), "text", true},
		{"json", []byte(`{"name":"flue","private":true}`), "text", true},
		{"an empty file", nil, "text", true},
		{"utf-8 beyond ascii", []byte("// naïve — ✓\n"), "text", true},
		{"a png", png, "image", true},
		{"a compiled object", []byte("\x7fELF\x02\x01\x01\x00\x00\x00"), "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			kind, mime, ok := classify(tc.head)
			if ok != tc.ok {
				t.Fatalf("classify ok = %v, want %v (mime %q)", ok, tc.ok, mime)
			}
			if kind != tc.kind {
				t.Errorf("classify kind = %q, want %q (mime %q)", kind, tc.kind, mime)
			}
			if ok && mime == "" {
				t.Error("an accepted file carries no mime type")
			}
		})
	}
}
```

- [ ] **Step 2: Run it and watch it fail**

```
go test ./internal/daemon/ -run TestClassify -v
```

Expected: compile failure, `undefined: classify`.

- [ ] **Step 3: Write it**

Append to `internal/daemon/file.go` (and add `net/http` and `strings` to its
imports; `strings` is already there from Task 4):

```go
// sniffBytes is how much of a file's head classify needs.
// http.DetectContentType reads at most this many and the extra would be
// discarded.
const sniffBytes = 512

// classify decides what a file is from its first bytes.
//
// From the content, never the extension. An extension is a claim by whoever
// named the file, and the two disagree constantly in a directory an agent has
// been writing in — a .txt holding a PNG, a .log holding a core dump, a file
// with no extension at all holding perfectly ordinary Go.
//
// Only text and images are accepted. Everything else is refused rather than
// sent, because the client has nothing to do with a zip but render it as
// mojibake, and sending megabytes for that is worse than saying no. That
// includes PDFs and archives, which are legible to something but not to a
// viewer this small.
//
// SVG lands in text, since http.DetectContentType reads it as XML. That is the
// honest answer here rather than a special case: this function knows what the
// bytes are, and an SVG genuinely is text — whether a viewer draws it is the
// viewer's decision to make later.
func classify(head []byte) (kind, mime string, ok bool) {
	mime = http.DetectContentType(head)
	base, _, _ := strings.Cut(mime, ";")
	switch {
	case strings.HasPrefix(base, "image/"):
		return "image", mime, true
	case strings.HasPrefix(base, "text/"):
		return "text", mime, true
	}
	return "", mime, false
}
```

- [ ] **Step 4: Run it and watch it pass**

```
go test ./internal/daemon/ -run TestClassify -v
```

Expected: PASS, every subtest.

- [ ] **Step 5: Commit**

```bash
git add internal/daemon/file.go internal/daemon/file_test.go
git commit -m "daemon: decide what a file is from its bytes, not its name"
```

---

### Task 7: Reading a file, one paced chunk at a time

This is the task with the trap in it. The outbox is 256 frames deep and a
connection that fills it is dropped as backlogged (`conn.enqueue`). An 8 MiB
file at 32 KiB a chunk is exactly 256 frames, so a pump that queued its chunks
as fast as it could read them would kill the connection it was answering.

The fix is one chunk in flight: the pump enqueues a chunk, waits for the writer
to have written it, then reads the next. That bounds queued memory to one
chunk, bounds what a keystroke can be stuck behind to 32 KiB, and never touches
the backlog threshold.

**Files:**
- Modify: `internal/daemon/conn.go`
- Modify: `internal/daemon/file.go`
- Modify: `internal/daemon/file_test.go`

**Interfaces:**
- Consumes: `resolvePath`, `classify`, `wire.FrameFile`, `wire.Read`,
  `wire.File`, `wire.Eof`.
- Produces: `frame.sent chan struct{}`; `conn.reads map[uint32]*fileRead`;
  `fileRead`; `conn.startRead(m wire.Read)`; `conn.pump(r *fileRead, limit int64)`;
  `conn.sendChunk(r *fileRead, b []byte) bool`; `conn.endRead(ref uint32)`.

- [ ] **Step 1: Write the failing test**

Append to `internal/daemon/file_test.go`:

```go
// readTarget spawns a session rooted at dir, which is what a read's relative
// paths resolve against.
func readTarget(t *testing.T, reg *session.Registry, dir string) *session.Session {
	t.Helper()
	s, err := reg.Spawn(session.SpawnOpts{Cmd: []string{"cat"}, Cwd: dir, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func TestReadStreamsAFileAndEndsWithEof(t *testing.T) {
	ts, reg := newTestServer(t)
	dir := t.TempDir()
	// Bigger than one chunk, so the pacing path is the path under test rather
	// than an incidental single frame.
	body := strings.Repeat("the quick brown fox\n", 5000)
	if err := os.WriteFile(filepath.Join(dir, "notes.md"), []byte(body), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	s := readTarget(t, reg, dir)

	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Read{ID: s.ID(), Path: "notes.md", ReqID: 31})

	var ref uint32
	readUntil(t, c, func(msg any, _ []byte) bool {
		f, ok := msg.(wire.File)
		if !ok {
			return false
		}
		if f.ReqID != 31 {
			t.Fatalf("File.ReqID = %d, want 31", f.ReqID)
		}
		if f.Kind != "text" {
			t.Fatalf("File.Kind = %q, want text", f.Kind)
		}
		if f.Size != int64(len(body)) {
			t.Fatalf("File.Size = %d, want %d", f.Size, len(body))
		}
		if f.Truncated {
			t.Fatal("File.Truncated is set on a file well under the cap")
		}
		// The resolved path, not the text that was asked about. Resolved the
		// way the daemon resolves it: on macOS t.TempDir() sits under
		// /var/folders, which is itself a symlink to /private/var, so a path
		// assembled from `dir` would not match what the daemon opened.
		want, err := filepath.EvalSymlinks(filepath.Join(dir, "notes.md"))
		if err != nil {
			t.Fatalf("EvalSymlinks: %v", err)
		}
		if f.Path != want {
			t.Fatalf("File.Path = %q, want the resolved path %q", f.Path, want)
		}
		if f.Ref == 0 {
			t.Fatal("File.Ref = 0; refs are numbered from 1")
		}
		ref = f.Ref
		return true
	})

	readUntil(t, c, func(msg any, out []byte) bool {
		e, ok := msg.(wire.Eof)
		if !ok {
			return false
		}
		if e.Ref != ref {
			t.Fatalf("Eof.Ref = %d, want %d", e.Ref, ref)
		}
		if string(out) != body {
			t.Fatalf("streamed %d bytes, want %d", len(out), len(body))
		}
		return true
	})
}

func TestReadSendsTheHeadOfATooLargeFileAndSaysSo(t *testing.T) {
	ts, reg := newTestServer(t)
	dir := t.TempDir()
	// One byte over the cap: the smallest file that proves the boundary.
	body := bytes.Repeat([]byte("x"), maxFileBytes+1)
	if err := os.WriteFile(filepath.Join(dir, "big.log"), body, 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	s := readTarget(t, reg, dir)

	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Read{ID: s.ID(), Path: "big.log", ReqID: 32})

	readUntil(t, c, func(msg any, _ []byte) bool {
		f, ok := msg.(wire.File)
		if !ok {
			return false
		}
		if !f.Truncated {
			t.Fatal("File.Truncated is not set on a file over the cap")
		}
		// The real size, so a viewer can say how much it is not showing.
		if f.Size != int64(len(body)) {
			t.Fatalf("File.Size = %d, want the real %d", f.Size, len(body))
		}
		return true
	})
	readUntil(t, c, func(msg any, out []byte) bool {
		if _, ok := msg.(wire.Eof); !ok {
			return false
		}
		if len(out) != maxFileBytes {
			t.Fatalf("streamed %d bytes, want exactly the cap %d", len(out), maxFileBytes)
		}
		return true
	})
}

func TestReadRefusesWhatItCannotShow(t *testing.T) {
	ts, reg := newTestServer(t)
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatalf("Mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "a.out"), []byte("\x7fELF\x02\x01\x01\x00\x00\x00"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	s := readTarget(t, reg, dir)

	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})

	cases := []struct {
		reqID uint64
		path  string
		code  string
	}{
		{41, "nope.txt", "not_found"},
		{42, "sub", "is_dir"},
		{43, "a.out", "unsupported"},
		{44, "", "bad_path"},
	}
	for _, tc := range cases {
		writeControl(t, c, wire.Read{ID: s.ID(), Path: tc.path, ReqID: tc.reqID})
		readUntil(t, c, func(msg any, _ []byte) bool {
			e, ok := msg.(wire.Error)
			if !ok {
				return false
			}
			if e.ReqID != tc.reqID {
				return false
			}
			if e.Code != tc.code {
				t.Errorf("read %q: code = %q, want %q", tc.path, e.Code, tc.code)
			}
			return true
		})
	}
}

// TestReadReportsThePathItActuallyOpened. A symlink means the file you get is
// not the path you clicked, and file.path is where the reader finds that out.
func TestReadReportsThePathItActuallyOpened(t *testing.T) {
	ts, reg := newTestServer(t)
	dir := t.TempDir()
	target := filepath.Join(dir, "real.md")
	if err := os.WriteFile(target, []byte("# real\n"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if err := os.Symlink(target, filepath.Join(dir, "link.md")); err != nil {
		t.Fatalf("Symlink: %v", err)
	}
	s := readTarget(t, reg, dir)

	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Read{ID: s.ID(), Path: "link.md", ReqID: 46})

	// The temp dir itself can be behind a symlink (/var -> /private/var on
	// macOS), so the expectation is resolved the same way the daemon resolves
	// it rather than assembled from the path this test wrote.
	want, err := filepath.EvalSymlinks(target)
	if err != nil {
		t.Fatalf("EvalSymlinks: %v", err)
	}
	readUntil(t, c, func(msg any, _ []byte) bool {
		f, ok := msg.(wire.File)
		if !ok {
			return false
		}
		if f.Path != want {
			t.Fatalf("File.Path = %q, want the link's target %q", f.Path, want)
		}
		return true
	})
}

func TestReadRefusesAnUnknownSession(t *testing.T) {
	ts, _ := newTestServer(t)
	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Read{ID: "nosuchsession", Path: "x.txt", ReqID: 45})
	readUntil(t, c, func(msg any, _ []byte) bool {
		e, ok := msg.(wire.Error)
		if !ok {
			return false
		}
		if e.ReqID != 45 || e.Code != "not_found" {
			t.Fatalf("error = %+v, want not_found for reqId 45", e)
		}
		return true
	})
}
```

Add `bytes` to `file_test.go`'s imports.

- [ ] **Step 2: Run it and watch it fail**

```
go test ./internal/daemon/ -run TestRead -v
```

Expected: the reads are never answered and each test fails on `readUntil`'s
five-second deadline. `wire.Read` decodes but nothing handles it.

- [ ] **Step 3: Give the writer a way to say a frame has gone**

In `internal/daemon/conn.go`, add a field to `frame`:

```go
	// sent, when non-nil, is closed once this frame has been handed to the
	// socket. It is how the file pump paces itself, and it is only ever set on
	// file chunks.
	//
	// Nothing else needs it: every other frame is small and fire-and-forget,
	// and the outbox absorbs them. A file does not fit that pattern — 8 MiB is
	// 256 chunks, which is exactly outboxDepth, so a pump that queued as fast
	// as it read would trip the backlog check and drop the very connection it
	// was answering.
	sent chan struct{}
```

and close it in `runWriter`, after the write and before the error check, so it
fires whether the write succeeded or not (a pump waiting on a frame that failed
must be released, not left parked until the connection's context unwinds):

```go
		case f := <-c.out:
			ctx, cancel := context.WithTimeout(c.ctx, writeTimeout)
			err := c.mc.Write(ctx, f.text, f.b)
			cancel()
			if f.sent != nil {
				close(f.sent)
			}
			if err != nil || f.last {
```

- [ ] **Step 4: Hold reads on the connection**

Still in `conn.go`, add the map beside `attach` in the `conn` struct:

```go
	mu      sync.Mutex
	nextRef uint32
	attach  map[uint32]*attachment
	// reads are the file reads in flight, keyed by the ref they stream under.
	// Same counter as attach, different table: a read is structurally an
	// attachment (request, handle, binary frames, end) but it holds a file
	// rather than a subscription, and nothing that walks attachments should
	// find one.
	reads map[uint32]*fileRead
```

and build it in `newConn`, beside `attach`:

```go
		attach:    map[uint32]*attachment{},
		reads:     map[uint32]*fileRead{},
```

Then extend `closeAll` so a dropped connection releases its file descriptors.
Add this after the existing detach loop:

```go
	c.mu.Lock()
	reads := make([]uint32, 0, len(c.reads))
	for ref := range c.reads {
		reads = append(reads, ref)
	}
	c.mu.Unlock()
	for _, ref := range reads {
		c.endRead(ref)
	}
```

- [ ] **Step 5: Write the read lifecycle**

Append to `internal/daemon/file.go` (imports gain `io`, `io/fs`, `sync`, and
`"github.com/karnstack/flue/internal/session"` is not needed — the session
comes from the registry through the conn):

```go
// fileRead is one read in flight: an open file, the ref its chunks carry, and
// a way to tell the pump to stop.
type fileRead struct {
	ref  uint32
	f    *os.File
	done chan struct{}
	once sync.Once
}

func (r *fileRead) release() { r.once.Do(func() { close(r.done) }) }

func (r *fileRead) released() bool {
	select {
	case <-r.done:
		return true
	default:
		return false
	}
}

// startRead answers a read: resolve, decide, open, and start the pump.
//
// Everything that can refuse the request happens before a ref is minted, so a
// client that gets an error has nothing to clean up and a client that gets a
// file has a stream that is already running.
func (c *conn) startRead(m wire.Read) {
	s, ok := c.srv.reg.Get(m.ID)
	if !ok {
		c.sendErrorFor(m.ReqID, "not_found", "no such session")
		return
	}
	home, _ := os.UserHomeDir()
	abs, err := resolvePath(m.Path, s.Info().Cwd, home)
	if err != nil {
		c.sendErrorFor(m.ReqID, "bad_path", "not a usable path")
		return
	}
	// Symlinks resolve here rather than in resolvePath, which is pure so its
	// rules can be tested without a filesystem. The resolved path is what gets
	// opened and what file.path reports: a link means the file you get is not
	// the path you clicked, and a reader should be told what it actually
	// opened. EvalSymlinks also fails on a path that is not there, which is
	// where a missing file is usually caught.
	abs, err = filepath.EvalSymlinks(abs)
	if err != nil {
		c.sendErrorFor(m.ReqID, readErrCode(err), "cannot read that path")
		return
	}
	fi, err := os.Stat(abs)
	if err != nil {
		c.sendErrorFor(m.ReqID, readErrCode(err), "cannot read that path")
		return
	}
	if fi.IsDir() {
		c.sendErrorFor(m.ReqID, "is_dir", "that is a directory")
		return
	}
	if !fi.Mode().IsRegular() {
		// A socket, a device, a fifo. Opening one can block forever and none
		// of them has a size worth showing.
		c.sendErrorFor(m.ReqID, "unsupported", "not a regular file")
		return
	}

	f, err := os.Open(abs)
	if err != nil {
		c.sendErrorFor(m.ReqID, readErrCode(err), "cannot read that path")
		return
	}
	head := make([]byte, sniffBytes)
	n, err := io.ReadFull(f, head)
	if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
		_ = f.Close()
		c.sendErrorFor(m.ReqID, readErrCode(err), "cannot read that path")
		return
	}
	kind, mime, ok := classify(head[:n])
	if !ok {
		_ = f.Close()
		c.sendErrorFor(m.ReqID, "unsupported", "not a text or image file")
		return
	}
	limit := int64(maxFileBytes)
	if kind == "image" {
		// Refused rather than truncated: half a PNG is not a smaller PNG.
		if fi.Size() > maxImageBytes {
			_ = f.Close()
			c.sendErrorFor(m.ReqID, "too_large", "image is too large to show")
			return
		}
		limit = maxImageBytes
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		_ = f.Close()
		c.sendErrorFor(m.ReqID, readErrCode(err), "cannot read that path")
		return
	}

	c.mu.Lock()
	if len(c.reads) >= maxReads {
		c.mu.Unlock()
		_ = f.Close()
		c.sendErrorFor(m.ReqID, "busy", "too many reads at once")
		return
	}
	c.nextRef++
	r := &fileRead{ref: c.nextRef, f: f, done: make(chan struct{})}
	c.reads[r.ref] = r
	c.mu.Unlock()

	_ = c.sendControl(wire.File{
		Ref:       r.ref,
		Path:      abs,
		Size:      fi.Size(),
		Mime:      mime,
		Kind:      kind,
		Truncated: fi.Size() > limit,
		ReqID:     m.ReqID,
	})
	go c.pump(r, limit)
}

// readErrCode maps a filesystem error to the code the client is told.
//
// Two outcomes, because two are all a client can act on: it may not read this,
// or there is nothing there. Anything else — a broken device, an interrupted
// syscall — reads as not_found, which is what the user sees anyway.
func readErrCode(err error) string {
	if errors.Is(err, fs.ErrPermission) {
		return "denied"
	}
	return "not_found"
}

// pump streams the file under its ref and ends with eof.
//
// One chunk in flight at a time; see sendChunk. The loop stops at limit rather
// than at the size read earlier, because a file can grow between the stat and
// the read and the cap is the promise that matters.
func (c *conn) pump(r *fileRead, limit int64) {
	defer c.endRead(r.ref)

	buf := make([]byte, chunkBytes)
	var sent int64
	for sent < limit {
		want := int64(len(buf))
		if left := limit - sent; left < want {
			want = left
		}
		n, err := r.f.Read(buf[:want])
		if n > 0 {
			sent += int64(n)
			if !c.sendChunk(r, buf[:n]) {
				return
			}
		}
		if err != nil {
			break
		}
	}
	// A cancelled read is over, and eof would tell the client a stream it
	// abandoned finished cleanly.
	if r.released() {
		return
	}
	_ = c.sendControl(wire.Eof{Ref: r.ref})
}

// sendChunk queues one chunk and waits for the writer to have written it.
//
// The wait is the flow control, and it is doing three jobs. The outbox holds
// 256 frames and drops a connection that fills it, and an 8 MiB file is
// exactly 256 chunks — so a pump that queued as fast as it read would drop the
// connection it was answering. It bounds queued memory to one chunk rather
// than a whole file. And it bounds what the next keystroke can be queued
// behind to 32 KiB, on a socket that carries the terminal too.
//
// It costs nothing in throughput: a websocket write returns when the bytes
// reach the socket buffer, not when the far end acknowledges them, so this
// paces the pump against the link rather than against the round trip.
func (c *conn) sendChunk(r *fileRead, b []byte) bool {
	sent := make(chan struct{})
	if err := c.enqueue(frame{b: wire.EncodeBinary(wire.FrameFile, r.ref, b), sent: sent}); err != nil {
		return false
	}
	select {
	case <-sent:
		return true
	case <-r.done:
		return false
	case <-c.ctx.Done():
		return false
	}
}

// endRead closes a read and forgets it. Safe to call twice: the pump ends every
// read it finishes, and a cancel or a dropped connection may have ended the
// same one already.
func (c *conn) endRead(ref uint32) {
	c.mu.Lock()
	r := c.reads[ref]
	delete(c.reads, ref)
	c.mu.Unlock()
	if r == nil {
		return
	}
	// Released before the file is closed, so a pump blocked in sendChunk stops
	// waiting rather than discovering it later through a read error.
	r.release()
	_ = r.f.Close()
}
```

Add `"errors"` and `"io/fs"` and `"io"` and `"sync"` to `file.go`'s imports.
`errors` is already there from Task 4.

- [ ] **Step 6: Add the dispatch arm**

In `conn.go`'s `handleControl`, after the `case wire.Stat:` block:

```go
	case wire.Read:
		c.startRead(m)
```

- [ ] **Step 7: Run it and watch it pass**

```
go test ./internal/daemon/ -run TestRead -v
```

Expected: PASS, all four tests.

- [ ] **Step 8: Run the whole daemon suite with the race detector**

```
go test -race ./internal/daemon/
```

Expected: PASS, no race reports. The pump is a goroutine touching a file and a
map that the read loop also touches, so this is the run that matters.

- [ ] **Step 9: Commit**

```bash
git add internal/daemon/file.go internal/daemon/conn.go internal/daemon/file_test.go
git commit -m "daemon: stream a file under its own ref, one paced chunk at a time"
```

---

### Task 8: Cancelling, and the caps that bound a connection

**Files:**
- Modify: `internal/daemon/conn.go`
- Modify: `internal/daemon/file_test.go`

**Interfaces:**
- Consumes: `conn.endRead`, `wire.Cancel`.
- Produces: a `case wire.Cancel:` arm in `handleControl`.

- [ ] **Step 1: Write the failing test**

Append to `internal/daemon/file_test.go`:

```go
// TestCancelStopsAReadAndReleasesItsRef proves the two halves that matter: no
// eof arrives for a cancelled read, and the slot it held is free again.
//
// The second half is the observable one. maxReads is 2, so a connection that
// cancels one read and starts two more only succeeds if the cancel actually
// released the first — otherwise the third is refused with busy.
func TestCancelStopsAReadAndReleasesItsRef(t *testing.T) {
	ts, reg := newTestServer(t)
	dir := t.TempDir()
	body := bytes.Repeat([]byte("y"), 4<<20)
	for _, name := range []string{"one.log", "two.log", "three.log"} {
		if err := os.WriteFile(filepath.Join(dir, name), body, 0o644); err != nil {
			t.Fatalf("WriteFile: %v", err)
		}
	}
	s := readTarget(t, reg, dir)

	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Read{ID: s.ID(), Path: "one.log", ReqID: 51})

	var ref uint32
	readUntil(t, c, func(msg any, _ []byte) bool {
		f, ok := msg.(wire.File)
		if !ok {
			return false
		}
		ref = f.Ref
		return true
	})
	writeControl(t, c, wire.Cancel{Ref: ref})

	// Two more reads have to fit. They only do if the cancel gave the slot
	// back, since maxReads is 2 and the cancelled read would otherwise still
	// hold one. Deterministic rather than racy: one connection has one read
	// loop, so the cancel is handled before either read behind it.
	writeControl(t, c, wire.Read{ID: s.ID(), Path: "two.log", ReqID: 52})
	writeControl(t, c, wire.Read{ID: s.ID(), Path: "three.log", ReqID: 53})

	seen := map[uint64]bool{}
	readUntil(t, c, func(msg any, _ []byte) bool {
		switch v := msg.(type) {
		case wire.File:
			seen[v.ReqID] = true
		case wire.Error:
			if v.ReqID == 52 || v.ReqID == 53 {
				t.Fatalf("read %d refused with %q; the cancelled read did not release its slot", v.ReqID, v.Code)
			}
		}
		return seen[52] && seen[53]
	})
}

// TestReadsAreCappedPerConnection pins the refusal itself, which the test
// above only proves the absence of.
func TestReadsAreCappedPerConnection(t *testing.T) {
	ts, reg := newTestServer(t)
	dir := t.TempDir()
	body := bytes.Repeat([]byte("z"), 6<<20)
	for _, name := range []string{"a.log", "b.log", "c.log"} {
		if err := os.WriteFile(filepath.Join(dir, name), body, 0o644); err != nil {
			t.Fatalf("WriteFile: %v", err)
		}
	}
	s := readTarget(t, reg, dir)

	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	// Three at once against a cap of two. The files are large enough that the
	// first two are still streaming when the third arrives.
	writeControl(t, c, wire.Read{ID: s.ID(), Path: "a.log", ReqID: 61})
	writeControl(t, c, wire.Read{ID: s.ID(), Path: "b.log", ReqID: 62})
	writeControl(t, c, wire.Read{ID: s.ID(), Path: "c.log", ReqID: 63})

	readUntil(t, c, func(msg any, _ []byte) bool {
		e, ok := msg.(wire.Error)
		if !ok {
			return false
		}
		if e.ReqID != 63 {
			t.Fatalf("error = %+v, want it to answer the third read", e)
		}
		if e.Code != "busy" {
			t.Fatalf("error code = %q, want busy", e.Code)
		}
		return true
	})
}

// TestCancelOfAnUnknownRefIsIgnored: a client may cancel a read the daemon has
// already finished, and a race the client cannot avoid must not be an error it
// has to handle.
func TestCancelOfAnUnknownRefIsIgnored(t *testing.T) {
	ts, reg := newTestServer(t)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "small.txt"), []byte("hi\n"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	s := readTarget(t, reg, dir)

	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Cancel{Ref: 999})
	// The connection is still usable, and says so by answering the next thing
	// asked of it.
	writeControl(t, c, wire.Read{ID: s.ID(), Path: "small.txt", ReqID: 71})
	readUntil(t, c, func(msg any, _ []byte) bool {
		f, ok := msg.(wire.File)
		if !ok {
			return false
		}
		if f.ReqID != 71 {
			t.Fatalf("File.ReqID = %d, want 71", f.ReqID)
		}
		return true
	})
}
```

- [ ] **Step 2: Run it and watch it fail**

```
go test ./internal/daemon/ -run 'TestCancel|TestReadsAreCapped' -v
```

Expected: `TestCancelStopsAReadAndReleasesItsRef` fails (the cancel does
nothing, so the third read is refused with `busy`) and
`TestCancelOfAnUnknownRefIsIgnored` fails on the deadline or on a `bad_message`
error. `TestReadsAreCappedPerConnection` may already pass, since the cap
landed in Task 7.

- [ ] **Step 3: Add the dispatch arm**

In `conn.go`'s `handleControl`, after the `case wire.Read:` arm:

```go
	case wire.Cancel:
		// A ref this connection does not hold is ignored rather than refused.
		// A read finishing and a client cancelling it cross on the wire all the
		// time — a viewer closed as the last chunk lands — and a race the
		// client cannot avoid must not be an error it has to handle.
		c.endRead(m.Ref)
```

- [ ] **Step 4: Run it and watch it pass**

```
go test ./internal/daemon/ -run 'TestCancel|TestReadsAreCapped' -v
```

Expected: PASS, all three.

- [ ] **Step 5: Prove a dropped connection releases its files**

Append to `internal/daemon/file_test.go`:

```go
// TestClosingAConnectionEndsItsReads. A phone that goes into a pocket
// mid-read must not leave a file open on the machine. The pump is a goroutine
// holding a descriptor; nothing else would ever end it.
func TestClosingAConnectionEndsItsReads(t *testing.T) {
	ts, reg := newTestServer(t)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "big.log"), bytes.Repeat([]byte("q"), 6<<20), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	s := readTarget(t, reg, dir)

	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Read{ID: s.ID(), Path: "big.log", ReqID: 81})
	readUntil(t, c, func(msg any, _ []byte) bool {
		_, ok := msg.(wire.File)
		return ok
	})

	// Drop it mid-stream. Under -race, a pump that kept running against a
	// closed connection or a closed file is what this catches.
	_ = c.CloseNow()

	// A fresh connection can start two reads, which it could not if the
	// dropped one's read were somehow still counted. The cap is per
	// connection, so this asserts the pump ended rather than the slot: the
	// stronger claim is the -race run below.
	c2 := dial(t, ts)
	writeControl(t, c2, wire.Hello{Ver: "test"})
	writeControl(t, c2, wire.Read{ID: s.ID(), Path: "big.log", ReqID: 82})
	readUntil(t, c2, func(msg any, _ []byte) bool {
		f, ok := msg.(wire.File)
		return ok && f.ReqID == 82
	})
}
```

`CloseNow` is `github.com/coder/websocket`'s abrupt close: it closes the
underlying connection without the closing handshake, which is what a phone
losing its network looks like from the daemon's side.

- [ ] **Step 6: Run the whole suite, with the race detector**

```
go test -race ./internal/daemon/ -v
```

Expected: PASS, no race reports, no goroutine complaining after a test ends.

- [ ] **Step 7: Commit**

```bash
git add internal/daemon/conn.go internal/daemon/file_test.go
git commit -m "daemon: cancel a read, and release every read a connection held"
```

---

### Task 9: The contract, and the full suite

`spec/protocol.md` is the contract rather than a description of one, so a
message that is not in it does not exist as far as the next reader is
concerned.

**Files:**
- Modify: `spec/protocol.md`

- [ ] **Step 1: Add the messages to the tables**

In `spec/protocol.md`, add to the "Client to server" table, after the `peek`
row:

```
| `stat` | `id`, `paths[]`, `reqId?` | ask whether paths exist, relative to a session |
| `read` | `id`, `path`, `reqId?` | start reading one |
| `cancel` | `ref` | abandon a read in flight |
```

and to the "Server to client" table, after the `preview` row:

```
| `stats` | `entries[]`, `reqId?` | answers `stat` |
| `file` | `ref`, `path`, `size`, `mime`, `kind`, `truncated?`, `reqId?` | answers `read`; content follows as `0x02` frames |
| `eof` | `ref` | that read has sent every byte |
```

- [ ] **Step 2: Add the frame type**

In the "Binary frames" block near the top, extend the list:

```
0x00  output      daemon -> client
0x01  input       client -> daemon
0x02  file chunk  daemon -> client
```

and add a sentence under it:

> A `0x02` frame's `ref` is a read's handle rather than an attachment's, minted
> from the same counter. A client routes on the frame type, not on the ref.

- [ ] **Step 3: Write the section**

Add a `### Reading files` section after `### Previews`:

```markdown
### Reading files

`stat` and `read` answer the two questions a terminal cannot: is this text a
real path, and what is in it. They exist because an agent session names files
constantly and the reader is often on a device with no other window to open
one in.

Resolution is the daemon's. A leading `~` expands to the daemon user's home, a
relative path resolves against the session's live working directory, and the
result is cleaned; `file.path` reports the resolved path, while each
`stats.entries[].path` echoes the text that was asked about, in the order it
was asked. A relative path that does not exist under the session's cwd is a
miss, with no second attempt against the spawn directory: two resolution rules
would make "opened the wrong file" indistinguishable from "opened the right
one".

`stat` takes up to 32 paths at once, because a client verifies a whole hovered
line rather than one candidate at a time, and a path it cannot resolve is
`exists: false` rather than an error — "no" is the ordinary answer here.

`read` mints a `ref` from the same counter `attach` uses and answers `file`,
after which the content arrives as `0x02` frames under that ref and ends with
`eof`. Chunks are 32 KiB: a WebSocket message is capped at 1 MiB, and file
content shares one socket with the terminal, so a larger frame would sit in
front of the next keystroke. The daemon keeps one chunk in flight at a time for
the same reason.

What may be read is anything the daemon's user can read, and nothing is
written. That is not a widening: a client that can send `read` can already send
`spawn` and run `cat`, and both run as the same user.

Text is sent to 8 MiB, past which `file.truncated` is true, `file.size` remains
the real size, and only the head arrives. An image is refused past 4 MiB rather
than truncated. `file.kind` is `text` or `image`, sniffed from the content and
never from the extension; anything else is refused. Two reads may be open per
connection.

`cancel` abandons a read by `ref`. A ref the daemon does not hold is ignored:
a read finishing and a client cancelling it cross on the wire routinely, and a
race the client cannot avoid should not be an error it has to handle. Every
read is ended and its file closed when the connection drops.

Refusals are `not_found`, `is_dir`, `too_large`, `denied`, `bad_path`, `busy`
and `unsupported`, each correlated by `reqId`.
```

- [ ] **Step 4: Run everything**

```
go test ./...
cd web && pnpm vitest run && pnpm run lint
```

Expected: PASS throughout. `web` should be untouched by this task, so a failure
there means something from Task 3 was left half-done.

- [ ] **Step 5: Commit and open the pull request**

```bash
git add spec/protocol.md
git commit -m "spec: stat, read, cancel, and the file frame"
git push -u origin feat/file-peek
gh pr create --title "Read a file the session named: the wire and the daemon" --body "$(cat <<'EOF'
Phase 1 of the file peek design: the daemon can answer "does this path exist"
and "send me this file", over the wire protocol.

No UI yet, and no HTTP endpoint. An `/api/file` would work on loopback and be
invisible from a phone, because the relay forwards exactly one piece of HTTP
and it is pairing. `peek` is the precedent.

- `stat` verifies every path on a hovered line in one message
- `read` mints a ref and streams content as `0x02` frames, ending with `eof`
- `cancel` abandons one, and a dropped connection ends every read it held
- Chunks are 32 KiB with one in flight, which keeps an 8 MiB file from
  filling the 256-frame outbox and dropping the connection it is answering
- Reads reach anything the daemon user can read, which is what a client that
  can `spawn` a shell could already reach. Nothing writes.

Design: `docs/superpowers/specs/2026-08-11-file-peek-design.md`
Plan: `docs/superpowers/plans/2026-08-11-file-peek-phase-1-wire-and-daemon.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## What phase 2 picks up

Phase 2 gets its own plan and covers the browser: `client.ts` methods for
`stat`, `read` and `cancel` with chunk routing by ref, the `detectLinks` seam
on the emulator, the xterm link provider with wrapped-line assembly, the
candidate matcher in `web/src/lib/paths.ts`, and a plain-text viewer. It
underlines a candidate only when its `stats` entry is `kind: "file"`, so a
directory does not pretend to be openable.

The e2e case the design calls for, a relayed read against a real Worker, lands
with phase 2 rather than here: `web/e2e` drives the browser client, which does
not exist until then. Phase 1's relay-shaped claims (the 1 MiB cap, the paced
chunks) are pinned by the caps and the Go tests above until it does.

Phase 3 adds Shiki with the JavaScript regex engine, `data:` images, and the
content cache.
