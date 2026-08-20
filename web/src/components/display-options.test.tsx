import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import {
  COLUMN_LABELS,
  DEFAULT_VIEW,
  DIRECTION_LABELS,
  DIRECTIONS,
  GROUPING_LABELS,
  GROUPINGS,
  ORDERING_LABELS,
  ORDERINGS,
  SUBGROUPING_LABELS,
  type ViewConfig,
} from '@/sessions/view'
import { DisplayOptions } from './display-options'

/**
 * Mount, then open the popover, since every control is inside it.
 *
 * The view handed in is deliberately a fresh object each time: half of what
 * these cases assert is that the component answers with a *new* view rather
 * than editing the one it was lent, and a shared literal would make that
 * impossible to tell apart.
 */
async function open(over: Partial<ViewConfig> = {}) {
  const user = userEvent.setup()
  const onChange = vi.fn()
  const view: ViewConfig = { ...DEFAULT_VIEW, columns: [...DEFAULT_VIEW.columns], ...over }
  render(<DisplayOptions view={view} onChange={onChange} />)
  await user.click(screen.getByRole('button', { name: 'Display options' }))
  return { user, onChange, view }
}

/** Open one of the two selects and take the option reading `label`. */
async function pick(user: ReturnType<typeof userEvent.setup>, of: string, label: string) {
  const trigger = screen.getByRole('combobox', { name: of })
  trigger.focus()
  await user.keyboard('{Enter}')
  await user.click(await screen.findByRole('option', { name: label }))
}

