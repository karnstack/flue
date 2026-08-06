/*
 * What a tab on a *hosted* relay is a session of.
 *
 * On loopback and on a self-hosted relay a tab needs no such thing: the origin
 * is the machine, and the daemon it speaks to is the one this browser paired
 * with. flue.sh is one origin in front of every machine on every account, so a
 * tab there has to know three more facts before it can open anything —
 *
 *   which machine       the device id, which is the record its static key is
 *                       pinned under and the name it uses to ask for a token
 *   which key           the daemon's Noise static, which the IK initiator names
 *                       as the responder's; without it the handshake is built
 *                       against whatever this browser happened to pin last
 *   which control plane where the *next* token comes from, sixty seconds after
 *                       the one in the fragment
 *
 * — and all three arrive in the fragment `openSession` navigated here with
 * (app/src/server/devices.ts). A fragment is whatever the link someone clicked
 * put there, so the first two are checked against each other before either is
 * believed: a device id *is* the hash of the key it names, which makes the
 * handoff self-proving (`namesItsOwnKey`, and the two attacks it stops).
 *
 * This module turns that handoff into a session, and turns a *reload* of the
 * same tab back into one: the fragment is scrubbed as it is read, so without
 * something remembered a refresh would land on a page with a pinned key it
 * cannot find and no token it can use.
 *
 * What is remembered, and where. `sessionStorage`, holding the device id and
 * the control plane's origin — per tab, gone when the tab closes, and neither
 * value is a secret (the id is public, the origin is in the address bar of the
 * page that sent the user here). The key itself is *not* in there: it lives in
 * the key store beside this browser's own private key, which is where key
 * material belongs. And the token is in neither, deliberately — it is a bearer
 * credential with a sixty-second life, and a copy of one at rest is a copy that
 * can be replayed. A reload mints a fresh one instead.
 */
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { loadPinnedDaemonKeyFor, savePinnedDaemonKeyFor } from '@/crypto/keys'
import type { RelayHandoff } from '@/lib/url'
import { refreshClientToken } from './control-plane'

/** A Noise X25519 static public key is 32 bytes. Nothing else is one. */
const KEY_BYTES = 32

/** Twelve hex characters — 48 bits of the digest, as Go slices it. */
const DEVICE_ID_LENGTH = 12

/**
 * Where the two non-secret facts survive a reload.
 *
 * One key holding both, as JSON, because they are one fact — "this tab is a
 * session on that machine, opened from that control plane" — and two keys is
 * two ways for half of it to be missing.
 */
const SESSION_KEY = 'flue.relay.session'

/** What this tab is, once the handoff (or the reload) has been resolved. */
export interface RelaySession {
  /** The machine at the far end: 12 hex characters. */
  deviceId: string
  /** Its Noise static public key, pinned under that id. */
  daemonPub: Uint8Array
  /** The origin to ask for the next channel token. */
  controlPlane: string
  /**
   * The token the fragment carried, or null on a reload.
   *
   * Spent on the first dial and never again — see `channelTokenSource`.
   */
  token: string | null
}

/**
 * Resolve this tab into a session, or null if it is not one.
 *
 * Two ways in, and the first one wins: a handoff that has just been read out of
 * the fragment, or what a previous load of this same tab left behind. Null for
 * everything else — a self-hosted relay (which hands out no session and asks
 * for no token), a bookmarked hosted-relay URL whose fragment is long gone, a
 * browser whose key store will not open.
 *
 * Every failure lands on that same null rather than throwing. The caller's
 * answer to a null is the explainer screen, and there is no partial session
 * worth building: a tab with an id and no key cannot handshake, and a tab with
 * a key and no control plane cannot survive its first minute.
 */
export async function resolveRelaySession(
  handoff: RelayHandoff | null,
  store: Storage | null = safeSessionStorage(),
  here: string = location.origin,
): Promise<RelaySession | null> {
  try {
    if (handoff) return await adopt(handoff, here, store)
    return await restore(here, store)
  } catch {
    // A key store that will not open (private browsing, a blocked origin, a
    // refused quota) is not a session, and a rejected promise at the entry
    // point would mount no app at all.
    return null
  }
}

