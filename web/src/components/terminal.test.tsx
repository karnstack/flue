import { StrictMode, type ReactNode } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FlueClientProvider } from '@/client/provider'
import type { SessionInfo } from '@/client/protocol'
import { GUTTER_PX } from '@/lib/geometry'
import { createFakeEmulator, type FakeEmulator } from '@/testing/emulator'
import { attached, fakeClient, sizeChanged, type FakeSocket } from '@/testing/socket'
import { Terminal, TERMINAL_SHORTCUT_HINT } from './terminal'

/**
 * One emulator per mount, all of them kept.
 *
 * Kept rather than replaced because StrictMode builds two, and "the second one
 * is the live one" is a property worth being able to assert rather than assume.
 */
function emulators() {
  const built: FakeEmulator[] = []
  const create = (opts: { cols?: number; rows?: number }) => {
    const em = createFakeEmulator(opts)
    built.push(em)
    return em
  }
  return { built, create, live: () => built[built.length - 1]! }
}

/** Pretend every element is this big. Only the pane is measured. */
function paneOf(width: number, height: number) {
  return vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockReturnValue({ width, height, top: 0, left: 0, right: width, bottom: height } as DOMRect)
}

/**
 * A ResizeObserver that can be made to fire.
 *
 * The global stub in test-setup.ts never invokes its callback, so with it the
 * component's `observer.observe(pane)` could be deleted outright and every
 * test would stay green — the layout would still run off the `attached` path.
 * This makes that wiring load-bearing: `fire()` reaches the component only if
 * the pane really was observed.
 *
 * Install before mounting.
 */
function resizeObservers() {
  const live: Array<{ cb: () => void; targets: Element[] }> = []
  vi.stubGlobal(
    'ResizeObserver',
    class {
      targets: Element[] = []
      constructor(readonly cb: () => void) {
        live.push(this)
      }
      observe(el: Element) {
        this.targets.push(el)
      }
      unobserve() {}
      disconnect() {
        this.targets = []
      }
    },
  )
  return {
    watching: (el: Element) => live.some((o) => o.targets.includes(el)),
    fire: () => {
      for (const o of live) if (o.targets.length) o.cb()
    },
  }
}

const pane = () => document.querySelector<HTMLElement>('[data-flue-mode]')!
const inset = () => document.querySelector<HTMLElement>('[data-flue-inset]')!
const surfaceEl = () => document.querySelector<HTMLElement>('[data-flue-surface]')!

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.title = 'flue'
  localStorage.clear()
})

/**
 * Mount a terminal into a client that is already connected.
 *
 * The two-pass render is load-bearing, not ceremony. A terminal reached by
 * navigating — which is every way a user reaches one after the first paint —
 * mounts into a socket that is already open, and several of the behaviours
 * below only exist in that shape. Rendering the whole tree at once instead
 * would put every mount effect ahead of the socket opening.
 */
function mountTerminal(children: (em: ReturnType<typeof emulators>) => ReactNode) {
  const { client, sockets } = fakeClient()
  const em = emulators()
  const view = render(<FlueClientProvider client={client}>{null}</FlueClientProvider>)
  const sock = sockets[0]!
  act(() => sock.open())

  const show = (node: ReactNode) =>
    view.rerender(<FlueClientProvider client={client}>{node}</FlueClientProvider>)

  act(() => show(children(em)))
  return { client, sockets, sock, em, view, show }
}

