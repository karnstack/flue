# File peek, phase 2: clicking and reading

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A real path named in terminal output underlines on hover and opens in
a plain, windowed text viewer over the session — on loopback and over the relay
alike — consuming the wire verbs phase 1 shipped.

**Architecture:** Three layers, each behind an existing seam. `FlueClient`
gains `stat` (a promise, shaped like `peek`) and `read`/`cancel` (a streaming
sink, shaped like the attach/abandon lifecycle). The `Emulator` interface gains
one emulator-agnostic method, `detectLinks(detector)`, which xterm implements
with `registerLinkProvider` and wrapped-line assembly. A Radix dialog in
`web/src/files/` renders the stream windowed, painting chunks as they arrive.
Zero new dependencies, zero bundle cost.

**Tech Stack:** TypeScript, React 19, `radix-ui` umbrella package, `@xterm/xterm`
6.0, Vitest + jsdom + testing-library. No Go changes; the daemon side shipped
in #55.

**Spec:** `docs/superpowers/specs/2026-08-11-file-peek-design.md` (issue #78)

## Global Constraints

- The wire contract is phase 1's, verbatim: chunks are 32 KiB, text caps at
  8 MiB (`truncated: true`, head only), images refuse past 4 MiB, two reads
  per connection, 32 paths per `stat`, error codes exactly `not_found`,
  `is_dir`, `too_large`, `denied`, `bad_path`, `busy`, `unsupported`, each
  correlated by `reqId`. Nothing in this phase changes `spec/protocol.md` or
  `testdata/wire/control.json`.
- A client must silently discard `0x02` frames and `eof` for a ref it does not
  hold — a cancel and a finishing read cross on the wire routinely
  (spec/protocol.md, "A cancel stops a stream; it does not un-send one").
- A viewer closed before its `file` arrives remembers the `reqId` as abandoned
  and sends `cancel` the moment the ref lands, mirroring `abandon` for attach.
- Verification cache: 30 s for a hit, 2 s for a miss, keyed by the raw matched
  text per session.
- Only `exists && kind === 'file'` entries underline. A directory that
  underlined would open into an `is_dir` refusal; better it never invites the
  click.
- No new dependencies. Phase 3 brings Shiki; this phase ships at zero bundle
  cost.
- No CSP change, no new HTTP endpoints. Everything rides the wire.
- **pnpm only** in `web/`. Never `npm`, `npx`, or `yarn`.
- Prose in web sources feeds the Tailwind scanner via `styles.build.test.ts`.
  New scanned files here: `web/src/lib/paths.ts`, `web/src/emulator/links.ts`,
  `web/src/files/*.tsx`, plus edits to `emulator/types.ts`, `xterm.ts`, and
  `components/terminal.tsx`. Keep comments free of bare lowercase utility
  words (see the notes at the top of `web/src/styles.css`); `src/testing/` and
  `src/client/` are outside the perimeter.
- Commit after every task. Branch `feat/file-peek-viewer`; `main` is protected,
  everything lands by pull request.
- Test commands: `cd web && pnpm vitest run` and `pnpm run lint`; e2e is
  `make e2e` from the repo root (not in CI; run it for Task 7).

## File Structure

| File | Responsibility |
|---|---|
| `web/src/client/client.ts` (modify) | `stat` promise verb; `read`/`cancel` streaming lifecycle; `0x02` routing; teardown of both |
| `web/src/client/client.test.ts` (modify) | The client promises and the chunk routing by ref |
| `web/src/lib/paths.ts` (create) | Path candidates out of one line of text, `:line[:col]`, punctuation stripping |
| `web/src/lib/paths.test.ts` (create) | The matcher's table |
| `web/src/emulator/types.ts` (modify) | `LinkCandidate`, `LinkDetector`, `detectLinks` on the seam |
| `web/src/emulator/links.ts` (create) | Logical-line assembly over soft-wrapped rows; match ranges back to buffer cells |
| `web/src/emulator/links.test.ts` (create) | Assembly and mapping against a real xterm buffer |
| `web/src/emulator/xterm.ts` (modify) | `detectLinks` via `registerLinkProvider`, disposal |
| `web/src/testing/emulator.ts` (modify) | `detectLinks` on the fake, recorded for tests |
| `web/src/files/detector.ts` (create) | The `LinkDetector`: find + cached verify + open |
| `web/src/files/detector.test.ts` (create) | Cache lifetimes, batching, the file-only rule |
| `web/src/files/viewer.tsx` (create) | The dialog: header, truncation notice, windowed text body, refusal copy |
| `web/src/files/viewer.test.tsx` (create) | Streaming paint, windowing, `:line` mark, refusals, cancel on close |
| `web/src/components/terminal.tsx` (modify) | Wire detector + viewer into the session view |
| `web/src/components/terminal.test.tsx` (modify) | The wiring, end to end over the fake socket |
| `web/e2e/fleet.e2e.ts` (modify) | One relayed read of a real file |

Interfaces the tasks share (defined once here, used verbatim throughout):

```ts
// web/src/emulator/types.ts
export interface LinkCandidate {
  path: string   // as matched, wrapping punctuation and :line[:col] suffix removed
  start: number  // index into the logical line of the first character of the span
  end: number    // index one past the last character, suffix included
  line?: number
  col?: number
}
export interface LinkDetector {
  find(text: string): LinkCandidate[]
  verify(paths: string[]): Promise<boolean[]>
  open(candidate: LinkCandidate): void
}
// Emulator gains: detectLinks(detector: LinkDetector | null): void

// web/src/client/client.ts
export interface ReadFailure { code: string; msg: string }
export interface ReadSink {
  file(meta: FileMsg): void
  chunk(bytes: Uint8Array): void
  eof(): void
  fail(f: ReadFailure): void
}
export interface ReadHandle { cancel(): void }
// FlueClient gains:
//   stat(id: string, paths: string[]): Promise<PathEntry[]>
//   read(id: string, path: string, sink: ReadSink): ReadHandle

// web/src/files/detector.ts
export interface DetectorDeps {
  stat(paths: string[]): Promise<PathEntry[]>
  open(candidate: LinkCandidate): void
  now?(): number
}
export function createPathDetector(deps: DetectorDeps): LinkDetector

// web/src/files/viewer.tsx
export interface FileTarget { path: string; line?: number; col?: number }
export interface FileViewerProps {
  sessionId: string
  target: FileTarget
  onClose: () => void
}
```

---

### Task 1: `stat` on the client

**Files:**
- Modify: `web/src/client/client.ts`
- Test: `web/src/client/client.test.ts`

**Interfaces:**
- Consumes: `StatMsg`, `StatsMsg`, `PathEntry` from `protocol.ts` (already
  shipped); the `Settlers<T>` shape and the `peek` idiom at `client.ts:588`.
- Produces: `FlueClient.stat(id: string, paths: string[]): Promise<PathEntry[]>`.

- [ ] **Step 1: Write the failing tests**

Append a `describe('stat', ...)` to `client.test.ts`, mirroring the peek suite
at `:2899` (same `connected()` harness, same shapes):

```ts
describe('stat', () => {
  it('resolves with the entries, in the order asked', async () => {
    const { c, sock } = connected()
    const answer = c.stat('s1', ['a/b.go', '~/notes.md'])
    const sent = sock.sentControl().find((m) => m.type === 'stat')!
    expect(sent).toMatchObject({ type: 'stat', id: 's1', paths: ['a/b.go', '~/notes.md'] })
    sock.emitControl({
      type: 'stats',
      entries: [
        { path: 'a/b.go', exists: true, kind: 'file', size: 12, mtime: 1754870400 },
        { path: '~/notes.md', exists: false },
      ],
      reqId: sent.reqId,
    })
    await expect(answer).resolves.toEqual([
      { path: 'a/b.go', exists: true, kind: 'file', size: 12, mtime: 1754870400 },
      { path: '~/notes.md', exists: false },
    ])
  })

  it('correlates two stats in flight by reqId', async () => {
    const { c, sock } = connected()
    const first = c.stat('s1', ['one'])
    const second = c.stat('s1', ['two'])
    const sent = sock.sentControl().filter((m) => m.type === 'stat')
    sock.emitControl({ type: 'stats', entries: [{ path: 'two', exists: true, kind: 'file' }], reqId: sent[1]!.reqId })
    sock.emitControl({ type: 'stats', entries: [{ path: 'one', exists: false }], reqId: sent[0]!.reqId })
    await expect(first).resolves.toEqual([{ path: 'one', exists: false }])
    await expect(second).resolves.toEqual([{ path: 'two', exists: true, kind: 'file' }])
  })

  it('rejects on a refusal, and still surfaces it through onError', async () => {
    const { c, sock } = connected()
    const heard: string[] = []
    c.onError((e) => heard.push(e.code))
    const answer = c.stat('s1', Array.from({ length: 33 }, (_, i) => `p${i}`))
    const sent = sock.sentControl().find((m) => m.type === 'stat')!
    sock.emitControl({ type: 'error', code: 'bad_path', msg: 'too many paths in one stat', reqId: sent.reqId })
    await expect(answer).rejects.toThrow('too many paths in one stat')
    expect(heard).toEqual(['bad_path'])
  })

  it('rejects while the connection is down', async () => {
    const { c } = harness()
    await expect(c.stat('s1', ['a'])).rejects.toThrow('not connected')
  })

  it('rejects when the connection drops with the ask in flight', async () => {
    const { c, sock } = connected()
    const answer = c.stat('s1', ['a'])
    sock.close()
    await expect(answer).rejects.toThrow('connection lost')
  })

  it('gives up when nothing answers', async () => {
    vi.useFakeTimers()
    const { c } = connected()
    const answer = c.stat('s1', ['a'])
    const settled = expect(answer).rejects.toThrow('did not answer')
    await vi.advanceTimersByTimeAsync(5_000)
    await settled
  })

  it('ignores a stats answer nobody waits for', () => {
    const { sock } = connected()
    sock.emitControl({ type: 'stats', entries: [], reqId: 999 })
    // nothing thrown, nothing emitted — the harness fails on flue: logs
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd web && pnpm vitest run src/client/client.test.ts -t stat`
Expected: FAIL — `c.stat is not a function`.

- [ ] **Step 3: Implement `stat`**

In `client.ts`: a `STAT_TIMEOUT_MS = 5_000` beside `PEEK_TIMEOUT_MS` (:61); a
`private statAsks: Map<number, Settlers<PathEntry[]>> = new Map()` beside
`peeks`; the method beside `peek`, an exact structural copy of it (readiness
check, entry before send, `settle` wrapper clearing the deadline, delete on
timeout). The deadline earns its place for peek's reason: an old daemon answers
with an uncorrelated `bad_message` that reaches no asker.

```ts
  /**
   * Ask whether up to 32 paths exist, resolved against one session's live
   * working directory. Entries answer in the order asked; a path the daemon
   * cannot resolve is `exists: false` rather than a refusal — "no" is the
   * ordinary answer here.
   */
  stat(id: string, paths: string[]): Promise<PathEntry[]> {
    if (!this.ready || !this.sock) {
      return Promise.reject(new Error('flue: not connected'))
    }
    const reqId = this.nextReqId++
    return new Promise<PathEntry[]>((resolve, reject) => {
      const deadline = setTimeout(() => {
        if (!this.statAsks.delete(reqId)) return
        reject(new Error('flue: the daemon did not answer'))
      }, STAT_TIMEOUT_MS)
      const settle = <T,>(cb: (v: T) => void) => (v: T) => {
        clearTimeout(deadline)
        cb(v)
      }
      this.statAsks.set(reqId, { resolve: settle(resolve), reject: settle(reject) })
      if (!this.send({ type: 'stat', id, paths, reqId })) {
        clearTimeout(deadline)
        this.statAsks.delete(reqId)
        reject(new Error('flue: not connected'))
      }
    })
  }
```

`handleControl` gains a `case 'stats'` (settle by `reqId`, drop an answer
nobody waits for); the `case 'error'` chain gains a `statAsks` arm between the
peek arm and the agent arm, same shape (delete, reject with
`new Error(msg.msg || msg.code)`, emit to `errorListeners`, break); `teardown`
rejects and clears `statAsks` exactly as it does `peeks`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && pnpm vitest run src/client/client.test.ts`
Expected: PASS, including the untouched golden-fixture suite.

- [ ] **Step 5: Commit**

```bash
git add web/src/client/client.ts web/src/client/client.test.ts
git commit -m "feat(web): stat on the client, a promise per hovered line"
```

---

### Task 2: `read`, `cancel`, and `0x02` routing

**Files:**
- Modify: `web/src/client/client.ts`
- Test: `web/src/client/client.test.ts`

**Interfaces:**
- Consumes: `ReadMsg`, `CancelMsg`, `FileMsg`, `EofMsg`, `FRAME_FILE` from
  `protocol.ts`; the `abandoned` idiom (`client.ts:842`, redemption at
  `:1006-1013`).
- Produces: `ReadFailure`, `ReadSink`, `ReadHandle` (exported), and
  `FlueClient.read(id, path, sink): ReadHandle`.

A read is a stream, not a promise: `file` arrives, then binary frames, then
`eof`, and the viewer paints along the way. So the shape is a sink of four
callbacks and a handle whose `cancel()` does the right thing at every stage:
before `file`, mark the reqId abandoned and send `cancel` when the ref lands
(the attach/abandon mechanism, spec-mandated); after `file`, send
`cancel{ref}` and drop the routing so late frames and the crossing `eof` are
discarded silently.

- [ ] **Step 1: Write the failing tests**

```ts
describe('read', () => {
  const collect = () => {
    const seen = { meta: null as FileMsg | null, chunks: [] as string[], eof: 0, failed: null as ReadFailure | null }
    const sink: ReadSink = {
      file: (m) => { seen.meta = m },
      chunk: (b) => seen.chunks.push(new TextDecoder().decode(b)),
      eof: () => seen.eof++,
      fail: (f) => { seen.failed = f },
    }
    return { seen, sink }
  }
  const opened = (sock: FakeSocket, reqId: unknown, ref = 7) => {
    sock.emitControl({
      type: 'file', ref, path: '/home/k/a.go', size: 11,
      mime: 'text/plain; charset=utf-8', kind: 'text', reqId,
    })
  }

  it('streams file, chunks, then eof to the sink', () => {
    const { c, sock } = connected()
    const { seen, sink } = collect()
    c.read('s1', 'a.go', sink)
    const sent = sock.sentControl().find((m) => m.type === 'read')!
    expect(sent).toMatchObject({ type: 'read', id: 's1', path: 'a.go' })
    opened(sock, sent.reqId)
    sock.emitBinary(FRAME_FILE, 7, 'package ')
    sock.emitBinary(FRAME_FILE, 7, 'main\n')
    sock.emitControl({ type: 'eof', ref: 7 })
    expect(seen.meta).toMatchObject({ path: '/home/k/a.go', size: 11, kind: 'text' })
    expect(seen.chunks).toEqual(['package ', 'main\n'])
    expect(seen.eof).toBe(1)
    expect(seen.failed).toBeNull()
  })

  it('routes chunks by ref when two reads interleave', () => {
    const { c, sock } = connected()
    const a = collect()
    const b = collect()
    c.read('s1', 'a.go', a.sink)
    c.read('s1', 'b.go', b.sink)
    const sent = sock.sentControl().filter((m) => m.type === 'read')
    opened(sock, sent[0]!.reqId, 7)
    opened(sock, sent[1]!.reqId, 8)
    sock.emitBinary(FRAME_FILE, 8, 'bee')
    sock.emitBinary(FRAME_FILE, 7, 'aye')
    expect(a.seen.chunks).toEqual(['aye'])
    expect(b.seen.chunks).toEqual(['bee'])
  })

  it('keeps 0x02 frames away from terminal output', () => {
    const { c, sock } = connected()
    attachRef(sock, 3)
    const before = c.lastSeqFor(3)
    sock.emitBinary(FRAME_FILE, 3, 'not output')
    expect(c.lastSeqFor(3)).toBe(before)
  })

  it('discards frames and eof for a ref it does not hold', () => {
    const { sock } = connected()
    sock.emitBinary(FRAME_FILE, 42, 'late')
    sock.emitControl({ type: 'eof', ref: 42 })
    // silence is the assertion; the harness fails on flue: logs
  })

  it('cancel after file sends cancel and goes deaf to the stream', () => {
    const { c, sock } = connected()
    const { seen, sink } = collect()
    const handle = c.read('s1', 'a.go', sink)
    opened(sock, sock.sentControl().find((m) => m.type === 'read')!.reqId)
    handle.cancel()
    expect(sock.sentControl().find((m) => m.type === 'cancel')).toMatchObject({ type: 'cancel', ref: 7 })
    sock.emitBinary(FRAME_FILE, 7, 'late')
    sock.emitControl({ type: 'eof', ref: 7 })
    expect(seen.chunks).toEqual([])
    expect(seen.eof).toBe(0)
  })

  it('cancel before file marks the ask abandoned, then cancels the ref when it lands', () => {
    const { c, sock } = connected()
    const { seen, sink } = collect()
    const handle = c.read('s1', 'a.go', sink)
    handle.cancel()
    expect(sock.sentControl().find((m) => m.type === 'cancel')).toBeUndefined()
    opened(sock, sock.sentControl().find((m) => m.type === 'read')!.reqId)
    expect(sock.sentControl().find((m) => m.type === 'cancel')).toMatchObject({ type: 'cancel', ref: 7 })
    expect(seen.meta).toBeNull()
  })

  it('fails the sink on a refusal, with the code intact', () => {
    const { c, sock } = connected()
    const { seen, sink } = collect()
    c.read('s1', 'somewhere/', sink)
    const sent = sock.sentControl().find((m) => m.type === 'read')!
    sock.emitControl({ type: 'error', code: 'is_dir', msg: 'that is a directory', reqId: sent.reqId })
    expect(seen.failed).toEqual({ code: 'is_dir', msg: 'that is a directory' })
  })

  it('fails the sink when the connection drops mid-stream', () => {
    const { c, sock } = connected()
    const { seen, sink } = collect()
    c.read('s1', 'a.go', sink)
    opened(sock, sock.sentControl().find((m) => m.type === 'read')!.reqId)
    sock.close()
    expect(seen.failed).toEqual({ code: 'lost', msg: 'flue: connection lost' })
  })

  it('fails the sink when nothing answers the ask', async () => {
    vi.useFakeTimers()
    const { c, sock } = connected()
    const { seen, sink } = collect()
    c.read('s1', 'a.go', sink)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(seen.failed).toEqual({ code: 'timeout', msg: 'flue: the daemon did not answer' })
    // and a file that limps in later is cancelled, not delivered
    opened(sock, sock.sentControl().find((m) => m.type === 'read')!.reqId)
    expect(sock.sentControl().find((m) => m.type === 'cancel')).toMatchObject({ type: 'cancel', ref: 7 })
    expect(seen.meta).toBeNull()
  })

  it('fails immediately while the connection is down', async () => {
    const { c } = harness()
    const { seen, sink } = collect()
    c.read('s1', 'a.go', sink)
    await Promise.resolve()
    expect(seen.failed).toEqual({ code: 'lost', msg: 'flue: not connected' })
  })
})
```

(`FakeSocket`, `attachRef`, `connected`, `harness` already exist in the file;
import `FRAME_FILE` and the new types at the top.)

- [ ] **Step 2: Run them to verify they fail**

Run: `cd web && pnpm vitest run src/client/client.test.ts -t read`
Expected: FAIL — `c.read is not a function`.

- [ ] **Step 3: Implement**

State beside the other maps:

```ts
  /** Read asks in flight, by reqId — the stretch before `file` names a ref. */
  private readAsks: Map<number, { sink: ReadSink; deadline: ReturnType<typeof setTimeout> }> = new Map()
  /** Live streams, by ref. A ref missing here means "discard", not "protest". */
  private reads: Map<number, { sink: ReadSink; reqId: number }> = new Map()
  /** Which ref answered which ask, so a handle can cancel after `file`. */
  private readRefs: Map<number, number> = new Map()
  /** Reads let go of before their `file` arrived; cancelled the moment it does. */
  private abandonedReads: Set<number> = new Set()
```

The verb and its cancel:

```ts
  read(id: string, path: string, sink: ReadSink): ReadHandle {
    if (!this.ready || !this.sock) {
      queueMicrotask(() => sink.fail({ code: 'lost', msg: 'flue: not connected' }))
      return { cancel: () => {} }
    }
    const reqId = this.nextReqId++
    const deadline = setTimeout(() => {
      if (!this.readAsks.delete(reqId)) return
      this.abandonedReads.add(reqId)
      sink.fail({ code: 'timeout', msg: 'flue: the daemon did not answer' })
    }, READ_TIMEOUT_MS)
    this.readAsks.set(reqId, { sink, deadline })
    if (!this.send({ type: 'read', id, path, reqId })) {
      clearTimeout(deadline)
      this.readAsks.delete(reqId)
      queueMicrotask(() => sink.fail({ code: 'lost', msg: 'flue: not connected' }))
      return { cancel: () => {} }
    }
    return { cancel: () => this.cancelRead(reqId) }
  }

  private cancelRead(reqId: number) {
    const ask = this.readAsks.get(reqId)
    if (ask !== undefined) {
      clearTimeout(ask.deadline)
      this.readAsks.delete(reqId)
      this.abandonedReads.add(reqId)
      return
    }
    const ref = this.readRefs.get(reqId)
    if (ref === undefined) return
    this.readRefs.delete(reqId)
    this.reads.delete(ref)
    this.send({ type: 'cancel', ref })
  }
```

`READ_TIMEOUT_MS = 10_000` beside the other deadlines. The timeout adds the
reqId to `abandonedReads` for the same reason cancel does: a `file` that limps
in after the deadline must be cancelled, not orphaned open on the daemon.

`handleControl` gains:

```ts
      case 'file': {
        if (msg.reqId !== undefined && this.abandonedReads.delete(msg.reqId)) {
          // Asked for, then let go of before the answer arrived. Cancel the
          // stream rather than adopting one nobody is behind — the same move
          // an abandoned attach makes with detach.
          this.send({ type: 'cancel', ref: msg.ref })
          break
        }
        const ask = msg.reqId !== undefined ? this.readAsks.get(msg.reqId) : undefined
        if (ask === undefined) break
        clearTimeout(ask.deadline)
        this.readAsks.delete(msg.reqId!)
        this.readRefs.set(msg.reqId!, msg.ref)
        this.reads.set(msg.ref, { sink: ask.sink, reqId: msg.reqId! })
        ask.sink.file(msg)
        break
      }

      case 'eof': {
        const r = this.reads.get(msg.ref)
        if (r === undefined) break // a cancel and a finishing read crossed; the spec says discard
        this.reads.delete(msg.ref)
        this.readRefs.delete(r.reqId)
        r.sink.eof()
        break
      }
```

The `error` chain gains a `readAsks` arm beside the `statAsks` one (clear the
deadline, delete, `sink.fail({ code: msg.code, msg: msg.msg })`, emit, break).

`receive` routes the third frame type ahead of the output check:

```ts
    if (frame.type === FRAME_FILE) {
      this.reads.get(frame.ref)?.sink.chunk(frame.payload)
      return
    }
    if (frame.type !== FRAME_OUTPUT) return
```

`teardown` fails every `readAsks` entry (clearing its deadline) and every
`reads` entry with `{ code: 'lost', msg: 'flue: connection lost' }`, then
clears all four structures — the daemon closes its side when the connection
drops, so pending cancels mean nothing on the next socket.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && pnpm vitest run src/client/client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/client/client.ts web/src/client/client.test.ts
git commit -m "feat(web): read, cancel, and 0x02 chunk routing on the client"
```

---

### Task 3: path candidates in a line of text

**Files:**
- Create: `web/src/lib/paths.ts`
- Test: `web/src/lib/paths.test.ts`
- Modify: `web/src/emulator/types.ts` (the `LinkCandidate` interface only, so
  this task compiles on its own)

**Interfaces:**
- Produces: `findPaths(text: string): LinkCandidate[]`, and
  `LinkCandidate` in `emulator/types.ts` (the shape in File Structure above).
  `lib/geometry.ts` importing `Cell` from `@/emulator/types` is the precedent
  for the import direction.

Matching is deliberately generous — verification decides the underline. A
false positive dies quietly at `stat`; a false negative is a path that refuses
to open forever.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest'
import { findPaths } from './paths'

const paths = (text: string) => findPaths(text).map((c) => c.path)

describe('findPaths', () => {
  it.each([
    ['wrote internal/wire/binary.go today', ['internal/wire/binary.go']],
    ['see /etc/hosts and ~/notes.md', ['/etc/hosts', '~/notes.md']],
    ['relative ./a.ts and ../b/c.rs', ['./a.ts', '../b/c.rs']],
    ['bare CLAUDE.md name', ['CLAUDE.md']],
    ['dotted styles.build.test.ts name', ['styles.build.test.ts']],
    ['no paths in this sentence at all', []],
    ['not http://example.com/a/b nor wss://relay/x', []],
  ])('%s -> %j', (text, want) => {
    expect(paths(text)).toEqual(want)
  })

  it.each([
    ['trailing stop internal/a.go.', 'internal/a.go'],
    ['comma web/src/b.ts, then', 'web/src/b.ts'],
    ['quoted "spec/protocol.md"', 'spec/protocol.md'],
    ['ticked `internal/wire/binary.go`', 'internal/wire/binary.go'],
    ['parenthesised (docs/plan.md)', 'docs/plan.md'],
    ['bracketed [a/b.c];', 'a/b.c'],
  ])('%s strips to %s', (text, want) => {
    expect(paths(text)).toEqual([want])
  })

  it('captures a :line suffix and keeps it inside the span', () => {
    const [c] = findPaths('boom at src/foo.ts:12 sorry')
    expect(c).toMatchObject({ path: 'src/foo.ts', line: 12, col: undefined })
    expect('boom at src/foo.ts:12 sorry'.slice(c!.start, c!.end)).toBe('src/foo.ts:12')
  })

  it('captures :line:col', () => {
    expect(findPaths('src/foo.ts:12:3')[0]).toMatchObject({ path: 'src/foo.ts', line: 12, col: 3 })
  })

  it('strips punctuation after the suffix', () => {
    expect(findPaths('(src/foo.ts:12).')[0]).toMatchObject({ path: 'src/foo.ts', line: 12 })
  })

  it('reports spans in line coordinates', () => {
    const line = 'a internal/a.go b ~/x.md'
    const [first, second] = findPaths(line)
    expect(line.slice(first!.start, first!.end)).toBe('internal/a.go')
    expect(line.slice(second!.start, second!.end)).toBe('~/x.md')
  })

  it('keeps a directory-shaped candidate; verification refuses it later', () => {
    expect(paths('under web/src/ somewhere')).toEqual(['web/src/'])
  })

  it('is generous with word/word — stat is the arbiter', () => {
    expect(paths('either/or')).toEqual(['either/or'])
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd web && pnpm vitest run src/lib/paths.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Add `LinkCandidate` to `emulator/types.ts` (verbatim from File Structure).
Then `lib/paths.ts`:

```ts
import type { LinkCandidate } from '@/emulator/types'

/*
 * Pulls path-shaped spans out of one logical line of terminal text.
 *
 * Generous on purpose: verification against the daemon decides what gets
 * decorated, so a stray match costs one cached stat and a miss costs a path
 * that never opens. Tokens are whitespace-separated — a path with a space in
 * it is not findable in plain terminal output anyway.
 */

const OPENERS = new Set(['(', '[', '{', '<', '"', "'", '`'])
const CLOSERS = new Set([')', ']', '}', '>', '"', "'", '`', '.', ',', ';', ':', '!', '?'])
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i
const ROOTED = /^(?:\/|~\/|\.\/|\.\.\/)/
const RELATIVE = /^[\w.~$@+-][\w.~$@+=%-]*(?:\/[\w.~$@+=%-]+)+\/?$/
const BARE_FILE = /^[\w$@+-][\w.$@+-]*\.[A-Za-z][A-Za-z0-9]{0,15}$/
const LINE_COL = /:(\d{1,7})(?::(\d{1,4}))?$/

export function findPaths(text: string): LinkCandidate[] {
  const found: LinkCandidate[] = []
  for (const token of text.matchAll(/\S+/g)) {
    let start = token.index
    let raw = token[0]
    while (raw.length > 0 && OPENERS.has(raw[0]!)) {
      raw = raw.slice(1)
      start++
    }
    while (raw.length > 0 && CLOSERS.has(raw[raw.length - 1]!)) raw = raw.slice(0, -1)
    if (raw.length === 0) continue
    let path = raw
    let line: number | undefined
    let col: number | undefined
    const suffix = LINE_COL.exec(raw)
    if (suffix !== null) {
      path = raw.slice(0, suffix.index)
      line = Number(suffix[1])
      if (suffix[2] !== undefined) col = Number(suffix[2])
    }
    if (path.length === 0 || SCHEME.test(path)) continue
    if (!ROOTED.test(path) && !RELATIVE.test(path) && !BARE_FILE.test(path)) continue
    found.push({ path, start, end: start + raw.length, line, col })
  }
  return found
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && pnpm vitest run src/lib/paths.test.ts`
Expected: PASS. Iterate on the token maths, not the tests, until they do.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/paths.ts web/src/lib/paths.test.ts web/src/emulator/types.ts
git commit -m "feat(web): find path-shaped candidates in a line of terminal text"
```

---

### Task 4: `detectLinks` through the emulator seam

**Files:**
- Modify: `web/src/emulator/types.ts` (`LinkDetector`, the `detectLinks` method)
- Create: `web/src/emulator/links.ts`
- Modify: `web/src/emulator/xterm.ts`
- Modify: `web/src/testing/emulator.ts`
- Test: `web/src/emulator/links.test.ts`

**Interfaces:**
- Consumes: `findPaths` (Task 3), xterm's `registerLinkProvider` /
  `ILinkProvider` / `IBufferRange` (1-based positions, typings at
  `node_modules/@xterm/xterm/typings/xterm.d.ts:1102,1393,1473`).
- Produces: `Emulator.detectLinks(detector: LinkDetector | null): void`;
  `logicalLineAt(term, bufferLine)` and `pathLinksAt(term, bufferLine,
  detector)` in `emulator/links.ts`; `FakeEmulator.detector` (the last
  detector handed over, `null` after `detectLinks(null)`).

The hard part is wrapped lines: a 90-character path in an 80-column phone view
occupies two buffer rows, and xterm hands the provider one row at a time.
Assemble the logical line by walking `isWrapped` backward and forward,
recording one buffer position per UTF-16 unit as the text is built — so match
indices map back to cells even where wide glyphs make string length and cell
count disagree. Get this wrong and the feature works on a laptop and silently
fails on the phone it exists for.

- [ ] **Step 1: Write the failing tests**

`links.test.ts` drives a real xterm buffer, no DOM mount needed:

```ts
import { Terminal } from '@xterm/xterm'
import { describe, expect, it } from 'vitest'
import { findPaths } from '@/lib/paths'
import type { LinkDetector } from './types'
import { logicalLineAt, pathLinksAt } from './links'

const filled = async (text: string, cols = 40) => {
  const term = new Terminal({ cols, rows: 6, allowProposedApi: true })
  await new Promise<void>((done) => term.write(text, done))
  return term
}

const yes: LinkDetector = {
  find: findPaths,
  verify: (paths) => Promise.resolve(paths.map(() => true)),
  open: () => {},
}

describe('logicalLineAt', () => {
  it('reads one unwrapped row, trailing blanks trimmed', async () => {
    const term = await filled('wrote internal/a.go here')
    expect(logicalLineAt(term, 1)?.text).toBe('wrote internal/a.go here')
  })

  it('assembles a soft-wrapped line from any of its rows', async () => {
    const long = 'wrote docs/superpowers/specs/2026-08-11-file-peek-design.md now'
    const term = await filled(long, 20)
    for (const row of [1, 2, 3]) {
      expect(logicalLineAt(term, row)?.text).toBe(long)
    }
  })

  it('does not leak across a hard newline', async () => {
    const term = await filled('first line\r\nsecond line')
    expect(logicalLineAt(term, 1)?.text).toBe('first line')
    expect(logicalLineAt(term, 2)?.text).toBe('second line')
  })

  it('maps text indices to cells across wide glyphs', async () => {
    const term = await filled('日本 internal/a.md')
    const line = logicalLineAt(term, 1)!
    const at = line.text.indexOf('internal')
    // two wide glyphs occupy four cells, plus the space: column 6, 1-based
    expect(line.cells[at]).toEqual({ x: 6, y: 1 })
  })
})

describe('pathLinksAt', () => {
  it('returns a link spanning the wrapped rows, range inclusive and 1-based', async () => {
    const long = 'at docs/superpowers/specs/2026-08-11-file-peek-design.md end'
    const term = await filled(long, 20)
    const links = await pathLinksAt(term, 2, yes)
    expect(links).toHaveLength(1)
    expect(links![0]!.range.start.y).toBe(1)
    expect(links![0]!.range.end.y).toBeGreaterThan(1)
    expect(links![0]!.text).toBe('docs/superpowers/specs/2026-08-11-file-peek-design.md')
  })

  it('offers nothing when verification says no', async () => {
    const term = await filled('maybe not/a/path.txt')
    const no = { ...yes, verify: (p: string[]) => Promise.resolve(p.map(() => false)) }
    expect(await pathLinksAt(term, 1, no)).toBeUndefined()
  })

  it('offers nothing for a line with no candidates, without asking', async () => {
    const term = await filled('nothing here resembles one')
    let asked = 0
    const counting = { ...yes, verify: (p: string[]) => { asked++; return Promise.resolve(p.map(() => true)) } }
    expect(await pathLinksAt(term, 1, counting)).toBeUndefined()
    expect(asked).toBe(0)
  })

  it('activate hands the candidate, line number included, to open', async () => {
    const term = await filled('fell over at src/foo.ts:12 sadly')
    const opened: unknown[] = []
    const catching = { ...yes, open: (c: unknown) => opened.push(c) }
    const links = await pathLinksAt(term, 1, catching)
    links![0]!.activate(new MouseEvent('click'), links![0]!.text)
    expect(opened[0]).toMatchObject({ path: 'src/foo.ts', line: 12 })
  })
})
```

And in `emulator.test.ts`, one seam-level case in the Emulator interface block:

```ts
  it('carries a link detector across detectLinks, and survives disposal', async () => {
    const { em, done } = await screen('holds internal/a.go steady')
    em.detectLinks({ find: findPaths, verify: (p) => Promise.resolve(p.map(() => true)), open: () => {} })
    em.detectLinks(null)
    done()
    em.detectLinks(null) // after dispose: a no-op, not a throw
  })
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd web && pnpm vitest run src/emulator/links.test.ts src/emulator/emulator.test.ts`
Expected: FAIL — `links.ts` missing, `detectLinks` not on the interface.

- [ ] **Step 3: Implement**

`emulator/types.ts` — `LinkDetector` (verbatim from File Structure, with doc
comments) and, on `Emulator`:

```ts
  /**
   * Decorate real file paths in the output so a click can open them, or pass
   * null to stop. Every emulator can mark a span of text and report a press
   * on it; how candidates are found, checked, and opened is the detector's
   * business, so nothing xterm-shaped crosses this seam.
   */
  detectLinks(detector: LinkDetector | null): void
```

`emulator/links.ts`:

```ts
import type { IBufferCellPosition, ILink, Terminal } from '@xterm/xterm'
import type { LinkDetector } from './types'

/**
 * One logical line: the row asked about plus every row soft-wrapped onto it,
 * with a buffer position recorded per UTF-16 unit as the text is assembled.
 * Match indices are string offsets; cells are what the decoration needs; wide
 * glyphs make the two disagree, so the mapping is carried, not computed.
 */
export function logicalLineAt(
  term: Terminal,
  bufferLine: number,
): { text: string; cells: IBufferCellPosition[] } | null {
  const buf = term.buffer.active
  const asked = bufferLine - 1
  if (!buf.getLine(asked)) return null
  let first = asked
  while (first > 0 && buf.getLine(first)?.isWrapped) first--
  let last = asked
  while (buf.getLine(last + 1)?.isWrapped) last++
  let text = ''
  const cells: IBufferCellPosition[] = []
  for (let y = first; y <= last; y++) {
    const row = buf.getLine(y)
    if (!row) break
    for (let x = 0; x < row.length; x++) {
      const cell = row.getCell(x)
      if (!cell || cell.getWidth() === 0) continue
      const chars = cell.getChars() || ' '
      for (let i = 0; i < chars.length; i++) {
        text += chars[i]!
        cells.push({ x: x + 1, y: y + 1 })
      }
    }
  }
  let cut = text.length
  while (cut > 0 && text[cut - 1] === ' ') cut--
  return { text: text.slice(0, cut), cells: cells.slice(0, cut) }
}

/** The verified links for one hovered row; undefined when nothing qualifies. */
export async function pathLinksAt(
  term: Terminal,
  bufferLine: number,
  detector: LinkDetector,
): Promise<ILink[] | undefined> {
  const line = logicalLineAt(term, bufferLine)
  if (line === null) return undefined
  const candidates = detector.find(line.text)
  if (candidates.length === 0) return undefined
  const real = await detector.verify(candidates.map((c) => c.path))
  const links: ILink[] = []
  for (let i = 0; i < candidates.length; i++) {
    if (real[i] !== true) continue
    const c = candidates[i]!
    const from = line.cells[c.start]
    const to = line.cells[c.end - 1]
    if (from === undefined || to === undefined) continue
    links.push({
      range: { start: from, end: to },
      text: c.path,
      activate: () => detector.open(c),
    })
  }
  return links.length > 0 ? links : undefined
}
```

`xterm.ts` — a module-level-in-factory holder beside `disposed`:

```ts
  let linkProvider: IDisposable | null = null
```

the method on the returned object:

```ts
    detectLinks(detector) {
      linkProvider?.dispose()
      linkProvider = null
      if (disposed || detector === null) return
      linkProvider = term.registerLinkProvider({
        provideLinks: (y, provide) => {
          pathLinksAt(term, y, detector).then(provide, () => provide(undefined))
        },
      })
    },
```

and in `dispose()`, ahead of `term.dispose()`: `linkProvider?.dispose();
linkProvider = null`. Import `pathLinksAt` and the `IDisposable` type.

`testing/emulator.ts` — on the interface:

```ts
  /** The last detector handed to detectLinks(); null after detectLinks(null). */
  detector: LinkDetector | null
```

initialised `detector: null` in the literal, and:

```ts
    detectLinks(detector: LinkDetector | null) {
      mutable(self).detector = detector
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && pnpm vitest run src/emulator` — then `pnpm run lint`, which is
`tsc --noEmit` and is what catches a fake emulator missing the new method.
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add web/src/emulator/types.ts web/src/emulator/links.ts web/src/emulator/links.test.ts \
  web/src/emulator/xterm.ts web/src/emulator/emulator.test.ts web/src/testing/emulator.ts
git commit -m "feat(web): detectLinks through the emulator seam, wrapped lines included"
```

---

### Task 5: the detector — find, cached verify, open

**Files:**
- Create: `web/src/files/detector.ts`
- Test: `web/src/files/detector.test.ts`

**Interfaces:**
- Consumes: `findPaths` (Task 3), `LinkDetector`/`LinkCandidate` (Task 4),
  `PathEntry` (protocol).
- Produces: `createPathDetector(deps: DetectorDeps): LinkDetector` and the
  exported constants `VERIFY_HIT_MS = 30_000`, `VERIFY_MISS_MS = 2_000`.

The cache lifetimes are the design's numbers and asymmetric on purpose: an
agent says it is writing `src/foo.ts`, the reader hovers a moment before the
file exists, and a long negative memory would leave that path dead for the
rest of the session.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it, vi } from 'vitest'
import type { PathEntry } from '@/client/protocol'
import { createPathDetector, VERIFY_HIT_MS, VERIFY_MISS_MS } from './detector'

const answering = (kind: 'file' | 'dir' | 'none') => {
  const asked: string[][] = []
  const stat = vi.fn(async (paths: string[]): Promise<PathEntry[]> =>
    paths.map((p) => (kind === 'none' ? { path: p, exists: false } : { path: p, exists: true, kind })),
  )
  return { asked, stat }
}

describe('createPathDetector', () => {
  it('finds with findPaths and opens through the dep', () => {
    const opened: unknown[] = []
    const d = createPathDetector({ stat: async () => [], open: (c) => opened.push(c) })
    const [c] = d.find('at src/a.ts:3')
    d.open(c!)
    expect(opened[0]).toMatchObject({ path: 'src/a.ts', line: 3 })
  })

  it('verifies files true, everything else false', async () => {
    const files = createPathDetector({ stat: answering('file').stat, open: () => {} })
    await expect(files.verify(['a'])).resolves.toEqual([true])
    const dirs = createPathDetector({ stat: answering('dir').stat, open: () => {} })
    await expect(dirs.verify(['a'])).resolves.toEqual([false])
    const gone = createPathDetector({ stat: answering('none').stat, open: () => {} })
    await expect(gone.verify(['a'])).resolves.toEqual([false])
  })

  it('remembers a hit for 30 seconds, not 31', async () => {
    let t = 0
    const { stat } = answering('file')
    const d = createPathDetector({ stat, open: () => {}, now: () => t })
    await d.verify(['a'])
    t = VERIFY_HIT_MS - 1
    await d.verify(['a'])
    expect(stat).toHaveBeenCalledTimes(1)
    t = VERIFY_HIT_MS + 1
    await d.verify(['a'])
    expect(stat).toHaveBeenCalledTimes(2)
  })

  it('forgets a miss after 2 seconds, so a file written moments later revives', async () => {
    let t = 0
    const { stat } = answering('none')
    const d = createPathDetector({ stat, open: () => {}, now: () => t })
    await d.verify(['a'])
    t = VERIFY_MISS_MS + 1
    await d.verify(['a'])
    expect(stat).toHaveBeenCalledTimes(2)
  })

  it('sends one stat per hovered line, deduplicated', async () => {
    const { stat } = answering('file')
    const d = createPathDetector({ stat, open: () => {} })
    await d.verify(['a', 'b', 'a'])
    expect(stat).toHaveBeenCalledTimes(1)
    expect(stat).toHaveBeenCalledWith(['a', 'b'])
  })

  it('splits past the protocol cap of 32 paths per stat', async () => {
    const { stat } = answering('file')
    const d = createPathDetector({ stat, open: () => {} })
    const many = Array.from({ length: 40 }, (_, i) => `p${i}`)
    await expect(d.verify(many)).resolves.toEqual(many.map(() => true))
    expect(stat).toHaveBeenCalledTimes(2)
    expect(stat.mock.calls[0]![0]).toHaveLength(32)
    expect(stat.mock.calls[1]![0]).toHaveLength(8)
  })

  it('answers all-false when stat rejects, and does not poison the cache', async () => {
    let fail = true
    const stat = vi.fn(async (paths: string[]): Promise<PathEntry[]> => {
      if (fail) throw new Error('flue: not connected')
      return paths.map((p) => ({ path: p, exists: true, kind: 'file' as const }))
    })
    const d = createPathDetector({ stat, open: () => {} })
    await expect(d.verify(['a'])).resolves.toEqual([false])
    fail = false
    await expect(d.verify(['a'])).resolves.toEqual([true])
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd web && pnpm vitest run src/files/detector.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import type { PathEntry } from '@/client/protocol'
import type { LinkCandidate, LinkDetector } from '@/emulator/types'
import { findPaths } from '@/lib/paths'

/* How long a verification answer stands. Short for a miss on purpose: an
 * agent announces a file moments before writing it, and a long negative
 * memory would keep that path dead long after it turned real. */
export const VERIFY_HIT_MS = 30_000
export const VERIFY_MISS_MS = 2_000

const CACHE_CAP = 600
const STAT_BATCH = 32 // the protocol's ceiling on paths per stat

export interface DetectorDeps {
  stat(paths: string[]): Promise<PathEntry[]>
  open(candidate: LinkCandidate): void
  now?(): number
}

export function createPathDetector(deps: DetectorDeps): LinkDetector {
  const now = deps.now ?? Date.now
  const held = new Map<string, { yes: boolean; until: number }>()
  const remember = (path: string, yes: boolean) => {
    if (held.size >= CACHE_CAP) {
      for (const oldest of held.keys()) {
        held.delete(oldest)
        if (held.size < CACHE_CAP) break
      }
    }
    held.set(path, { yes, until: now() + (yes ? VERIFY_HIT_MS : VERIFY_MISS_MS) })
  }
  return {
    find: findPaths,
    open: deps.open,
    async verify(paths) {
      const t = now()
      const answers = new Map<string, boolean>()
      const unknown: string[] = []
      for (const p of paths) {
        const kept = held.get(p)
        if (kept !== undefined && kept.until > t) answers.set(p, kept.yes)
        else if (!answers.has(p) && !unknown.includes(p)) unknown.push(p)
      }
      for (let at = 0; at < unknown.length; at += STAT_BATCH) {
        const batch = unknown.slice(at, at + STAT_BATCH)
        try {
          const entries = await deps.stat(batch)
          for (let i = 0; i < batch.length; i++) {
            const yes = entries[i]?.exists === true && entries[i]?.kind === 'file'
            answers.set(batch[i]!, yes)
            remember(batch[i]!, yes)
          }
        } catch {
          // The daemon is unreachable or refused; nothing decorates, nothing
          // is remembered, and the next hover asks again.
          for (const p of batch) answers.set(p, false)
        }
      }
      return paths.map((p) => answers.get(p) === true)
    },
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && pnpm vitest run src/files/detector.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/files/detector.ts web/src/files/detector.test.ts
git commit -m "feat(web): the link detector, verification cached 30s hit 2s miss"
```

---

### Task 6: the viewer

**Files:**
- Create: `web/src/files/viewer.tsx`
- Test: `web/src/files/viewer.test.tsx`

**Interfaces:**
- Consumes: `useFlueClient` (`@/client/provider`), `ReadSink`/`ReadHandle`
  (Task 2), `FileMsg`, Radix `Dialog` via the `radix-ui` umbrella, `Button`
  from `@/components/ui/button`, lucide icons.
- Produces: `FileViewer({ sessionId, target, onClose })` and `FileTarget`.

Shape and classes follow `scratch/provider.tsx:285-301` (full-bleed on a
phone, a centered `sm:` panel with `shadow-high ring-1 ring-hairline`) and the
`shortcuts-help.tsx` header row. The body is windowed by arithmetic — a
monospace line is exactly 20 px (`leading-5`), so the window is
`scrollTop / 20` with an overscan, padding standing in for the unrendered
rest. Chunks paint as they arrive: the head of an 8 MiB file is readable
before the tail leaves the daemon, which over a 50 ms relay is the difference
between instant and eight seconds. One rAF per batch of chunks, so painting
never outruns the frame rate.

- [ ] **Step 1: Write the failing tests**

`viewer.test.tsx`, driven through a `FlueClientProvider` over the fake socket
(the `testing/socket.ts` helpers):

```tsx
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FlueClientProvider } from '@/client/provider'
import { FRAME_FILE } from '@/client/protocol'
import { fakeClient, type FakeSocket } from '@/testing/socket'
import { FileViewer, type FileTarget } from './viewer'

const openViewer = async (target: FileTarget, onClose = vi.fn()) => {
  const { client, sock } = fakeClient()
  render(
    <FlueClientProvider client={client}>
      <FileViewer sessionId="s1" target={target} onClose={onClose} />
    </FlueClientProvider>,
  )
  const sent = sock.control().find((m) => m.type === 'read')
  return { sock, sent, onClose }
}

const served = (sock: FakeSocket, reqId: unknown, over: Record<string, unknown> = {}) =>
  act(() => {
    sock.emitControl({
      type: 'file', ref: 7, path: '/home/k/proj/a.go', size: 22,
      mime: 'text/plain; charset=utf-8', kind: 'text', reqId, ...over,
    })
  })

const flowed = async (sock: FakeSocket, body: string) => {
  await act(async () => {
    sock.emitBinary(FRAME_FILE, 7, body)
    await new Promise((f) => requestAnimationFrame(f))
  })
}

afterEach(() => vi.restoreAllMocks())

describe('FileViewer', () => {
  it('asks for the file and shows its name while opening', async () => {
    const { sent } = await openViewer({ path: 'a.go' })
    expect(sent).toMatchObject({ type: 'read', id: 's1', path: 'a.go' })
    expect(screen.getByRole('dialog', { name: 'a.go' })).toBeTruthy()
    expect(screen.getByText(/Opening/)).toBeTruthy()
  })

  it('paints chunks as they arrive, then finishes on eof', async () => {
    const { sock, sent } = await openViewer({ path: 'a.go' })
    served(sock, sent!.reqId)
    await flowed(sock, 'package main\n\nfunc main()')
    expect(screen.getByText('package main')).toBeTruthy()
    act(() => sock.emitControl({ type: 'eof', ref: 7 }))
    expect(screen.getByText('func main()')).toBeTruthy()
  })

  it('shows the resolved directory and the size, not the clicked text', async () => {
    const { sock, sent } = await openViewer({ path: 'a.go' })
    served(sock, sent!.reqId)
    expect(screen.getByText('/home/k/proj')).toBeTruthy()
    expect(screen.getByText('22 B')).toBeTruthy()
  })

  it('windows a large body instead of rendering every line', async () => {
    const { sock, sent } = await openViewer({ path: 'big.txt' })
    served(sock, sent!.reqId, { size: 1 << 20 })
    await flowed(sock, Array.from({ length: 10_000 }, (_, i) => `row ${i}`).join('\n'))
    expect(screen.getByText('row 0')).toBeTruthy()
    expect(screen.queryByText('row 9999')).toBeNull()
    expect(document.querySelectorAll('[data-file-row]').length).toBeLessThan(200)
  })

  it('marks the :line the click named', async () => {
    const { sock, sent } = await openViewer({ path: 'a.go', line: 2 })
    served(sock, sent!.reqId)
    await flowed(sock, 'one\ntwo\nthree')
    act(() => sock.emitControl({ type: 'eof', ref: 7 }))
    expect(screen.getByText('two').getAttribute('data-marked')).toBe('true')
    expect(screen.getByText('one').getAttribute('data-marked')).toBeNull()
  })

  it('says how much of a truncated file it is showing', async () => {
    const { sock, sent } = await openViewer({ path: 'big.log' })
    served(sock, sent!.reqId, { size: 41943040, truncated: true })
    expect(screen.getByRole('status').textContent).toMatch(/first 8 MiB of 40 MiB/)
  })

  it('turns a refusal into words', async () => {
    const { sock, sent } = await openViewer({ path: 'web/src/' })
    act(() => sock.emitControl({ type: 'error', code: 'is_dir', msg: 'that is a directory', reqId: sent!.reqId }))
    expect(screen.getByRole('alert').textContent).toMatch(/directory/)
  })

  it('declines an image politely, and stops the stream', async () => {
    const { sock, sent } = await openViewer({ path: 'shot.png' })
    served(sock, sent!.reqId, { mime: 'image/png', kind: 'image', size: 184320 })
    expect(screen.getByRole('alert').textContent).toMatch(/image/i)
    expect(sock.control().find((m) => m.type === 'cancel')).toMatchObject({ type: 'cancel', ref: 7 })
  })

  it('cancels the read when closed mid-stream', async () => {
    const { sock, sent, onClose } = await openViewer({ path: 'a.go' })
    served(sock, sent!.reqId)
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalled()
  })

  it('offers the resolved path to the clipboard', async () => {
    const wrote: string[] = []
    Object.assign(navigator, { clipboard: { writeText: (t: string) => (wrote.push(t), Promise.resolve()) } })
    const { sock, sent } = await openViewer({ path: 'a.go' })
    served(sock, sent!.reqId)
    await userEvent.click(screen.getByRole('button', { name: /copy path/i }))
    expect(wrote).toEqual(['/home/k/proj/a.go'])
  })
})
```

(Check `testing/socket.ts` for the exact `fakeClient` return shape and adjust
the destructuring; the cancel-on-close assertion moves to the unmount if
Radix's Escape path proves awkward under jsdom — the load-bearing claim is
that closing cancels, asserted via `sock.control()` after `unmount()`.)

- [ ] **Step 2: Run them to verify they fail**

Run: `cd web && pnpm vitest run src/files/viewer.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```tsx
import { Dialog } from 'radix-ui'
import { useEffect, useRef, useState } from 'react'
import { Check, Copy, FileText, X } from 'lucide-react'
import { useFlueClient } from '@/client/provider'
import type { FileMsg } from '@/client/protocol'
import { Button } from '@/components/ui/button'

export interface FileTarget {
  path: string
  line?: number
  col?: number
}

export interface FileViewerProps {
  sessionId: string
  target: FileTarget
  onClose: () => void
}

/* One monospace row is exactly this tall (leading-5), which is what lets the
 * body be windowed by arithmetic instead of a virtualization library. */
const LINE_PX = 20
const OVERSCAN = 20
const TEXT_CAP = 8 << 20 // the daemon's ceiling; past it only the head arrived

const REFUSALS: Record<string, string> = {
  not_found: 'Nothing at this path under the session.',
  is_dir: 'That path is a directory.',
  too_large: 'This image is too large to send.',
  denied: 'The machine may not read this file.',
  busy: 'Two files are already streaming from this machine. Close one first.',
  unsupported: 'Neither text nor an image, so nothing sensible to show.',
  bad_path: 'Not a usable path.',
  timeout: 'The machine did not answer in time.',
  lost: 'The connection dropped before the file arrived whole.',
}

type Phase =
  | { at: 'opening' }
  | { at: 'text'; meta: FileMsg; done: boolean }
  | { at: 'image'; meta: FileMsg }
  | { at: 'refused'; code: string }

export function FileViewer({ sessionId, target, onClose }: FileViewerProps) {
  const client = useFlueClient()
  const [phase, setPhase] = useState<Phase>({ at: 'opening' })
  const [, setPaint] = useState(0)
  const linesRef = useRef<string[]>([])
  const frame = useRef(0)

  useEffect(() => {
    linesRef.current = []
    setPhase({ at: 'opening' })
    const decoder = new TextDecoder()
    let tail = ''
    let kind: 'text' | 'image' = 'text'
    const repaint = () => {
      if (frame.current !== 0) return
      frame.current = requestAnimationFrame(() => {
        frame.current = 0
        setPaint((n) => n + 1)
      })
    }
    const push = (piece: string) => {
      const parts = (tail + piece).split('\n')
      tail = parts.pop() ?? ''
      for (const p of parts) linesRef.current.push(p.endsWith('\r') ? p.slice(0, -1) : p)
    }
    const handle = client.read(sessionId, target.path, {
      file: (meta) => {
        kind = meta.kind
        if (meta.kind === 'image') {
          setPhase({ at: 'image', meta })
          queueMicrotask(() => handle.cancel())
          return
        }
        setPhase({ at: 'text', meta, done: false })
      },
      chunk: (bytes) => {
        if (kind === 'image') return
        push(decoder.decode(bytes, { stream: true }))
        repaint()
      },
      eof: () => {
        push(decoder.decode())
        if (tail !== '') {
          linesRef.current.push(tail)
          tail = ''
        }
        setPhase((p) => (p.at === 'text' ? { ...p, done: true } : p))
        repaint()
      },
      fail: (f) => setPhase({ at: 'refused', code: f.code }),
    })
    return () => {
      handle.cancel()
      if (frame.current !== 0) cancelAnimationFrame(frame.current)
      frame.current = 0
    }
  }, [client, sessionId, target.path])

  const meta = phase.at === 'text' || phase.at === 'image' ? phase.meta : null
  const shownPath = meta?.path ?? target.path
  const slash = shownPath.lastIndexOf('/')
  const base = slash >= 0 ? shownPath.slice(slash + 1) : shownPath
  const dir = slash > 0 ? shownPath.slice(0, slash) : slash === 0 ? '/' : ''

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/25" />
        <Dialog.Content
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            document.querySelector<HTMLElement>('[data-file-body]')?.focus()
          }}
          className={
            'fixed inset-0 z-50 flex flex-col overflow-hidden bg-popover text-popover-foreground outline-none ' +
            'sm:inset-auto sm:top-[8vh] sm:left-1/2 sm:h-[78vh] sm:w-[64rem] sm:max-w-[calc(100vw-2rem)] sm:-translate-x-1/2 ' +
            'sm:rounded-lg sm:shadow-high sm:ring-1 sm:ring-hairline'
          }
        >
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-hairline pr-1.5 pl-4 sm:h-9">
            <FileText aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <Dialog.Title className="shrink-0 font-heading text-sm font-medium">{base}</Dialog.Title>
            <span className="min-w-0 flex-1 truncate text-control text-muted-foreground">{dir}</span>
            {meta !== null && (
              <span className="shrink-0 text-control whitespace-nowrap text-muted-foreground">{fmtBytes(meta.size)}</span>
            )}
            <CopyPath path={shownPath} />
            <Dialog.Close asChild>
              <Button aria-label="Close file" size="icon-sm" variant="ghost">
                <X />
              </Button>
            </Dialog.Close>
          </div>
          {phase.at === 'text' && phase.meta.truncated === true && (
            <p role="status" className="shrink-0 border-b border-hairline bg-muted/40 px-4 py-1.5 text-control text-muted-foreground">
              Showing the first {fmtBytes(TEXT_CAP)} of {fmtBytes(phase.meta.size)}. The rest stayed on the machine.
            </p>
          )}
          {phase.at === 'opening' && (
            <p role="status" className="flex-1 px-4 py-3 text-control text-muted-foreground">
              Opening…
            </p>
          )}
          {phase.at === 'refused' && (
            <p role="alert" className="flex-1 px-4 py-3 text-control text-destructive">
              {REFUSALS[phase.code] ?? 'The machine refused this read.'}
            </p>
          )}
          {phase.at === 'image' && (
            <p role="alert" className="flex-1 px-4 py-3 text-control text-muted-foreground">
              An image ({phase.meta.mime}, {fmtBytes(phase.meta.size)}). The viewer cannot render one yet.
            </p>
          )}
          {phase.at === 'text' && <TextWindow lines={linesRef.current} mark={target.line} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function TextWindow({ lines, mark }: { lines: string[]; mark?: number }) {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const jumped = useRef(false)
  const [top, setTop] = useState(0)
  const [tall, setTall] = useState(0)

  useEffect(() => {
    const box = boxRef.current
    if (box === null) return
    const measure = () => setTall(box.clientHeight)
    measure()
    const watcher = new ResizeObserver(measure)
    watcher.observe(box)
    return () => watcher.disconnect()
  }, [])

  useEffect(() => {
    const box = boxRef.current
    if (box === null || mark === undefined || jumped.current || lines.length < mark) return
    jumped.current = true
    box.scrollTop = Math.max(0, (mark - 4) * LINE_PX)
    setTop(box.scrollTop)
  }, [lines.length, mark])

  const rows = Math.max(1, Math.ceil((tall > 0 ? tall : 480) / LINE_PX))
  const first = Math.max(0, Math.floor(top / LINE_PX) - OVERSCAN)
  const last = Math.min(lines.length, first + rows + OVERSCAN * 2)

  return (
    <div
      ref={boxRef}
      data-file-body
      tabIndex={-1}
      onScroll={(e) => setTop(e.currentTarget.scrollTop)}
      className="min-h-0 flex-1 overflow-auto overscroll-contain py-2 font-mono text-[12.5px] leading-5 outline-none"
    >
      <div
        className="w-max min-w-full"
        style={{ paddingTop: first * LINE_PX, paddingBottom: (lines.length - last) * LINE_PX }}
      >
        {lines.slice(first, last).map((text, i) => {
          const n = first + i + 1
          return (
            <div
              key={n}
              data-file-row
              data-marked={n === mark ? 'true' : undefined}
              className="h-5 pr-6 pl-4 whitespace-pre data-marked:bg-teal-500/15"
            >
              {text}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function CopyPath({ path }: { path: string }) {
  const [held, setHeld] = useState(false)
  return (
    <Button
      aria-label="Copy path"
      size="icon-sm"
      variant="ghost"
      onClick={() => {
        void navigator.clipboard?.writeText(path).then(() => {
          setHeld(true)
          setTimeout(() => setHeld(false), 1500)
        })
      }}
    >
      {held ? <Check /> : <Copy />}
    </Button>
  )
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KiB', 'MiB', 'GiB']
  let v = n
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  const shown = v >= 10 ? Math.round(v) : Math.round(v * 10) / 10
  return `${shown} ${units[u]}`
}
```

Adjust to the codebase as found: the `data-marked:` variant needs Tailwind 4's
attribute-variant syntax as used elsewhere, else fall back to a conditional
class; `Button` size/variant names must match `ui/button.tsx`. Keep every
comment clear of bare utility words — `styles.build.test.ts` is the judge.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && pnpm vitest run src/files/viewer.test.tsx` and
`pnpm vitest run src/styles.build.test.ts`
Expected: PASS, and no stray compiled utility from the new prose.

- [ ] **Step 5: Commit**

```bash
git add web/src/files/viewer.tsx web/src/files/viewer.test.tsx
git commit -m "feat(web): a windowed file viewer that paints chunks as they arrive"
```

---

### Task 7: wire it into the session view

**Files:**
- Modify: `web/src/components/terminal.tsx`
- Test: `web/src/components/terminal.test.tsx`

**Interfaces:**
- Consumes: `createPathDetector` (Task 5), `FileViewer`/`FileTarget` (Task 6),
  `emulator.detectLinks` (Task 4), `client.stat` (Task 1),
  `FakeEmulator.detector` (Task 4).
- Produces: hovering a line in a session stats it; clicking a verified path
  opens the viewer; closing it returns focus to the terminal.

- [ ] **Step 1: Write the failing tests**

In `terminal.test.tsx`, using the existing `mountTerminal` + `emulators()`
harness:

```tsx
describe('file links', () => {
  it('hands the emulator a detector that stats through this session', async () => {
    const { sock } = await mounted() // whatever the local attach helper is named
    const em = ems.live()
    const answer = em.detector!.verify(['internal/a.go'])
    const sent = sock.sentControl().find((m) => m.type === 'stat')
    expect(sent).toMatchObject({ type: 'stat', id: 's1', paths: ['internal/a.go'] })
    act(() => {
      sock.emitControl({
        type: 'stats',
        entries: [{ path: 'internal/a.go', exists: true, kind: 'file' }],
        reqId: sent!.reqId,
      })
    })
    await expect(answer).resolves.toEqual([true])
  })

  it('opens the viewer when a verified path is clicked, and reads it', async () => {
    const { sock } = await mounted()
    act(() => ems.live().detector!.open({ path: 'src/foo.ts', start: 0, end: 10, line: 12 }))
    expect(screen.getByRole('dialog', { name: 'foo.ts' })).toBeTruthy()
    expect(sock.sentControl().find((m) => m.type === 'read')).toMatchObject({
      type: 'read', id: 's1', path: 'src/foo.ts',
    })
  })

  it('closing the viewer cancels the read and refocuses the terminal', async () => {
    const { sock } = await mounted()
    const em = ems.live()
    const before = em.focusCalls
    act(() => em.detector!.open({ path: 'src/foo.ts', start: 0, end: 10 }))
    act(() => {
      sock.emitControl({
        type: 'file', ref: 9, path: '/w/src/foo.ts', size: 5,
        mime: 'text/plain; charset=utf-8', kind: 'text',
        reqId: sock.sentControl().find((m) => m.type === 'read')!.reqId,
      })
    })
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'foo.ts' })).toBeNull()
    expect(sock.sentControl().find((m) => m.type === 'cancel')).toMatchObject({ type: 'cancel', ref: 9 })
    expect(em.focusCalls).toBeGreaterThan(before)
  })
})
```

(Adapt the mount helper names to the file's own — `mountTerminal`,
`attachRef`, `emulators()` — as found when editing.)

- [ ] **Step 2: Run them to verify they fail**

Run: `cd web && pnpm vitest run src/components/terminal.test.tsx -t 'file links'`
Expected: FAIL — `detector` is null, no dialog.

- [ ] **Step 3: Implement**

In `terminal.tsx`:

1. State beside `pasteBox` and friends: `const [peeked, setPeeked] =
   useState<FileTarget | null>(null)`.
2. In the mount effect, right after `emulator.attachTo(surface)`:

```ts
    emulator.detectLinks(
      createPathDetector({
        stat: (paths) => client.stat(sessionId, paths),
        open: (candidate) =>
          setPeeked({ path: candidate.path, line: candidate.line, col: candidate.col }),
      }),
    )
```

   Disposal needs nothing new — `emulator.dispose()` already drops the
   provider (Task 4).
3. The actions bag gains `focusSurface: () => emulator.focus()` so the render
   half can hand focus back; follow the existing `actionsRef` assignment and
   the null on teardown.
4. In the JSX, beside the other overlays:

```tsx
      {peeked !== null && (
        <FileViewer
          sessionId={sessionId}
          target={peeked}
          onClose={() => {
            setPeeked(null)
            actionsRef.current?.focusSurface()
          }}
        />
      )}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && pnpm vitest run src/components/terminal.test.tsx && pnpm run lint`
Expected: PASS, clean types.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/terminal.tsx web/src/components/terminal.test.tsx
git commit -m "feat(web): click a path the session named, read it over the session"
```

---

### Task 8: one relayed read, for real

**Files:**
- Modify: `web/e2e/fleet.e2e.ts`

**Interfaces:**
- Consumes: the running fleet from `startFleet()` (two daemons, the real
  Worker), `FleetClient`/`relaySocket` as already imported there, and
  `client.read`/`client.stat` from Task 1-2.

The 1 MiB relay cap and the chunk pacing only exist for real over the relay;
this is the one place they are genuinely proven. The test writes a ~192 KiB
file on machine B through a session's own shell, then reads it from a tab on
machine A across the Worker, and asserts the bytes arrive whole and chunked.

- [ ] **Step 1: Write the test**

After the existing remote-session test (which has already joined machine B to
the fleet — order in this suite is load-bearing and documented there):

```ts
  it('reads a file from machine B over the relay, chunked, complete, and cancelable', async () => {
    const stamp = `flue-peek-${NONCE}`
    const filePath = `/tmp/${stamp}.txt`

    // Write a file on machine B through its own daemon, loopback.
    const shut = open(fleet.b.origin, { token: fleet.b.token })
    let written = ''
    try {
      const onB = new FlueClient(daemonSocketUrl())
      await connected(onB)
      const ref = await new Promise<number>((resolve, reject) => {
        const off = onB.onAttached((a) => { off(); resolve(a.ref) })
        setTimeout(() => reject(new Error('no attach')), 10_000)
        onB.spawn({ cmd: ['/bin/sh'], cols: 80, rows: 24 })
      })
      onB.sendInput(ref, new TextEncoder().encode(
        `head -c 196608 /dev/urandom | base64 > ${filePath} && echo ${stamp}-done\n`,
      ))
      let seen = ''
      onB.onOutput((r, bytes) => { if (r === ref) seen += new TextDecoder().decode(bytes) })
      await until('the file to be written on machine B', () => seen.includes(`${stamp}-done`))
      const entries = await onB.stat(peekSession, [filePath]) // peekSession: the session id, from onSessions
      written = String(entries[0]?.size ?? '')
      onB.close()
    } finally {
      shut()
    }

    // Read it from machine A's tab, across the Worker.
    const t = open(fleet.a.origin, { token: fleet.a.token })
    const f = new FleetClient(
      [{ id: LOCAL_MACHINE_ID, name: '', client: new FlueClient(daemonSocketUrl()), pinned: false }],
      undefined,
      { enrol: enrolThisBrowser, directoryFetch: readDirectoryViaDaemon },
    )
    const view = watch(f)
    try {
      await until("machine B to be online in machine A's tab", () => {
        t.focus()
        return view.latest().machines.some((m) => m.id === fleet.b.machineId && m.status === 'online')
      }, 90_000)
      const remote = f.clientFor(fleet.b.machineId as string) as FlueClient
      const sessions = view.latest().sessions.filter((s) => s.machineId === fleet.b.machineId)
      const sid = sessions[0]!.id

      const chunks: number[] = []
      let body = new Uint8Array(0)
      const outcome = await new Promise<string>((resolve) => {
        remote.read(sid, filePath, {
          file: (meta) => { if (meta.kind !== 'text') resolve(`kind ${meta.kind}`) },
          chunk: (bytes) => {
            chunks.push(bytes.length)
            const next = new Uint8Array(body.length + bytes.length)
            next.set(body); next.set(bytes, body.length)
            body = next
          },
          eof: () => resolve('eof'),
          fail: (fl) => resolve(`${fl.code}: ${fl.msg}`),
        })
      })
      expect(outcome).toBe('eof')
      expect(body.length).toBe(Number(written))
      expect(chunks.length).toBeGreaterThanOrEqual(4)     // ~192 KiB base64 in 32 KiB chunks
      expect(Math.max(...chunks)).toBeLessThanOrEqual(32 << 10)
    } finally {
      view.off?.()
      f.close?.()
      t.close()
    }
  }, 120_000)
```

Adapt the scaffolding calls (`open`, `watch`, `until`, `connected`, teardown
method names) to the suite's own as found in the file — the assertions are the
contract: complete bytes, ≥4 chunks, no chunk past 32 KiB, all across the
Worker. The session id for the loopback `stat` comes from the same
`onSessions` listener pattern the marker test uses.

- [ ] **Step 2: Run it**

Run: `make e2e` from the repo root (builds `bin/flue-e2e`, boots wrangler and
two daemons; 180 s budget). If the sandbox forbids the port binds, run what is
runnable and flag the gap in the PR rather than faking the pass.

- [ ] **Step 3: Commit**

```bash
git add web/e2e/fleet.e2e.ts
git commit -m "test(e2e): one relayed read, chunked and complete, through the real Worker"
```

---

### Task 9: full sweep and the pull request

- [ ] **Step 1: The whole web suite and lint**

Run: `cd web && pnpm vitest run && pnpm run lint`
Expected: green, including `styles.build.test.ts` (the prose scanner) and the
golden-fixture suite.

- [ ] **Step 2: Go, untouched but proven so**

Run: `go test ./...` from the repo root.
Expected: green — this phase changes no Go, and the run proves it.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feat/file-peek-viewer
gh pr create --title "Click a path the session named: hover, verify, and read it in a viewer" \
  --body "..."
```

Body: what shipped (client verbs, the seam, the viewer), what deliberately did
not (Shiki, images, the LRU — #79), the relay story, and `Closes #78`. Hand
the URL back.

## Self-Review

- **Spec coverage.** Client verbs (Tasks 1-2), `detectLinks` seam + wrapped
  lines (Task 4), candidates + `:line[:col]` + punctuation (Task 3), hover
  verification one-stat-per-line with 30 s/2 s cache (Task 5), windowed viewer
  + truncation notice + resolved-path header + copy + `:line` mark (Task 6),
  session wiring (Task 7), the relayed e2e read (Task 8). Phase 3's Shiki,
  images, and LRU are explicitly out. The image `kind` is answered with honest
  copy rather than mojibake, which is the phase boundary the design drew.
- **Placeholders.** None; every step carries its code or its exact command.
  The two "adapt as found" notes (test-harness helper names, Tailwind variant
  syntax) name the thing to check and where, not work left undesigned.
- **Type consistency.** `LinkCandidate`/`LinkDetector` live in
  `emulator/types.ts` and are imported everywhere else; `ReadSink.fail`
  carries `{code, msg}` and the viewer's `REFUSALS` keys match the protocol's
  codes plus the client's own `timeout`/`lost`; `FakeEmulator.detector` is the
  property Task 7's tests read; `focusSurface` is the one action name Task 7
  both defines and calls.
