import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { NewSessionRequest } from '@/sessions/new-session'
import { NewSessionDialog, type NewSessionDialogProps } from './new-session-dialog'

const MACHINES = [
  { id: 'local', name: 'mesa.local' },
  { id: 'attic-pi', name: 'Attic Pi' },
]

function show(over: Partial<NewSessionDialogProps> = {}) {
  const props: NewSessionDialogProps = {
    open: true,
    initial: {},
    machines: MACHINES,
    known: [],
    onSubmit: vi.fn(),
    onClose: vi.fn(),
    ...over,
  }
  const view = render(<NewSessionDialog {...props} />)
  const submitted = () => (props.onSubmit as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
    | NewSessionRequest
    | undefined
  return { ...view, props, submitted, rerender: view.rerender }
}

const start = () => userEvent.click(screen.getByRole('button', { name: 'Start session' }))

describe('NewSessionDialog', () => {
  it('submits the ridden machine and nothing else when nothing is typed', async () => {
    // The bar this had to clear to be allowed in front of a one-click button:
    // opening it and pressing Start must be the old behaviour exactly.
    const { submitted } = show({ initial: { machineId: 'local' } })

    await start()

    expect(submitted()).toEqual({ machineId: 'local', cwd: '', name: '', tags: [] })
  })

  it('carries a name, a directory and tags', async () => {
    const user = userEvent.setup()
    const { submitted } = show({ initial: { machineId: 'local' } })

    await user.type(screen.getByLabelText('Name'), 'deploy')
    await user.type(screen.getByLabelText('Directory'), '/srv/app')
    await user.type(screen.getByLabelText('Tags'), 'ops{Enter}api{Enter}')
    await start()

    expect(submitted()).toEqual({
      machineId: 'local',
      cwd: '/srv/app',
      name: 'deploy',
      tags: ['ops', 'api'],
    })
  })

  it('counts a tag typed but never entered', async () => {
    // Somebody who typed a tag and reached straight for Start is done, and a
    // dialog that threw the keystroke away would be disagreeing with them in
    // silence — the chips are gone before anyone can read what was sent.
    const user = userEvent.setup()
    const { submitted } = show()

    await user.type(screen.getByLabelText('Tags'), 'staging')
    await start()

    expect(submitted()?.tags).toEqual(['staging'])
  })

  it('does not start a session on the Enter that finishes a tag', async () => {
    // The tag field sits inside a real form, so its own Enter has to be
    // stopped: a set the reader was still assembling is not an answer.
    const user = userEvent.setup()
    const { props } = show()

    await user.type(screen.getByLabelText('Tags'), 'ops{Enter}')

    expect(props.onSubmit).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Remove ops' })).toBeTruthy()
  })

  it('submits on Enter from the name field, like every other form', async () => {
    const user = userEvent.setup()
    const { submitted } = show({ initial: { machineId: 'attic-pi' } })

    await user.type(screen.getByLabelText('Name'), 'quick{Enter}')

    expect(submitted()).toEqual({ machineId: 'attic-pi', cwd: '', name: 'quick', tags: [] })
  })

  it('opens on what the press implied, and lets it be edited', async () => {
    const user = userEvent.setup()
    const { submitted } = show({
      initial: { machineId: 'attic-pi', cwd: '/srv', tags: ['api'] },
    })

    expect(screen.getByLabelText('Directory')).toHaveProperty('value', '/srv')

    // A prefill and not a decision: the chip is there to be taken off again.
    await user.click(screen.getByRole('button', { name: 'Remove api' }))
    await start()

    expect(submitted()).toEqual({ machineId: 'attic-pi', cwd: '/srv', name: '', tags: [] })
  })

  it('offers the fleet’s own tags, minus the ones already chosen', async () => {
    const user = userEvent.setup()
    const { submitted } = show({ known: ['api', 'ops'], initial: { tags: ['api'] } })

    expect(screen.queryByRole('button', { name: 'Add api' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Add ops' }))
    await start()

    expect(submitted()?.tags).toEqual(['api', 'ops'])
  })

  it('puts the chosen tags under their field, not above its heading', async () => {
    // Leading chips are right for a dialog whose whole subject is tags. Here
    // they read as a stray line belonging to the field before them: "No tags
    // yet." landed between the Directory input and a heading called Tags.
    const user = userEvent.setup()
    show()

    await user.type(screen.getByLabelText('Tags'), 'ops{Enter}')

    const field = screen.getByLabelText('Tags')
    const chip = screen.getByRole('button', { name: 'Remove ops' })
    expect(field.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('asks which machine only when there is a choice to make', () => {
    const { unmount } = show({ machines: [MACHINES[0]!] })
    expect(screen.queryByRole('combobox', { name: 'Machine' })).toBeNull()
    unmount()

    show()
    expect(screen.getByRole('combobox', { name: 'Machine' })).toBeTruthy()
  })

  it('falls back to the first machine when the press named one that has gone', async () => {
    // A heading for a machine that dropped between render and click. Without
    // the fallback the trigger renders blank over a form pointing at an id no
    // option carries.
    const { submitted } = show({ initial: { machineId: 'vanished' } })

    await start()

    expect(submitted()?.machineId).toBe('local')
  })

  it('takes the machine the fleet has not named yet, once it names it', async () => {
    // The terminal screen subscribes to the fleet and the first delivery can
    // land after this has rendered. A machine chosen once, at mount, would
    // leave the picker empty for good.
    const { rerender, submitted, props } = show({ machines: [], initial: { machineId: 'local' } })

    expect(screen.getByText(/no machine is reachable/i)).toBeTruthy()

    rerender(<NewSessionDialog {...props} machines={MACHINES} />)
    await start()

    expect(submitted()?.machineId).toBe('local')
  })

  it('refuses in words when no machine is reachable', async () => {
    const { props } = show({ machines: [] })

    expect(screen.getByRole('button', { name: 'Start session' })).toHaveProperty('disabled', true)

    await start()

    expect(props.onSubmit).not.toHaveBeenCalled()
  })

  it('closes itself after a submit, and on Cancel', async () => {
    const { props } = show({ initial: { machineId: 'local' } })

    await start()
    expect(props.onClose).toHaveBeenCalledTimes(1)

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(props.onClose).toHaveBeenCalledTimes(2)
  })
})
