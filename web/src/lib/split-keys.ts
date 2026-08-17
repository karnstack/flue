/*
 * The split chords, next of kin to the switcher's (switcher/keys.ts) and
 * bound by the same three constraints: browser-reserved combinations, a
 * terminal underneath that owns most keys, and layouts that move characters
 * around. The survivors:
 *
 *   - Mac: ⌘D splits side by side, ⇧⌘D splits stacked — the pair Supacode
 *     and VS Code taught. A Cmd chord never reaches the shell, and Chrome
 *     lets a page preventDefault its bookmark shortcut.
 *   - Elsewhere: Ctrl+Shift+D and Ctrl+Alt+Shift+D. Plain Ctrl+D is EOF —
 *     the keystroke that closes shells — and may never be taken; Ctrl+Shift
 *     is the namespace a terminal emulator conventionally reserves for its
 *     own chrome (#64), and Alt is the only modifier left to say "the other
 *     axis".
 */

/**
 * Which way one split lies: `row` is side by side (a split to the right),
 * `column` is stacked (a split downward). Axes mix freely — every split in
 * the tree (sessions/pane-tree.ts) carries its own.
 */
export type SplitDirection = 'row' | 'column'

/**
 * The three verbs that add a pane: split the asking pane along an axis, or
 * open a new tab beside its tab. Tabs and splits compose — a tab holds a
 * whole split tree — so this names the placement of one new pane, never a
 * mode the group switches into.
 */
export type GroupLayout = SplitDirection | 'tabs'

/** What a keystroke asked the split to do, or null for "not ours". */
export function matchSplitChord(e: KeyboardEvent, apple: boolean): SplitDirection | null {
  // `code` first for the reason the switcher's brackets use it — `key` is
  // what the layout produced under Shift — with the character accepted
  // behind it for layouts that report one.
  const d = e.code === 'KeyD' || (e.key.length === 1 && e.key.toLowerCase() === 'd')
  if (!d) return null

  if (apple) {
    if (!e.metaKey || e.ctrlKey || e.altKey) return null
    return e.shiftKey ? 'column' : 'row'
  }

  if (!e.ctrlKey || !e.shiftKey || e.metaKey) return null
  return e.altKey ? 'column' : 'row'
}

/** How a split chord is printed, for menu rows and tooltips. */
export function splitChordLabel(apple: boolean, dir: SplitDirection): string {
  if (apple) return dir === 'row' ? '⌘D' : '⇧⌘D'
  return dir === 'row' ? 'Ctrl+Shift+D' : 'Ctrl+Alt+Shift+D'
}

/**
 * Whether a keystroke asked for a new tab. ⌥⌘T on a Mac and Ctrl+Alt+T
 * elsewhere, because the two natural spellings are both browser property:
 * ⌘T/Ctrl+T opens a browser tab and ⇧⌘T/Ctrl+Shift+T reopens one, and
 * neither can be taken back (#64). Matched on `code`: with Alt held a Mac
 * layout produces † for the T key, which is exactly the trap the split
 * chords dodge the same way.
 */
export function matchNewTabChord(e: KeyboardEvent, apple: boolean): boolean {
  const t = e.code === 'KeyT' || (e.key.length === 1 && e.key.toLowerCase() === 't')
  if (!t) return false
  if (apple) return e.metaKey && e.altKey && !e.ctrlKey && !e.shiftKey
  return e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey
}

/** How the new-tab chord is printed. */
export function newTabChordLabel(apple: boolean): string {
  return apple ? '⌥⌘T' : 'Ctrl+Alt+T'
}
