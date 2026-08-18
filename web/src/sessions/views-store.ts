/*
 * The arrangements of the sessions list a person named and kept.
 *
 * A saved view is a `ViewConfig` with a name on it, shown as a tab above the
 * sessions list: "Ops" is grouped by tag with the ended ones left out, "All"
 * is the built-in default nobody saved. They live in this browser's
 * localStorage and nowhere else, and that is a limitation with a reason. A
 * view spans machines by definition — it is grouped by machine, it searches
 * across the fleet — so no single daemon owns one, and there is nothing to
 * sync them through that would not first have to be invented. Per browser is
 * the honest scope; the cost is that a view named on a laptop is not there on
 * a phone.
 *
 * Everything read out is measured rather than believed, exactly as
 * relay/machines.ts measures its records and for the same reason: localStorage
 * is writable by anything on the origin and survives every deploy, so a
 * corrupt document, a foreign shape, or a grouping this build no longer has a
 * word for all have to read as something. They read as "no such view" — the
 * tab is simply not there and the sessions list falls back to the default
 * view, which is also the state a browser that never saved one is in, and
 * therefore a state already known to work.
 *
 * Rows are validated one at a time rather than all or nothing. One tab whose
 * `columns` came back mangled should cost its owner that tab, not the four
 * beside it that are perfectly readable.
 */
import {
  COLUMN_KEYS,
  DEFAULT_DIRECTIONS,
  DEFAULT_VIEW,
  DIRECTIONS,
  GROUPINGS,
  ORDERINGS,
  type ColumnKey,
  type ViewConfig,
} from './view'

/** Where the views live. A JSON array of SavedView, and nothing else. */
const VIEWS_KEY = 'flue.views'

/** Where the arrangement on screen right now lives, pressed tab included. */
const CURRENT_KEY = 'flue.view.current'

/**
 * One kept arrangement, under the name its tab shows.
 *
 * The name is the identity — there is no id, because the only thing that ever
 * refers to a view is a tab a person clicks, and giving two tabs the same
 * label would be the confusing outcome rather than the useful one. Names are
 * compared exactly: `Ops` and `ops` are two views, since the alternative is a
 * store that silently declines to save what someone typed.
 */
export interface SavedView extends ViewConfig {
  name: string
}

/** Whether a parsed value is a view this module is willing to offer. */
function isSavedView(value: unknown): value is SavedView {
  const v = value as SavedView | null
  return (
    typeof v?.name === 'string' &&
    // Trimmed, because a tab labelled with three spaces is a tab nobody can
    // point at, tell from its neighbour, or say the name of out loud.
    v.name.trim() !== '' &&
    isViewConfig(v)
  )
}

/**
 * Whether a parsed value carries every field of a ViewConfig, believably.
 *
 * The direction is the one field allowed to be missing, because views were
 * being saved before it existed and reading those as corrupt would cost their
 * owners every tab on the day directions shipped. What the writing build
 * meant by a directionless view is exactly what direction() answers: the
 * ordering's natural way, which is how that build showed it.
 */
function isViewConfig(value: unknown): value is ViewConfig {
  const v = value as ViewConfig | null
  return (
    isMember(GROUPINGS, v?.grouping) &&
    isMember(ORDERINGS, v.ordering) &&
    (v.direction === undefined || isMember(DIRECTIONS, v.direction)) &&
    typeof v.search === 'string' &&
    Array.isArray(v.columns) &&
    v.columns.every((c: unknown) => isMember(COLUMN_KEYS, c)) &&
    typeof v.showExited === 'boolean'
  )
}

/** The direction a stored view meant, written down or not. See isViewConfig. */
function direction(v: ViewConfig): ViewConfig['direction'] {
  return v.direction ?? DEFAULT_DIRECTIONS[v.ordering]
}

/** Whether a stored word is still one of the words this build knows. */
function isMember<T extends string>(allowed: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
}

/**
 * Every view this browser has kept, in the order their tabs should read.
 *
 * Stored order, which is the order they were first saved in — see saveView on
 * why editing one does not move it. Storage the browser will not open at all
 * (private modes exist), a document that is not JSON, one that is not an
 * array, and rows of the wrong shape all land on the same answer as an empty
 * store: no views, and the sessions list shows its default arrangement.
 */
