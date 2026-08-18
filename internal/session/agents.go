package session

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Claude Code is not the only tool whose work outlives its process. Codex and
// Pi keep per-conversation transcripts on disk too, and each can be told to
// pick a conversation back up — by id for Codex, by transcript path for Pi.
// This file is claude.go's doctrine extended to all three: read the stores at
// snapshot time, never write them, answer every failure with "no session",
// and let the worst case be a printed command that says it cannot find that
// conversation.
//
// The agent names here are the snapshot's wire strings — they travel in the
// snapshot JSON from one daemon to the next, so they are spelled once.
const (
	agentClaude = "claude"
	agentCodex  = "codex"
	agentPi     = "pi"
)

// Codex keeps rollouts under ~/.codex/sessions/YYYY/MM/DD, one
// rollout-<timestamp>-<uuid>.jsonl per conversation, and its first line is a
// session_meta record naming the conversation's id and working directory.
// Unlike Claude's store there is no per-project directory, so matching a
// shell's cwd means opening candidate files — which is why the walk below is
// bounded twice, by date directory and then by mtime, before a single file
// is read.
func codexSessionsRoot(home string) string {
	if home == "" {
		return ""
	}
	return filepath.Join(home, ".codex", "sessions")
}

// Pi keeps sessions under ~/.pi/agent/sessions, one directory per working
// directory, one <timestamp>_<uuid>.jsonl per conversation whose first line
// names the id and cwd. The directory name is a slug of the cwd, but the
// slug's exact spelling is Pi's own business — the honest match is the cwd
// recorded inside the file, so the scan reads first lines the way the Codex
// one does rather than guessing at directory names.
func piSessionsRoot(home string) string {
	if home == "" {
		return ""
	}
	return filepath.Join(home, ".pi", "agent", "sessions")
}

// agentFirstLineCap bounds how much of a transcript's first line the scans
// below will read. A Codex session_meta line carries the model's base
// instructions and runs to tens of kilobytes; a line still unfinished at this
// cap is not one these scans can judge, and the file is skipped rather than
// held in memory.
const agentFirstLineCap = 256 << 10

// transcriptCandidate is a file worth opening: where it is and when it was
// last written. The scans collect these cheaply — stat only — and read
// newest-first, so the common case opens one file.
type transcriptCandidate struct {
	path string
	at   time.Time
}

// firstLine reads path's first line, up to agentFirstLineCap bytes. A file
// shorter than the cap with no trailing newline is its own first line; a
// line longer than the cap is nobody's.
func firstLine(path string) ([]byte, bool) {
	f, err := os.Open(path)
	if err != nil {
		return nil, false
	}
	defer f.Close()
	buf := make([]byte, agentFirstLineCap)
	n, err := io.ReadFull(f, buf)
	if err != nil && n == 0 {
		return nil, false
	}
	data := buf[:n]
	if i := bytes.IndexByte(data, '\n'); i >= 0 {
		return data[:i], true
	}
	if n < agentFirstLineCap {
		return data, len(data) > 0
	}
	return nil, false
}

// newestFirst orders candidates for reading. Stable ordering matters only to
// tests; to the user, two transcripts written the same nanosecond are the
// same guess.
func newestFirst(cands []transcriptCandidate) {
	sort.Slice(cands, func(i, j int) bool { return cands[i].at.After(cands[j].at) })
}

