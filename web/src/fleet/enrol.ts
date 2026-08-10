/*
 * How a tab on the daemon's own origin becomes a device of the fleet, and how
 * it reads the fleet directory from the one party that can reach it.
 *
 * A browser that paired over the relay holds four things: its own device key, a
 * fleet-signed certificate naming that key, the fleet's public key to check
 * every other certificate under, and a `GET /directory` on the origin that
 * served it. A tab the user opened on http://127.0.0.1:7717 holds the first and
 * none of the rest. It never ran a ceremony because it never needed one — the
 * session cookie is its credential, and it was only ever talking to the machine
 * it is on.
 *
 * That cost nothing while a browser reached one machine. It is the whole gap
 * now that the sessions screen is the fleet's: a loopback tab listed one machine
 * on a laptop that was fully joined, with nothing on any screen saying why.
 * Three records missing, and a fourth obstacle that no record would have fixed —
 * the relay's `GET /directory` is a cross-origin fetch from 127.0.0.1 and the
 * Worker sends no `Access-Control-Allow-Origin`, so the answer is discarded
 * before `readDirectory` sees a byte of it.
 *
 * The daemon that served the page answers both halves on its loopback surface
 * (internal/daemon/fleet.go): `POST /api/fleet/enrol` mints this browser a
 * device certificate and hands over the fleet public key, and
 * `GET /api/fleet/directory` fetches the relay's directory and returns those
 * bytes unchanged. Everything downstream is exactly what it was — every blob
 * still verified under the pinned fleet key, one source built per machine that
 * verifies — because the daemon added transport here and not trust.
 *
 * # Why a fleet key may be learned over this connection
 *
 * crypto/keys.ts is emphatic that it may not be learned over *a* connection,
 * and that rule is untouched. A key taken off an arbitrary connection is
 * trust-on-first-use one level up: whoever supplied it can then sign a machine
 * certificate for every machine this browser will ever dial. So the two writers
 * that existed both had the user behind them — the QR the user carried across
 * from a screen they control, and (fleet.ts, adoptFleetKey) a Noise session
 * keyed to a daemon key pinned at exactly such a ceremony.
 *
 * The narrow thing that is different here is that there is no intermediary to
 * be. The "wire" is a socket to 127.0.0.1, which the operating system routes to
 * one process on this computer and to nothing else: the process that owns the
 * fleet key, wrote it to relay.json, and served this page. Nothing sits between
 * a tab and its own daemon — no relay, no hop, no name to resolve — so there is
 * no party for the argument against wire-learned keys to be about. What answers
 * is not "a peer", it is this machine.
 *
 * Nor is any authority created. The tab calling this already holds strictly
 * more: a client that can open /ws on loopback can spawn a shell, and a shell
 * can read `~/.config/flue/relay.json`, which holds the fleet *seed* — the
 * signing half. Anyone able to reach this endpoint could already mint whatever
 * certificate they liked, for the whole fleet, without asking. The endpoint's
 * own comment (internal/daemon/fleet.go, EnrolPath) sets that argument out in
 * full, including why it is HTTP-on-loopback and must never become a wire
 * message: over the wire it *would* be an escalation, because a relay-origin
 * device cannot read relay.json.
 *
 * Which leaves the two things this module does check, and they are consistency
 * rather than trust: the certificate has to verify under the fleet key it
 * arrived beside, and it has to name this browser's own device key. Both fail
 * closed. Trust here comes from the origin; the checks are what stop a browser
 * storing a certificate it could only ever be refused for presenting.
 *
 * None of this reaches a relay-served tab. Nothing on a relay origin imports
 * this module, the endpoints do not exist there, and `adoptFleetKey`'s rule
 * about welcomes is exactly as strict as it was.
 */
