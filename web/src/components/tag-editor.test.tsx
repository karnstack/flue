import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { TagEditor } from './tag-editor'

type Props = Parameters<typeof TagEditor>[0]

/** Mount open, on a session tagged `api`, with three tags known to the fleet. */
function renderEditor(over: Partial<Props> = {}) {
  const props: Props = {
    open: true,
    current: ['api'],
    known: ['api', 'db', 'deploy'],
    onSubmit: vi.fn(),
    onClose: vi.fn(),
    ...over,
  }
  const view = render(<TagEditor {...props} />)
  return { ...view, props }
}

describe('TagEditor', () => {
  it('renders nothing at all while closed', () => {
    renderEditor({ open: false })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows the session tags as chips that remove themselves', async () => {
    const user = userEvent.setup()
    renderEditor({ current: ['api', 'db'] })

    expect(screen.getByRole('dialog', { name: 'Edit tags' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Remove api' })).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Remove db' }))

    expect(screen.queryByRole('button', { name: 'Remove db' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Remove api' })).toBeTruthy()
  })

  it('adds a trimmed tag on Enter and empties the field', async () => {
    const user = userEvent.setup()
    renderEditor()

    await user.type(screen.getByLabelText('Add tag'), '  feat-x  {Enter}')

    expect(screen.getByRole('button', { name: 'Remove feat-x' })).toBeTruthy()
    expect((screen.getByLabelText('Add tag') as HTMLInputElement).value).toBe('')
  })

  it('adds nothing for a blank entry', async () => {
    const user = userEvent.setup()
    renderEditor()

    await user.type(screen.getByLabelText('Add tag'), '   {Enter}')

    expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(1)
  })

  it('keeps a tag it already has to one chip', async () => {
    const user = userEvent.setup()
    renderEditor()

    await user.type(screen.getByLabelText('Add tag'), 'api{Enter}')

    expect(screen.getAllByRole('button', { name: 'Remove api' })).toHaveLength(1)
  })

  it('suggests the fleet tags this session does not carry', async () => {
    const user = userEvent.setup()
    renderEditor()

    // `api` is already on the session, so it is not on offer.
    expect(screen.queryByRole('button', { name: 'Add api' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Add db' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add deploy' })).toBeTruthy()

    await user.type(screen.getByLabelText('Add tag'), 'de')

    expect(screen.queryByRole('button', { name: 'Add db' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Add deploy' })).toBeTruthy()
  })

  it('takes a suggestion by click, which then stops being one', async () => {
    const user = userEvent.setup()
    renderEditor()

    await user.click(screen.getByRole('button', { name: 'Add db' }))

    expect(screen.getByRole('button', { name: 'Remove db' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add db' })).toBeNull()
  })

  it('submits the set it was left holding, then asks to close', async () => {
    const user = userEvent.setup()
    const { props } = renderEditor()

    await user.click(screen.getByRole('button', { name: 'Add db' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(props.onSubmit).toHaveBeenCalledWith(['api', 'db'])
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('submits an empty list, because empty is how tags are cleared', async () => {
    // [] on the wire means "no tags", and it has to be reachable: a session
    // whose last tag cannot be taken off keeps it forever.
    const user = userEvent.setup()
    const { props } = renderEditor({ current: ['api', 'db'] })

    await user.click(screen.getByRole('button', { name: 'Remove api' }))
    await user.click(screen.getByRole('button', { name: 'Remove db' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(props.onSubmit).toHaveBeenCalledWith([])
  })

  it('does not submit the dialog when Enter adds a tag', async () => {
    const user = userEvent.setup()
    const { props } = renderEditor()

    await user.type(screen.getByLabelText('Add tag'), 'feat-x{Enter}')

    expect(props.onSubmit).not.toHaveBeenCalled()
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('closes without submitting on Escape', async () => {
    const user = userEvent.setup()
    const { props } = renderEditor()

    await user.type(screen.getByLabelText('Add tag'), 'feat-x{Enter}')
    await user.keyboard('{Escape}')

    expect(props.onSubmit).not.toHaveBeenCalled()
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('closes without submitting on Cancel', async () => {
    const user = userEvent.setup()
    const { props } = renderEditor()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(props.onSubmit).not.toHaveBeenCalled()
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('forgets an abandoned edit when it opens on the next session', async () => {
    const user = userEvent.setup()
    const { props, rerender } = renderEditor()

    await user.click(screen.getByRole('button', { name: 'Add db' }))
    rerender(<TagEditor {...props} open={false} />)
    rerender(<TagEditor {...props} open={true} current={['ops']} />)

    expect(screen.getByRole('button', { name: 'Remove ops' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Remove db' })).toBeNull()
  })
})
