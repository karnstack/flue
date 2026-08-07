import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useSearch } from '@tanstack/react-router'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { loadOrCreateDeviceKey, savePinnedDaemonKey, type DeviceKey } from '@/crypto/keys'
import { cn } from '@/lib/utils'

/**
 * Where the ceremony is completed; `internal/daemon/pairing.go`, PairPath.
 *
 * The ceremony is a second device scanning a code shown on a first, and the
 * daemon handing back its static key over the connection the user themselves
 * established — which is the whole basis of the pin.
 */
const PAIR_ENDPOINT = '/api/pair'

/** A Noise static key, in bytes. Anything else is not one. */
const KEY_BYTES = 32

/**
 * The one status that means the request reached the daemon's pairing handler.
 *
 * That is the guarantee, and it is narrower than "the token was redeemed". The
 * daemon answers a pairing attempt with 200 or 403 and nothing else
 * (`writePairOutcome`), but several of its 403s are decided *before* redeem: no
 * pairing identity configured, a body that would not parse, a missing token, a
 * public key that is not 32 bytes, a failed provenance check, a request that
 * went away mid-body. Those left the window open. They cannot be told apart from
 * the ones that closed it — the uniformity is deliberate, see refusePair — and
 * they do not need to be, because every one of them is deterministic: the same
 * page posting the same body a second time fails the same check. Re-offering
 * Pair there would be offering a loop, so treating the whole of 403 as the end
 * of the ceremony withholds no button that could have worked.
 *
 * What matters is the other direction, and it holds: nothing in front of the
 * daemon answers 403. The relay reserves it for a `pairResult` and rejects what
 * it judges alone with a status of its own — 400 for a foreign Origin or a body
 * it could not parse, 413 over the size cap, 429 over the concurrency cap, 503
 * with no daemon leg attached, 504 at its deadline, 502 for an answer it could
 * not pass on (relay/src/hub.ts, pairRejected). The daemon's own origin adds 503
 * `ErrNoAuth`, 405 and 500. None of those presented a token to anything, so the
 * user's two minutes are still theirs and the Pair button stays.
 *
 * The one thing this cannot see is an intermediary that writes a 403 of its own
 * — an edge rule, a corporate proxy — which is indistinguishable from the
 * daemon's here and costs the user a fresh code from Devices. The alternative is
 * matching on a body any of those could also forge, which would trade a rare
 * wasted window for a spendable one.
 */
const REFUSED_STATUS = 403

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

/**
 * What a device is told when the daemon answered as a key other than the one
 * the QR named.
 *
 * This is the attack the pinned key exists to catch, so it is stated as one.
 * Nothing was paired with the machine whose code was scanned — whatever
 * answered is something else — and the only safe move is to go back to the
 * screen that draws the code and start again.
 */
const IMPOSTOR_NOTE =
  'This pairing link is being tampered with — the daemon that answered is not the one in the QR. Nothing was paired with the machine you scanned. Start again from Devices.'

/**
 * What a device is told after a 200 it cannot finish.
 *
 * Deliberately not the impostor's message and deliberately not "nothing was
 * kept": a 200 means the daemon has already written this device into its
 * registry. The pairing is half-done — real on the daemon, useless here — and
 * the paired browser is now listing a row the user has no working half of. The
 * only thing that clears it is a revoke there, so that is what this says.
 */
const ORPHAN_NOTE =
  'The paired browser now lists this device even so — open Devices there and revoke it.'

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
 * A pairing that did not happen, and whether there is any point pressing Pair
 * again.
 *
 * `spent` is the difference between a request the daemon's pairing handler read
 * and everything else. Read is enough, and it stays enough now that a wrong
 * token no longer closes the window: this page's token comes out of the URL and
 * never changes, so whatever refused it — redeem, or a check ahead of redeem —
 * will refuse the identical retry just as flatly (see REFUSED_STATUS). Either
 * way the button would be a click that cannot work. The one thing the daemon's
 * 403 no longer means is that the *user's* window is over; only that this
 * device's attempt at it is. A request that never got that far spent nothing, whether it was never
 * sent or whether the relay in front of the daemon answered instead, and
 * pressing Pair again is a fair thing to offer. Neither case ever retries on its
 * own.
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
 * The daemon's static key as the QR carries it: unpadded URL-safe base64.
 *
 * `?k=` is spliced into the pairing URL raw by the daemon — see conn.go, which
 * does the same with the token — so the alphabet is RFC 4648 §5 and there is no
 * padding to strip. Anything that is not exactly 32 bytes of that is not a
 * Noise static key and is refused as one, rather than being rounded off into a
 * shorter string that happens to decode.
 */