/**
 * A handoff, taken as this tab's session: pin the key, remember the rest.
 *
 * The key is pinned *before* the tab is remembered, so a store that refuses the
 * write leaves nothing behind claiming there is a session to restore.
 */
async function adopt(
  handoff: RelayHandoff,
  here: string,
  store: Storage | null,
): Promise<RelaySession | null> {
  const daemonPub = decodeKey(handoff.daemonKey)
  const controlPlane = originOf(handoff.controlPlane, here)
  if (!daemonPub || !controlPlane) return null
  // Before anything is written down. See `namesItsOwnKey`.
  if (!namesItsOwnKey(handoff.deviceId, daemonPub)) return null

  await savePinnedDaemonKeyFor(handoff.deviceId, daemonPub)
  try {
    store?.setItem(
      SESSION_KEY,
      JSON.stringify({ deviceId: handoff.deviceId, controlPlane }),
    )
  } catch {
    // A full or disabled sessionStorage costs this tab its reload, and nothing
    // else. The session it is in the middle of opening still works.
  }

  return { deviceId: handoff.deviceId, daemonPub, controlPlane, token: handoff.token }
}

/** The session a previous load of this same tab left behind, or null. */
async function restore(here: string, store: Storage | null): Promise<RelaySession | null> {
  const raw = store?.getItem(SESSION_KEY)
  if (!raw) return null

  let saved: { deviceId?: unknown; controlPlane?: unknown }
  try {
    saved = JSON.parse(raw) as typeof saved
  } catch {
    return null
  }
  if (typeof saved.deviceId !== 'string' || typeof saved.controlPlane !== 'string') return null

  const controlPlane = originOf(saved.controlPlane, here)
  if (!controlPlane) return null

  // The key store is the authority on the key, exactly as it is for a
  // self-hosted browser. No key means no session: a handshake cannot be built,
  // and asking for a token to open one would be asking for a credential this
  // tab could not spend.
  const daemonPub = await loadPinnedDaemonKeyFor(saved.deviceId)
  if (!daemonPub) return null
  // The same check on the way out of the store as on the way in, so the
  // invariant is one sentence rather than two: a key filed under an id hashes
  // to that id. `adopt` can no longer write a record that fails this; what it
  // catches is one written by a build before that check existed.
  if (!namesItsOwnKey(saved.deviceId, daemonPub)) return null

  // No token, on purpose. Nothing at rest holds one, so the first dial after a
  // reload mints its own — which is the same path every reconnect takes.
  return { deviceId: saved.deviceId, daemonPub, controlPlane, token: null }
}

/**
 * How the relay socket gets a channel token for each dial, or null when there
 * is no session and none is wanted.
 *
 * The handoff's token is spent on the first dial and then dropped: it was
 * minted a moment ago, so using it saves a round trip on the one dial where the
 * user is watching, and it works even if the control plane is having a bad
 * second. Every dial after it re-mints — which is the whole point, because that
 * first token is dead sixty seconds later and the reconnect that needed it may
 * be an hour away.
 *
 * Null for a self-hosted relay: it authorizes no browser at all, and offering a
 * subprotocol nobody will echo would break the connection rather than secure it
 * (./socket, `subprotocols`).
 */
export function channelTokenSource(
  session: RelaySession | null,
): (() => Promise<string>) | null {
  if (!session) return null
  let first = session.token
  return async () => {
    if (first !== null) {
      const token = first
      first = null
      return token
    }
    return refreshClientToken(session.controlPlane, session.deviceId)
  }
}

