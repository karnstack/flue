import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'

/**
 * One step of the trail. `to` is absent on the step the reader is already
 * standing on, which is always the last one — a crumb that linked to the page
 * it is on is a control that does nothing.
 *
 * Typed as a plain string rather than as TanStack's path union, so that a
 * caller may assemble one — a machine's own screen, a saved view. See the
 * Link below for what that costs.
 */
export interface Crumb {
  label: string
  to?: string
}

export interface PageHeaderProps {
  crumbs: Crumb[]
  /** Right-aligned controls: the screen's one primary button, search, menus. */
  actions?: ReactNode
  /** An optional second row under the heading: a blurb, view tabs, a notice. */
  children?: ReactNode
}

/**
 * The header every management screen opens with.
 *
 * The last crumb *is* the `h1`, rather than a trail item repeating a title
 * rendered beside it. Every screen in the app today carries exactly one crumb,
 * so a design that printed both would say the same word twice on the common
 * path — twice on screen, and twice to anyone listening to it. Keeping them
 * one element means the trail has to carry `aria-current="page"` on a heading,
 * which is legal (aria-current is global) and is what leaves the breadcrumb
 * pattern whole. The heading therefore sits inside the landmark; a reader
 * jumping by heading still lands on it, and one jumping by landmark reaches
 * the trail that names where the heading sits.
 *
 * This renders inside each route rather than in AppShell. What a header
 * carries — which crumbs, which actions, whether a second row exists at all —
 * is the route's own business, and a shell that owned it would have to be fed
 * every one of those through context to end up rendering the same markup.
 *
 * No shell furniture rides along. The sidebar trigger sat here from md up for
 * a while, and it was the only thing on any of these screens whose subject was
 * the app rather than the page: a permanent control for putting away a
 * four-item nav that nothing on a desktop is short of room for. Collapsing is
 * still there for anyone who wants it — the primitive binds mod+B — and the
 * shell's mobile band keeps a trigger of its own, where the nav really does
 * cost the screen it is on.
 */
export function PageHeader({ crumbs, actions, children }: PageHeaderProps) {
  const current = crumbs.length - 1
  return (
    /*
      A gapped column, which is why both rows below are conditional rather
      than always present and sometimes empty: a gap is paid for an empty
      child, so an actions row with no actions in it would push the page down
      by itself.
    */
    <div data-slot="page-header" className="flex flex-col gap-y-3">
      {/*
        Wraps, and that is what makes this header survive a phone.
        `justify-between` on a row that cannot wrap does not push the actions
        off the end — it overlaps them onto the heading, which is exactly what
        the sessions toolbar did at 390px: a search field, a display menu and a
        split button printed straight through the word "Sessions" and then ran
        off the right edge. Wrapping puts them on their own line instead, and
        `w-full` there is what lets that line be a toolbar — the search grows
        into it (see SessionSearch) while the rest range right. From `sm` up
        this row goes back to its own width and nothing moves.
      */}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-0 items-center gap-x-1.5">
          <nav aria-label="Breadcrumb" className="min-w-0">
            <ol className="flex flex-wrap items-baseline gap-x-2">
              {crumbs.map((crumb, i) => (
                // Index in the key because a trail is positional: two crumbs
                // may legitimately read the same (a session named after its
                // machine) and only their depth tells them apart.
                <li key={`${i}:${crumb.label}`} className="flex items-baseline gap-x-2">
                  {i > 0 && (
                    // Punctuation, not content. Muted, and taken out of the
                    // accessibility tree entirely: the trail's structure is
                    // already carried by the ol/li, and a slash announced
                    // between every pair of crumbs is noise on top of it.
                    <span
                      aria-hidden="true"
                      className="text-2xl/8 font-semibold text-muted-foreground sm:text-xl/7"
                    >
                      /
                    </span>
                  )}
                  {i === current ? (
                    <h1
                      aria-current="page"
                      className="text-2xl/8 font-semibold tracking-tight text-zinc-950 sm:text-xl/7 dark:text-white"
                    >
                      {crumb.label}
                    </h1>
                  ) : crumb.to !== undefined ? (
                    /*
                      A router Link, never a plain anchor: a page load would
                      tear down the tab's one socket, and the trail is chrome —
                      the cheapest way there is to leave a screen.

                      Note what `to` does *not* buy here. TanStack rejects a
                      path literal the route tree has no match for, but a value
                      it cannot see the literal of — this one — infers as
                      `string` and is waved through, so a crumb pointing
                      nowhere is a runtime not-found rather than a compile
                      error. Callers that can write the literal should;
                      router.test.tsx is what holds the line for the paths the
                      app itself links to.
                    */
                    <Link
                      to={crumb.to}
                      className="text-2xl/8 font-semibold tracking-tight text-zinc-500 transition-colors hover:text-zinc-950 sm:text-xl/7 dark:text-zinc-400 dark:hover:text-white"
                    >
                      {crumb.label}
                    </Link>
                  ) : (
                    // An ancestor with nowhere to go: a section that has no
                    // screen of its own still names where the reader is.
                    <span className="text-2xl/8 font-semibold tracking-tight text-zinc-500 sm:text-xl/7 dark:text-zinc-400">
                      {crumb.label}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </nav>
        </div>
        {actions ? (
          <div className="flex w-full items-center justify-end gap-x-2 sm:w-auto sm:shrink-0">
            {actions}
          </div>
        ) : null}
      </div>
      {children ? <div>{children}</div> : null}
    </div>
  )
}
