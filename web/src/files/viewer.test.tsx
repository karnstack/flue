import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FlueClientProvider } from '@/client/provider'
import { fakeClient, type FakeSocket } from '@/testing/socket'
import { FileViewer, type FileTarget } from './viewer'

const openViewer = (target: FileTarget) => {
  // jsdom lays nothing out, and the virtualizer windows on measured boxes —
  // offsetWidth/offsetHeight for the scroll box, getBoundingClientRect for
  // row measurement. Every element pretending to be 800x480 is what
  // terminal.test.tsx's paneOf does for the same reason.
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(480)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 800,
    height: 480,
    top: 0,
    left: 0,
    right: 800,
    bottom: 480,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect)
  const onClose = vi.fn()
  const { client, last } = fakeClient()
  client.connect()
  const sock = last()
  act(() => sock.open())
  const view = render(
    <FlueClientProvider client={client}>
      <FileViewer sessionId="s1" target={target} onClose={onClose} />
    </FlueClientProvider>,
  )
  const sent = sock.control().find((m) => m.type === 'read')
  // Answer every stat not yet answered with one entry (or nothing for null).
  // The cache protocol stats around a read — before it starts, after it
  // ends, and once more to validate a reopen — so tests answer by sweep.
  const answeredStats = new Set<number>()
  const answerStats = (entry: Record<string, unknown> | null) =>
    act(async () => {
      for (const m of sock.control().filter((x) => x.type === 'stat')) {
        const id = m.reqId as number
        if (answeredStats.has(id)) continue
        answeredStats.add(id)
        sock.emitControl({ type: 'stats', entries: entry === null ? [] : [entry], reqId: id })
      }
      await Promise.resolve()
    })
  return { sock, sent, onClose, view, client, answerStats }
}

const served = (sock: FakeSocket, reqId: unknown, over: Record<string, unknown> = {}) =>
  act(() => {
    sock.emitControl({
      type: 'file',
      ref: 7,
      path: '/home/k/proj/a.go',
      size: 22,
      mime: 'text/plain; charset=utf-8',
      kind: 'text',
      reqId: reqId as number,
      ...over,
    })
  })

const flowed = async (sock: FakeSocket, body: string) => {
  await act(async () => {
    sock.emitFile(7, body)
    await new Promise((frame) => requestAnimationFrame(frame))
  })
}

afterEach(() => vi.restoreAllMocks())

