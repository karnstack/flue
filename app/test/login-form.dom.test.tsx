// The sign-in form, in a DOM.
//
// This is the `dom` project (see vitest.config.ts): jsdom, not workerd, because
// there is no DOM in a Worker. `LoginForm` takes the two calls it makes as
// props, so nothing here boots Start, a router or a database — what is under
// test is what the visitor sees and what the form asks for, which is exactly
// the surface the anti-enumeration rule lives on in the client.
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CODE_SENT_MESSAGE, LoginForm } from '../src/components/login-form'

afterEach(cleanup)

function setup(
  overrides: {
    requestCode?: (input: { email: string; invite: string }) => Promise<{ ok: boolean }>
    submitCode?: (input: {
      email: string
      code: string
      invite: string
    }) => Promise<{ ok: boolean }>
  } = {},
) {
  const requestCode = vi.fn(overrides.requestCode ?? (async () => ({ ok: true })))
  const submitCode = vi.fn(overrides.submitCode ?? (async () => ({ ok: true })))
  const onSignedIn = vi.fn()
  render(<LoginForm requestCode={requestCode} submitCode={submitCode} onSignedIn={onSignedIn} />)
  return { requestCode, submitCode, onSignedIn, user: userEvent.setup() }
}

describe('LoginForm', () => {
  it('renders the address step first', () => {
    setup()
    expect(screen.getByRole('heading', { name: 'Sign in to flue' })).toBeDefined()
    expect(screen.getByLabelText('Email address')).toBeDefined()
    // The code field is not merely hidden — it does not exist until there is a
    // reason for it.
    expect(screen.queryByLabelText('Code')).toBeNull()
  })

  it('asks the server for a code, then shows the code field', async () => {
    const { requestCode, user } = setup()

    await user.type(screen.getByLabelText('Email address'), 'someone@example.com')
    await user.click(screen.getByRole('button', { name: 'Send me a code' }))

    expect(requestCode).toHaveBeenCalledWith({ email: 'someone@example.com', invite: '' })
    expect(await screen.findByLabelText('Code')).toBeDefined()
  })

  it('passes an invite code along when one is typed', async () => {
    const { requestCode, submitCode, user } = setup()

    await user.type(screen.getByLabelText('Email address'), 'newcomer@example.com')
    await user.type(screen.getByLabelText(/Invite code/), 'inv-abc')
    await user.click(screen.getByRole('button', { name: 'Send me a code' }))

    expect(requestCode).toHaveBeenCalledWith({ email: 'newcomer@example.com', invite: 'inv-abc' })

    // ...and it is still there for the submission, which is where it is spent.
    await user.type(await screen.findByLabelText('Code'), '12345678')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(submitCode).toHaveBeenCalledWith({
      email: 'newcomer@example.com',
      code: '12345678',
      invite: 'inv-abc',
    })
  })

  it('says the same thing whoever asked', async () => {
    // The server answers `{ok:true}` to a member, an invitee and a stranger
    // alike; the form must not be the thing that gives the game away. Both
    // runs are driven identically and the rendered text compared.
    async function copyAfterAsking(email: string): Promise<string> {
      const { user } = setup()
      await user.type(screen.getByLabelText('Email address'), email)
      await user.click(screen.getByRole('button', { name: 'Send me a code' }))
      const message = (await screen.findByText(CODE_SENT_MESSAGE)).textContent ?? ''
      cleanup()
      return message
    }

    expect(await copyAfterAsking('member@example.com')).toBe(
      await copyAfterAsking('nobody@example.com'),
    )
    expect(CODE_SENT_MESSAGE).toContain('If that address can sign in')
  })

  it('hands the code over and reports a successful sign-in', async () => {
    const { submitCode, onSignedIn, user } = setup()

    await user.type(screen.getByLabelText('Email address'), 'member@example.com')
    await user.click(screen.getByRole('button', { name: 'Send me a code' }))
    await user.type(await screen.findByLabelText('Code'), '01234567')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(submitCode).toHaveBeenCalledWith({
      email: 'member@example.com',
      code: '01234567',
      invite: '',
    })
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1))
  })

  it('reports a refusal without saying which refusal it was', async () => {
    const { onSignedIn, user } = setup({ submitCode: async () => ({ ok: false }) })

    await user.type(screen.getByLabelText('Email address'), 'member@example.com')
    await user.click(screen.getByRole('button', { name: 'Send me a code' }))
    await user.type(await screen.findByLabelText('Code'), '00000000')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('That code did not work')
    // Not a hint about accounts, invites or attempts left.
    expect(alert.textContent).not.toMatch(/account|invite|exist|attempt/i)
    expect(onSignedIn).not.toHaveBeenCalled()
  })

  it('does not claim a sign-in when the call itself fails', async () => {
    const { onSignedIn, user } = setup({
      submitCode: async () => {
        throw new Error('offline')
      },
    })

    await user.type(screen.getByLabelText('Email address'), 'member@example.com')
    await user.click(screen.getByRole('button', { name: 'Send me a code' }))
    await user.type(await screen.findByLabelText('Code'), '00000000')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect((await screen.findByRole('alert')).textContent).toContain('Something went wrong')
    expect(onSignedIn).not.toHaveBeenCalled()
  })
})
