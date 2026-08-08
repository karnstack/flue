package session

import (
	"os"
	"path/filepath"
	"strings"
	"time"
)

// The daemon is the session holder: its shells are its children and they die
// with it. Revive brings a session back with its scrollback and a fresh shell,
// which is the best anything on this side of the pty can do — the process that
// was running is gone, and no amount of bookkeeping brings a process back.
//
// For one program that is not the whole story. Claude Code keeps its own
// transcript per conversation, on disk, under the user's home directory, and
// can be told to pick one back up by id. So the process is unrecoverable and
// the *work* is not, and the difference between those two is a line of text:
// the marker that says the shell ended can name the command that resumes what
// the shell was doing.
//
// Nothing here is a promise about Claude Code's internals. The layout below is
// read at snapshot time and never written, every failure is answered with "no
// id", and an id that turns out to be wrong costs the user one command that
// says it cannot find that conversation. That is the whole exposure, and it is
// why this is a hint printed into the scrollback rather than a command the
// daemon runs on the user's behalf.

const (
	// claudeHomeDir and claudeProjectsDir are where Claude Code keeps its
	// transcripts: one directory per project, named after the project's path,
	// holding one .jsonl per conversation named after the conversation's id.
	claudeHomeDir     = ".claude"
	claudeProjectsDir = "projects"

	// transcriptSuffix is what a conversation's file is called.
	transcriptSuffix = ".jsonl"
)

// claudeSlug is a working directory as Claude Code names its project
// directory: every character that is not a letter or a digit becomes a hyphen,
// so /Users/karn/code/flue becomes -Users-karn-code-flue and a path with a dot
// segment in it — /Users/karn/code/flue/.claude/worktrees/ship — becomes
// -Users-karn-code-flue--claude-worktrees-ship, the doubled hyphen being the
// separator and the dot in sequence.
//
// ASCII-wise on purpose. The mapping is over bytes rather than runes because a
// multi-byte character would otherwise become one hyphen where the directory
// on disk has one per byte, and getting that wrong is a lookup that silently
// finds nothing rather than one that finds the wrong thing.
func claudeSlug(cwd string) string {
	var b strings.Builder
	b.Grow(len(cwd))
	for i := 0; i < len(cwd); i++ {
		ch := cwd[i]
		switch {
		case ch >= 'a' && ch <= 'z', ch >= 'A' && ch <= 'Z', ch >= '0' && ch <= '9':
			b.WriteByte(ch)
		default:
			b.WriteByte('-')
		}
	}
	return b.String()
}

// claudeProjectDir is where Claude Code would keep the transcripts for work
// done in cwd, given home. An empty home or cwd names nothing.
func claudeProjectDir(home, cwd string) string {
	if home == "" || cwd == "" {
		return ""
	}
	return filepath.Join(home, claudeHomeDir, claudeProjectsDir, claudeSlug(cwd))
}

// latestClaudeSession is the id of the most recently written conversation in
// dir, provided it was written at or after notBefore.
//
// The deadline is the entire filter, and it is what keeps this from attaching
// a stranger's conversation to a shell that never ran Claude Code. A session's
// own start time is what callers pass: a transcript last written before the
// shell existed cannot be that shell's work, whereas one written during its
// life plausibly is. "Plausibly" is as strong as this gets — two shells in one
// directory would both be offered the newer of the two conversations — and it
// is why the result is printed as a suggestion rather than acted on.
//
// Every failure is the same answer. A missing directory is a project Claude
// Code has never been run in; an unreadable one is a permissions problem the
// user has bigger reasons to care about; a file whose mtime cannot be read is
// skipped. None of them is worth a log line on a shutdown path.
func latestClaudeSession(dir string, notBefore time.Time) (string, bool) {
	if dir == "" {
		return "", false
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", false
	}
	var (
		best   string
		bestAt time.Time
	)
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), transcriptSuffix) {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		at := info.ModTime()
		if at.Before(notBefore) || (best != "" && !at.After(bestAt)) {
			continue
		}
		best, bestAt = strings.TrimSuffix(e.Name(), transcriptSuffix), at
	}
	return best, best != ""
}

// claudeSessionFor is the conversation a session running in cwd since since
// most plausibly belongs to, or "" when there is no evidence of one.
func claudeSessionFor(cwd string, since time.Time) string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	id, ok := latestClaudeSession(claudeProjectDir(home, cwd), since)
	if !ok {
		return ""
	}
	return id
}