describe('FileViewer', () => {
  it('asks for the file and says so while opening', () => {
    const { sent } = openViewer({ path: 'a.go' })
    expect(sent).toMatchObject({ type: 'read', id: 's1', path: 'a.go' })
    expect(screen.getByRole('dialog', { name: 'a.go' })).toBeTruthy()
    expect(screen.getByRole('status').textContent).toMatch(/Opening/)
  })

  it('paints chunks as they arrive, then finishes on eof', async () => {
    const { sock, sent } = openViewer({ path: 'notes.txt' })
    served(sock, sent!.reqId, { path: '/home/k/notes.txt' })
    await flowed(sock, 'package main\n\nfunc main()')
    expect(screen.getByText('package main')).toBeTruthy()
    await act(async () => {
      sock.emitControl({ type: 'eof', ref: 7 })
      await new Promise((frame) => requestAnimationFrame(frame))
    })
    expect(screen.getByText('func main()')).toBeTruthy()
  })

  it('shows the resolved directory and the size, not the clicked text', () => {
    const { sock, sent } = openViewer({ path: 'a.go' })
    served(sock, sent!.reqId)
    expect(screen.getByText('/home/k/proj')).toBeTruthy()
    expect(screen.getByText('22 B')).toBeTruthy()
  })

  it('windows a large body instead of rendering every line', async () => {
    const { sock, sent } = openViewer({ path: 'big.txt' })
    served(sock, sent!.reqId, { size: 1 << 20 })
    await flowed(sock, Array.from({ length: 10_000 }, (_, i) => `row ${i}`).join('\n'))
    expect(screen.getByText('row 0')).toBeTruthy()
    expect(screen.queryByText('row 9999')).toBeNull()
    expect(document.querySelectorAll('[data-file-row]').length).toBeLessThan(200)
  })

  it('chops a single enormous line into bounded rows, painting before eof', async () => {
    const { sock, sent } = openViewer({ path: 'min.js' })
    served(sock, sent!.reqId, { size: 200_001 })
    // No newline anywhere: the failure mode is one giant DOM row, blank
    // until eof. Chopping bounds the row and paints the head immediately.
    await flowed(sock, 'y'.repeat(20_000))
    const rows = document.querySelectorAll('[data-file-row]')
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.textContent!.length).toBeLessThanOrEqual(8192)
    }
  })

  it('marks the line the click named', async () => {
    const { sock, sent } = openViewer({ path: 'notes.txt', line: 2 })
    served(sock, sent!.reqId, { path: '/home/k/notes.txt' })
    await flowed(sock, 'one\ntwo\nthree')
    await act(async () => {
      sock.emitControl({ type: 'eof', ref: 7 })
      await new Promise((frame) => requestAnimationFrame(frame))
    })
    expect(screen.getByText('two').getAttribute('data-marked')).toBe('true')
    expect(screen.getByText('one').getAttribute('data-marked')).toBeNull()
  })

  it('says how much of a shortened file it is showing', () => {
    const { sock, sent } = openViewer({ path: 'big.log' })
    served(sock, sent!.reqId, { size: 41943040, truncated: true })
    expect(screen.getByRole('status').textContent).toMatch(/first 8 MiB of 40 MiB/)
  })

  it('turns a refusal into words', () => {
    const { sock, sent } = openViewer({ path: 'web/src/' })
    act(() =>
      sock.emitControl({
        type: 'error',
        code: 'is_dir',
        msg: 'that is a directory',
        reqId: sent!.reqId as number,
      }),
    )
    expect(screen.getByRole('alert').textContent).toMatch(/directory/)
  })

  it('reports Escape to its owner', async () => {
    const { sock, sent, onClose } = openViewer({ path: 'a.go' })
    served(sock, sent!.reqId)
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('cancels the read when taken down mid-stream', () => {
    const { sock, sent, view, client } = openViewer({ path: 'a.go' })
    served(sock, sent!.reqId)
    // The owner removes the viewer and keeps the connection, which is what
    // closing the dialog does; the whole tab going away is teardown's case.
    view.rerender(<FlueClientProvider client={client}>{null}</FlueClientProvider>)
    expect(sock.control().find((m) => m.type === 'cancel')).toMatchObject({ type: 'cancel', ref: 7 })
  })

  it('renders an image from its assembled chunks as a data URL', async () => {
    const { sock, sent } = openViewer({ path: 'shot.png' })
    served(sock, sent!.reqId, { path: '/home/k/shot.png', mime: 'image/png', kind: 'image', size: 8 })
    await flowed(sock, 'fake')
    await flowed(sock, 'png!')
    await act(async () => {
      sock.emitControl({ type: 'eof', ref: 7 })
      await new Promise((frame) => requestAnimationFrame(frame))
    })
    const img = screen.getByRole('img', { name: 'shot.png' })
    expect(img.getAttribute('src')).toMatch(/^data:image\/png;base64,/)
    expect(sock.control().find((m) => m.type === 'cancel')).toBeUndefined()
  })

  it('swaps plain rows for highlighted spans once the file is complete', async () => {
    const { sock, sent } = openViewer({ path: 'a.ts' })
    served(sock, sent!.reqId, { path: '/home/k/a.ts' })
    await flowed(sock, 'const x = 1')
    await act(async () => {
      sock.emitControl({ type: 'eof', ref: 7 })
      await new Promise((frame) => requestAnimationFrame(frame))
    })
    await waitFor(() => {
      expect(document.querySelector('[data-file-row] span')).not.toBeNull()
    })
    // The colour must arrive through the scheme-aware classes, never as an
    // inline color — inline would pin the light palette under a dark scheme.
    const span = document.querySelector<HTMLElement>('[data-file-row] span[style]')!
    expect(span.style.color).toBe('')
    expect(span.style.getPropertyValue('--peek-light')).not.toBe('')
    expect(span.style.getPropertyValue('--peek-dark')).not.toBe('')
    expect(span.className).toContain('text-(--peek-light)')
    expect(span.className).toContain('dark:text-(--peek-dark)')
  })

  it('keeps plain rows for a shortened file', async () => {
    const { sock, sent } = openViewer({ path: 'big.ts' })
    served(sock, sent!.reqId, { path: '/home/k/big.ts', size: 41943040, truncated: true })
    await flowed(sock, 'const x = 1')
    await act(async () => {
      sock.emitControl({ type: 'eof', ref: 7 })
      await new Promise((done) => setTimeout(done, 50))
    })
    expect(document.querySelector('[data-file-row] span')).toBeNull()
  })

  it('serves a reopen from the cache once the surrounding stats agree', async () => {
    const path = `cache-hit-${Math.random().toString(36).slice(2)}.txt`
    const { sock, sent, view, client, answerStats } = openViewer({ path })
    const entry = { path, exists: true, kind: 'file', size: 5, mtime: 111 }
    await answerStats(entry) // the stat riding beside the read
    served(sock, sent!.reqId, { path: `/home/k/${path}`, size: 5 })
    await flowed(sock, 'hello')
    await act(async () => {
      sock.emitControl({ type: 'eof', ref: 7 })
      await new Promise((frame) => requestAnimationFrame(frame))
    })
    await answerStats(entry) // the confirming stat after the stream

    view.rerender(<FlueClientProvider client={client}>{null}</FlueClientProvider>)
    view.rerender(
      <FlueClientProvider client={client}>
        <FileViewer sessionId="s1" target={{ path }} onClose={vi.fn()} />
      </FlueClientProvider>,
    )
    await answerStats(entry) // the reopen's validation
    await act(async () => {
      await new Promise((frame) => requestAnimationFrame(frame))
    })
    expect(screen.getByText('hello')).toBeTruthy()
    expect(sock.control().filter((m) => m.type === 'read')).toHaveLength(1)
  })

  it('re-reads when the stat says the file changed', async () => {
    const path = `cache-stale-${Math.random().toString(36).slice(2)}.txt`
    const { sock, sent, view, client, answerStats } = openViewer({ path })
    const entry = { path, exists: true, kind: 'file', size: 5, mtime: 111 }
    await answerStats(entry)
    served(sock, sent!.reqId, { path: `/home/k/${path}`, size: 5 })
    await flowed(sock, 'hello')
    await act(async () => {
      sock.emitControl({ type: 'eof', ref: 7 })
      await new Promise((frame) => requestAnimationFrame(frame))
    })
    await answerStats(entry)

    view.rerender(<FlueClientProvider client={client}>{null}</FlueClientProvider>)
    view.rerender(
      <FlueClientProvider client={client}>
        <FileViewer sessionId="s1" target={{ path }} onClose={vi.fn()} />
      </FlueClientProvider>,
    )
    await answerStats({ ...entry, mtime: 999 })
    expect(sock.control().filter((m) => m.type === 'read')).toHaveLength(2)
  })

  it('does not remember a file whose stamp moved while it streamed', async () => {
    // The stale-bytes case: an edit lands between the stream and the
    // confirming stat, same size. An after-only check would bless post-edit
    // bytes with the post-edit stamp and serve them stale forever after.
    const path = `cache-torn-${Math.random().toString(36).slice(2)}.txt`
    const { sock, sent, view, client, answerStats } = openViewer({ path })
    await answerStats({ path, exists: true, kind: 'file', size: 5, mtime: 100 })
    served(sock, sent!.reqId, { path: `/home/k/${path}`, size: 5 })
    await flowed(sock, 'hello')
    await act(async () => {
      sock.emitControl({ type: 'eof', ref: 7 })
      await new Promise((frame) => requestAnimationFrame(frame))
    })
    await answerStats({ path, exists: true, kind: 'file', size: 5, mtime: 200 })

    view.rerender(<FlueClientProvider client={client}>{null}</FlueClientProvider>)
    view.rerender(
      <FlueClientProvider client={client}>
        <FileViewer sessionId="s1" target={{ path }} onClose={vi.fn()} />
      </FlueClientProvider>,
    )
    // Nothing was remembered, so the reopen reads again rather than stats
    // its way to a replay.
    expect(sock.control().filter((m) => m.type === 'read')).toHaveLength(2)
  })

  it('wraps long lines by default, and unwraps on the toggle', async () => {
    const { sock, sent } = openViewer({ path: 'notes.txt' })
    served(sock, sent!.reqId, { path: '/home/k/notes.txt' })
    await flowed(sock, 'a very long line\nand another')
    const row = () => document.querySelector('[data-file-row]')!
    expect(row().className).toContain('whitespace-pre-wrap')
    const toggle = screen.getByRole('button', { name: 'Wrap lines' })
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    await userEvent.click(toggle)
    expect(row().className).not.toContain('whitespace-pre-wrap')
    expect(row().className).toContain('whitespace-pre')
    await userEvent.click(toggle)
    expect(row().className).toContain('whitespace-pre-wrap')
  })

  it('offers the resolved path to the clipboard', async () => {
    const wrote: string[] = []
    Object.assign(navigator, {
      clipboard: { writeText: (t: string) => (wrote.push(t), Promise.resolve()) },
    })
    const { sock, sent } = openViewer({ path: 'a.go' })
    served(sock, sent!.reqId)
    await userEvent.click(screen.getByRole('button', { name: /copy path/i }))
    expect(wrote).toEqual(['/home/k/proj/a.go'])
  })
})
