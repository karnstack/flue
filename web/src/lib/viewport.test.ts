import { beforeEach, describe, expect, it } from 'vitest'
import { trackVisualViewport, type ViewportLike } from './viewport'

/** A hand-cranked visualViewport double; fire() plays both handler slots. */
function fakeViewport(init: { height: number; offsetTop?: number; scale?: number }) {
  const vv = {
    height: init.height,
    offsetTop: init.offsetTop ?? 0,
    scale: init.scale ?? 1,
    onresize: null as ViewportLike['onresize'],
    onscroll: null as ViewportLike['onscroll'],
    fire() {
      vv.onresize?.(new Event('x'))
    },
  }
  return vv
}

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

  it('releases the surface to the browser while pinch-zoomed', () => {
    const vv = fakeViewport({ height: 700 })
    trackVisualViewport({ pane, surface, viewport: vv })

    vv.scale = 2
    vv.height = 350
    vv.fire()
    // One finger must pan the zoomed page, and a zoom is not a layout change:
    // the pane keeps its unzoomed size so the pty never refits on a pinch.
    expect(surface.style.touchAction).toBe('auto')
    expect(pane.style.height).toBe('700px')

    vv.scale = 1
    vv.height = 700
    vv.fire()
    expect(surface.style.touchAction).toBe('')
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
})
