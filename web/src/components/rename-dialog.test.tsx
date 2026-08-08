import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { RenameDialog } from './rename-dialog'

type Props = Parameters<typeof RenameDialog>[0]

/** Mount open, on a session that already carries a name, with both spies. */
function renderDialog(over: Partial<Props> = {}) {
  const props: Props = {
    open: true,
    initial: 'api server',
    onSubmit: vi.fn(),
    onClose: vi.fn(),
    ...over,
  }
  const view = render(<RenameDialog {...props} />)
  return { ...view, props }
}

describe('RenameDialog', () => {
  it('renders nothing at all while closed', () => {
    renderDialog({ open: false })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens on the current name, focused and selected end to end', () => {
    renderDialog()

    expect(screen.getByRole('dialog', { name: 'Rename session' })).toBeTruthy()
    const field = screen.getByLabelText('Name') as HTMLInputElement
    expect(field.value).toBe('api server')

    // Focused *and* selected: the common act is replacing the name outright,
    // so the first keystroke should overwrite rather than append.
    expect(document.activeElement).toBe(field)
    expect(field.selectionStart).toBe(0)
    expect(field.selectionEnd).toBe('api server'.length)
  })

  it('submits the typed name on Enter, then asks to close', async () => {
    const user = userEvent.setup()
    const { props } = renderDialog()

    await user.clear(screen.getByLabelText('Name'))
    await user.type(screen.getByLabelText('Name'), 'db migrations{Enter}')

    expect(props.onSubmit).toHaveBeenCalledWith('db migrations')
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('submits the typed name from the Save button', async () => {
    const user = userEvent.setup()
    const { props } = renderDialog()

    await user.clear(screen.getByLabelText('Name'))
    await user.type(screen.getByLabelText('Name'), 'db migrations')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(props.onSubmit).toHaveBeenCalledWith('db migrations')
  })

  it('submits before it asks to close', async () => {
    // Task 19 wires both to the same "stop renaming this row" state, so the
    // update must be sent while the dialog still holds what to send.
    const user = userEvent.setup()
    const calls: string[] = []
    renderDialog({ onSubmit: () => calls.push('submit'), onClose: () => calls.push('close') })

    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(calls).toEqual(['submit', 'close'])
  })

  it('lets an empty field through, because empty is how a name is cleared', async () => {
    // The daemon reads '' as "no name", which puts the session back on the
    // title its program announces. A dialog that refused to submit nothing
    // would make that unreachable from the UI.
    const user = userEvent.setup()
    const { props } = renderDialog()

    await user.clear(screen.getByLabelText('Name'))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(props.onSubmit).toHaveBeenCalledWith('')
  })

  it('reads a field of spaces as a clear', async () => {
    const user = userEvent.setup()
    const { props } = renderDialog()

    await user.clear(screen.getByLabelText('Name'))
    await user.type(screen.getByLabelText('Name'), '   {Enter}')

    expect(props.onSubmit).toHaveBeenCalledWith('')
  })

  it('trims what it submits', async () => {
    const user = userEvent.setup()
    const { props } = renderDialog()

    await user.clear(screen.getByLabelText('Name'))
    await user.type(screen.getByLabelText('Name'), '  api  {Enter}')

    expect(props.onSubmit).toHaveBeenCalledWith('api')
  })

  it('closes without submitting on Escape', async () => {
    const user = userEvent.setup()
    const { props } = renderDialog()

    await user.type(screen.getByLabelText('Name'), 'half a thought')
    await user.keyboard('{Escape}')

    expect(props.onSubmit).not.toHaveBeenCalled()
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('closes without submitting on Cancel', async () => {
    const user = userEvent.setup()
    const { props } = renderDialog()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(props.onSubmit).not.toHaveBeenCalled()
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('forgets an abandoned edit when it opens on the next session', async () => {
    const user = userEvent.setup()
    const { props, rerender } = renderDialog()

    await user.clear(screen.getByLabelText('Name'))
    await user.type(screen.getByLabelText('Name'), 'never sent')
    rerender(<RenameDialog {...props} open={false} />)
    rerender(<RenameDialog {...props} open={true} initial="db" />)

    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('db')
  })
})
