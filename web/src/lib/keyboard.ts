export type KeyboardMode = 'tab' | 'focus'

/**
 * The Keyboard Lock API, which TypeScript's DOM lib does not declare.
 *
 * Chromium only. Everywhere else this is absent, and `createKeyboardModes`
 * treats that as "tab mode is the only mode" rather than as an error.
 */
interface KeyboardLock {
  lock(keys?: string[]): Promise<void>
  unlock(): void
}

export interface KeyboardModes {
  mode(): KeyboardMode
  enterFocus(): Promise<void>
  exitFocus(): Promise<void>
  /** Release the document listener, and any lock still held. */
  dispose(): void
}

/**
 * Two modes, because browsers reserve Cmd+W, Cmd+T, Cmd+L and Ctrl+Tab and a
 * page cannot preventDefault them.
 *
 * - tab mode: the browser keeps its shortcuts, so tab groups, tab search and
 *   switching all work. This is the default, and the reason flue lives in a
 *   browser at all.
 * - focus mode: fullscreen plus navigator.keyboard.lock(), so the terminal
 *   receives every key. Chromium's hold-Esc gesture remains the way out.
 *
 * The two are all-or-nothing. Fullscreen without the lock keeps none of the
 * browser's shortcuts out of the browser's hands and loses every one of tab
 * mode's benefits, so a failure at any step backs the whole thing out.
 *
 * `onChange` is called only when the mode actually changes, including when the
 * browser leaves fullscreen without being asked — which is how the documented
 * escape gesture arrives.
 */
export function createKeyboardModes(
  el: HTMLElement,
  onChange: (mode: KeyboardMode) => void = () => {},
): KeyboardModes {
  let mode: KeyboardMode = 'tab'
  let live = true

  const keyboard = (): KeyboardLock | undefined =>
    (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard

  function set(next: KeyboardMode) {
    if (mode === next) return
    mode = next
    onChange(next)
  }

  async function leaveFullscreen(): Promise<void> {
    if (!document.fullscreenElement) return
    try {
      await document.exitFullscreen?.()
    } catch {
      // Already on the way out, or never really in. Either way there is
      // nothing left to do and nothing to report.
    }
  }

  async function enterFocus(): Promise<void> {
    if (mode === 'focus') return

    const kb = keyboard()
    if (!kb?.lock) return

    try {
      await el.requestFullscreen()
    } catch {
      // Chromium refuses this outside a user gesture, and Safari refuses it
      // outright on some elements. Nothing has changed yet, so nothing to undo.
      return
    }

    try {
      await kb.lock()
    } catch {
      await leaveFullscreen()
      return
    }

    // Between the two awaits the user may have left fullscreen already, in
    // which case the lock is not held by anything and focus mode is a lie.
    if (!live || !document.fullscreenElement) {
      kb.unlock?.()
      return
    }

    set('focus')
  }

  async function exitFocus(): Promise<void> {
    keyboard()?.unlock?.()
    await leaveFullscreen()
    set('tab')
  }

  const onFullscreenChange = () => {
    if (document.fullscreenElement || mode !== 'focus') return
    // The browser acted, not the page: hold-Esc, an OS window change, or the
    // element leaving the document. The lock does not outlive fullscreen, but
    // unlocking is cheap and leaves nothing ambiguous behind.
    keyboard()?.unlock?.()
    set('tab')
  }
  document.addEventListener('fullscreenchange', onFullscreenChange)

  return {
    mode: () => mode,
    enterFocus,
    exitFocus,
    dispose() {
      if (!live) return
      live = false
      document.removeEventListener('fullscreenchange', onFullscreenChange)
      // A view can unmount while focus mode is on — a reconnect that navigates
      // away, or a route change from another tab-group action. The element is
      // going away and the browser drops fullscreen with it, but the lock is
      // held by the document, so it has to be handed back explicitly.
      if (mode === 'focus') keyboard()?.unlock?.()
      mode = 'tab'
    },
  }
}