describe('DisplayOptions', () => {
  it('keeps every control behind one named trigger', async () => {
    const user = userEvent.setup()
    render(<DisplayOptions view={DEFAULT_VIEW} onChange={vi.fn()} />)

    // Nothing on screen until asked for: this rides in a header beside a
    // search field and a New button, and four controls at rest would be a
    // form where a page title belongs.
    expect(screen.queryByRole('combobox', { name: 'Grouping' })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Display options' }))

    // Radix makes the panel a dialog, and an unnamed dialog is announced as
    // the word "dialog" and nothing else.
    expect(screen.getByRole('dialog', { name: 'Display options' })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Grouping' })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Ordering' })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Direction' })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: 'Show exited sessions' })).toBeTruthy()
  })

  it('reads back the arrangement it was handed', async () => {
    await open({ grouping: 'tag', ordering: 'name', direction: 'desc', showExited: false })

    expect(screen.getByRole('combobox', { name: 'Grouping' }).textContent).toContain('Tag')
    expect(screen.getByRole('combobox', { name: 'Ordering' }).textContent).toContain('Name')
    expect(screen.getByRole('combobox', { name: 'Direction' }).textContent).toContain('Descending')
    expect(
      screen.getByRole('checkbox', { name: 'Show exited sessions' }).getAttribute('aria-checked'),
    ).toBe('false')
  })

  it('offers every grouping this build knows a word for', async () => {
    const { user } = await open()
    screen.getByRole('combobox', { name: 'Grouping' }).focus()
    await user.keyboard('{Enter}')

    for (const grouping of GROUPINGS) {
      expect(
        screen.getByRole('option', { name: GROUPING_LABELS[grouping] }),
        grouping,
      ).toBeTruthy()
    }
  })

  it('offers every ordering this build knows a word for', async () => {
    const { user } = await open()
    screen.getByRole('combobox', { name: 'Ordering' }).focus()
    await user.keyboard('{Enter}')

    for (const ordering of ORDERINGS) {
      expect(
        screen.getByRole('option', { name: ORDERING_LABELS[ordering] }),
        ordering,
      ).toBeTruthy()
    }
  })

  it('offers both directions', async () => {
    const { user } = await open()
    screen.getByRole('combobox', { name: 'Direction' }).focus()
    await user.keyboard('{Enter}')

    for (const direction of DIRECTIONS) {
      expect(
        screen.getByRole('option', { name: DIRECTION_LABELS[direction] }),
        direction,
      ).toBeTruthy()
    }
  })

  it('edits the grouping and nothing else', async () => {
    const { user, onChange, view } = await open({ subgrouping: 'none' })

    await pick(user, 'Grouping', 'Tag')

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith({ ...view, grouping: 'tag' })
  })

  describe('the second cut', () => {
    it('offers every grouping but the first, and calls the way out "Nothing"', async () => {
      const { user } = await open({ grouping: 'machine' })
      screen.getByRole('combobox', { name: 'Then by' }).focus()
      await user.keyboard('{Enter}')

      // The first cut again would be one subheading under every heading — a
      // choice that can only ever draw nothing.
      expect(screen.queryByRole('option', { name: 'Machine' })).toBeNull()
      for (const grouping of GROUPINGS) {
        if (grouping === 'machine') continue
        expect(
          screen.getByRole('option', { name: SUBGROUPING_LABELS[grouping] }),
          grouping,
        ).toBeTruthy()
      }
      expect(screen.getByRole('option', { name: 'Nothing' })).toBeTruthy()
    })

    it('reads back the second cut it was handed', async () => {
      await open({ grouping: 'machine', subgrouping: 'tag' })
      expect(screen.getByRole('combobox', { name: 'Then by' }).textContent).toContain('Tag')
    })

    it('edits the second cut and nothing else', async () => {
      const { user, onChange, view } = await open({ grouping: 'machine', subgrouping: 'none' })

      await pick(user, 'Then by', 'Tag')

      expect(onChange).toHaveBeenCalledTimes(1)
      expect(onChange).toHaveBeenCalledWith({ ...view, subgrouping: 'tag' })
    })

    it('turns the second cut off when the first cut takes its key', async () => {
      // Machine then tag, and the reader picks Tag for the first cut: a view
      // cut by tag then tag would draw exactly as tag alone, and a select
      // still reading "Tag" under it would claim a second cut that is not
      // there.
      const { user, onChange, view } = await open({ grouping: 'machine', subgrouping: 'tag' })

      await pick(user, 'Grouping', 'Tag')

      expect(onChange).toHaveBeenCalledWith({ ...view, grouping: 'tag', subgrouping: 'none' })
    })

    it('turns the second cut off, and the control with it, when grouping is off', async () => {
      // Nothing cut once cannot be cut twice.
      const { user, onChange, view } = await open({ grouping: 'machine', subgrouping: 'tag' })

      await pick(user, 'Grouping', 'No grouping')

      expect(onChange).toHaveBeenCalledWith({ ...view, grouping: 'none', subgrouping: 'none' })
    })

    it('refuses the second cut while there is no first', async () => {
      await open({ grouping: 'none', subgrouping: 'none' })
      const then = screen.getByRole('combobox', { name: 'Then by' })
      expect(then.hasAttribute('disabled') || then.getAttribute('aria-disabled') === 'true').toBe(
        true,
      )
    })
  })

  it('edits the ordering, and turns the direction back to that key’s own', async () => {
    // The default view reads by last active, newest first. Directory is a
    // textual key that naturally reads a to z — a direction remembered from
    // the previous key would make every switch open backwards.
    const { user, onChange, view } = await open()

    await pick(user, 'Ordering', 'Directory')

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith({ ...view, ordering: 'directory', direction: 'asc' })
  })

  it('edits the direction and nothing else', async () => {
    const { user, onChange, view } = await open()

    await pick(user, 'Direction', 'Ascending')

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith({ ...view, direction: 'asc' })
  })

  it('takes the ended sessions away and nothing else', async () => {
    const { user, onChange, view } = await open({ showExited: true })

    await user.click(screen.getByRole('checkbox', { name: 'Show exited sessions' }))

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith({ ...view, showExited: false })
  })

  it('puts the ended sessions back and nothing else', async () => {
    const { user, onChange, view } = await open({ showExited: false })

    await user.click(screen.getByRole('checkbox', { name: 'Show exited sessions' }))

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith({ ...view, showExited: true })
  })

  it('shows one chip per column, pressed for the ones on', async () => {
    await open({ columns: ['name', 'machine'] })

    for (const [key, label] of Object.entries(COLUMN_LABELS)) {
      const chip = screen.getByRole('button', { name: label })
      const on = key === 'name' || key === 'machine'
      expect(chip.getAttribute('aria-pressed'), label).toBe(String(on))
    }
  })

  it('takes a column off without disturbing the rest', async () => {
    const { user, onChange, view } = await open()

    await user.click(screen.getByRole('button', { name: 'Tags' }))

    expect(onChange).toHaveBeenCalledWith({
      ...view,
      columns: ['name', 'directory', 'machine', 'state', 'lastActive'],
    })
  })

  it('puts a column back where it reads, not where it was clicked', async () => {
    // The chip row is the only place a column can be turned on, and the order
    // it produces is the order the headings run in — otherwise turning
    // Directory back on would park it at the far right, past Created, purely
    // because of when it was pressed.
    const { user, onChange, view } = await open({ columns: ['name', 'machine', 'created'] })

    await user.click(screen.getByRole('button', { name: 'Directory' }))

    expect(onChange).toHaveBeenCalledWith({
      ...view,
      columns: ['name', 'directory', 'machine', 'created'],
    })
  })

  it('offers the name column as permanently on', async () => {
    // The sessions list prints the name column whether or not it was asked
    // for — a list of unnamed rows identifies nothing — so the chip that
    // claims to control it says "on" and refuses the click. The alternative,
    // a chip that toggles a flag the list ignores, is a control that lies.
    const { user, onChange } = await open({ columns: ['machine'] })
    const chip = screen.getByRole('button', { name: 'Name' })

    expect(chip.getAttribute('aria-pressed')).toBe('true')
    expect(chip.hasAttribute('disabled')).toBe(true)
    expect(chip.getAttribute('title')).toBeTruthy()

    await user.click(chip)

    expect(onChange).not.toHaveBeenCalled()
  })

  it('answers with a new view and never edits the one it was lent', async () => {
    // DEFAULT_VIEW is a single frozen object shared by every browser tab that
    // has never saved an arrangement, so a control that edited in place would
    // throw for most callers and quietly corrupt the rest.
    const { user, onChange, view } = await open()
    const before = { ...view, columns: [...view.columns] }

    await user.click(screen.getByRole('button', { name: 'Tags' }))
    await user.click(screen.getByRole('checkbox', { name: 'Show exited sessions' }))

    expect(view).toEqual(before)
    expect(onChange).toHaveBeenCalledTimes(2)
    for (const [next] of onChange.mock.calls) expect(next).not.toBe(view)
    // The column list in particular: that is the one field with an array in
    // it, and the one a `push` would reach.
    expect(onChange.mock.calls[0]![0].columns).not.toBe(view.columns)
  })
})
