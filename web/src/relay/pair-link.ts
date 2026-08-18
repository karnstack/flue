/*
 * What a scanned or pasted pairing link has to prove before this tab will
 * follow it.
 *
 * The pairing ceremony itself lives at /pair and re-checks everything; this
 * parser exists for the moment before, when the text in hand is whatever a
 * camera decoded or a clipboard held. Its one security-relevant judgement is
 * the origin check: a link minted for some other host would walk this tab off
 * its relay, so it is refused rather than followed — the ceremony it names
 * belongs to a door this is not.
 */

/** Where a refused paste went wrong, in words the panel can choose from. */
export type PairLinkFailure = 'unreadable' | 'foreign' | 'incomplete'

export type PairLink = { ok: true; target: string } | { ok: false; reason: PairLinkFailure }

/**
 * Reads `raw` as a pairing link for the relay at `origin`.
 *
 * Accepts the absolute URL a QR encodes (internal/daemon/conn.go writes it,
 * src/routes/devices.tsx appends the machine) and the bare /pair path a
 * mangled copy can be cut down to — anything relative is resolved against `origin`,
 * which is also what makes prose land on `unreadable` rather than throwing.
 * The token and key must both be present because /pair without them is its
 * refusal screen, and sending the user there would spend the tap teaching
 * nothing. On success `target` is the path and search only, ready for a
 * same-origin navigation.
 */
export function parsePairLink(raw: string, origin: string): PairLink {
  let url: URL
  try {
    url = new URL(raw.trim(), origin)
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  if (url.pathname !== '/pair') return { ok: false, reason: 'unreadable' }
  if (url.origin !== origin) return { ok: false, reason: 'foreign' }
  const t = url.searchParams.get('t')
  const k = url.searchParams.get('k')
  if (t === null || t === '' || k === null || k === '') {
    return { ok: false, reason: 'incomplete' }
  }
  return { ok: true, target: url.pathname + url.search }
}
