// The enrolment form, in a DOM.
//
// The `dom` project (see vitest.config.ts): jsdom, not workerd, because there
// is no DOM in a Worker. `EnrollForm` takes the one call it makes as a prop, so
// nothing here boots Start, a router or a database — what is under test is the
// half of the flow a person actually touches: the code they type, the machine
// they are told about, and what the form says when the answer is no.
//
// This is the *browser* end of a device-authorization handshake, so the thing
// worth testing hardest is that the form never claims more than the server
// said. "Connected" is an authorization decision, and a form that renders it
// optimistically has invented one.
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CODE_REJECTED_MESSAGE,
  EnrollForm,
  type ConfirmOutcome,
} from '../src/components/enroll-form'

afterEach(cleanup)

const APPROVED: ConfirmOutcome = { ok: true, deviceId: 'b5d05f15398a', label: 'mac studio' }

function setup(
  overrides: {
    confirm?: (input: { userCode: string }) => Promise<ConfirmOutcome>
    initialCode?: string
  } = {},
) {
  const confirm = vi.fn(overrides.confirm ?? (async () => APPROVED))
  render(<EnrollForm confirm={confirm} initialCode={overrides.initialCode} />)
  return { confirm, user: userEvent.setup() }
}

describe('EnrollForm', () => {
  it('asks for the code the daemon printed', () => {
    setup()
    expect(screen.getByRole('heading', { name: 'Connect a machine' })).toBeDefined()
    expect(screen.getByLabelText('Enrolment code')).toBeDefined()
    expect(screen.getByRole('button', { name: /Connect/ })).toBeDefined()
  })

  it('fills in a code the link carried, without approving anything', async () => {
    // `startDeviceAuth` hands the daemon a `verificationUrlComplete` with the
    // code in the query string, and the route passes it through. Filling the
    // field in is a convenience; the person still has to press the button,
    // because that press is the authorization.
    const { confirm } = setup({ initialCode: 'BCDF-GHJK' })
    expect((screen.getByLabelText('Enrolment code') as HTMLInputElement).value).toBe('BCDF-GHJK')
    await waitFor(() => expect(confirm).not.toHaveBeenCalled())
  })

  it('sends the code and names the machine that connected', async () => {
    const { confirm, user } = setup()

    // Typed the way a person types: lowercase, off a terminal.
    await user.type(screen.getByLabelText('Enrolment code'), 'bcdf-ghjk')
    await user.click(screen.getByRole('button', { name: /Connect/ }))

    expect(confirm).toHaveBeenCalledWith({ userCode: 'BCDF-GHJK' })

    // The machine, by the name it gave itself and the id it computed for
    // itself — a person approving a device has to be able to tell which one.
    expect(await screen.findByText(/mac studio/)).toBeDefined()
    expect(screen.getByText('b5d05f15398a')).toBeDefined()
    // And the form is gone: there is nothing left to confirm.
    expect(screen.queryByLabelText('Enrolment code')).toBeNull()
  })

  it('says one thing about every refusal', async () => {
    // The server answers `{ok:false}` to a wrong code, an expired one, one
    // somebody else already approved and a caller over their guess cap. It does
    // not say which, and neither may this: a form that distinguished them would
    // be the oracle the cap exists to deny.
    const { user } = setup({ confirm: async () => ({ ok: false }) })

    await user.type(screen.getByLabelText('Enrolment code'), 'ZZZZ-ZZZZ')
    await user.click(screen.getByRole('button', { name: /Connect/ }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(CODE_REJECTED_MESSAGE)
    expect(alert.textContent).not.toMatch(/expired|already|someone|attempt|too many/i)
    // Nothing was connected, so nothing says it was.
    expect(screen.queryByText('b5d05f15398a')).toBeNull()
    expect(screen.getByLabelText('Enrolment code')).toBeDefined()
  })

  it('does not claim a machine connected when the call itself fails', async () => {
    const { user } = setup({
      confirm: async () => {
        throw new Error('offline')
      },
    })

    await user.type(screen.getByLabelText('Enrolment code'), 'BCDF-GHJK')
    await user.click(screen.getByRole('button', { name: /Connect/ }))

    expect((await screen.findByRole('alert')).textContent).toContain('Something went wrong')
    expect(screen.queryByText('b5d05f15398a')).toBeNull()
  })

  it('confirms once however many times the button is pressed', async () => {
    // A double-click is one authorization, not two. The server makes a repeat
    // confirmation a no-op, but a second in-flight request would also race the
    // daemon's approving poll — and the person pressing has no idea either
    // happened.
    let release: (result: ConfirmOutcome) => void = () => {}
    const pending = new Promise<ConfirmOutcome>((resolve) => {
      release = resolve
    })
    const { confirm, user } = setup({ confirm: async () => pending })

    await user.type(screen.getByLabelText('Enrolment code'), 'BCDF-GHJK')
    const button = screen.getByRole('button', { name: /Connect/ })
    await user.click(button)
    await user.click(button)

    expect(confirm).toHaveBeenCalledTimes(1)
    release(APPROVED)
    expect(await screen.findByText(/mac studio/)).toBeDefined()
  })

  it('offers a way back for the next machine', async () => {
    const { confirm, user } = setup()

    await user.type(screen.getByLabelText('Enrolment code'), 'BCDF-GHJK')
    await user.click(screen.getByRole('button', { name: /Connect/ }))
    await screen.findByText(/mac studio/)

    await user.click(screen.getByRole('button', { name: 'Connect another machine' }))

    // A fresh, empty field — the previous code is spent, and leaving it there
    // invites a second press that can only fail.
    const field = await screen.findByLabelText('Enrolment code')
    expect((field as HTMLInputElement).value).toBe('')
    expect(confirm).toHaveBeenCalledTimes(1)
  })
})
