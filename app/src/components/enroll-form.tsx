// The browser half of `flue link`: type the code, connect the machine.
//
// Free of every Start import, like `LoginForm` — it takes the one call it makes
// as a prop. That keeps the component testable in a plain DOM and keeps the
// route file the only place that knows about RPC.
//
// What this form is, precisely, is the authorization step of a device-
// authorization grant. The daemon is sitting on another machine with no
// credential, polling; pressing the button here is what binds it to the account
// whose cookie this page was loaded with. Two consequences run through the
// code below.
//
// It never claims more than the server said. `{ok:true}` is the only thing that
// renders "connected", because "connected" *is* the authorization decision —
// optimism here would be a form inventing one. A transport failure is reported
// as a transport failure, not as a refusal, and never as a success.
//
// It says one thing about every refusal. `confirmDeviceAuth` answers
// `{ok:false}` to a code that was mistyped, one that expired, one somebody else
// already approved, and a caller who has burnt their guess allowance — and it
// deliberately does not distinguish them, because a user code is short enough
// to guess at if guessing tells you anything. A form with four friendlier
// messages would hand back exactly what the server withheld.
import { useState, type FormEvent } from 'react'
import { MonitorCheckIcon, MonitorSmartphoneIcon, PlugZapIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
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
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'

/**
 * What `confirmDeviceAuth` answers, spelled out here rather than imported.
 *
 * The route wires the two together, so a change to the server's result is a
 * type error at the wiring — while this file stays free of anything that would
 * drag Start, drizzle or a D1 binding into a jsdom test.
 */
export type ConfirmOutcome = { ok: true; deviceId: string; label: string } | { ok: false }

export interface EnrollFormProps {
  confirm: (input: { userCode: string }) => Promise<ConfirmOutcome>
  /** The code from `?code=`, if the person followed the link the daemon printed. */
  initialCode?: string
}

/**
 * The one sentence every refusal produces. Exported so the test can assert that
 * it does not depend on *which* refusal it was.
 */
export const CODE_REJECTED_MESSAGE =
  'That code did not work. Check it, or run flue link again for a fresh one.'

const UNAVAILABLE_MESSAGE = 'Something went wrong at our end. Try again in a moment.'

/**
 * The longest string sent to the server, matching the route's validator.
 *
 * A code is eight letters and a dash; the slack is for a paste that brought
 * whitespace or a URL fragment with it. Anything past this is not somebody's
 * code, and the server refuses whatever does not normalize to exactly eight
 * letters of its alphabet regardless.
 */
const MAX_CODE_INPUT = 64

/** Which of the two failures happened. Only one of them is about the code. */
type Failure = { kind: 'refused' | 'unavailable'; message: string }

export function EnrollForm({ confirm, initialCode }: EnrollFormProps) {
  const [code, setCode] = useState(initialCode ?? '')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [connected, setConnected] = useState<{ deviceId: string; label: string } | null>(null)

  async function onConfirm(event: FormEvent) {
    event.preventDefault()
    // A double-click is one authorization, not two. The server makes a repeat
    // confirmation of your own code a no-op, but a second in-flight request
    // would still race the daemon's approving poll, and the person pressing
    // would have no idea either request existed.
    if (busy) return
    setBusy(true)
    setFailure(null)
    try {
      const result = await confirm({ userCode: code })
      if (result.ok) {
        // Announced as well as rendered. The card below says the same thing at
        // length and stays put; the toast is what catches the eye of somebody
        // who pressed the button and looked back at their terminal.
        toast.success(`${result.label} is connected`)
        setConnected({ deviceId: result.deviceId, label: result.label })
      } else setFailure({ kind: 'refused', message: CODE_REJECTED_MESSAGE })
    } catch {
      // The call never landed. That is not a verdict on the code, and is not
      // rendered as one — the field stays valid and the machine stays
      // unconnected.
      setFailure({ kind: 'unavailable', message: UNAVAILABLE_MESSAGE })
    } finally {
      setBusy(false)
    }
  }

  if (connected) {
    return (
      <Page>
        <Card>
          <CardContent>
            <Empty className="border-0 p-0">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <MonitorCheckIcon />
                </EmptyMedia>
                {/* The label the daemon gave itself and the id it derived from
                    its own key: the two things that let a person tell which
                    machine they just handed an account to. */}
                <EmptyTitle>{connected.label} is connected</EmptyTitle>
                <EmptyDescription>
                  It is enrolled to your account. The machine picks this up on its next poll,
                  within a few seconds — you can close this page.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Badge variant="secondary">
                  <code>{connected.deviceId}</code>
                </Badge>
                {/* Two ways on, side by side on anything wider than a phone
                    and stacked below it — full width there, because a pair of
                    half-width buttons at 390px is two truncated labels. */}
                <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
                  <Button asChild className="sm:w-auto">
                    <a href="/devices">
                      <MonitorSmartphoneIcon data-icon="inline-start" />
                      Your machines
                    </a>
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setConnected(null)
                      // The code that got here is spent — the approving poll
                      // deletes the grant. Leaving it in the field would invite
                      // a second press that can only fail.
                      setCode('')
                      setFailure(null)
                    }}
                  >
                    Connect another machine
                  </Button>
                </div>
              </EmptyContent>
            </Empty>
          </CardContent>
        </Card>
      </Page>
    )
  }

  const invalid = failure?.kind === 'refused'

  return (
    <Page>
      {/* The form wraps the whole card so the submit button can live in the
          footer without being associated to a form by id. */}
      <form onSubmit={onConfirm}>
        <Card>
          <CardHeader>
            <CardTitle>
              {/* A real heading inside CardTitle, which is a styled div: this
                  is the page's only h1, and Tailwind's preflight resets the
                  element's own size so it inherits the card's title styling. */}
              <h1>Connect a machine</h1>
            </CardTitle>
            <CardDescription>
              Run <code>flue link</code> on the machine you want to reach from here. It prints a
              code — type it below.
            </CardDescription>
          </CardHeader>

          <CardContent>
            <FieldGroup>
              <Field data-invalid={invalid || undefined}>
                <FieldLabel htmlFor="user-code">Enrolment code</FieldLabel>
                <Input
                  id="user-code"
                  name="userCode"
                  // Not `one-time-code`: this is typed from another screen, not
                  // received, and offering to autofill it from an SMS is noise.
                  autoComplete="off"
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  autoFocus
                  required
                  maxLength={MAX_CODE_INPUT}
                  aria-invalid={invalid || undefined}
                  value={code}
                  // Uppercased in state, not with a CSS transform: the value
                  // really is what is shown, so copying it back out gives the
                  // code. The server normalizes anyway — this is only so the
                  // field matches the terminal it was read from.
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                />
                <FieldDescription>
                  Eight letters, as shown by <code>flue link</code>. Capitals and the dash are
                  optional.
                </FieldDescription>
                {failure ? <FieldError>{failure.message}</FieldError> : null}
              </Field>
            </FieldGroup>
          </CardContent>

          <CardFooter>
            <Button type="submit" disabled={busy}>
              {busy ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <PlugZapIcon data-icon="inline-start" />
              )}
              {busy ? 'Connecting…' : 'Connect machine'}
            </Button>
          </CardFooter>
        </Card>
      </form>
    </Page>
  )
}

/**
 * The one-card page both states sit in, so switching between them does not
 * move.
 *
 * `flex-1`, not `min-h-svh`: the root layout already owns a full-height column
 * and put a header above this, so claiming the viewport height again here
 * would make the page one header taller than the window and scroll for
 * nothing. Same width as the sign-in card — these two screens are seen minutes
 * apart and a card that changes size between them reads as a different app.
 */
function Page({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex flex-1 items-center justify-center p-4 sm:p-6">
      <div className="w-full max-w-sm">{children}</div>
    </main>
  )
}
