import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useSearch } from '@tanstack/react-router'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { loadOrCreateDeviceKey, savePinnedDaemonKey, type DeviceKey } from '@/crypto/keys'
import { cn } from '@/lib/utils'

/** Where the ceremony is completed; `internal/daemon/pairing.go`, PairPath. */
const PAIR_ENDPOINT = '/api/pair'

/** A Noise static key, in bytes. Anything else is not one. */
const KEY_BYTES = 32

/**
 * The daemon bounds the label it stores at 64 runes and truncates anything
 * longer, so the field says so rather than silently losing the end of a name.
 * `maxLength` counts UTF-16 units, which is the same number for every label
 * that is not made of astral characters and is never fewer.
 */
const MAX_LABEL = 64

/** The name offered when the browser will not say what it is running on. */
const FALLBACK_LABEL = 'This device'

/**
 * What every failure on this page ends with.
 *
 * The daemon answers each of its refusals with the same eight bytes on purpose
 * — whether a window was open, whether the token had ever existed, whether it
 * had expired is information about the user's live ceremony and this endpoint
 * is reachable without a session token. So the page cannot say which of them
 * happened, and does the honest thing instead: it states the rule, which covers
 * all three, and points at the one screen that can start another.
 */
const EXPIRY_NOTE =
  'Pairing links work once and expire after two minutes — start again from Devices on the paired browser.'

/*
 * The page's two shared class strings, spelled out rather than assembled.
 *
 * Every token here has to stay hyphenated: styles.build.test.ts explains a
 * compiled utility by finding it inside a `className` or a `cn(...)` call, and
 * a single-word name pasted together in a constant is beyond its reach.
 */
const PROSE = 'text-base/7 text-pretty text-zinc-600 sm:text-sm/6 dark:text-zinc-400'
const FIELD_LABEL = 'text-base/6 font-medium text-zinc-950 sm:text-sm/6 dark:text-white'

/** What the daemon answers a completed pairing with; see handlePair. */
interface PairAnswer {
  deviceId?: unknown
  daemonPub?: unknown
}

/**
 * A pairing that did not happen, and whether the token went with it.
 *
 * `spent` is the difference between a daemon that answered and one that was
 * never reached. Once it has answered, the window is closed whatever it said —
 * redeem clears it on a wrong token as readily as on a right one — so offering
 * the button again would be offering a click that cannot work. A request that
 * got no answer spent nothing, and pressing Pair again is a fair thing to
 * offer. Neither case ever retries on its own.
 */
interface Failure {
  text: string
  spent: boolean
}

/** Standard base64, which is the encoding handlePair reads the key out of. */
function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** The bytes behind standard base64, or null if the text was not any. */
function fromBase64(text: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

/**
 * What to call this device before the user says.
 *
 * navigator.platform is deprecated and coarse — "iPhone", "MacIntel", "Linux
 * aarch64" — and coarse is the whole requirement: this is a starting point in
 * an editable field, not an identifier. Nothing is derived from it, and the
 * daemon derives the device's identity from its key rather than its name.
 */
function defaultLabel(): string {
  const platform = typeof navigator === 'undefined' ? '' : navigator.platform
  return platform.trim() || FALLBACK_LABEL
}

/**
 * The page around whatever it is saying.
 *
 * Centred in the viewport and no wider than a paragraph, because the device
 * reading it is a phone held in one hand: this route sits outside AppShell, so
 * there is no sidebar, no nav and no chrome of any kind — a device that is not
 * paired yet has nothing it could navigate to.
 */
function Frame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-y-5 px-5 py-10 sm:max-w-md">
      <h1 className="text-2xl/8 font-semibold tracking-tight text-zinc-950 sm:text-xl/7 dark:text-white">
        {title}
      </h1>
      {children}
    </main>
  )
}

/**
 * The new device's side of the pairing ceremony.
 *
 * It is reached by scanning the code an already-paired browser is showing, and
 * the daemon serves it without a session token because the device opening it
 * has none — getting one is what this page is for. See `withProvenance` in
 * internal/daemon/server.go for how narrow that exemption is.
 *
 * The token is read from `?t=`, and the route id is written out rather than
 * imported from src/router.tsx: importing it would close a cycle, since the
 * router imports this component. The literal is not unchecked — `from` is typed
 * against the registered route tree, so a path that drifts is a compile error
 * rather than an empty object at runtime.
 */