/**
 * Whether `deviceId` is the name this key actually has.
 *
 * A device id *is* `hex(sha256(publicKey))[:12]` — `DeviceID` in
 * internal/crypto/devices.go, `deviceIdFor` in app/src/lib/device-id.ts, and
 * this. So a handoff carries its own proof that `k` and `d` are one machine's
 * pair, and checking it costs one hash.
 *
 * **What the check closes: poisoning.** `k` and `d` arrive in the fragment,
 * which is whatever the link someone clicked put there. Taken on trust, a `d`
 * naming the victim's machine beside a `k` that is anything else overwrites the
 * pinned record for that machine — deliberately, and for good reasons
 * (crypto/keys.ts) — and every later session with it builds its Noise IK
 * handshake against a static the daemon cannot prove. `readMessageB` throws,
 * the socket reports an ordinary close, and the tab reconnects into the
 * identical failure for as long as it is open, with nothing on screen to say
 * why. A crafted link becomes a lasting denial of service for one machine in
 * one browser. That inconsistent pair is exactly what this refuses.
 *
 * **What it does NOT close: substitution.** A `k` and `d` that are both the
 * *attacker's* machine pass this check, because the pair is self-consistent — a
 * real machine's key under that key's real name. With a live `t` the real
 * control plane minted for that machine, such a link opens one dial into a box
 * somebody else owns, on the genuine `relay.flue.sh` origin with its genuine
 * certificate, while every signal on the screen says flue.sh is at the other
 * end. That residual is OPEN, and docs/FOLLOW-UPS.md item 14 ("Left standing")
 * carries it. Closing it means not taking `k` from the fragment at all: fetch
 * the named device's public key from the control plane under the session
 * cookie, which answers only for machines the caller owns, so a link can no
 * longer name a machine the user does not.
 *
 * It is one dial rather than a session, and that bound is *enforced* rather
 * than free. The victim's next refresh names a device their cookie does not own
 * and is answered 403 (app/src/server/refresh-token.ts) — but only because the
 * refresh reached the real control plane, which takes both of the checks in
 * `originOf` and `RelayCSP`. The same link with an `a=` of the attacker's
 * choosing would have been refreshed by the attacker, and one dial would have
 * been a session lasting as long as the tab stayed open.
 *
 * Neither half goes wrong through the control plane itself: `openSession` reads
 * `k` and `d` out of the same row, so they cannot disagree. The check is not
 * about distrusting it; it is about the fragment being an input like any other.
 *
 * Compared exactly, and in lower case, over the whole string. An id is twelve
 * hex characters in lower case everywhere it is written — the daemon computes
 * it, the control plane stores it — so a case-insensitive or prefix comparison
 * would only widen what counts as a match, and this is the one place where
 * being generous is the bug.
 *
 * ("in lower case" is spelled out because the one-word form is a Tailwind
 * utility, and prose in a comment compiles — see styles.build.test.ts.)
 */
function namesItsOwnKey(deviceId: string, publicKey: Uint8Array): boolean {
  return deviceId === bytesToHex(sha256(publicKey)).slice(0, DEVICE_ID_LENGTH)
}

/** base64url (or base64) to a 32-byte key, or null if it is not one. */
function decodeKey(encoded: string): Uint8Array | null {
  const standard = encoded.replaceAll('-', '+').replaceAll('_', '/').replace(/=+$/, '')
  if (!/^[A-Za-z0-9+/]+$/.test(standard)) return null
  let binary: string
  try {
    binary = atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, '='))
  } catch {
    return null
  }
  if (binary.length !== KEY_BYTES) return null
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}

/**
 * The origin of a URL the fragment named, or null — checked against `here`, the
 * origin this page was itself served from.
 *
 * Reduced to an origin rather than kept as it arrived, so a handoff carrying a
 * path, a query or a credential in the authority cannot become part of the URL
 * this tab later posts to. `https:` only, with one exception: a loopback host,
 * because `vite dev` and a local `wrangler dev` are both plain http and a
 * browser treats loopback as a trustworthy origin for exactly this reason.
 * Everything else is refused — `javascript:`, `data:`, and plain http to a
 * public host, which would be a credentialed POST over a network anyone can
 * read.
 *
 * **And it must be same-site with the page.** That is the check that matters,
 * and it used to be absent — any `https:` origin at all was taken.
 *
 * The attack it closes runs through the *substitution* residual in
 * `namesItsOwnKey`. A link naming the attacker's own machine passes every check
 * above, so it opens one dial into a box they own; the bound on it is that the
 * *next* token has to come from `app.flue.sh`, which answers 403 for a device
 * the victim's cookie does not own. A crafted `#a=https://evil.example` moves
 * that decision to the attacker: their proxy relays the refresh to the real
 * control plane, hands back a genuine token for their own machine, and one dial
 * becomes a session that lasts as long as the tab is open — on the genuine
 * relay origin, with its genuine certificate, with nothing on screen to say so.
 * The 403 was never the bound; the origin the refresh goes to was.
 *
 * Same-*site* rather than same-origin, because the refresh is legitimately
 * cross-origin: `relay.flue.sh` fetches from `app.flue.sh`. That pairing is
 * already forced by the cookie — `SameSite=Lax` withholds the session cookie
 * from a cross-*site* request, so a control plane on another registrable domain
 * could never have been refreshed from here anyway (docs/SAAS.md). Requiring it
 * here turns a deployment fact into a check, and costs no working deployment
 * anything.
 *
 * Two controls rather than one, deliberately. `connect-src 'self'
 * https://app.flue.sh` (internal/daemon.RelayCSP) is the bound that does not
 * depend on this code being right; this is the bound that does not depend on
 * the deployment, which matters because a self-hosted relay whose control plane
 * is its own gets the same policy string and so allows an origin it never uses.
 */
