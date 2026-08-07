/*
 * Which of the two ways this page was served, and what this browser holds for
 * the harder one.
 *
 * The same build is served by the daemon over loopback and by the relay from a
 * public origin, and the transport underneath it is not the same in the two
 * cases: on loopback the socket at /ws *is* the daemon, and on a relay origin
 * the far end of the socket is a Worker that can read nothing (see ./socket).
 * The tab has to know which it is before it opens anything, and the only
 * evidence it has is the host it was served from.
 *
 * There is no build flag for this and there must not be one: the daemon and the
 * relay serve the same bytes, and a page that decided its own transport at
 * build time would be a second artefact to keep honest.
 */
import { loadOrCreateDeviceKey, loadPinnedDaemonKey } from '@/crypto/keys'
import type { RelayIdentity } from './socket'

/**
 * Every host the daemon can serve this app from.
 *
 * It binds loopback and only loopback (`listenAddr` in internal/daemon), so
 * this list is complete by construction rather than by guesswork — which is
 * what makes the negative safe to draw. `[::1]` carries its brackets because
 * that is how a URL spells an IPv6 host and how `location.hostname` reports one.
 */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * True when this page was served by a relay rather than by the daemon.
 *
 * By elimination, and deliberately so: a workers.dev origin, a custom domain,
 * an origin nobody has thought of yet — all of them are "not the daemon", and
 * the failure mode of the elimination is the safe one. An unrecognised host
 * treated as a relay speaks Noise to something that has to prove it holds the
 * pinned key; an unrecognised host treated as loopback would send the session
 * cookie and the terminal's bytes to whoever served the page.
 */
export function isRelayOrigin(loc: { hostname: string } = location): boolean {
  return !LOOPBACK.has(loc.hostname)
}

/**
 * What this browser can prove about itself and about the daemon it belongs to,
 * or null when it can prove nothing.
 *
 * Null means one screen: the explainer at src/routes/unpaired.tsx. It is not a
 * failure to retry — a browser with no daemon key has no daemon to retry
 * against — and pairing is the only thing that changes the answer.
 *
 * The daemon key is read first and this browser's own key only after it. A
 * browser that has never paired must leave here with nothing written: minting a
 * private key for a tab that cannot reach anything would be storing a secret
 * nobody asked for, and /pair makes its own when a ceremony actually begins.
 *
 * A key store that will not open at all — private browsing, a blocked origin, a
 * quota refused — lands on the same null. There is no identity to be had either
 * way, and the alternative is a rejected promise at the entry point, which
 * mounts no app and tells the user even less than the explainer does.
 */
export async function loadRelayIdentity(): Promise<RelayIdentity | null> {
  try {
    const daemonPub = await loadPinnedDaemonKey()
    if (daemonPub === null) return null
    return { deviceKey: await loadOrCreateDeviceKey(), daemonPub }
  } catch {
    return null
  }
}
