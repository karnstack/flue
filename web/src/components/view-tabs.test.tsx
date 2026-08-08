import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { DEFAULT_VIEW } from '@/sessions/view'
import type { SavedView } from '@/sessions/views-store'

import { ViewTabs } from './view-tabs'

type Props = Parameters<typeof ViewTabs>[0]

const WORK: SavedView = { ...DEFAULT_VIEW, name: 'Work', search: 'flue' }
const OPS: SavedView = { ...DEFAULT_VIEW, name: 'Ops', grouping: 'tag' }

/** Mount on two saved views, sitting on the built-in "All", with every spy. */
function renderTabs(over: Partial<Props> = {}) {
  const props: Props = {
    views: [WORK, OPS],
    active: null,
    dirty: false,
    onSelect: vi.fn(),
    onSaveCurrent: vi.fn(),
    onDelete: vi.fn(),
    ...over,
  }
  const view = render(<ViewTabs {...props} />)
  return { ...view, props }
}

/** The tab strip's own buttons, in the order they read. */
function tabNames(): string[] {
  return screen
    .getAllByRole('button')
    .filter((b) => b.hasAttribute('aria-pressed'))
    .map((b) => b.textContent ?? '')
}

describe('ViewTabs', () => {
  it('reads All first, then the saved views in the order given', () => {
    renderTabs()
    expect(tabNames()).toEqual(['All', 'Work', 'Ops'])
  })

  it('presses All when no view is active', () => {
    renderTabs()
    expect(screen.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Work' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('presses the active view and nothing else', () => {
    renderTabs({ active: 'Ops' })
    expect(screen.getByRole('button', { name: 'Ops' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('button', { name: 'Work' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('selects a view by name', async () => {
    const user = userEvent.setup()
    const { props } = renderTabs({ active: null })

    await user.click(screen.getByRole('button', { name: 'Work' }))

    expect(props.onSelect).toHaveBeenCalledWith('Work')
  })

  it('selects the built-in All as null', async () => {
    const user = userEvent.setup()
    const { props } = renderTabs({ active: 'Work' })

    await user.click(screen.getByRole('button', { name: 'All' }))

    expect(props.onSelect).toHaveBeenCalledWith(null)
  })

  it('shows nothing but All in a browser that saved no views', () => {
    renderTabs({ views: [] })
    expect(tabNames()).toEqual(['All'])
  })

  it('captures a name from the save dialog', async () => {
    const user = userEvent.setup()
    const { props } = renderTabs()

    await user.click(screen.getByRole('button', { name: 'Save current view' }))
    await user.type(screen.getByLabelText('Name'), 'Feature x')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(props.onSaveCurrent).toHaveBeenCalledWith('Feature x')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('captures a name on Enter', async () => {
    const user = userEvent.setup()
    const { props } = renderTabs()

    await user.click(screen.getByRole('button', { name: 'Save current view' }))
    await user.type(screen.getByLabelText('Name'), 'Feature x{Enter}')

    expect(props.onSaveCurrent).toHaveBeenCalledWith('Feature x')
  })

  it('opens the save dialog focused on an empty field', async () => {
    const user = userEvent.setup()
    renderTabs()

    await user.click(screen.getByRole('button', { name: 'Save current view' }))

    const field = screen.getByLabelText('Name') as HTMLInputElement
    expect(field.value).toBe('')
    expect(document.activeElement).toBe(field)
  })

  it('trims what it saves', async () => {
    const user = userEvent.setup()
    const { props } = renderTabs()

    await user.click(screen.getByRole('button', { name: 'Save current view' }))
    await user.type(screen.getByLabelText('Name'), '  Ops  {Enter}')

    expect(props.onSaveCurrent).toHaveBeenCalledWith('Ops')
  })

  it('refuses a name that is nothing but blanks, from the button', async () => {
    // The store drops a blank-named row on the next read, so a view saved
    // under one is a tab that lives until the page reloads.
    const user = userEvent.setup()
    const { props } = renderTabs()

    await user.click(screen.getByRole('button', { name: 'Save current view' }))
    await user.type(screen.getByLabelText('Name'), '   ')

    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(props.onSaveCurrent).not.toHaveBeenCalled()
  })

  it('refuses a name that is nothing but blanks, from Enter', async () => {
    // Disabling the button is not the whole guard: Enter reaches the form
    // without going near it.
    const user = userEvent.setup()
    const { props } = renderTabs()

    await user.click(screen.getByRole('button', { name: 'Save current view' }))
    await user.type(screen.getByLabelText('Name'), '   {Enter}')

    expect(props.onSaveCurrent).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('refuses a blank name from a submit that reached the form anyway', async () => {
    // The disabled button is what stops jsdom's implicit submission, so it is
    // the only thing the case above proves. This one submits the form
    // directly, which is what pins the handler's own guard — the half that
    // holds wherever a browser hands a submit to a form without going past
    // its default button.
    const user = userEvent.setup()
    const { props } = renderTabs()

    await user.click(screen.getByRole('button', { name: 'Save current view' }))
    await user.type(screen.getByLabelText('Name'), '   ')
    fireEvent.submit(screen.getByLabelText('Name').closest('form')!)

    expect(props.onSaveCurrent).not.toHaveBeenCalled()
  })

  it('refuses an empty field', async () => {
    const user = userEvent.setup()
    const { props } = renderTabs()

    await user.click(screen.getByRole('button', { name: 'Save current view' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(props.onSaveCurrent).not.toHaveBeenCalled()
  })

  it('lets an existing name through, because saving one is an update', async () => {
    const user = userEvent.setup()
    const { props } = renderTabs()

    await user.click(screen.getByRole('button', { name: 'Save current view' }))
    await user.type(screen.getByLabelText('Name'), 'Work{Enter}')

    expect(props.onSaveCurrent).toHaveBeenCalledWith('Work')
  })

  it('saves nothing when the dialog is dismissed with Escape', async () => {
    const user = userEvent.setup()
    const { props } = renderTabs()

    await user.click(screen.getByRole('button', { name: 'Save current view' }))
    await user.type(screen.getByLabelText('Name'), 'half a thought')
    await user.keyboard('{Escape}')

    expect(props.onSaveCurrent).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('saves nothing when the dialog is dismissed with Cancel', async () => {
    const user = userEvent.setup()
    const { props } = renderTabs()

    await user.click(screen.getByRole('button', { name: 'Save current view' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(props.onSaveCurrent).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('forgets an abandoned name on the next open', async () => {
    const user = userEvent.setup()
    renderTabs()

    await user.click(screen.getByRole('button', { name: 'Save current view' }))
    await user.type(screen.getByLabelText('Name'), 'never saved')
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: 'Save current view' }))

    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('')
  })

  it('offers to update the active view once it is dirty', async () => {
    const user = userEvent.setup()
    const { props } = renderTabs({ active: 'Work', dirty: true })

    await user.click(screen.getByRole('button', { name: 'Update view' }))

    expect(props.onSaveCurrent).toHaveBeenCalledWith('Work')
  })

  it('offers no update while the active view matches what is saved', () => {
    renderTabs({ active: 'Work', dirty: false })
    expect(screen.queryByRole('button', { name: 'Update view' })).toBeNull()
  })

  it('offers no update on All, which has no name to update', () => {
    // Editing the built-in default is not editing anything kept; the way to
    // keep it is to give it a name, which is what the + is for.
    renderTabs({ active: null, dirty: true })
    expect(screen.queryByRole('button', { name: 'Update view' })).toBeNull()
  })

  it('deletes the view its own menu belongs to', async () => {
    const user = userEvent.setup()
    const { props } = renderTabs()

    await user.click(screen.getByRole('button', { name: 'View options for Ops' }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete view' }))

    expect(props.onDelete).toHaveBeenCalledWith('Ops')
    expect(props.onSelect).not.toHaveBeenCalled()
  })

  it('gives the built-in All no menu of its own', () => {
    renderTabs()
    expect(screen.queryByRole('button', { name: 'View options for All' })).toBeNull()
  })
})
