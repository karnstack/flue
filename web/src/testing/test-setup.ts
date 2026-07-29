import '@testing-library/dom'

// jsdom implements neither of these, and both are exercised by the
// terminal view's resize handling and focus mode.
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}

if (!globalThis.matchMedia) {
  globalThis.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    // The pre-2018 MediaQueryList listener API. Deprecated, but every real
    // browser still ships it, so a stub that omits it is not a MediaQueryList
    // — and xterm 6 uses exactly this pair to watch devicePixelRatio. Without
    // them, `Terminal.open()` throws
    // "this._resolutionMediaMatchList.addListener is not a function" and no
    // test can mount a terminal at all.
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof matchMedia
}
