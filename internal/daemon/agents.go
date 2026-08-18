package daemon

import (
	"errors"

	"github.com/karnstack/flue/internal/agentstore"
	"github.com/karnstack/flue/internal/wire"
)

// The agent transcript verbs: agents, agentRead, agentSearch.
//
// The daemon serves these rather than the client reading files itself,
// because the transcripts live under the daemon user's home and the client
// may be a phone on the other side of a relay. They ride the wire protocol
// rather than HTTP for the same reason every remote interaction does: the
// Noise channel is the only leg a relayed tab has, and a loopback-only HTTP
// endpoint would make the feature local-only for no reason it could name.
//
// Sessions are addressed as (tool, id) and never as paths. The index is the
// only thing that turns one into the other, so nothing a client sends names a
// file — the read verb's resolution rules are for files a session mentioned;
// these verbs are for stores whose layout is the daemon's business alone.
//
// The verbs are answers, not streams: each request does its bounded piece of
// file work and replies once. The file work runs on a goroutine per request,
// the way startRead's pump does, so a search that walks sixty megabytes never
// stops the read loop answering keystrokes — but unlike a read there is no
// per-request state to hold or cancel by name: the reply is the whole of it,
// which is why nothing here mints a ref or adds a table to conn. What the
// goroutines do get is a count and a cap — maxAgentWork below, the maxReads
// shape, refused with busy — and, for search, the connection's context, so a
// connection that closes mid-scan abandons the walk rather than making
// closeAll's pumps.Wait sit through the rest of a sixty-four megabyte budget.
// A page read takes no context on purpose: its file work is bounded to one
// window (readBudget, widened at worst to maxLineBytes plus it), which is
// finished long before a cancellation could usefully interrupt it.

// maxAgentWork is how many agent verbs one connection may be answering at
// once. The bound is on goroutines and the file reads behind them: without
// one, a client can queue an unbounded pile of searches and every one walks
// files until teardown. Four is a viewer's honest worst case — a search still
// scanning, the page a hit opened, and a prefetch either side — with nothing
// to spare, because a client that wants a fifth answer sooner should not get
// it by costing this machine five concurrent scans. The agents verb itself
// stays uncounted: it answers from memory on the read loop and holds no
// goroutine to cap.
const maxAgentWork = 4

// SetAgentIndex installs the transcript index. Nil — a Server nobody wired,
// which is every test's default and a daemon whose home directory could not
// be resolved — leaves the verbs answering bad_message and keeps the
// capability out of the welcome, so a client never draws a screen the daemon
// cannot fill.
func (s *Server) SetAgentIndex(idx *agentstore.Index) {
	s.agentIdxMu.Lock()
	defer s.agentIdxMu.Unlock()
	s.agentIdx = idx
}

func (s *Server) agentIndex() *agentstore.Index {
	s.agentIdxMu.Lock()
	defer s.agentIdxMu.Unlock()
	return s.agentIdx
}

// handleAgents answers the agents verb. A snapshot of the in-memory index —
// no file work — so it runs on the read loop like list does.
func (c *conn) handleAgents(m wire.Agents) {
	idx := c.srv.agentIndex()
	if idx == nil {
		c.sendErrorFor(m.ReqID, "bad_message", "agents unavailable")
		return
	}
	sessions, building := idx.Snapshot(m.Tools, m.Cwd)
	_ = c.sendControl(wire.AgentIndex{Building: building, Sessions: sessions, ReqID: m.ReqID})
}

// beginAgentWork claims one of the connection's agent-work slots, answering
// busy over reqID when none is free. The refusal takes no slot — a client
// refused N times in a row is owed the same capacity it started with — and it
// is cheap by design: the check runs on the read loop, before any goroutine
// or file is committed.
func (c *conn) beginAgentWork(reqID uint64) bool {
	c.mu.Lock()
	if c.agentWork >= maxAgentWork {
		c.mu.Unlock()
		c.sendErrorFor(reqID, "busy", "too many agent requests at once")
		return false
	}
	c.agentWork++
	c.mu.Unlock()
	return true
}

func (c *conn) endAgentWork() {
	c.mu.Lock()
	c.agentWork--
	c.mu.Unlock()
}

// handleAgentRead answers agentRead on its own goroutine: one page is a
// bounded window of one file, but a window of a cold file on a slow disk is
// still no business of the loop the next keystroke arrives on.
func (c *conn) handleAgentRead(m wire.AgentRead) {
	idx := c.srv.agentIndex()
	if idx == nil {
		c.sendErrorFor(m.ReqID, "bad_message", "agents unavailable")
		return
	}
	if m.Dir != "" && m.Dir != "forward" && m.Dir != "backward" {
		c.sendErrorFor(m.ReqID, "bad_message", "dir must be forward or backward")
		return
	}
	if !c.beginAgentWork(m.ReqID) {
		return
	}
	c.pumps.Add(1)
	go func() {
		defer c.pumps.Done()
		defer c.endAgentWork()
		page, err := idx.ReadPage(agentstore.Tool(m.Tool), m.ID, m.Offset, m.Dir, m.Limit)
		if c.ctx.Err() != nil {
			return
		}
		if err != nil {
			c.sendErrorFor(m.ReqID, agentErrCode(err), "cannot read that transcript")
			return
		}
		_ = c.sendControl(wire.AgentPage{
			Tool: m.Tool, ID: m.ID, Messages: page.Messages,
			Start: page.Start, Next: page.Next, Eof: page.Eof,
			FileSize: page.FileSize, ReqID: m.ReqID,
		})
	}()
}

// handleAgentSearch answers agentSearch on its own goroutine, for the reason
// agentRead gets one with less argument: a search's budget is sixty-four
// megabytes of other tools' files.
func (c *conn) handleAgentSearch(m wire.AgentSearch) {
	idx := c.srv.agentIndex()
	if idx == nil {
		c.sendErrorFor(m.ReqID, "bad_message", "agents unavailable")
		return
	}
	if !c.beginAgentWork(m.ReqID) {
		return
	}
	c.pumps.Add(1)
	go func() {
		defer c.pumps.Done()
		defer c.endAgentWork()
		hits, building, truncated, err := idx.Search(c.ctx, m.Query, m.Tools, m.Cwd, m.Limit)
		if c.ctx.Err() != nil {
			return
		}
		if err != nil {
			c.sendErrorFor(m.ReqID, agentErrCode(err), "cannot run that search")
			return
		}
		_ = c.sendControl(wire.AgentHits{
			Building: building, Truncated: truncated, Hits: hits, ReqID: m.ReqID,
		})
	}()
}

// agentErrCode maps the store's errors to the two codes the client acts on:
// bad_message is the client's own bug (a tool outside the protocol, an empty
// query), not_found is a session that is not there — the ordinary answer over
// stores other programs prune.
func agentErrCode(err error) string {
	if errors.Is(err, agentstore.ErrUnknownTool) || errors.Is(err, agentstore.ErrBadQuery) {
		return "bad_message"
	}
	return "not_found"
}