export function listViews(): SavedView[] {
  let raw: string | null
  try {
    raw = localStorage.getItem(VIEWS_KEY)
  } catch {
    return []
  }
  if (raw === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  // Copied field by field, so a row that smuggled extra properties in through
  // storage does not carry them back out through this module's type — and so
  // that `columns` is this caller's own array rather than one shared with
  // whatever else read the store.
  return parsed.filter(isSavedView).map((v) => ({
    name: v.name,
    grouping: v.grouping,
    ordering: v.ordering,
    direction: direction(v),
    search: v.search,
    columns: [...v.columns] as ColumnKey[],
    showExited: v.showExited,
  }))
}

/**
 * Write one view down, replacing any view of the same name.
 *
 * Replaced where it already sat, rather than dropped and appended. These are
 * tabs: adjusting the ordering of the view you are looking at and watching its
 * tab jump to the far end of the strip would move the target out from under
 * the pointer that just clicked it. A name not yet kept is appended, so a new
 * tab appears where new tabs belong — at the end, next to the button that
 * makes them.
 *
 * Throws if storage refuses the write. The caller is the half that can say
 * "that did not save"; swallowing it would leave a tab on screen that is not
 * there after a reload.
 *
 * Throws on a name that is nothing but blanks for exactly that reason rather
 * than a different one. listViews will not hand such a row back, so writing it
 * would produce a tab that is there until the page reloads and then is not —
 * the precise failure the paragraph above refuses to allow, arriving by a
 * quieter route. Whitespace *inside* a name is the reader's business; this
 * only asks that something be there.
 */
export function saveView(view: SavedView): void {
  if (view.name.trim() === '') throw new TypeError('flue: a saved view needs a name')
  const kept = listViews()
  const at = kept.findIndex((v) => v.name === view.name)
  if (at < 0) kept.push(view)
  else kept[at] = view
  localStorage.setItem(VIEWS_KEY, JSON.stringify(kept))
}

/**
 * Forget one view by name.
 *
 * Idempotent: forgetting a view that was never kept succeeds, because the
 * state the caller asked for is "not there", and it is.
 */
export function deleteView(name: string): void {
  localStorage.setItem(VIEWS_KEY, JSON.stringify(listViews().filter((v) => v.name !== name)))
}

/**
 * The arrangement the sessions screen should open with: whatever this browser
 * was looking at last, measured, or the default when nothing readable is
 * there. Change the grouping, reload, and watch it snap back to machine — the
 * bug this exists to close.
 *
 * The whole record is believed or none of it is, unlike the per-row salvage
 * of listViews: half an arrangement is not something the screen can show, and
 * the default is a state every browser starts in and therefore one already
 * known to work. What comes back is the caller's own object, columns array
 * included — DEFAULT_VIEW is frozen, and handing it out directly would let
 * the first edit throw.
 *
 * The pressed tab is measured against the saved views rather than merely
 * against `string`: a view deleted in another browser tab can still be named
 * here, and restoring a pressed tab the strip cannot draw would be a lie. The
 * arrangement itself is kept either way — it is what the reader was looking
 * at, whatever its name used to be.
 */
export function loadCurrent(): { view: ViewConfig; active: string | null } {
  const fallback = () => ({
    view: { ...DEFAULT_VIEW, columns: [...DEFAULT_VIEW.columns] },
    active: null,
  })
  let raw: string | null
  try {
    raw = localStorage.getItem(CURRENT_KEY)
  } catch {
    return fallback()
  }
  if (raw === null) return fallback()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return fallback()
  }
  const record = parsed as { view?: unknown; active?: unknown } | null
  if (record === null || !isViewConfig(record.view)) return fallback()
  const view: ViewConfig = {
    grouping: record.view.grouping,
    ordering: record.view.ordering,
    direction: direction(record.view),
    search: record.view.search,
    columns: [...record.view.columns],
    showExited: record.view.showExited,
  }
  const active =
    typeof record.active === 'string' && listViews().some((v) => v.name === record.active)
      ? record.active
      : null
  return { view, active }
}

/**
 * Write down what the screen is showing, pressed tab and all.
 *
 * Best effort, and silently so — unlike saveView there is no promise on
 * screen to break: the reader asked for an arrangement and has it, and a
 * browser that refuses to remember it simply opens on the default next time,
 * which is where every browser started.
 */
export function saveCurrent(view: ViewConfig, active: string | null): void {
  try {
    localStorage.setItem(CURRENT_KEY, JSON.stringify({ view, active }))
  } catch {
    // Nothing to do and nobody to tell: see above.
  }
}
