/**
 * The address that starts a session, and the shape of what it carries.
 *
 * A route rather than a click handler, and that is the whole design. Starting
 * a session takes a round trip — `spawn` has no id in it, the daemon answers
 * with one — so a screen that spawned and then opened a tab would be calling
 * window.open from a continuation, which Safari refuses outright and Chrome
 * refuses once the gesture has aged out. Putting the *request* in a URL means
 * the tab opens on the click itself and does its own asking, so nothing
 * depends on how long a daemon takes to answer.
 *
 * It also answers the complaint this was written for. The old `+` pointed at
 * `/?cwd=`, so a new session came up behind the whole dashboard — page, shell,
 * session list — for as long as the spawn took. This page renders one pill.
 */

/**
 * The path, written out here so the route, the two screens that link to it and
 * this module's builder all read the same literal. `to` is typed against the
 * registered route tree wherever it is used, so a path that drifts is a
 * compile error rather than a dead link.
 */
export const NEW_SESSION_PATH = '/new' as const

/** What a link to the new-session page may say about the session it wants. */
export interface NewSessionSearch {
  /** The machine to start on: the fleet's machineId, `local` for this one. */
  d?: string
  /** The directory to start in. Absent means the daemon's own default. */
  cwd?: string
  /** A name to apply the moment the session exists. */
  name?: string
  /** Tags to apply alongside it. */
  tags?: string[]
}

/** Everything the new-session dialog collects, before the empties are dropped. */
export interface NewSessionRequest {
  machineId: string
  cwd: string
  name: string
  tags: string[]
}

/**
 * The request as search parameters, with every empty answer left out.
 *
 * Omitted rather than sent blank, for the reason `flue open` omits an empty
 * `cwd`: a parameter that is sometimes '' and sometimes absent is one more
 * case for the page to tell apart, and both of those already mean "nothing was
 * asked for". Name and tags are the same story — the daemon is only told about
 * them when there is something to tell.
 *
 * Tags stay an array rather than being joined. The router's own search
 * serialiser writes arrays as JSON and reads them back the same way, so a tag
 * with a comma in it survives the trip; a joined string would quietly become
 * two tags.
 */
export function newSessionSearch(want: Partial<NewSessionRequest>): NewSessionSearch {
  const search: NewSessionSearch = {}
  const name = want.name?.trim() ?? ''
  const tags = (want.tags ?? []).map((t) => t.trim()).filter((t) => t !== '')
  if (want.machineId !== undefined && want.machineId !== '') search.d = want.machineId
  if (want.cwd !== undefined && want.cwd.trim() !== '') search.cwd = want.cwd.trim()
  if (name !== '') search.name = name
  if (tags.length > 0) search.tags = tags
  return search
}

/**
 * What the page will act on, out of whatever arrived in the address bar.
 *
 * Every field is narrowed rather than trusted. A route's search is its
 * parent's merged with its own, the root route has no schema, and a link can
 * be edited by hand or repeated — a parameter given twice parses to an array,
 * and a number stays a number — so what reaches the component is a raw parse
 * of somebody else's typing. Anything that is not the shape this page can use
 * is dropped, which lands on the page's own defaults: this machine, the
 * daemon's default directory, no name, no tags.
 */
export function validateNewSessionSearch(search: Record<string, unknown>): NewSessionSearch {
  const out: NewSessionSearch = {}
  if (typeof search.d === 'string' && search.d !== '') out.d = search.d
  if (typeof search.cwd === 'string' && search.cwd !== '') out.cwd = search.cwd
  if (typeof search.name === 'string' && search.name !== '') out.name = search.name
  if (Array.isArray(search.tags)) {
    const tags = search.tags.filter((t): t is string => typeof t === 'string' && t.trim() !== '')
    if (tags.length > 0) out.tags = tags
  }
  return out
}
