// The two things both Durable Objects in this Worker need from HTTP: a bounded
// body read, and the headers every JSON answer either of them writes.

/** What every JSON answer this Worker writes carries. `no-store` because all of
 * them are about live state — a refusal that got cached by anything in the path
 * would outlive the condition that caused it, and the fleet directory is a set
 * a revocation is expected to change under a reader's feet. */
export const JSON_NO_STORE = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }

/**
 * The request body, or null if it runs past `max`.
 *
 * Content-Length is consulted first so an honestly-labelled oversized POST is
 * refused without being read, and the stream is then counted as it arrives:
 * a chunked body declares no length at all, and buffering an undeclared one
 * would hand an endpoint a memory DoS — the exposure the channel cap and the
 * handshake deadline bound on the client leg (spec/relay-protocol.md, Auth),
 * and the one the blob cap bounds on `PUT /directory`.
 */
export async function readCapped(req: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get('Content-Length'))
  if (Number.isFinite(declared) && declared > max) return null
  if (!req.body) return new Uint8Array(0)
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > max) return null
      chunks.push(value)
    }
  } finally {
    // Releases the leg of an oversized body we stopped reading; a no-op once
    // the stream has ended on its own.
    await reader.cancel().catch(() => {})
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.byteLength
  }
  return out
}