import { sameKey, verifyCert } from '@/crypto/cert'
import {
  KEY_BYTES,
  loadOrCreateDeviceKey,
  loadPinnedDeviceCert,
  loadPinnedFleetKey,
  savePinnedDeviceCert,
  savePinnedFleetKey,
} from '@/crypto/keys'
import type { DirectoryAnswer, DirectoryFetch } from '@/relay/directory'

/** `POST /api/fleet/enrol` — daemon.EnrolPath. Loopback only, and behind the
 *  session token like every other /api route. */
export const ENROL_PATH = '/api/fleet/enrol'

/** `GET /api/fleet/directory` — daemon.FleetDirectoryPath. The relay's own
 *  answer, byte for byte, from a party that is allowed to ask for it. */
export const FLEET_DIRECTORY_PATH = '/api/fleet/directory'

/** The slice of `fetch` this module uses, so a test can answer without a
 *  Response implementation jsdom does not have. The same three members
 *  DirectoryAnswer names, for the same reason. */
export type EnrolPost = (path: string, body: string) => Promise<DirectoryAnswer>

/** The enrolment answer, as daemon.enrolAnswer writes it. `deviceId` and
 *  `machineId` are read past deliberately: the fleet learns which slot this
 *  machine holds from the welcome that names it, and a second source for one
 *  fact is a second thing that can disagree. */
interface EnrolBody {
  deviceCert?: unknown
  fleetPub?: unknown
}

/**
 * Ask this machine's daemon to enrol this browser, and keep what it hands back.
 *
 * Called once per fleet epoch on a loopback tab, before anything is expanded —
 * the browser has no way to know whether this daemon has seen it before, and
 * asking is cheaper than remembering. The endpoint is idempotent by lookup: a
 * key it already holds is answered with the same device id and the same
 * certificate bytes, so the second call and the two-hundredth write nothing.
 *
 * **Every failure is the same answer: false, quietly.** A daemon with no fleet
 * key answers 409 (the machine has not joined a relay, or joined one before
 * fleet keys existed), a revoked key gets 403, an old daemon 404, a fetch that
 * cannot leave the tab throws. None of them is retried here — one attempt per
 * epoch, because the cure for all of them is a change on the machine, and a tab
 * that polled an endpoint answering 409 would be a request every few seconds
 * for as long as it stayed open. A tab in that state is exactly the tab this
 * browser has always been on loopback: one machine, working.
 *
 * Returns whether this browser gained something that changes *which machines it
 * can reach* — a fleet key it did not hold, a first certificate, or a key that
 * replaced a stale one. That, and only that, is worth re-reading the directory
 * for; see FleetClient.connect. The ordinary second load reports false.
 */
