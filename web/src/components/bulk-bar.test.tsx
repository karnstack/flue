import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { BulkBar } from './bulk-bar'

type Props = Parameters<typeof BulkBar>[0]

/** Three selected sessions, at least one of them still running, all spies. */
function renderBar(over: Partial<Props> = {}) {
  const props: Props = {
    count: 3,
    anyRunning: true,
    onTag: vi.fn(),
    onPin: vi.fn(),
    onClose: vi.fn(),
    onClear: vi.fn(),
    ...over,
  }
  const view = render(<BulkBar {...props} />)
  return { ...view, props }
}

/** Press Close and hand back the confirm that opens. */
async function openConfirm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Close' }))
  return screen.getByRole('dialog')
}

describe('BulkBar', () => {
  it('renders nothing at all while nothing is selected', () => {
    const { container } = renderBar({ count: 0 })

    expect(container.firstChild).toBeNull()
    expect(screen.queryByRole('toolbar')).toBeNull()
  })

  it('names itself and counts what is selected', () => {
    renderBar()

    const bar = screen.getByRole('toolbar', { name: 'Bulk actions' })
    expect(within(bar).getByText('3 selected')).toBeTruthy()
  })

  it('counts a single selection in the singular', () => {
    renderBar({ count: 1 })
    expect(screen.getByText('1 selected')).toBeTruthy()
  })

  it('reports Tag and Pin straight through, with nothing in the way', async () => {
    const user = userEvent.setup()
    const { props } = renderBar()

    await user.click(screen.getByRole('button', { name: 'Tag' }))
    await user.click(screen.getByRole('button', { name: 'Pin' }))

    expect(props.onTag).toHaveBeenCalledTimes(1)
    expect(props.onPin).toHaveBeenCalledTimes(1)
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('drops the selection from the X', async () => {
    const user = userEvent.setup()
    const { props } = renderBar()

    await user.click(screen.getByRole('button', { name: 'Clear selection' }))

    expect(props.onClear).toHaveBeenCalledTimes(1)
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('asks before it closes anything', async () => {
    const user = userEvent.setup()
    const { props } = renderBar()

    expect(screen.queryByRole('dialog')).toBeNull()
    await openConfirm(user)

    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('names the count in the confirm and says what closing costs', async () => {
    const user = userEvent.setup()
    renderBar()

    const confirm = await openConfirm(user)

    expect(confirm.getAttribute('aria-labelledby')).toBeTruthy()
    expect(screen.getByRole('dialog', { name: 'Close 3 sessions?' })).toBeTruthy()
    expect(within(confirm).getByText('Running processes will be killed.')).toBeTruthy()
  })

  it('asks about one session in the singular', async () => {
    const user = userEvent.setup()
    renderBar({ count: 1 })

    await openConfirm(user)

    expect(screen.getByRole('dialog', { name: 'Close 1 session?' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Close session' })).toBeTruthy()
  })

  it('makes no threat about processes when none of them is running', async () => {
    // `anyRunning` false means every selected session has already exited, so
    // there is nothing left to kill and saying so would be a scare with no
    // referent.
    const user = userEvent.setup()
    renderBar({ anyRunning: false })

    const confirm = await openConfirm(user)

    expect(screen.getByRole('dialog', { name: 'Close 3 sessions?' })).toBeTruthy()
    expect(within(confirm).queryByText(/killed/i)).toBeNull()
    expect(within(confirm).getByText('They have already exited.')).toBeTruthy()
  })

  it('softens the same way for one exited session', async () => {
    const user = userEvent.setup()
    renderBar({ count: 1, anyRunning: false })

    const confirm = await openConfirm(user)

    expect(within(confirm).queryByText(/killed/i)).toBeNull()
    expect(within(confirm).getByText('It has already exited.')).toBeTruthy()
  })

  it('closes the sessions once the confirm is taken', async () => {
    const user = userEvent.setup()
    const { props } = renderBar()

    const confirm = await openConfirm(user)
    await user.click(within(confirm).getByRole('button', { name: 'Close sessions' }))

    expect(props.onClose).toHaveBeenCalledTimes(1)
    // The selection is the caller's to drop, and it drops it by closing what
    // was in it. A clear from here would be a second opinion about state this
    // bar does not own.
    expect(props.onClear).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('fires nothing when the confirm is refused', async () => {
    const user = userEvent.setup()
    const { props } = renderBar()

    const confirm = await openConfirm(user)
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }))

    expect(props.onClose).not.toHaveBeenCalled()
    expect(props.onClear).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
    // The selection survived the near miss: the bar is still counting it.
    expect(screen.getByText('3 selected')).toBeTruthy()
  })

  it('fires nothing when the confirm is dismissed on Escape', async () => {
    const user = userEvent.setup()
    const { props } = renderBar()

    await openConfirm(user)
    await user.keyboard('{Escape}')

    expect(props.onClose).not.toHaveBeenCalled()
    expect(props.onClear).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('3 selected')).toBeTruthy()
  })

  it('asks again the next time, rather than remembering a refusal', async () => {
    const user = userEvent.setup()
    const { props } = renderBar()

    const first = await openConfirm(user)
    await user.click(within(first).getByRole('button', { name: 'Cancel' }))
    const second = await openConfirm(user)
    await user.click(within(second).getByRole('button', { name: 'Close sessions' }))

    expect(props.onClose).toHaveBeenCalledTimes(1)
  })
})