// latestCodexSession is the id of the newest Codex conversation whose
// recorded cwd is cwd, written at or after notBefore — the same deadline
// filter, for the same reason, as latestClaudeSession.
//
// The walk is the store's own year/month/day layout, and it descends only
// into day directories at or after notBefore's calendar day (the store names
// its days in local time, as the rollout filenames show). Everything that
// survives the date and mtime filters gets its first line read, newest
// first, until one names the right cwd.
func latestCodexSession(root, cwd string, notBefore time.Time) (string, time.Time, bool) {
	if root == "" || cwd == "" {
		return "", time.Time{}, false
	}
	nb := notBefore.Local()
	nbDay := nb.Year()*10_000 + int(nb.Month())*100 + nb.Day()
	var cands []transcriptCandidate
	years, err := os.ReadDir(root)
	if err != nil {
		return "", time.Time{}, false
	}
	for _, y := range years {
		yn, yok := dirNum(y)
		if !yok || (yn+1)*10_000 <= nbDay {
			continue
		}
		months, err := os.ReadDir(filepath.Join(root, y.Name()))
		if err != nil {
			continue
		}
		for _, m := range months {
			mn, mok := dirNum(m)
			if !mok || (yn*100+mn+1)*100 <= nbDay {
				continue
			}
			days, err := os.ReadDir(filepath.Join(root, y.Name(), m.Name()))
			if err != nil {
				continue
			}
			for _, d := range days {
				dn, dok := dirNum(d)
				if !dok || yn*10_000+mn*100+dn < nbDay {
					continue
				}
				files, err := os.ReadDir(filepath.Join(root, y.Name(), m.Name(), d.Name()))
				if err != nil {
					continue
				}
				for _, f := range files {
					if f.IsDir() || !strings.HasSuffix(f.Name(), transcriptSuffix) {
						continue
					}
					info, err := f.Info()
					if err != nil || info.ModTime().Before(notBefore) {
						continue
					}
					cands = append(cands, transcriptCandidate{
						path: filepath.Join(root, y.Name(), m.Name(), d.Name(), f.Name()),
						at:   info.ModTime(),
					})
				}
			}
		}
	}
	newestFirst(cands)
	for _, c := range cands {
		line, ok := firstLine(c.path)
		if !ok {
			continue
		}
		var meta struct {
			Type    string `json:"type"`
			Payload struct {
				ID  string `json:"id"`
				Cwd string `json:"cwd"`
			} `json:"payload"`
		}
		if json.Unmarshal(line, &meta) != nil || meta.Type != "session_meta" || meta.Payload.Cwd != cwd {
			continue
		}
		id := meta.Payload.ID
		if id == "" {
			// The uuid tail of rollout-<timestamp>-<uuid>: the same fallback
			// identity agentstore uses for a meta line with no id.
			name := strings.TrimSuffix(filepath.Base(c.path), transcriptSuffix)
			if len(name) <= 36 {
				continue
			}
			id = name[len(name)-36:]
		}
		return id, c.at, true
	}
	return "", time.Time{}, false
}

// dirNum reads a directory entry named by a number — the only kind the Codex
// store's date levels hold. Anything else is not part of the layout.
func dirNum(e os.DirEntry) (int, bool) {
	if !e.IsDir() {
		return 0, false
	}
	n, err := strconv.Atoi(e.Name())
	if err != nil || n < 0 {
		return 0, false
	}
	return n, true
}

// latestPiSession is the transcript path of the newest Pi conversation whose
// recorded cwd is cwd, written at or after notBefore. A path rather than an
// id because that is what `pi --session` takes.
func latestPiSession(root, cwd string, notBefore time.Time) (string, time.Time, bool) {
	if root == "" || cwd == "" {
		return "", time.Time{}, false
	}
	dirs, err := os.ReadDir(root)
	if err != nil {
		return "", time.Time{}, false
	}
	var cands []transcriptCandidate
	for _, d := range dirs {
		if !d.IsDir() {
			continue
		}
		files, err := os.ReadDir(filepath.Join(root, d.Name()))
		if err != nil {
			continue
		}
		for _, f := range files {
			if f.IsDir() || !strings.HasSuffix(f.Name(), transcriptSuffix) {
				continue
			}
			info, err := f.Info()
			if err != nil || info.ModTime().Before(notBefore) {
				continue
			}
			cands = append(cands, transcriptCandidate{
				path: filepath.Join(root, d.Name(), f.Name()),
				at:   info.ModTime(),
			})
		}
	}
	newestFirst(cands)
	for _, c := range cands {
		line, ok := firstLine(c.path)
		if !ok {
			continue
		}
		var meta struct {
			Type string `json:"type"`
			Cwd  string `json:"cwd"`
		}
		if json.Unmarshal(line, &meta) != nil || meta.Type != "session" || meta.Cwd != cwd {
			continue
		}
		return c.path, c.at, true
	}
	return "", time.Time{}, false
}

// agentSessionFor is the conversation a session running in cwd since since
// most plausibly belongs to — which tool's, and the reference its resume
// command wants — or ("", "") when there is no evidence of one.
//
// When more than one store answers, the newest transcript wins: a shell that
// ran Claude Code in the morning and Codex in the afternoon was last doing
// the afternoon's work, and one hint line is all the seam has room for.
func agentSessionFor(cwd string, since time.Time) (agent, ref string) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", ""
	}
	var bestAt time.Time
	consider := func(a, r string, at time.Time, ok bool) {
		if ok && (agent == "" || at.After(bestAt)) {
			agent, ref, bestAt = a, r, at
		}
	}
	id, at, ok := latestClaudeSession(claudeProjectDir(home, cwd), since)
	consider(agentClaude, id, at, ok)
	id, at, ok = latestCodexSession(codexSessionsRoot(home), cwd, since)
	consider(agentCodex, id, at, ok)
	path, at, ok := latestPiSession(piSessionsRoot(home), cwd, since)
	consider(agentPi, path, at, ok)
	return agent, ref
}
