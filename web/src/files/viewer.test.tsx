import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FlueClientProvider } from '@/client/provider'
import { fakeClient, type FakeSocket } from '@/testing/socket'
import { FileViewer, type FileTarget } from './viewer'

const openViewer = (target: FileTarget) => {
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
  return { sock, sent, onClose, view, client }
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
    const { sock, sent } = openViewer({ path: 'a.go' })
    served(sock, sent!.reqId)
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
    const { sock, sent } = openViewer({ path: 'a.go', line: 2 })
    served(sock, sent!.reqId)
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

  it('declines an image honestly, and stops the stream', async () => {
    const { sock, sent } = openViewer({ path: 'shot.png' })
    served(sock, sent!.reqId, { mime: 'image/png', kind: 'image', size: 184320 })
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByRole('alert').textContent).toMatch(/image/i)
    expect(sock.control().find((m) => m.type === 'cancel')).toMatchObject({ type: 'cancel', ref: 7 })
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
