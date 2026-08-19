import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FlueClientProvider } from '@/client/provider'
import { fakeClient, type FakeSocket } from '@/testing/socket'
import { FileContents, type FileTarget } from './contents'

const openContents = (target: FileTarget, header?: Parameters<typeof FileContents>[0]['header']) => {
  // jsdom lays nothing out, and the virtualizer windows on measured boxes —
  // the same pretend geometry viewer.test.tsx uses.
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
  const { client, last } = fakeClient()
  client.connect()
  const sock = last()
  act(() => sock.open())
  const view = render(
    <FlueClientProvider client={client}>
      <FileContents sessionId="s1" target={target} header={header} />
    </FlueClientProvider>,
  )
  const sent = sock.control().find((m) => m.type === 'read')
  return { sock, sent, view, client }
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

describe('FileContents', () => {
  it('asks for the file and says so while opening', () => {
    const { sent } = openContents({ path: 'a.go' })
    expect(sent).toMatchObject({ type: 'read', id: 's1', path: 'a.go' })
    expect(screen.getByRole('status').textContent).toMatch(/Opening/)
  })

  it('paints streamed chunks as they arrive, then finishes on eof', async () => {
    const { sock, sent } = openContents({ path: 'notes.txt' })
    served(sock, sent!.reqId, { path: '/home/k/notes.txt' })
    await flowed(sock, 'package main\n\nfunc main()')
    expect(screen.getByText('package main')).toBeTruthy()
    await act(async () => {
      sock.emitControl({ type: 'eof', ref: 7 })
      await new Promise((frame) => requestAnimationFrame(frame))
    })
    expect(screen.getByText('func main()')).toBeTruthy()
  })

  it('turns a refusal into words', () => {
    const { sock, sent } = openContents({ path: 'web/src/' })
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

  it('hands the header slot the resolved name, directory and size', () => {
    const { sock, sent } = openContents({ path: 'a.go' }, (view) => (
      <header>
        {view.base} in {view.dir} at {view.meta === null ? '' : String(view.meta.size)}
      </header>
    ))
    served(sock, sent!.reqId)
    expect(screen.getByRole('banner').textContent).toBe('a.go in /home/k/proj at 22')
  })
})
