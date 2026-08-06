// The sign-in form: an address, then a code.
//
// Deliberately free of every Start import — it takes the two calls it makes as
// props. That keeps the anti-enumeration rule testable in a plain DOM (the
// component is what decides what the visitor is *told*, and it has to tell
// everyone the same thing) and keeps the route file as the only place that
// knows about RPC.
//
// The copy is the security-relevant part. After the first step this form says
// the same sentence to a member, to someone holding an invite and to a
// stranger, because the server does the same thing for all three. Any
// friendlier wording — "check your inbox", "no account with that address",
// even a different spinner — hands over the user list.
import { useState, type FormEvent } from 'react'

export interface LoginFormProps {
  requestCode: (input: { email: string; invite: string }) => Promise<{ ok: boolean }>
  submitCode: (input: { email: string; code: string; invite: string }) => Promise<{ ok: boolean }>
  /** Called once the session cookie is set. The route decides where to go. */
  onSignedIn: () => void
}

/**
 * The one sentence step one ever produces. Exported so a test can assert that
 * it does not depend on who asked.
 */
export const CODE_SENT_MESSAGE =
  'If that address can sign in, we have sent it an eight-digit code. It is good for ten minutes.'

const CODE_REJECTED_MESSAGE =
  'That code did not work. Check it, or go back and ask for a new one.'

const UNAVAILABLE_MESSAGE = 'Something went wrong at our end. Try again in a moment.'

export function LoginForm({ requestCode, submitCode, onSignedIn }: LoginFormProps) {
  const [step, setStep] = useState<'email' | 'code'>('email')
  const [email, setEmail] = useState('')
  const [invite, setInvite] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onAskForCode(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await requestCode({ email, invite })
      // Always. The server answers `{ok:true}` whatever it decided, and this
      // form moves on whatever it hears — there is no branch here to observe.
      setStep('code')
    } catch {
      // Only a transport failure reaches this, and it says nothing about the
      // address: the server does not fail differently for a member.
      setError(UNAVAILABLE_MESSAGE)
    } finally {
      setBusy(false)
    }
  }

  async function onSignIn(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await submitCode({ email, code, invite })
      if (result.ok) onSignedIn()
      // One message for every refusal — wrong code, expired code, spent
      // invite, disabled account. The server does not say which, and neither
      // does this.
      else setError(CODE_REJECTED_MESSAGE)
    } catch {
      setError(UNAVAILABLE_MESSAGE)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main>
      <h1>Sign in to flue</h1>

      {step === 'email' ? (
        <form onSubmit={onAskForCode}>
          <p>Type your email address. We will send you a code to sign in with.</p>
          <label htmlFor="email">Email address</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />

          <label htmlFor="invite">Invite code (only if you have one)</label>
          <input
            id="invite"
            name="invite"
            type="text"
            autoComplete="off"
            value={invite}
            onChange={(e) => setInvite(e.target.value)}
          />

          <button type="submit" disabled={busy}>
            {busy ? 'Sending…' : 'Send me a code'}
          </button>
        </form>
      ) : (
        <form onSubmit={onSignIn}>
          <p>{CODE_SENT_MESSAGE}</p>
          <label htmlFor="code">Code</label>
          <input
            id="code"
            name="code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />

          <button type="submit" disabled={busy}>
            {busy ? 'Checking…' : 'Sign in'}
          </button>
          <button
            type="button"
            onClick={() => {
              setStep('email')
              setCode('')
              setError(null)
            }}
          >
            Use a different address
          </button>
        </form>
      )}

      {error === null ? null : <p role="alert">{error}</p>}

      {/*
       * The terms, one click from the only place an account is created — a
       * plain anchor rather than a router `Link` so this component keeps
       * needing nothing but React (see the note at the top of this file), and
       * because a document load is the right thing for a static page anyway.
       *
       * It is on the sign-in screen because signing in *is* the sign-up: there
       * is no separate "create an account" page to put it on, and terms nobody
       * was shown before they agreed to them are not terms.
       */}
      <p>
        By signing in you agree to the <a href="/terms">terms of service</a>.
      </p>
    </main>
  )
}