export function PairRoute() {
  const { t } = useSearch({ from: '/pair' })
  /*
   * The route's validateSearch narrows `t` to a non-empty string, and the type
   * here says it did — but a route's search is its parent's merged with its
   * own, and the root route has no schema at all, so what actually arrives is
   * whatever the URL parsed to. A link carrying ?t twice parses to an array,
   * and an array is not a token. Measured rather than believed, because the one
   * thing this value does is get posted at the daemon.
   */
  const token = typeof t === 'string' ? t : ''

  const [key, setKey] = useState<DeviceKey | null>(null)
  const [label, setLabel] = useState(defaultLabel)
  const [sending, setSending] = useState(false)
  const [paired, setPaired] = useState<string | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)

  /**
   * The one key load this page performs, held so both of StrictMode's mounts
   * await the same answer.
   *
   * Two `loadOrCreateDeviceKey` calls racing on an empty store both find
   * nothing and both write, and the key posted to the daemon is then not
   * certainly the key that ends up stored — a device paired under an identity
   * it does not have, which nothing would report until the first handshake
   * failed.
   */
  const pending = useRef<Promise<DeviceKey> | null>(null)

  useEffect(() => {
    // Nothing is generated and nothing is asked of the daemon without a token:
    // a visitor who arrived here by hand is reading an explanation, not
    // beginning a ceremony.
    if (token === '') return

    let live = true
    pending.current ??= loadOrCreateDeviceKey()
    void pending.current.then(
      (k) => {
        if (live) setKey(k)
      },
      () => {
        if (!live) return
        setFailure({
          text: 'This browser would not let flue keep a key for this device, so there is nothing to pair with.',
          spent: false,
        })
      },
    )
    return () => {
      live = false
    }
  }, [token])

  /**
   * The whole exchange as one answer: null when this device is paired, and a
   * Failure when it is not.
   *
   * The daemon's own words are carried out verbatim. It is the thing that
   * refused, this page has no better account of why than it does, and a
   * paraphrase would be this page inventing a reason.
   */
  async function attempt(device: DeviceKey): Promise<Failure | null> {
    let res: Response
    try {
      res = await fetch(PAIR_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          publicKey: toBase64(device.publicKey),
          label: label.trim() || FALLBACK_LABEL,
        }),
      })
    } catch {
      return {
        text: 'The daemon could not be reached, so nothing was sent.',
        spent: false,
      }
    }

    if (!res.ok) {
      const said = await res.text().then(
        (body) => body.trim(),
        () => '',
      )
      return { text: said || `The daemon refused the pairing (${res.status}).`, spent: true }
    }

    const answer = (await res.json().catch(() => null)) as PairAnswer | null
    const daemonPub = typeof answer?.daemonPub === 'string' ? fromBase64(answer.daemonPub) : null
    if (daemonPub === null || daemonPub.length !== KEY_BYTES) {
      // The device is registered by now — this is a 200 — but a device that
      // cannot name the daemon's static key can never open the handshake, so
      // this is a failure however the daemon sees it.
      return {
        text: 'The daemon took this device but answered with a key that could not be read, so nothing was kept.',
        spent: true,
      }
    }

    try {
      await savePinnedDaemonKey(daemonPub)
    } catch {
      return {
        text: 'This browser would not keep the daemon’s key, so this device cannot reach it.',
        spent: true,
      }
    }
    return null
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (key === null || sending) return
    const named = label.trim() || FALLBACK_LABEL
    setFailure(null)
    setSending(true)
    void attempt(key).then((outcome) => {
      setSending(false)
      if (outcome === null) setPaired(named)
      else setFailure(outcome)
    })
  }

  if (token === '') {
    return (
      <Frame title="Nothing to pair with yet">
        <p className={PROSE}>
          This page finishes a pairing that starts somewhere else. On the browser that is already
          paired, open Devices, press Pair device, and scan the code it shows with this device — or
          open the link printed beside it here.
        </p>
        <p className={PROSE}>{EXPIRY_NOTE}</p>
      </Frame>
    )
  }

  /*
   * A refusal the daemon answered is the end of this page. The window closes on
   * the first presentation whether or not the token was right, so a second Pair
   * could only fail the same way — and a button that cannot work is worse than
   * no button, because it reads as though the ceremony is still in reach.
   */
  const stopped = failure?.spent === true

  return (
    <Frame title={paired !== null ? 'Paired' : stopped ? 'Not paired' : 'Pair this device'}>
      {/*
        The heading carries the outcome, so the paragraph under it is only worth
        reading while there is still something to decide. Once the daemon has
        refused, what matters is its own words and what to do about them, and
        both are in the live region below.
      */}
      {!stopped && (
        <p className={PROSE}>
          {paired === null
            ? 'This device makes a key of its own. Nothing is copied from the browser you scanned, and whatever is paired here can be cut off from Devices there.'
            : 'This device can reach that machine’s sessions from now on, and Devices on the paired browser can cut it off again at any point.'}
        </p>
      )}

      {paired === null && !stopped && (
        <form onSubmit={submit} className="flex flex-col gap-y-4">
          <div className="flex flex-col gap-y-2">
            <label htmlFor="flue-pair-label" className={FIELD_LABEL}>
              Name this device
            </label>
            {/*
              Taller than the shared Input on a phone and back to its own height
              from sm up: this field is the only thing to hit on the screen, and
              the screen is a phone's. Autocorrect and capitalisation are off
              because a device name is not prose — "iphone" corrected to "I
              phone" is a name the user has to fix after the fact.
            */}
            <Input
              id="flue-pair-label"
              name="label"
              value={label}
              maxLength={MAX_LABEL}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              disabled={sending}
              className="h-10 sm:h-8"
              onChange={(e) => setLabel(e.target.value)}
            />
            <p className={PROSE}>It is what the paired browser lists this device as.</p>
          </div>
          {/*
            The one filled control on the page, taking its amber from --primary
            rather than naming a colour. Shut until the key is in hand and while
            the request is out: pairing without a key would enrol nothing, and a
            second press spends a token the first press is already spending.
          */}
          <Button
            type="submit"
            size="lg"
            disabled={key === null || sending}
            className="h-11 w-full"
          >
            {sending ? 'Pairing…' : 'Pair'}
          </Button>
        </form>
      )}

      {/*
        Always on the page, never mounted with its text. Several screen readers
        announce only changes to a live region that was already in the
        accessibility tree, so a region that appears alongside its first message
        is a message nobody hears — which is also why it is not dropped when
        empty. Empty, it contributes no line box at all, and `empty:mt-0` takes
        its own spacing with it.
      */}
      <p role="status" className={cn(PROSE, 'empty:mt-0')}>
        {paired !== null && `Paired ✓ — ${paired}. You can close this page.`}
        {failure !== null && `${failure.text} ${EXPIRY_NOTE}`}
      </p>
    </Frame>
  )
}