describe('Terminal', () => {
  let live: FakeSocket

  beforeEach(() => {
    document.title = 'flue'
  })

  it('attaches to its own session on mount', () => {
    const { sock } = mountTerminal((em) => (
      <Terminal sessionId="s1" createEmulator={em.create} />
    ))
    live = sock

    expect(live.ofType('attach')).toEqual([{ type: 'attach', id: 's1', lastSeq: 0, reqId: 1 }])
  })

  it('writes the output for its own ref and nobody else’s', () => {
    const { sock, em } = mountTerminal((e) => <Terminal sessionId="s1" createEmulator={e.create} />)

    act(() => sock.emitControl(attached({ ref: 2, id: 's1' })))
    act(() => sock.emitOutput(2, 'mine'))
    act(() => sock.emitOutput(3, 'someone else’s'))

    expect(em.live().text()).toBe('mine')
  })

  it('resets the screen before a truncated snapshot', () => {
    // `truncated` means the offset asked for had already been evicted, so what
    // follows is a fresh snapshot rather than a continuation. Writing it on
    // top of what is already there would interleave two different pasts.
    const { sock, em } = mountTerminal((e) => <Terminal sessionId="s1" createEmulator={e.create} />)

    act(() => sock.emitControl(attached({ ref: 1, id: 's1', truncated: true })))
    act(() => sock.emitOutput(1, 'fresh'))

    // A full reset, not an erase-in-display: the snapshot arrives with no
    // assumptions about scroll region, character set, or attributes, and
    // ESC[2J leaves every one of those where the evicted output left them.
    expect(em.live().text()).toBe('\x1bcfresh')
  })

  it('does not reset when the attach is an ordinary continuation', () => {
    const { sock, em } = mountTerminal((e) => <Terminal sessionId="s1" createEmulator={e.create} />)

    act(() => sock.emitControl(attached({ ref: 1, id: 's1', truncated: false, seq: 40 })))
    act(() => sock.emitOutput(1, 'more'))

    expect(em.live().text()).toBe('more')
  })

  it('ignores an attached for a session it is not showing', () => {
    // One client serves the whole tab, so every listener sees every reply.
    const { sock, em } = mountTerminal((e) => <Terminal sessionId="s1" createEmulator={e.create} />)

    act(() => sock.emitControl(attached({ ref: 7, id: 'other', cols: 200, rows: 60 })))

    expect(em.live().cols).toBe(80)
    act(() => sock.emitOutput(7, 'not mine'))
    expect(em.live().text()).toBe('')
  })

  it('sends what the user types to its own ref', () => {
    const { sock, em } = mountTerminal((e) => <Terminal sessionId="s1" createEmulator={e.create} />)
    act(() => sock.emitControl(attached({ ref: 4, id: 's1' })))

    act(() => em.live().send('ls\r'))

    expect(sock.input()).toEqual([{ ref: 4, text: 'ls\r' }])
  })

  it('drops keystrokes typed before the attach comes back', () => {
    // The client refuses input on an unknown ref anyway; the point is that the
    // view does not invent one, which a `?? 0` would.
    const { sock, em } = mountTerminal((e) => <Terminal sessionId="s1" createEmulator={e.create} />)

    act(() => em.live().send('rm -rf /\r'))

    expect(sock.input()).toEqual([])
  })

  it('takes its dimensions from the daemon rather than guessing', () => {
    const { sock, em } = mountTerminal((e) => <Terminal sessionId="s1" createEmulator={e.create} />)

    act(() => sock.emitControl(attached({ ref: 1, id: 's1', cols: 132, rows: 43 })))

    expect(em.live().cols).toBe(132)
    expect(em.live().rows).toBe(43)
  })

  it('follows a size change broadcast by another client', () => {
    const { sock, em } = mountTerminal((e) => <Terminal sessionId="s1" createEmulator={e.create} />)
    act(() => sock.emitControl(attached({ ref: 1, id: 's1', primary: false })))

    act(() => sock.emitControl(sizeChanged({ ref: 1, cols: 100, rows: 30, primary: false })))

    expect(em.live().cols).toBe(100)
    expect(em.live().rows).toBe(30)
  })

  it('detaches on unmount', () => {
    const { sock, em, show } = mountTerminal((e) => (
      <Terminal sessionId="s1" createEmulator={e.create} />
    ))
    act(() => sock.emitControl(attached({ ref: 5, id: 's1' })))

    act(() => show(null))

    expect(sock.ofType('detach')).toEqual([{ type: 'detach', ref: 5 }])
    expect(em.live().disposals).toBe(1)
  })

  it('retires the session by name when it unmounts inside the attach round-trip', async () => {
    // There is no ref to detach yet. Without forget, the reattach plan asks
    // for this session on every reconnect for the life of the tab, and nothing
    // is watching it.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const { sock, sockets, show } = mountTerminal((e) => (
      <Terminal sessionId="s1" createEmulator={e.create} />
    ))

    act(() => show(null))
    act(() => sock.close())
    await act(() => vi.advanceTimersByTimeAsync(125))
    act(() => sockets[1]!.open())

    expect(sockets[1]!.ofType('attach')).toEqual([])
    vi.useRealTimers()
  })

  it('leaves exactly one attachment behind a StrictMode double-mount', () => {
    // React runs every mount effect twice in development: mount, clean up,
    // mount. On an already-open socket that is attach / forget / attach inside
    // one round-trip, and the daemon answers both. Adopting both leaves the
    // first ref attached — and primary — with nobody behind it until the
    // socket drops, and delivers `attached` twice to one view.
    const { sock, em } = mountTerminal((e) => (
      <StrictMode>
        <Terminal sessionId="s1" createEmulator={e.create} />
      </StrictMode>
    ))

    expect(em.built).toHaveLength(2)
    expect(sock.ofType('attach')).toHaveLength(2)

    act(() => {
      sock.emitControl(attached({ ref: 1, id: 's1', cols: 111, rows: 11, reqId: 1 }))
      sock.emitControl(attached({ ref: 2, id: 's1', cols: 222, rows: 22, reqId: 2 }))
    })

    expect(sock.ofType('detach')).toEqual([{ type: 'detach', ref: 1 }])
    // The live view adopted the second reply and only the second: taking both
    // would leave it sized to whichever arrived last with no way to tell.
    expect(em.live().cols).toBe(222)
    expect(em.built[0]!.disposals).toBe(1)

    act(() => sock.emitOutput(2, 'hello'))
    expect(em.live().text()).toBe('hello')
  })

  it('reports a reconnect, then clears it when the session comes back', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const { sock, sockets } = mountTerminal((e) => (
      <Terminal sessionId="s1" createEmulator={e.create} />
    ))
    act(() => sock.emitControl(attached({ ref: 1, id: 's1' })))
    expect(screen.queryByRole('status')).toBeNull()

    act(() => sock.close())
    expect(screen.getByRole('status').textContent).toContain('Reconnecting')

    await act(() => vi.advanceTimersByTimeAsync(125))
    act(() => sockets[1]!.open())
    // Still not live: the socket is up but the attach is a round-trip away,
    // and the screen on display is whatever was there before the outage.
    expect(screen.getByRole('status').textContent).toContain('Reconnecting')

    act(() => sockets[1]!.emitControl(attached({ ref: 1, id: 's1' })))
    expect(screen.queryByRole('status')).toBeNull()
    vi.useRealTimers()
  })

  it('reports the process exiting, with its code, once', () => {
    const { sock, em } = mountTerminal((e) => <Terminal sessionId="s1" createEmulator={e.create} />)
    act(() => sock.emitControl(attached({ ref: 1, id: 's1' })))

    act(() => sock.emitControl({ type: 'exit', ref: 1, code: 130 }))

    expect(screen.getByRole('status').textContent).toContain('exited')
    expect(em.live().text()).toContain('[process exited: 130]')
  })

  it('ignores an exit for another session', () => {
    const { sock } = mountTerminal((e) => <Terminal sessionId="s1" createEmulator={e.create} />)
    act(() => sock.emitControl(attached({ ref: 1, id: 's1' })))

    act(() => sock.emitControl({ type: 'exit', ref: 9, code: 1 }))

    expect(screen.queryByRole('status')).toBeNull()
  })

  it('shows gone when the daemon answers its attach with not_found', () => {
    const { sock } = mountTerminal((em) => <Terminal sessionId="s1" createEmulator={em.create} />)

    act(() =>
      sock.emitControl({ type: 'error', code: 'not_found', msg: 'no such session', reqId: 1 }),
    )

    expect(screen.getByRole('status').textContent).toContain('gone')
  })

  it('ignores a not_found that answers someone else’s attach', () => {
    // Exactness is the point of the reqId: before it, any not_found arriving
    // while this view held no ref was assumed to be its own.
    const { sock } = mountTerminal((em) => <Terminal sessionId="s1" createEmulator={em.create} />)

    act(() =>
      sock.emitControl({ type: 'error', code: 'not_found', msg: 'no such session', reqId: 99 }),
    )

    expect(screen.queryByRole('status')?.textContent ?? '').not.toContain('gone')
  })

  it('gives up on a session the restarted daemon has never heard of', async () => {
    // The daemon restarting is the whole reason this path exists, and it is
    // the one shape where the view already holds a ref: it went live, the
    // socket dropped, the client replayed its attach, and the fresh daemon
    // answers not_found because its registry is empty. A ref kept from the
    // previous connection would make the view ignore that answer, and since
    // nothing else ever clears it, every later reconnect would repeat it —
    // "Reconnecting…" until the tab is reloaded by hand.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const { sock, sockets } = mountTerminal((e) => (
      <Terminal sessionId="s1" createEmulator={e.create} />
    ))
    act(() => sock.emitControl(attached({ ref: 1, id: 's1' })))
    expect(screen.queryByRole('status')).toBeNull()

    act(() => sock.close())
    await act(() => vi.advanceTimersByTimeAsync(125))
    act(() => sockets[1]!.open())
    expect(sockets[1]!.ofType('attach')).toEqual([
      { type: 'attach', id: 's1', lastSeq: 0, reqId: 2 },
    ])

    act(() =>
      sockets[1]!.emitControl({
        type: 'error',
        code: 'not_found',
        msg: 'no such session',
        reqId: 2,
      }),
    )
    expect(screen.getByRole('status').textContent).toContain('gone')

    // And it stays given up on: the plan no longer names the session, so the
    // next reconnect asks for nothing at all.
    act(() => sockets[1]!.close())
    await act(() => vi.advanceTimersByTimeAsync(125))
    act(() => sockets[2]!.open())
    expect(sockets[2]!.ofType('attach')).toEqual([])
    vi.useRealTimers()
  })

  it('goes on saying the session is gone through a reconnect', async () => {
    // Nothing is coming back, so walking the pill to "Reconnecting…" would
    // promise that waiting helps.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const { sock, sockets } = mountTerminal((e) => (
      <Terminal sessionId="ghost" createEmulator={e.create} />
    ))
    act(() =>
      sock.emitControl({ type: 'error', code: 'not_found', msg: 'no such session', reqId: 1 }),
    )

    act(() => sock.close())
    await act(() => vi.advanceTimersByTimeAsync(125))
    act(() => sockets[1]!.open())

    expect(screen.getByRole('status').textContent).toContain('gone')
    vi.useRealTimers()
  })

  it('goes on reporting the exit through a reconnect', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const { sock, sockets } = mountTerminal((e) => (
      <Terminal sessionId="s1" createEmulator={e.create} />
    ))
    act(() => sock.emitControl(attached({ ref: 1, id: 's1' })))
    act(() => sock.emitControl({ type: 'exit', ref: 1, code: 0 }))

    act(() => sock.close())
    await act(() => vi.advanceTimersByTimeAsync(125))
    act(() => sockets[1]!.open())

    expect(screen.getByRole('status').textContent).toContain('exited')
    vi.useRealTimers()
  })

  it('puts the keyboard into the terminal without waiting for a click', () => {
    // A session *is* the tab. Having to click a full-bleed black rectangle
    // before it accepts a keystroke is the kind of thing that reads as broken.
    const { em } = mountTerminal((e) => <Terminal sessionId="s1" createEmulator={e.create} />)
    expect(em.live().focusCalls).toBe(1)
  })

  it('names the tab after the session, and hands the name back on unmount', () => {
    const { sock, show } = mountTerminal((e) => (
      <Terminal sessionId="s1" createEmulator={e.create} />
    ))

    act(() => sock.emitControl(attached({ ref: 1, id: 's1', title: 'vim README.md' })))
    expect(document.title).toBe('vim README.md')

    act(() => show(null))
    expect(document.title).toBe('flue')
  })

  describe('the sizing policy', () => {
    it('asks the daemon for the cells its own pane holds, when primary', async () => {
      // Driven through the ResizeObserver rather than a window event, because
      // that is the only thing the component listens to — and because firing
      // it is what proves the pane was observed at all.
      const observers = resizeObservers()
      const box = paneOf(800 + GUTTER_PX, 408)
      const { sock, em } = mountTerminal((e) => (
        <Terminal sessionId="s1" createEmulator={e.create} />
      ))
      // 80x24 rendered at 800x408 puts a cell at 10 x 17.
      em.live().measured = { width: 800, height: 408 }

      act(() => sock.emitControl(attached({ ref: 1, id: 's1', cols: 80, rows: 24, primary: true })))
      // The observed element is the inset box, not the pane: the pane carries
      // the terminal's margin and cells are fit to what sits inside it.
      expect(observers.watching(inset())).toBe(true)

      // The pane now holds twice the height, so 48 rows.
      box.mockReturnValue({ width: 800 + GUTTER_PX, height: 816 } as DOMRect)
      act(() => observers.fire())

      await waitFor(() =>
        expect(sock.ofType('resize')).toContainEqual({
          type: 'resize',
          ref: 1,
          cols: 80,
          rows: 48,
          primary: true,
        }),
      )
    })

    it('re-fits when only the pane changed, with nothing arriving from the daemon', async () => {
      // The observer is the sole path here: no attach, no size broadcast, no
      // navigation. A window that is dragged narrower has to reach the pty.
      const observers = resizeObservers()
      const box = paneOf(800 + GUTTER_PX, 408)
      const { sock, em } = mountTerminal((e) => (
        <Terminal sessionId="s1" createEmulator={e.create} />
      ))
      em.live().measured = { width: 800, height: 408 }
      act(() => sock.emitControl(attached({ ref: 1, id: 's1', cols: 80, rows: 24, primary: true })))
      await new Promise((r) => setTimeout(r, 40))
      expect(sock.ofType('resize')).toEqual([])

      box.mockReturnValue({ width: 400 + GUTTER_PX, height: 408 } as DOMRect)
      act(() => observers.fire())

      await waitFor(() =>
        expect(sock.ofType('resize')).toContainEqual({
          type: 'resize',
          ref: 1,
          cols: 40,
          rows: 24,
          primary: true,
        }),
      )
    })

    it('asks for nothing when the dimensions already fit', async () => {
      paneOf(800 + GUTTER_PX, 408)
      const { sock, em } = mountTerminal((e) => (
        <Terminal sessionId="s1" createEmulator={e.create} />
      ))
      em.live().measured = { width: 800, height: 408 }

      act(() => sock.emitControl(attached({ ref: 1, id: 's1', cols: 80, rows: 24, primary: true })))
      await new Promise((r) => setTimeout(r, 40))

      expect(sock.ofType('resize')).toEqual([])
    })

    it('scales its surface instead of touching the pty, when not primary', async () => {
      // The whole point of the policy: a phone at 400px must not drag a
      // laptop's terminal down to 40 columns.
      paneOf(400, 400)
      const { sock, em } = mountTerminal((e) => (
        <Terminal sessionId="s1" createEmulator={e.create} />
      ))
      em.live().measured = { width: 1600, height: 800 }

      act(() =>
        sock.emitControl(attached({ ref: 1, id: 's1', cols: 160, rows: 47, primary: false })),
      )

      const surface = document.querySelector<HTMLElement>('[data-flue-surface]')!
      // The gutter is laid out with the screen, so it is scaled with it too.
      await waitFor(() =>
        expect(parseFloat(surface.style.scale)).toBeCloseTo(400 / (1600 + GUTTER_PX), 4),
      )
      expect(surface.style.width).toBe(`${1600 + GUTTER_PX}px`)
      expect(surface.style.height).toBe('800px')
      expect(sock.ofType('resize')).toEqual([])
    })

    it('gives the surface back to the pane when it is promoted to primary', async () => {
      // The daemon promotes the most recently active client when the primary
      // leaves, and says so with a sizeChanged. Nothing else will ever ask for
      // this client's dimensions, so it has to act on that.
      paneOf(800 + GUTTER_PX, 408)
      const { sock, em } = mountTerminal((e) => (
        <Terminal sessionId="s1" createEmulator={e.create} />
      ))
      // Twice the pane's height, so height is what binds: 0.5 exactly.
      em.live().measured = { width: 1600, height: 816 }

      act(() =>
        sock.emitControl(attached({ ref: 1, id: 's1', cols: 160, rows: 48, primary: false })),
      )
      const surface = document.querySelector<HTMLElement>('[data-flue-surface]')!
      await waitFor(() => expect(surface.style.scale).toBe('0.5'))

      act(() =>
        sock.emitControl(sizeChanged({ ref: 1, cols: 160, rows: 48, primary: true })),
      )

      await waitFor(() => expect(surface.style.scale).toBe(''))
      expect(surface.style.width).toBe('')
      await waitFor(() =>
        expect(sock.ofType('resize')).toContainEqual({
          type: 'resize',
          ref: 1,
          cols: 80,
          rows: 24,
          primary: true,
        }),
      )
    })

    it('asks for nothing at all when nothing has been laid out', async () => {
      // jsdom, and the first frame in a real browser. A zero-sized measurement
      // divided into a pane is an Infinity, and the daemon would be asked for
      // a 65535-column pty.
      paneOf(800, 400)
      const { sock, em } = mountTerminal((e) => (
        <Terminal sessionId="s1" createEmulator={e.create} />
      ))
      em.live().measured = null

      act(() => sock.emitControl(attached({ ref: 1, id: 's1', primary: true })))
      await new Promise((r) => setTimeout(r, 40))

      expect(sock.ofType('resize')).toEqual([])
    })
  })

  describe('keyboard modes', () => {
    it('starts in tab mode, so the browser keeps its own shortcuts', () => {
      mountTerminal((e) => <Terminal sessionId="s1" createEmulator={e.create} />)
      expect(pane().getAttribute('data-flue-mode')).toBe('tab')
    })

    it('offers the shortcut where there is already chrome to put it on', () => {
      mountTerminal((e) => <Terminal sessionId="s1" createEmulator={e.create} />)
      expect(screen.getByRole('status').textContent).toContain(TERMINAL_SHORTCUT_HINT)
    })

    it('enters focus mode on the shortcut, and takes the key before the terminal sees it', async () => {
      const el = document.createElement('div')
      const lock = vi.fn().mockResolvedValue(undefined)
      Object.defineProperty(navigator, 'keyboard', {
        value: { lock, unlock: vi.fn() },
        configurable: true,
      })
      Object.defineProperty(document, 'fullscreenElement', { value: el, configurable: true })
      const request = vi.fn().mockResolvedValue(undefined)
      HTMLElement.prototype.requestFullscreen = request

      const { sock } = mountTerminal((e) => <Terminal sessionId="s1" createEmulator={e.create} />)
      act(() => sock.emitControl(attached({ ref: 1, id: 's1' })))

      // Stands in for xterm's own handler, which lives on a helper textarea
      // inside the surface. Dispatching at that depth is what makes this
      // measure anything: a bubble-phase listener on window would run *after*
      // this one, and the shell would already have received a carriage return.
      // A fake emulator has no keyboard wiring of its own, so asserting on
      // what reached the socket would pass either way.
      const downstream = vi.fn()
      surfaceEl().addEventListener('keydown', downstream)

      await act(async () => {
        surfaceEl().dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            ctrlKey: true,
            shiftKey: true,
            bubbles: true,
          }),
        )
      })

      expect(request).toHaveBeenCalled()
      expect(lock).toHaveBeenCalled()
      await waitFor(() => expect(pane().getAttribute('data-flue-mode')).toBe('focus'))
      expect(downstream).not.toHaveBeenCalled()

      Object.defineProperty(navigator, 'keyboard', { value: undefined, configurable: true })
      Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true })
    })

    it('lets every other key through to the terminal', async () => {
      // The other half of the assertion above: capture-and-stop must apply to
      // the one shortcut and nothing else, or the terminal receives no input.
      const downstream = vi.fn()
      const { sock } = mountTerminal((e) => <Terminal sessionId="s1" createEmulator={e.create} />)
      act(() => sock.emitControl(attached({ ref: 1, id: 's1' })))
      surfaceEl().addEventListener('keydown', downstream)

      await act(async () => {
        surfaceEl().dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
        surfaceEl().dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        )
      })

      expect(downstream).toHaveBeenCalledTimes(2)
    })

    it('leaves an ordinary Enter alone', async () => {
      const request = vi.fn().mockResolvedValue(undefined)
      HTMLElement.prototype.requestFullscreen = request
      mountTerminal((e) => <Terminal sessionId="s1" createEmulator={e.create} />)

      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true }))
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }))
      })

      expect(request).not.toHaveBeenCalled()
    })
  })

  describe('theming', () => {
    it('builds the emulator with a palette rather than colouring it afterwards', () => {
      // A terminal that mounts in xterm's own colours and is repainted a frame
      // later flashes the wrong background across the whole viewport.
      const { em } = mountTerminal((e) => <Terminal sessionId="s1" createEmulator={e.create} />)
      expect(em.live().themes[0]?.background).toBeTruthy()
    })

    it('repaints when the OS switches appearance', () => {
      const listeners: Array<() => void> = []
      vi.spyOn(globalThis, 'matchMedia').mockImplementation(
        (query: string) =>
          ({
            matches: query.includes('dark'),
            media: query,
            addEventListener: (_: string, cb: () => void) => listeners.push(cb),
            removeEventListener: () => {},
            addListener: () => {},
            removeListener: () => {},
            dispatchEvent: () => false,
            onchange: null,
          }) as unknown as MediaQueryList,
      )

      const { em } = mountTerminal((e) => <Terminal sessionId="s1" createEmulator={e.create} />)
      const before = em.live().themes.length
      act(() => listeners.forEach((cb) => cb()))

      expect(em.live().themes.length).toBeGreaterThan(before)
    })
  })

  describe('the replay mute gate', () => {
    it('opens immediately on a fresh spawn, where head equals seq', () => {
      // Gating on "the first output frame" would never open here: the
      // daemon omits that frame entirely when the backlog is empty.
      const { sock, em } = mountTerminal((e) => (
        <Terminal sessionId="s1" createEmulator={e.create} />
      ))
      act(() => sock.emitControl(attached({ ref: 1, id: 's1', seq: 0 }))) // head defaults to seq

      act(() => em.live().send('ls\r'))

      expect(sock.input()).toEqual([{ ref: 1, text: 'ls\r' }])
    })

    it('mutes emulator replies while the backlog replays', () => {
      // The ring holds the shell's own DA/DECRQM/OSC-11 probe replies, and
      // xterm answers them again as they are written. Reproduced 4/4 before
      // the gate: reload, reopen, route navigation, second mirror tab.
      const { sock, em } = mountTerminal((e) => (
        <Terminal sessionId="s1" createEmulator={e.create} />
      ))
      act(() => sock.emitControl(attached({ ref: 1, id: 's1', seq: 0, head: 10 })))

      act(() => sock.emitOutput(1, '123456')) // 6 of 10 backlog bytes
      act(() => em.live().send('\x1b[?1;2c')) // xterm answering a replayed DA probe

      expect(sock.input()).toEqual([])

      act(() => sock.emitOutput(1, '7890')) // backlog complete: consumed == head
      act(() => em.live().send('ls\r'))

      expect(sock.input()).toEqual([{ ref: 1, text: 'ls\r' }])
    })

    it('opens at exactly head, not one byte later', () => {
      const { sock, em } = mountTerminal((e) => (
        <Terminal sessionId="s1" createEmulator={e.create} />
      ))
      act(() => sock.emitControl(attached({ ref: 1, id: 's1', seq: 0, head: 4 })))
      act(() => sock.emitOutput(1, 'abcd'))

      act(() => em.live().send('x'))

      expect(sock.input()).toEqual([{ ref: 1, text: 'x' }])
    })

    it('re-arms with the attachment after a reconnect mid-backlog', async () => {
      // The gate is per-attach state, not per-connection: a socket dying
      // mid-backlog resets it with the next attached, whose head names the
      // next replay's end.
      vi.useFakeTimers()
      vi.spyOn(Math, 'random').mockReturnValue(0)
      const { client, sockets, sock, em } = mountTerminal((e) => (
        <Terminal sessionId="s1" createEmulator={e.create} />
      ))
      act(() => sock.emitControl(attached({ ref: 1, id: 's1', seq: 0, head: 6 })))
      act(() => sock.emitOutput(1, 'abc')) // 3 of 6, then the socket dies

      act(() => sock.close())
      await act(() => vi.advanceTimersByTimeAsync(125))
      act(() => sockets[1]!.open())
      // The reattach resumes at 3; the daemon replays 3..8 as backlog.
      act(() => sockets[1]!.emitControl(attached({ ref: 1, id: 's1', seq: 3, head: 8 })))

      act(() => em.live().send('\x1b]11;rgb:0000/0000/0000\x07')) // OSC 11 reply to a replayed probe
      expect(sockets[1]!.input()).toEqual([])

      act(() => sockets[1]!.emitOutput(1, 'defgh')) // 3 + 5 = 8 == head
      act(() => em.live().send('ok'))
      expect(sockets[1]!.input()).toEqual([{ ref: 1, text: 'ok' }])
      void client
      vi.useRealTimers()
    })

    it('holds the gate while a counted frame is still being parsed', () => {
      // Real xterm parses writes on a later tick and emits its probe answers
      // *during* that parse, before the write's done callback fires. On
      // localhost the whole backlog commonly arrives in one frame before the
      // first parse tick, so a counter advanced at frame arrival would open
      // the gate with the probe replies still to come. The seam explicitly
      // permits an asynchronous done, so this fake defers it by hand.
      const pending: Array<() => void> = []
      const { sock, em } = mountTerminal((e) => (
        <Terminal
          sessionId="s1"
          createEmulator={(opts) => {
            const inner = e.create(opts)
            const parse = inner.write.bind(inner)
            inner.write = (bytes, done) => {
              parse(bytes)
              if (done) pending.push(done)
            }
            return inner
          }}
        />
      ))
      act(() => sock.emitControl(attached({ ref: 1, id: 's1', seq: 0, head: 4 })))

      act(() => sock.emitOutput(1, 'abcd')) // the whole backlog, one frame, done pending
      act(() => em.live().send('\x1b[?1;2c')) // the DA answer, emitted mid-parse

      expect(sock.input()).toEqual([]) // done has not fired, so the gate holds

      act(() => pending.forEach((done) => done())) // the parser catches up
      act(() => em.live().send('ls\r'))
      expect(sock.input()).toEqual([{ ref: 1, text: 'ls\r' }])
    })

    it('ignores a stale done from the previous attachment', async () => {
      // A done callback from a write enqueued under attachment 1 can fire
      // after attachment 2 has reseeded the counters: the emulator and the
      // effect survive a reconnect, and nothing recalls a callback already
      // handed to the parser. Those bytes are accounted for — the reattach's
      // seq names where they ended — so counting them again would open the
      // new gate early, mid-backlog. The ref cannot carry the check: the
      // daemon numbers refs from 1 again on every connection, so the same
      // value plausibly names both attachments, as it does here.
      vi.useFakeTimers()
      vi.spyOn(Math, 'random').mockReturnValue(0)
      const pending: Array<() => void> = []
      const { sockets, sock, em } = mountTerminal((e) => (
        <Terminal
          sessionId="s1"
          createEmulator={(opts) => {
            const inner = e.create(opts)
            const parse = inner.write.bind(inner)
            inner.write = (bytes, done) => {
              parse(bytes)
              if (done) pending.push(done)
            }
            return inner
          }}
        />
      ))
      act(() => sock.emitControl(attached({ ref: 1, id: 's1', seq: 0, head: 6 })))
      act(() => sock.emitOutput(1, 'abc')) // 3 bytes written, done still pending...

      act(() => sock.close()) // ...when the socket dies
      await act(() => vi.advanceTimersByTimeAsync(125))
      act(() => sockets[1]!.open())
      act(() => sockets[1]!.emitControl(attached({ ref: 1, id: 's1', seq: 3, head: 8 })))

      act(() => sockets[1]!.emitOutput(1, 'de')) // 2 of the 5 backlog bytes
      act(() => pending.splice(0).forEach((done) => done())) // the stale done fires among them

      act(() => em.live().send('\x1b[?1;2c')) // a DA answer to a replayed probe
      expect(sockets[1]!.input()).toEqual([]) // 3 + 2 < 8: still muted

      act(() => sockets[1]!.emitOutput(1, 'fgh')) // 3 + 5 = 8 == head
      act(() => pending.splice(0).forEach((done) => done()))
      act(() => em.live().send('ok'))
      expect(sockets[1]!.input()).toEqual([{ ref: 1, text: 'ok' }])
      vi.useRealTimers()
    })

    it('mutes a second mirror tab replaying the full ring', () => {
      // The second tab attaches with lastSeq 0 and receives the whole ring
      // as backlog — the fourth reproduction of the bug, same gate.
      const { sock, em } = mountTerminal((e) => (
        <Terminal sessionId="s1" createEmulator={e.create} />
      ))
      act(() => sock.emitControl(attached({ ref: 2, id: 's1', seq: 0, head: 5, primary: false })))
      act(() => sock.emitOutput(2, 'ring!'))
      act(() => em.live().send('live'))

      expect(sock.input()).toEqual([{ ref: 2, text: 'live' }])
    })
  })
})

