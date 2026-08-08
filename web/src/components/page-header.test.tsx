import { describe, expect, it } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithRouter } from '@/testing/render'
import { PageHeader } from './page-header'

/** The header's one landmark, found the way a screen reader finds it. */
const trail = () => screen.getByRole('navigation', { name: 'Breadcrumb' })

/** The header block itself, so the assertions about its rows can be exact. */
const block = () => document.querySelector('[data-slot="page-header"]')!

describe('PageHeader', () => {
  it('carries the sidebar trigger beside the crumbs, for md and up', async () => {
    // The shell used to spend a whole bar on this one button; now it sits on
    // the heading's own line. Below md it stands down — the shell's mobile
    // band still carries a trigger of its own there, beside the wordmark.
    await renderWithRouter(<PageHeader crumbs={[{ label: 'Sessions' }]} />)

    const trigger = screen.getByRole('button', { name: 'Toggle Sidebar' })
    expect(block().contains(trigger)).toBe(true)
    expect(trigger.className).toMatch(/\bmax-md:hidden\b/)
    // Outside the trail's landmark: the trigger is shell furniture, not a
    // step on the way here.
    expect(trail().contains(trigger)).toBe(false)
  })

  it('renders a lone crumb as the page heading, with nothing before it', async () => {
    // The single-crumb case is every screen in the app today, and the crumb
    // *is* the title: rendering the same word twice — once as a trail item,
    // once as a heading — would have a screen reader announce it twice.
    await renderWithRouter(<PageHeader crumbs={[{ label: 'Sessions' }]} />)

    const heading = screen.getByRole('heading', { level: 1, name: 'Sessions' })
    expect(within(trail()).getByRole('heading', { level: 1 })).toBe(heading)
    // No separator, and no second rendering of the word.
    expect(trail().textContent).toBe('Sessions')
  })

  it('marks the last crumb as the current page', async () => {
    await renderWithRouter(
      <PageHeader crumbs={[{ label: 'Sessions', to: '/sessions' }, { label: 'Feature x' }]} />,
      '/devices',
    )

    const heading = screen.getByRole('heading', { level: 1, name: 'Feature x' })
    expect(heading.getAttribute('aria-current')).toBe('page')
    // And only there: an ancestor that also claimed to be the page would
    // leave the trail with no answer to "where am I".
    const marked = within(trail())
      .getAllByText(/Sessions|Feature x/)
      .filter((el) => el.getAttribute('aria-current') === 'page')
    expect(marked).toHaveLength(1)
  })

  it('renders ancestor crumbs as router links that navigate', async () => {
    // A plain <a href> would reload the page and take the tab's one socket
    // with it. Only a router Link moves router.state.location.
    const { router } = await renderWithRouter(
      <PageHeader crumbs={[{ label: 'Sessions', to: '/sessions' }, { label: 'Feature x' }]} />,
      '/devices',
    )

    const link = within(trail()).getByRole('link', { name: 'Sessions' })
    expect(link.getAttribute('href')).toBe('/sessions')

    await userEvent.click(link)
    await waitFor(() => expect(router.state.location.pathname).toBe('/sessions'))
  })

  it('separates crumbs with a slash that assistive technology never reads', async () => {
    await renderWithRouter(
      <PageHeader crumbs={[{ label: 'Sessions', to: '/sessions' }, { label: 'Feature x' }]} />,
      '/devices',
    )

    expect(trail().textContent).toBe('Sessions/Feature x')
    const separators = trail().querySelectorAll('[aria-hidden="true"]')
    expect(separators).toHaveLength(1)
    expect(separators[0]!.textContent).toBe('/')
    // Muted, per the design tokens: the separator is punctuation, not content.
    expect(separators[0]!.getAttribute('class')).toContain('text-muted-foreground')
  })

  it('renders the actions slot beside the trail, outside the landmark', async () => {
    await renderWithRouter(
      <PageHeader
        crumbs={[{ label: 'Sessions' }]}
        actions={<button type="button">New session</button>}
      />,
    )

    const action = screen.getByRole('button', { name: 'New session' })
    expect(trail().contains(action)).toBe(false)
    expect(block().contains(action)).toBe(true)
  })

  it('renders children as a second row of the header block', async () => {
    await renderWithRouter(
      <PageHeader crumbs={[{ label: 'Sessions' }]}>
        <p>Closing a tab detaches.</p>
      </PageHeader>,
    )

    const blurb = screen.getByText('Closing a tab detaches.')
    expect(block().contains(blurb)).toBe(true)
    expect(trail().contains(blurb)).toBe(false)
    // Its own row, under the heading row rather than inside it.
    expect(block().children).toHaveLength(2)
  })

  it('leaves no empty row behind when there is nothing to put in one', async () => {
    // The block is a gapped column, and a gap is paid for an empty child —
    // an actions div with no actions would push the page down by itself.
    await renderWithRouter(<PageHeader crumbs={[{ label: 'Sessions' }]} />)

    // One row, and inside it only the leading cluster — the trigger and the
    // trail: no actions wrapper waiting to be filled, no second row under it.
    expect(block().children).toHaveLength(1)
    const row = block().firstElementChild!
    expect(row.children).toHaveLength(1)
    expect(row.firstElementChild!.contains(trail())).toBe(true)
  })
})
