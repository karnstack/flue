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
// even a different spinner — hands over the user list. That rule survives the
// toast below as well: it fires for every address, with the same hedge in it.
//
// One role="alert" on this screen, ever. The form-level refusal is an `Alert`,
// and no `FieldError` is used anywhere here — both render `role="alert"`, and
// two live regions announcing one failure is one failure announced twice.
import { useState, type FormEvent } from 'react'
import { ArrowLeftIcon, KeyRoundIcon, MailIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp'
import { Spinner } from '@/components/ui/spinner'

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

/**
 * The transient version of the same claim, for the toast.
 *
 * Hedged exactly as the sentence above is, and fired unconditionally — the
 * server answers `{ok:true}` whoever asked, so a toast that only appeared for
 * members would be the leak the whole screen is built to avoid. Short rather
 * than a copy of `CODE_SENT_MESSAGE`, which stays on the card where it can be
 * re-read; a toast is an acknowledgement, not documentation.
 */
const CODE_SENT_TOAST = 'Code sent, if that address can sign in.'

const CODE_REJECTED_MESSAGE =
  'That code did not work. Check it, or go back and ask for a new one.'

const UNAVAILABLE_MESSAGE = 'Something went wrong at our end. Try again in a moment.'

/**
 * How many digits a login code has — one slot each.
 *
 * `server/login.ts` mints eight and the route caps the field at 32 characters;
 * this is the *presentation* of that number, so it is stated here rather than
 * imported, and the field cannot accept a ninth digit whatever anyone pastes.
 */
const CODE_DIGITS = 8

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
      toast.message(CODE_SENT_TOAST)
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
    // Centred in what the root layout left over, rather than in a viewport of
    // its own: this screen sits under the site header, and a second `min-h-svh`
    // here would make the page one header taller than the window.
    <main className="flex flex-1 items-center justify-center p-4 sm:p-6">
      <div className="flex w-full max-w-sm flex-col gap-4">
        {step === 'email' ? (
          <form onSubmit={onAskForCode}>
            {/* The form wraps the card rather than sitting inside it, so the
                submit button can live in the footer without being tied to a
                form by id. Same shape as EnrollForm. */}
            <Card>
              <CardHeader>
                <CardTitle>
                  {/* A real heading inside CardTitle, which is a styled div:
                      this is the page's only h1, and Tailwind's preflight
                      resets the element's own size so it inherits the card's
                      title styling. */}
                  <h1>Sign in to flue</h1>
                </CardTitle>
                <CardDescription>
                  Type your email address. We will send you a code to sign in with.
                </CardDescription>
              </CardHeader>

              <CardContent>
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="email">Email address</FieldLabel>
                    <Input
                      id="email"
                      name="email"
                      type="email"
                      autoComplete="email"
                      autoFocus
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="invite">Invite code</FieldLabel>
                    <Input
                      id="invite"
                      name="invite"
                      type="text"
                      autoComplete="off"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      value={invite}
                      onChange={(e) => setInvite(e.target.value)}
                    />
                    <FieldDescription>
                      flue.sh is invite-only for now. Leave this empty if you already have an
                      account.
                    </FieldDescription>
                  </Field>
                </FieldGroup>
              </CardContent>

              <CardFooter>
                <Button type="submit" className="w-full" disabled={busy}>
                  {busy ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <MailIcon data-icon="inline-start" />
                  )}
                  {busy ? 'Sending…' : 'Send me a code'}
                </Button>
              </CardFooter>
            </Card>
          </form>
        ) : (
          <form onSubmit={onSignIn}>
            <Card>
              <CardHeader>
                <CardTitle>
                  <h1>Sign in to flue</h1>
                </CardTitle>
                {/* The hedged sentence, and the reason this screen exists in
                    the shape it does. It stays on the card rather than only in
                    a toast: it is the answer to "did anything happen?", and it
                    has to still be there when the reader comes back from their
                    mail app. */}
                <CardDescription>{CODE_SENT_MESSAGE}</CardDescription>
              </CardHeader>

              <CardContent>
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="code">Code</FieldLabel>
                    {/*
                      One box per digit rather than one field for eight of them.
                      This code is read off a mail app and typed into a browser
                      a character at a time, and a slotted field is what makes
                      "did I miss one?" answerable at a glance — it also takes a
                      paste and distributes it, which a mono `<input>` cannot.
                      Slots are bigger on a phone and settle back at `sm:`,
                      where the pointer is precise.
                    */}
                    <InputOTP
                      id="code"
                      name="code"
                      maxLength={CODE_DIGITS}
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      autoFocus
                      required
                      value={code}
                      onChange={setCode}
                    >
                      <InputOTPGroup className="w-full">
                        {Array.from({ length: CODE_DIGITS }, (_, i) => (
                          <InputOTPSlot
                            key={i}
                            index={i}
                            // Eight equal shares of the card rather than eight
                            // fixed boxes: at `max-w-sm` a fixed slot leaves the
                            // field ending well short of the button under it,
                            // and a row of boxes that does not line up with the
                            // control below reads as an accident. Taller on a
                            // phone, where it is a touch target.
                            className="h-10 w-full flex-1 text-base sm:h-9 sm:text-sm"
                          />
                        ))}
                      </InputOTPGroup>
                    </InputOTP>
                    <FieldDescription>Eight digits, from the email we just sent.</FieldDescription>
                  </Field>
                </FieldGroup>
              </CardContent>

              <CardFooter className="flex-col gap-2">
                <Button type="submit" className="w-full" disabled={busy}>
                  {busy ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <KeyRoundIcon data-icon="inline-start" />
                  )}
                  {busy ? 'Checking…' : 'Sign in'}
                </Button>
                {/* Secondary, and the smaller of the screen's two button sizes:
                    it is an inline form action, not the thing this card is
                    for. */}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full"
                  onClick={() => {
                    setStep('email')
                    setCode('')
                    setError(null)
                  }}
                >
                  <ArrowLeftIcon data-icon="inline-start" />
                  Use a different address
                </Button>
              </CardFooter>
            </Card>
          </form>
        )}

        {error === null ? null : (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {/*
         * The terms, one click from the only place an account is created — a
         * plain anchor rather than a router `Link` so this component keeps
         * needing nothing but React (see the note at the top of this file), and
         * because a document load is the right thing for a static page anyway.
         *
         * It is on the sign-in screen because signing in *is* the sign-up:
         * there is no separate "create an account" page to put it on, and terms
         * nobody was shown before they agreed to them are not terms.
         */}
        <p className="text-center text-base/6 text-balance text-muted-foreground sm:text-sm/6">
          By signing in you agree to the{' '}
          <a className="underline underline-offset-4 hover:text-foreground" href="/terms">
            terms of service
          </a>
          .
        </p>
      </div>
    </main>
  )
}