/** A complete SessionInfo, so a caller only names what it cares about. */
function session(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 's1',
    title: '',
    cwd: '/home/karn/code',
    cmd: [],
    state: 'running',
    exitCode: 0,
    cols: 80,
    rows: 24,
    lastActive: '2026-08-05T00:00:00Z',
    ...over,
  }
}

describe('the exit overlay', () => {
  it('appears when the shell exits, naming the code', () => {
    const { sock } = mountTerminal((em) => <Terminal sessionId="s1" createEmulator={em.create} />)

    act(() => sock.emitControl(attached({ ref: 1, id: 's1' })))
    act(() => sock.emitControl({ type: 'exit', ref: 1, code: 130 }))

    const card = screen.getByRole('alertdialog')
    expect(card.getAttribute('aria-label')).toBe('shell exited (130)')
    expect(card.textContent).toContain('(130)')
  })

  it('dims the terminal but leaves it in the tree, scrollback intact', () => {
    const { sock } = mountTerminal((em) => <Terminal sessionId="s1" createEmulator={em.create} />)

    act(() => sock.emitControl(attached({ ref: 1, id: 's1' })))
    expect(inset().className).not.toContain('opacity-60')

    act(() => sock.emitControl({ type: 'exit', ref: 1, code: 0 }))
    expect(inset().className).toContain('opacity-60')
    // The wrapper must not eat events meant for the scrollback under it.
    expect(screen.getByRole('alertdialog').parentElement!.className).toContain('pointer-events-none')
  })

  it('Restart spawns in the dead session’s directory, closes it, and hands over', () => {
    const onRestarted = vi.fn()
    const { sock } = mountTerminal((em) => (
      <Terminal sessionId="s1" createEmulator={em.create} onRestarted={onRestarted} />
    ))

    act(() => sock.emitControl(attached({ ref: 1, id: 's1' })))
    act(() => sock.emitControl({ type: 'sessions', sessions: [session()] }))
    act(() => sock.emitControl({ type: 'exit', ref: 1, code: 0 }))

    fireEvent.click(screen.getByRole('button', { name: 'Restart' }))
    const spawns = sock.ofType('spawn')
    expect(spawns).toHaveLength(1)
    expect(spawns[0]).toMatchObject({ cwd: '/home/karn/code', cols: 80, rows: 24 })

    // A second click while the first is unanswered must not start a second
    // shell.
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }))
    expect(sock.ofType('spawn')).toHaveLength(1)

    const reqId = spawns[0]!.reqId as number
    act(() => sock.emitControl(attached({ ref: 9, id: 's2', reqId })))

    // The new ref goes straight back — the next route attaches for itself.
    // Nothing is sent for the dead session: the exit already retired its ref
    // on both ends, and the daemon reaps it after ExitedRetention.
    expect(sock.ofType('detach')).toContainEqual({ type: 'detach', ref: 9 })
    expect(onRestarted).toHaveBeenCalledWith('s2')
  })

  it('Close just leaves — the daemon reaps an exited session on its own', () => {
    const onClosed = vi.fn()
    const { sock } = mountTerminal((em) => (
      <Terminal sessionId="s1" createEmulator={em.create} onClosed={onClosed} />
    ))

    act(() => sock.emitControl(attached({ ref: 1, id: 's1' })))
    act(() => sock.emitControl({ type: 'exit', ref: 1, code: 1 }))

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(sock.ofType('close')).toHaveLength(0)
    expect(onClosed).toHaveBeenCalled()
  })
})