function originOf(value: string, here: string): string | null {
  let url: URL
  let page: URL
  try {
    url = new URL(value)
    page = new URL(here)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') {
    // `LOOPBACK` in ./mode is the same list, for the same reason: the daemon
    // binds loopback and nothing else, so these are the only hosts a local
    // development control plane can be on.
    if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname)) return null
  }
  if (!sameSite(url, page)) return null
  return url.origin
}

/** Hosts a plain-http control plane may be on. See `originOf`. */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/**
 * Whether two URLs are same-site, in the sense the cookie uses: same scheme,
 * and hostnames under one registrable domain.
 *
 * The scheme is part of it because `SameSite` has been schemeful since 2020 —
 * `http://app.flue.sh` and `https://relay.flue.sh` are cross-site to a modern
 * browser, so a check that called them same-site would allow an `a=` whose
 * refresh could never carry a cookie anyway.
 *
 * The registrable domain is the approximation, and it is worth naming as one:
 * doing it exactly needs the Public Suffix List, which is a megabyte of data
 * that changes weekly and would be shipped to a terminal emulator to decide one
 * string comparison. The last two labels are right for `flue.sh` and for every
 * ordinary domain; they are wrong in one direction for a multi-label suffix
 * (`a.co.uk` and `b.co.uk` look same-site and are not), which is a gap only for
 * a self-hoster parked under such a suffix, and only alongside an attacker who
 * has registered a neighbour under it. On flue.sh itself the CSP is the tighter
 * of the two bounds and names one origin, so this being generous costs nothing
 * there.
 *
 * Loopback is a special case in the other direction: `localhost` and
 * `127.0.0.1` are separate sites to a browser, but they are one machine to a
 * developer running `vite dev` beside `wrangler dev`, and a page on loopback
 * fronts no account.
 */
function sameSite(a: URL, b: URL): boolean {
  if (a.protocol !== b.protocol) return false
  if (LOOPBACK.has(a.hostname) && LOOPBACK.has(b.hostname)) return true
  const site = registrableDomain(a.hostname)
  return site !== null && site === registrableDomain(b.hostname)
}

/**
 * The last two labels of a hostname — its registrable domain, near enough. See
 * `sameSite` for what "near enough" is doing there.
 *
 * An IP literal and a single-label name are their own site: there is nothing to
 * strip, and slicing two labels off `127.0.0.1` would produce `0.1`, which
 * several unrelated addresses would agree on.
 */
function registrableDomain(hostname: string): string | null {
  if (!hostname) return null
  if (hostname.startsWith('[') || /^[0-9.]+$/.test(hostname)) return hostname
  const labels = hostname.split('.')
  if (labels.some((l) => l === '')) return null
  return labels.length < 2 ? hostname : labels.slice(-2).join('.')
}

/**
 * `sessionStorage`, or null where reading it throws.
 *
 * It does throw: a browser with site data blocked raises a SecurityError on the
 * *property access*, before any method is called. A tab without it still opens
 * its session; it just cannot survive a reload.
 */
function safeSessionStorage(): Storage | null {
  try {
    return sessionStorage
  } catch {
    return null
  }
}
