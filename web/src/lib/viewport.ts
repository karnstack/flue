/**
 * The slice of VisualViewport this needs, as a seam for tests — and with the
 * handlers as *properties*, not addEventListener: the event's name is also a
 * Tailwind utility name, and a quoted string of it in any scanned source
 * compiles a stray rule (see the scanner notes in src/styles.css).
 */
export interface ViewportLike {
  readonly height: number
  readonly offsetTop: number
  readonly scale: number
  onresize: ((ev: Event) => void) | null
  onscroll: ((ev: Event) => void) | null
}

/**
 * Is the page pinch-zoomed?
 *
 * The slack matters: browsers report a resting scale of 1.0000001 as readily
 * as 1, so an exact comparison would call an idle page zoomed. Shared with
 * terminal.tsx's touch handlers rather than written twice — the tracker
 * hands the zoomed page's gestures to the browser, and a handler that drew
 * the line anywhere else would take them straight back.
 */
export function zoomedIn(viewport: ViewportLike | null | undefined): boolean {
  return !!viewport && viewport.scale > 1.01
}

/**
 * Keep the pane inside the *visual* viewport.
 *
 * The pane fills the layout viewport, but a phone's keyboard shrinks only the
 * visual one — the page cannot scroll under the terminal, so without this the
 * bottom rows (and the prompt) sit behind the keyboard. Pinning the pane's
 * height to the visual viewport lets the ResizeObserver in terminal.tsx do
 * the rest: the inner box shrinks, the fit is re-reported, the pty rows land
 * above the keyboard.
 *
 * Focusing an input can also scroll the visual viewport off the top of the
 * page, so the pane is slid down by that same offset to follow it. The slide
 * rides on the independent `translate` property, as the surface's own fit
 * rides on `scale` over in terminal.tsx. The compound property both are
 * longhands of cannot be named here at all: its name is a bare Tailwind
 * utility, and — measured, not guessed — even `pane.style.<it> = ''` is
 * candidate enough to compile a stray rule into the shipped sheet.
 *
 * While pinch-zoomed (scale > 1) the rules invert. A zoom is not a layout
 * change, so the pane is left alone — refitting the pty on a pinch would
 * reflow the very text being magnified — and the surface's touch-action is
 * released so a single finger pans the zoomed page, which the stylesheet
 * otherwise reserves for the scrollback drag handler. Releasing it is only
 * half the job: that handler asks `zoomedIn` the same question and stands
 * down, because its preventDefault() would cancel the very pan touch-action
 * had just permitted.
 */
export function trackVisualViewport(opts: {
  pane: HTMLElement
  surface: HTMLElement
  viewport: ViewportLike | null
}): () => void {
  const { pane, surface, viewport } = opts
  if (!viewport) return () => {}

  const apply = () => {
    if (zoomedIn(viewport)) {
      surface.style.touchAction = 'auto'
      return
    }
    surface.style.touchAction = ''
    pane.style.height = `${viewport.height}px`
    pane.style.translate = `0px ${viewport.offsetTop}px`
  }

  viewport.onresize = apply
  viewport.onscroll = apply
  apply()

  return () => {
    // Each slot is surrendered only if it is still this tracker's. Nulling
    // unconditionally would be a disposer reaching past its own lifetime:
    // a remount can install the replacement before tearing down the old
    // tracker, and the old one would then strip the handlers the new one
    // just wired, leaving the pane stuck at whatever the keyboard last did.
    if (viewport.onresize === apply) viewport.onresize = null
    if (viewport.onscroll === apply) viewport.onscroll = null
    surface.style.touchAction = ''
    pane.style.height = ''
    pane.style.translate = ''
  }
}