function keyFromLink(text: string): Uint8Array | null {
  if (text === '' || /[^A-Za-z0-9_-]/.test(text)) return null
  const std = text.replace(/-/g, '+').replace(/_/g, '/')
  const key = fromBase64(std.padEnd(Math.ceil(std.length / 4) * 4, '='))
  return key !== null && key.length === KEY_BYTES ? key : null
}

/** Longer than any refusal written for a person; the daemon's own is two
 *  words. */
const MAX_QUOTED = 200

/**
 * Whether a refusal is a message this page will repeat to a user.
 *
 * Anything much longer than a sentence, or anything carrying a tag or a line
 * break, was not written for a person — it is a proxy's error page or a stack
 * trace, and this endpoint has intermediaries in front of it that can produce
 * either. React would escape it and it would still be the wire on the screen
 * where a sentence belongs.
 *
 * Applied to the relay's JSON envelope as well as to bare text, because only
 * one end of that envelope is the daemon: the relay writes its own refusals
 * into the same shape, and the page cannot tell whose words it is holding.
 */
function quotable(text: string): boolean {
  return text !== '' && text.length <= MAX_QUOTED && !/[<>\n]/.test(text)
}

/**
 * What the far end said about a refusal, in words a person can read.
 *
 * This page is served over two transports and they answer the same refusal
 * differently. The daemon's own origin writes `pairing refused` as text/plain
 * (`http.Error`, in writePairOutcome); the relay cannot carry a bare text body
 * over its control channel and answers `{"error":"pairing refused"}` instead —
 * spec/relay-protocol.md, `pairResult.body` — and writes its own rejections into
 * that same envelope with words of their own. So the body is read once and read
 * both ways: as that envelope first, and as plain text when it is not one.
 *
 * Anything else comes back empty and the caller says what it knows instead. A
 * body with no message in it, and a page of HTML from something in the middle,
 * are both things the user would be shown raw otherwise — which is showing them
 * the wire rather than telling them what happened.
 */
async function refusalText(res: Response): Promise<string> {
  const body = await res.text().then(
    (text) => text.trim(),
    () => '',
  )
  if (body === '') return ''
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return quotable(body) ? body : ''
  }
  const said = (parsed as { error?: unknown } | null)?.error
  if (typeof said !== 'string') return ''
  const trimmed = said.trim()
  return quotable(trimmed) ? trimmed : ''
}

/**
 * Whether two keys are the same key.
 *
 * Length first, then every byte, without an early exit. Both operands are
 * public keys — one from a QR the user photographed, one from an HTTP response
 * — so there is no secret here for a timing side channel to leak; the loop runs
 * to the end because writing the cheap version of a key comparison teaches the
 * next reader of this file the wrong habit.
 */
