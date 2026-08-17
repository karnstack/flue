import { beforeEach, describe, expect, it } from 'vitest'
import { trackVisualViewport, zoomedIn, type ViewportLike } from './viewport'

/**
 * A hand-cranked visualViewport double. fire() plays both handler slots, as a
 * browser does when the keyboard both resizes and slides the viewport; scroll()
 * plays only the scroll slot, which is the iOS focus case — the viewport slides
 * off the top of the page without changing size, and nothing but that slot's
 * wiring makes the pane follow.
 */
function fakeViewport(init: { height: number; offsetTop?: number; scale?: number }) {
  const vv = {
    height: init.height,
    offsetTop: init.offsetTop ?? 0,
    scale: init.scale ?? 1,
    onresize: null as ViewportLike['onresize'],
    onscroll: null as ViewportLike['onscroll'],
    fire() {
      vv.onresize?.(new Event('x'))
      vv.onscroll?.(new Event('x'))
    },
    scroll() {
      vv.onscroll?.(new Event('x'))
    },
  }
  return vv
}

describe('zoomedIn', () => {
  it('leaves a resting page alone, through the rounding browsers report at 1', () => {
    expect(zoomedIn(fakeViewport({ height: 700 }))).toBe(false)
    expect(zoomedIn(fakeViewport({ height: 700, scale: 1.0000001 }))).toBe(false)
  })

  it('answers for a page a pinch has magnified', () => {
    expect(zoomedIn(fakeViewport({ height: 350, scale: 2 }))).toBe(true)
  })

  it('says no where there is no viewport to ask, so nothing stands down', () => {
    expect(zoomedIn(null)).toBe(false)
    expect(zoomedIn(undefined)).toBe(false)
  })
})

describe('trackVisualViewport', () => {
  let pane: HTMLElement
  let surface: HTMLElement

  beforeEach(() => {
    pane = document.createElement('div')
    surface = document.createElement('div')
  })

  it('is a no-op without a viewport, as on browsers that lack one', () => {
    const dispose = trackVisualViewport({ pane, surface, viewport: null })
    expect(pane.getAttribute('style')).toBeNull()
    dispose()
  })

  it('pins the pane to the visual viewport height when the keyboard opens', () => {
    const vv = fakeViewport({ height: 700 })
    trackVisualViewport({ pane, surface, viewport: vv })
    expect(pane.style.height).toBe('700px')

    vv.height = 400 // keyboard up
    vv.fire()
    expect(pane.style.height).toBe('400px')
  })

  it('follows the viewport down the page when focusing scrolls it', () => {
    const vv = fakeViewport({ height: 400, offsetTop: 120 })
    trackVisualViewport({ pane, surface, viewport: vv })
    // The independent `translate` property, not the compound one whose name
    // no scanned source file may contain — see the note in viewport.ts.
    expect(pane.style.translate).toBe('0px 120px')
  })

  it('slides after a focus scroll that moves the viewport without resizing it', () => {
    const vv = fakeViewport({ height: 400 })
    trackVisualViewport({ pane, surface, viewport: vv })
    expect(pane.style.translate).toBe('0px 0px')

    // Only the scroll slot is played: on iOS, focusing an input scrolls the
    // visual viewport off the top of the page at an unchanged height, so the
    // resize slot never fires and the follow rides entirely on this wiring.
    vv.offsetTop = 90
    vv.scroll()
    expect(pane.style.translate).toBe('0px 90px')
  })

  it('releases the surface to the browser while pinch-zoomed', () => {
    const vv = fakeViewport({ height: 700 })
    const gestureArea = document.createElement('div')
    trackVisualViewport({ pane, surface, gestureArea, viewport: vv })

    vv.scale = 2
    vv.height = 350
    vv.fire()
    // One finger must pan the zoomed page — which takes this *and* the drag
    // handler's own zoomedIn bail-out in terminal.tsx, since releasing
    // touch-action alone leaves its preventDefault() cancelling the pan. And
    // a zoom is not a layout change: the pane keeps its unzoomed size, so the
    // pty never refits on a pinch.
    expect(surface.style.touchAction).toBe('auto')
    expect(gestureArea.style.touchAction).toBe('auto')
    expect(pane.style.height).toBe('700px')

    vv.scale = 1
    vv.height = 700
    vv.fire()
    expect(surface.style.touchAction).toBe('')
    expect(gestureArea.style.touchAction).toBe('')
    expect(pane.style.height).toBe('700px')
  })

  it('clears everything it set on dispose', () => {
    const vv = fakeViewport({ height: 500, offsetTop: 40 })
    const dispose = trackVisualViewport({ pane, surface, viewport: vv })
    dispose()
    expect(pane.getAttribute('style')).toBe('')
    expect(surface.style.touchAction).toBe('')
    expect(vv.onresize).toBeNull()
    expect(vv.onscroll).toBeNull()

    vv.height = 300
    vv.fire() // a dead handler set would throw or restyle; neither may happen
    expect(pane.style.height).toBe('')
  })

  it('leaves the slots empty when every tracker is gone, in any dispose order', () => {
    // The failure this pins down: A then B install, A disposes first (its
    // slot check fails, so it restores nothing), then B disposes and puts
    // back the handler it captured — A's, whose tracker is already dead. The
    // resurrected closure would keep restyling A's detached pane on every
    // keyboard move, and nothing live would own the slot.
    const vv = fakeViewport({ height: 700 })
    const paneB = document.createElement('div')
    const surfaceB = document.createElement('div')
    const disposeA = trackVisualViewport({ pane, surface, viewport: vv })
    const disposeB = trackVisualViewport({ pane: paneB, surface: surfaceB, viewport: vv })

    disposeA()
    disposeB()
    expect(vv.onresize).toBeNull()
    expect(vv.onscroll).toBeNull()

    vv.height = 400
    vv.fire()
    expect(pane.style.height).toBe('')
    expect(paneB.style.height).toBe('')
  })

  it('hands the slot to the survivor when the top and a middle tracker dispose', () => {
    // Three panes overlap, the middle then the top go away: the slot must
    // fall to the one still alive — not to the middle one's dead handler,
    // which is what a captured-previous chain restores.
    const vv = fakeViewport({ height: 700 })
    const paneB = document.createElement('div')
    const paneC = document.createElement('div')
    trackVisualViewport({ pane, surface, viewport: vv })
    const disposeB = trackVisualViewport({
      pane: paneB,
      surface: document.createElement('div'),
      viewport: vv,
    })
    const disposeC = trackVisualViewport({
      pane: paneC,
      surface: document.createElement('div'),
      viewport: vv,
    })

    disposeB()
    disposeC()

    vv.height = 400
    vv.fire()
    expect(pane.style.height).toBe('400px')
    expect(paneB.style.height).toBe('')
    expect(paneC.style.height).toBe('')
  })

  it('does not unwire a newer tracker when an older one disposes', () => {
    // A remount can install the replacement before tearing the old one down.
    // The stale disposer must clear only its own pane, never the live
    // tracker's handlers — otherwise the pane stops following the keyboard.
    const vv = fakeViewport({ height: 700 })
    const disposeOld = trackVisualViewport({ pane, surface, viewport: vv })

    const newPane = document.createElement('div')
    const newSurface = document.createElement('div')
    trackVisualViewport({ pane: newPane, surface: newSurface, viewport: vv })

    disposeOld()
    expect(pane.getAttribute('style')).toBe('')

    vv.height = 400 // keyboard up, after the old tracker is gone
    vv.fire()
    expect(newPane.style.height).toBe('400px')
    expect(pane.style.height).toBe('')
  })
})