describe('the session theme', () => {
  it('mounts with the theme the session chose before', () => {
    localStorage.setItem('flue:theme:s1', 'dracula')
    const { em } = mountTerminal((e) => <Terminal sessionId="s1" createEmulator={e.create} />)

    // The stored preset is the emulator's very first theme — applied at
    // construction, not corrected after a default-themed first paint.
    expect(em.live().themes[0]?.background).toBe('#282a36')
  })

  it('mounts with flue’s own palette when the session never chose', () => {
    const { em } = mountTerminal((e) => <Terminal sessionId="s1" createEmulator={e.create} />)
    // The harness's matchMedia reports light, so flue's light pair — the
    // point is that it is flue's own palette, not a preset's.
    expect(em.live().themes[0]?.background).toBe('#ffffff')
  })
})

describe('the new-session link', () => {
  it('carries the session’s directory and opens a new tab', () => {
    const { sock } = mountTerminal((em) => <Terminal sessionId="s1" createEmulator={em.create} />)

    // Asked for on mount: the list is where the cwd comes from.
    expect(sock.ofType('list')).toHaveLength(1)

    act(() =>
      sock.emitControl({ type: 'sessions', sessions: [session({ cwd: '/tmp/with space' })] }),
    )

    const link = screen.getByRole('link', { name: 'New session in this directory' })
    expect(link.getAttribute('href')).toBe(`/?cwd=${encodeURIComponent('/tmp/with space')}`)
    expect(link.getAttribute('target')).toBe('_blank')
  })
})