export async function enrolThisBrowser(post: EnrolPost = browserPost): Promise<boolean> {
  try {
    const key = await loadOrCreateDeviceKey()
    const res = await post(ENROL_PATH, JSON.stringify({ publicKey: encodeBase64(key.publicKey) }))
    if (!res.ok) return false
    const body = JSON.parse(await res.text()) as EnrolBody | null

    const fleetPub = decodeBase64(body?.fleetPub)
    // The same width every reader in crypto/keys.ts enforces. A record of any
    // other length is one that module could never have written, and a verifier
    // handed it refuses every certificate — a browser listing no machines
    // rather than the wrong ones.
    if (fleetPub === null || fleetPub.length !== KEY_BYTES) return false
    const blob = decodeBase64(body?.deviceCert)
    if (blob === null) return false

    // Checked against the key it arrived beside, which proves nothing about the
    // daemon and is not meant to: see the exemption above. What it does prove
    // is that the two records are usable together and that the certificate is
    // this browser's own — a blob failing either is one that would be presented
    // to a sibling machine and refused, so it is better never stored.
    const cert = verifyCert(fleetPub, blob)
    if (cert === null || cert.kind !== 'device' || !sameKey(cert.device, key.publicKey)) {
      console.warn('flue: this machine offered its own browser a certificate that does not check out; ignoring it')
      return false
    }

    // Read before either write, because "was there one before this" is the
    // answer the caller acts on and the write destroys it.
    const heldKey = await loadPinnedFleetKey()
    const heldCert = await loadPinnedDeviceCert()
    const sameFleet = heldKey !== null && sameKey(heldKey, fleetPub)
    const sameCert = heldCert !== null && sameBytes(heldCert, blob)
    if (sameFleet && sameCert) return false

    /*
     * **The daemon's key wins here, where a welcome's would not.**
     * adoptFleetKey refuses to overwrite a pin and says why: two fleet keys
     * differ only if the fleet was set up again, and this browser's certificate
     * is signed by the old one, so adopting the new key alone would leave it
     * listing machines it cannot present anything to — with the ceremony as the
     * way out.
     *
     * Neither half of that holds on loopback. The certificate arrives *with*
     * the key, from the process that minted both, so the pair is coherent the
     * moment it lands rather than after somebody scans something. And there is
     * no ceremony to fall back on: a pairing link points at the relay's
     * address, which is a different origin and a different storage partition,
     * so a loopback tab that refused the overwrite would be stranded on a key
     * nothing signs under any more with no way back but clearing site data.
     *
     * The key first and the certificate second, the ordering adoptFleetCert
     * relies on for the same reason: the certificate is verified under the
     * pinned key everywhere else it is read.
     */
    if (!sameFleet) await savePinnedFleetKey(fleetPub)
    if (!sameCert) await savePinnedDeviceCert(blob)
    // A replacement certificate under the fleet key this browser already had
    // changes no machine's reachability — every machine admits any certificate
    // this fleet signed — so it is written down and reported as nothing gained.
    return !sameFleet || heldCert === null
  } catch {
    // A key store that will not open, a daemon that answered something that is
    // not JSON, a fetch the browser refused. All of them mean this tab is the
    // tab it was before: one machine, and every screen on it working.
    return false
  }
}

/**
 * Read the fleet directory through the daemon that served this page.
 *
 * The URL `readDirectory` builds is deliberately ignored. That argument names
 * the relay origin, which is precisely the origin this tab cannot fetch from —
 * the whole reason this seam exists — and one daemon reads one relay, so there
 * is nothing for the caller to choose between. What comes back is the relay's
 * own answer unchanged (daemon.handleFleetDirectory forwards the bytes), so
 * every blob in it is verified under the pinned fleet key exactly as it is when
 * a relay tab reads the same document directly.
 *
 * `no-store` for the reason the direct read gives: a directory served from a
 * cache is a revocation served late. `same-origin` credentials because this
 * route, unlike the relay's, is behind the session token.
 *
 * The honest failures arrive as a status and cost nothing but machines this
 * browser does not learn of — 404 from a daemon reading no directory at all,
 * 502 from one whose relay would not answer — because `readDirectory` treats
 * every non-ok answer as "nothing learned" and the sources built from pairing
 * records, and the loopback machine itself, stand either way.
 */
export const readDirectoryViaDaemon: DirectoryFetch = () =>
  fetch(FLEET_DIRECTORY_PATH, { cache: 'no-store', credentials: 'same-origin' })

/** The real POST: same-origin credentials, because withAuth wants the session
 *  cookie, and no cache anywhere near a credential. */
function browserPost(path: string, body: string): Promise<DirectoryAnswer> {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    cache: 'no-store',
    body,
  })
}

/** Standard base64 with padding — how Go's encoding/json reads the `[]byte`
 *  this field decodes into, and what daemon.handleEnrol expects. */
function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

/** The same alphabet on the way back. Null for anything that is not a string
 *  of it, which is every shape a daemon speaking another protocol could send. */
function decodeBase64(value: unknown): Uint8Array | null {
  if (typeof value !== 'string' || value === '') return null
  try {
    return Uint8Array.from(atob(value), (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

/** Whether two blobs are the same bytes. Not constant-time, and does not need
 *  to be: both sides are public artifacts this browser already holds. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, at) => byte === b[at])
}