function sameKey(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
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
 * The QR carries two things and both are read here: the token in `?t=`, and the
 * daemon's static public key in `?k=`. The key is the one this device pins, and
 * the answer to the POST below is only ever checked against it — the code on
 * the screen is the trusted channel, not the request.
 *
 * The route id is written out rather than imported from src/router.tsx:
 * importing it would close a cycle, since the router imports this component.
 * The literal is not unchecked — `from` is typed against the registered route
 * tree, so a path that drifts is a compile error rather than an empty object at
 * runtime.
 */
export function PairRoute() {
  const { t, k } = useSearch({ from: '/pair' })
  /*
   * The route's validateSearch narrows `t` and `k` to non-empty strings, and
   * the types here say it did — but a route's search is its parent's merged
   * with its own, and the root route has no schema at all, so what actually
   * arrives is whatever the URL parsed to. A link carrying ?t twice parses to
   * an array, and an array is not a token. Measured rather than believed,
   * because one of these values is posted at the daemon and the other is the
   * key everything this device ever says to it will be sealed to.
   */
  const token = typeof t === 'string' ? t : ''
  const carried = typeof k === 'string' ? k : ''

  /**
   * The daemon's static key, from the QR and from nowhere else.
   *
   * This is the pinning. The QR is drawn on a screen the user physically
   * controls and read by a camera, which is the one leg of this ceremony no
   * intermediary can sit in; the POST below and its answer travel exactly the
   * channel Noise IK exists to protect. So the key is taken from the link, and
   * the answer's `daemonPub` is only ever *checked against* it — a device that
   * pinned whatever answered would be doing trust-on-first-use over the
   * attacker's own wire.
   *
   * Memoised on the raw parameter rather than recomputed, because a fresh
   * Uint8Array every render is a fresh effect dependency every render.
   */
  const pinned = useMemo(() => keyFromLink(carried), [carried])

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
    // Nothing is generated and nothing is asked of the daemon without a token
    // and a key: a visitor who arrived here by hand is reading an explanation,
    // not beginning a ceremony, and a link with no key in it cannot begin one
    // that would be safe to finish.
    if (token === '' || pinned === null) return

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
  }, [token, pinned])

  /**
   * The whole exchange as one answer: null when this device is paired, and a
   * Failure when it is not.
   *
   * Whatever refused is quoted verbatim, in whichever of the two shapes it
   * answered in — see refusalText. It is the thing that refused, this page has
   * no better account of why than it does, and a paraphrase would be this page
   * inventing a reason.
   *
   * `expected` is the key from the QR, taken as an argument rather than read
   * from the closure so that this function cannot be reached without one.
   */
  async function attempt(device: DeviceKey, expected: Uint8Array): Promise<Failure | null> {
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
      const said = await refusalText(res)
      // The one status that means this request reached the daemon's pairing
      // handler — see REFUSED_STATUS. Everything else was answered by something
      // in front of it, which presented no token to anything, so the Pair button
      // stays and the user's window stays theirs.
      const spent = res.status === REFUSED_STATUS
      return {
        text:
          said ||
          (spent
            ? 'The daemon refused the pairing.'
            : `The pairing did not get through (${res.status}).`),
        spent,
      }
    }

    const answer = (await res.json().catch(() => null)) as PairAnswer | null
    const daemonPub = typeof answer?.daemonPub === 'string' ? fromBase64(answer.daemonPub) : null
    if (daemonPub === null || daemonPub.length !== KEY_BYTES) {
      // The device is registered by now — this is a 200 — but a device that
      // cannot read what the daemon answered has nothing to check the QR's key
      // against, so this is a failure however the daemon sees it. It is a
      // failure with a device in the registry, which is what ORPHAN_NOTE says.
      return {
        text: `The daemon took this device but answered with a key that could not be read. ${ORPHAN_NOTE}`,
        spent: true,
      }
    }

    // The check the QR is for. Whatever answered has to be the daemon named on
    // the screen the user scanned, and nothing else will do: the alternative is
    // pinning a key handed over the very channel the pin protects. A mismatch
    // is reported as tampering rather than as an error, because that is what it
    // is — and unlike the branch above, nothing was registered under this
    // device's key on the machine the user actually meant.
    if (!sameKey(daemonPub, expected)) {
      return { text: IMPOSTOR_NOTE, spent: true }
    }

    try {
      // `expected`, not `daemonPub`. They are equal by the line above, and this
      // says which of the two is the trusted one.
      await savePinnedDaemonKey(expected)
    } catch {
      return {
        text: `This browser would not keep the daemon’s key, so this device cannot reach it. ${ORPHAN_NOTE}`,
        spent: true,
      }
    }
    return null
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (key === null || pinned === null || sending) return
    const named = label.trim() || FALLBACK_LABEL
    setFailure(null)
    setSending(true)
    void attempt(key, pinned).then((outcome) => {
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
   * A token with no key beside it. The daemon writes both into every link it
   * hands out, so this is a link that was saved, retyped, forwarded through
   * something that rewrote it — or fabricated.
   *
   * The tempting fallback is to pair anyway and pin whatever the daemon
   * answers. That is precisely the trust-on-first-use this parameter exists to
   * end: the answer arrives over the channel an intermediary would be sitting
   * in, so a device that accepted it would pin the intermediary and never know.
   * So nothing is generated, nothing is sent, and the page says why.
   */
  if (pinned === null) {
    return (
      <Frame title="This link cannot pair anything">
        <p className={PROSE}>
          A pairing link carries the daemon’s own key, and this one does not carry a usable one — so
          this device has no way to tell the real daemon from something answering in its place.
          Nothing has been sent.
        </p>
        <p className={PROSE}>
          Scan the code Devices is showing on the paired browser right now. A link that was saved,
          retyped or passed through something that shortened it has lost the part that makes pairing
          safe.
        </p>
      </Frame>
    )
  }

  /*
   * A refusal the daemon itself answered is the end of this page. Either the
   * window closed on that presentation — which it does when the token was the
   * right one — or whatever refused it will refuse an identical retry
   * identically, and this page has no second token to offer. A button that
   * cannot work is worse than no button, because it reads as though the
   * ceremony is still in reach.
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
            The one filled control on the page, taking its teal from --primary
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
