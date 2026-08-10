import { DurableObject } from 'cloudflare:workers'
import { JSON_NO_STORE, readCapped } from './http'
import type { Env } from './index'

/**
 * FleetDirectory is the relay's store of signed blobs — in practice machine
 * certs and revocations, minted by the daemons under the fleet key
 * (spec/fleet-trust.md, "The fleet directory"). One object per relay —
 * `idFromName("directory")`, because one relay is one fleet — and it is the
 * only Durable Object here that is not per machine.
 *
 * "In practice", because this class cannot tell one kind from another and does
 * not try; what it holds is whatever the daemons PUT. Device certificates are
 * deliberately not among them — a device is handed its own by the machine that
 * minted it, in the pairing answer and again in every welcome — which is a
 * rule the daemons keep and this object could not enforce if it wanted to.
 * That rule is the reason `GET` below is not a public roster of the operator's
 * device keys and the labels beside them.
 *
 * **The relay stores and serves; it never verifies.** The fleet key never
 * touches the Worker, by design: not as a secret, not as a binding, not in a
 * log. So this class cannot tell a machine cert from a revocation from 200
 * bytes of noise, and must not try — every reader (daemon and browser both)
 * verifies every signature under the fleet public key and drops what fails.
 * What a hostile relay can do to this store is serve it stale, truncated or
 * empty; what it cannot do is mint an entry, because minting needs the key it
 * does not hold.
 *
 * "Availability is the relay's only power" — the spine of
 * spec/relay-protocol.md — survives this leg with one exception, and the
 * exception is worth naming here rather than only there. For a *certificate*,
 * withholding subtracts: a machine cert this object hides is a machine the
 * browser does not see. For a *revocation*, withholding adds — a machine that
 * never receives one goes on admitting a device the operator cut off — and the
 * answer a `GET` gives is shape-identical whether it is complete or filtered,
 * because entries are signed one by one and the set is signed not at all. There
 * is no epoch and no manifest for a reader to check an answer against. What
 * bounds it is that every holder re-publishes every revocation it has on every
 * connect and every 30 minutes, that a machine which has ingested one keeps it
 * forever, and that the relay still cannot mint the certificate the revocation
 * was about. A signed manifest is the real fix and is future work, not this
 * file's (spec/relay-protocol.md, "What withholding costs").
 *
 * Entries are **content-addressed**: the storage key is the SHA-256 of the
 * exact bytes PUT, and nothing else. That is the only key a Worker which
 * cannot read a blob is entitled to compute — a caller-supplied name would
 * make the relay arbitrate a namespace it cannot check, and one buggy or
 * hostile secret-holder could then PUT a machine cert over a revocation and
 * the relay would help. Content addressing makes that structurally
 * impossible: a PUT can only ever *add*. Two consequences fall straight out of
 * it — a duplicate PUT is idempotent (same bytes, same key, same value, no
 * second entry), and a blob round-trips byte for byte, because bytes the
 * relay mangled would not hash to the key it filed them under. Readers dedupe
 * on their own terms; a revocation outranks a device cert for the same key
 * whatever their timestamps, which is a rule about *meaning* and therefore
 * theirs, not ours.
 *
 * Hibernation rules, the same ones src/hub.ts lives by: sockets are accepted
 * with `ctx.acceptWebSocket` — never `ws.accept()`, which pins the object in
 * memory — no timers outside a request already holding the object awake, and
 * nothing about the store in memory, because a wake finds every field back at
 * its initializer. The entry count is a storage counter for exactly that
 * reason (`nextChannel` in the hub is the same idea). The daemon sockets carry
 * no attachment at all, and that is not an oversight: a directory socket is a
 * fan-out target and nothing more — no channel, no counters anything reads, no
 * per-socket state a wake could lose — so `getWebSockets('daemon')` is the
 * whole of what a handler needs to know about it.
 */
export class FleetDirectory extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // The edge answers keepalives itself, without waking a hibernated object
    // (spec/relay-protocol.md, Keepalive). The directory socket speaks the
    // same two strings the hub's legs do.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('flue-ping', 'flue-pong'))
  }

  /**
   * The four shapes of `/directory`, told apart the way the router told them
   * apart before forwarding: an upgrade, a PUT, a DELETE, or a GET. Auth
   * happened there — the daemon legs of this object are secret-gated by
   * `authorizeDaemon` in src/index.ts, exactly as `/daemon` is, and this object
   * trusts that the way DaemonHub does.
   */
  async fetch(req: Request): Promise<Response> {
    if (req.headers.get('Upgrade')?.toLowerCase() === 'websocket') return this.acceptDaemon()
    if (req.method === 'PUT') return this.put(req)
    if (req.method === 'DELETE') return this.reset()
    if (req.method === 'GET') return this.snapshot(req)
    return new Response('not found', { status: 404 })
  }

  /**
   * A daemon's push socket. Unlike the hub's daemon leg there is no takeover
   * here: every machine in the fleet holds one of these at once, which is the
   * point — a device paired on machine A has to reach machine B without B
   * polling.
   *
   * The socket is push-only. Nothing a daemon could say on it is part of this
   * protocol — a write is `PUT /directory`, an HTTP request that answers with
   * the key it filed — so any message from a daemon here is a protocol error,
   * handled in `webSocketMessage`.
   */
  private acceptDaemon(): Response {
    // The fan-out bound. The leg is secret-gated, so this is not the DoS cap
    // MAX_CLIENTS is on the hub's credential-less leg; it bounds the cost of
    // one PUT, which is one send per socket, against a fleet that has left
    // half-dead sockets behind or a secret-holder opening them in a loop. A
    // one-operator fleet reaches double digits.
    if (this.ctx.getWebSockets('daemon').length >= MAX_DAEMON_SOCKETS) {
      return new Response('{"error":"too many directory sockets"}', {
        status: 503,
        headers: JSON_NO_STORE,
      })
    }
    const pair = new WebSocketPair()
    this.ctx.acceptWebSocket(pair[1], ['daemon'])
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  /**
   * `PUT /directory`: one signed blob, stored under the hash of its own bytes.
   *
   * The body is read as bytes and never parsed. It reaches storage, the GET
   * and every push socket unchanged — parts B and C verify Ed25519 signatures
   * over *these* bytes, and a relay that re-encoded a blob into some canonical
   * shape of its own would break every signature over it while believing it
   * had been helpful.
   */
  private async put(req: Request): Promise<Response> {
    const blob = await readCapped(req, MAX_BLOB_BYTES)
    if (blob === null) return tooLarge()
    // An empty body is not a signed anything under any encoding, and hashing
    // it would spend an entry — permanently, since nothing here is ever
    // deleted — on the one blob that is certainly not a certificate.
    if (blob.byteLength === 0) {
      return new Response('{"error":"empty blob"}', { status: 400, headers: JSON_NO_STORE })
    }
    const key = await digestKey(blob)
    // Read all three, decide, then write once. Nothing awaits between the read
    // and the write except the write itself, so the input gate holds a second
    // PUT at the door and neither counter can drift: two blobs, two entries,
    // always.
    const have = await this.ctx.storage.get<Uint8Array | number>([
      BLOB_PREFIX + key,
      COUNT_KEY,
      VERSION_KEY,
    ])
    if (have.has(BLOB_PREFIX + key)) {
      // Already here, byte for byte — that is what sharing a key means. No
      // write, no push, no second entry, and no new version: a daemon that
      // re-PUTs on every reconnect (and one will) costs this object nothing,
      // and a replayed PUT of a blob captured off the wire changes nothing
      // either.
      return stored(key, 200)
    }
    const count = (have.get(COUNT_KEY) as number | undefined) ?? 0
    if (count >= MAX_ENTRIES) return full()
    const version = (have.get(VERSION_KEY) as number | undefined) ?? 0
    // One multi-key put: the blob, the count and the version land together or
    // not at all.
    await this.ctx.storage.put({
      [BLOB_PREFIX + key]: blob,
      [COUNT_KEY]: count + 1,
      [VERSION_KEY]: version + 1,
    })
    this.push(blob)
    return stored(key, 201)
  }

  /**
   * `GET /directory`: the whole set, credential-less.
   *
   * No order is promised. Storage hands these back sorted by key, which is to
   * say by digest, which is to say by nothing — the directory is a set, and a
   * reader that inferred "newest last" from this array would be reading a
   * property of SHA-256. `iat` is inside the blobs, where a reader that has
   * verified a signature can trust it.
   *
   * **Conditional.** The answer carries an `ETag` and a matching
   * `If-None-Match` is answered `304` with no body. The tag is the store's
   * version counter, bumped by every write that lands and by every reset, so
   * it changes exactly when the set does — never on a duplicate PUT, which
   * stores nothing, and never on a wipe-then-refill back to the same contents,
   * because it counts mutations rather than hashing them.
   *
   * It is worth the two storage keys because this document is the largest
   * thing the relay serves — 512 entries of 4 KiB is about 2.8 MiB of base64 —
   * and every daemon re-reads the whole of it on every reconnect, where the
   * usual answer is "nothing has changed since you last asked".
   *
   * Two things it deliberately is not. It is not a bound on an anonymous
   * flood: a caller who wants the bytes simply omits the header, and what
   * bounds them is the per-IP rate rule in src/index.ts. And it is not a
   * licence for anything to *hold* this document — `Cache-Control: no-store`
   * stays, because a directory served from a cache is a revocation served
   * late, and that is the one staleness this design cannot afford. The tag is
   * for clients that revalidate on purpose, which is what the daemon's leg
   * does (internal/transport/relay/directory.go), not for a shared cache
   * deciding on its own.
   */
  private async snapshot(req: Request): Promise<Response> {
    const version = (await this.ctx.storage.get<number>(VERSION_KEY)) ?? 0
    const etag = `"${version}"`
    if (req.headers.get('If-None-Match') === etag) {
      // No body, and the tag again so a client that revalidates twice has
      // something to send the second time.
      return new Response(null, { status: 304, headers: { ...JSON_NO_STORE, ETag: etag } })
    }
    const rows = await this.ctx.storage.list<Uint8Array>({ prefix: BLOB_PREFIX })
    const entries: { key: string; blob: string }[] = []
    for (const [k, blob] of rows) {
      entries.push({ key: k.slice(BLOB_PREFIX.length), blob: base64(blob) })
    }
    return new Response(JSON.stringify({ v: 1, entries }), {
      headers: { ...JSON_NO_STORE, ETag: etag },
    })
  }

  /**
   * `DELETE /directory`: empty the whole store, and the count with it.
   *
   * This is the escape hatch for a full directory, and it exists because
   * without it a full one is permanent. Nothing here ever deletes a single
   * entry — see `full()` for why selective pruning must not be the relay's
   * job — so at 512 entries every later PUT is refused, and a refused PUT of a
   * *revocation* is the fleet-wide kill switch reaching only the machine it was
   * typed on. Redeploying does not clear it either: the script name is a
   * constant, the object is `idFromName("directory")` on another constant, and
   * Durable Object storage outlives a redeploy. So the only way back is a
   * deliberate wipe, and this is it.
   *
   * **All or nothing, on purpose.** A wipe needs no opinion about what any blob
   * means, which is what makes it a thing this Worker may do: it deletes the
   * set, not a member of it. Pruning "the device certificates whose key is
   * revoked" would need the fleet key, and the whole design turns on that key
   * never being here.
   *
   * **Why it is safe to do this to a store of revocations.** Every daemon
   * re-offers everything it holds for this store — its machine certificate and
   * every revocation it knows — on every connect and every 30 minutes
   * (internal/transport/relay/directory.go, publishAll), so an emptied
   * directory refills itself from the fleet. To make that happen in
   * seconds rather than in half an hour, every daemon socket is closed here:
   * the reconnect that follows is a snapshot read and a full re-publish.
   *
   * **The residual, stated rather than hidden.** A blob whose only remaining
   * holder never reconnects is gone — and the one that matters is a revocation
   * published by a machine that has since been decommissioned, wiped or is
   * simply off for good. Every other machine that had *already* ingested it
   * still holds it (a revocation is written to that machine's own
   * revocations.json and re-published from there), so this is a narrow window
   * rather than a general loss; it is narrow, not empty. Un-revoking is not
   * what a wipe does — the device stays cut off on every machine that ever
   * heard — but a machine that never heard, and now never will, is one a
   * re-revoke from any surviving machine is the answer to.
   */
  private async reset(): Promise<Response> {
    // Read before the wipe, because the wipe takes the counter too. This is
    // what the object believed it was holding, which is the number the cap was
    // enforced against and therefore the one an operator is owed.
    const held = await this.ctx.storage.get<number>([COUNT_KEY, VERSION_KEY])
    const removed = (held.get(COUNT_KEY) as number | undefined) ?? 0
    // Everything: the blobs and the count, in one call, so no interleaving can
    // leave a counter that outlives the entries it counted and re-fills the
    // directory to 512 with nothing in it.
    await this.ctx.storage.deleteAll()
    // The version survives the wipe and moves forward, which is the one
    // counter that must not go back to zero: a reader holding the old tag has
    // to see this as a change, and a directory emptied and refilled to the
    // same contents would otherwise re-issue a tag that reader already has.
    await this.ctx.storage.put(VERSION_KEY, ((held.get(VERSION_KEY) as number | undefined) ?? 0) + 1)
    for (const ws of this.ctx.getWebSockets('daemon')) {
      try {
        // 1012 (service restart) is the honest code: the store this socket was
        // subscribed to is gone and the daemon's own reconnect is what refills
        // it. Nothing on this leg speaks daemon-ward except raw blobs, so there
        // is no in-band way to say "re-publish" — the close is the message, and
        // the daemon already knows what to do with one.
        ws.close(1012, 'the directory was reset; reconnect and republish')
      } catch {
        // Already closing; its own close event finishes the teardown.
      }
    }
    return new Response(JSON.stringify({ reset: true, removed }), { headers: JSON_NO_STORE })
  }

  /**
   * The write, to every daemon socket, as one binary message of exactly the
   * blob's bytes.
   *
   * Raw bytes and no envelope, because an envelope is a chance to reshape
   * something the relay cannot read: what the daemon verifies is the signature
   * over these bytes, and the shortest path to them is no framing at all. The
   * key is not sent — it is SHA-256 of the message, derivable by anyone who
   * wants it, and a daemon that verifies signatures has no use for it.
   *
   * The fan-out includes the socket belonging to the machine whose PUT this
   * was: an HTTP request carries no socket identity, so there is nobody to
   * exclude, and there is no need to — the receiver already holds the blob and
   * a push it already has is a no-op. Pushes are best-effort by nature. A
   * daemon that was offline, or whose send failed here, converges on its next
   * `GET /directory`; to close the window it opens this socket *first* and
   * GETs second, so a write in between arrives on one path or the other.
   */
  private push(blob: Uint8Array): void {
    for (const ws of this.ctx.getWebSockets('daemon')) {
      try {
        ws.send(blob)
      } catch {
        // Closing under us — its close event finishes the teardown, and the
        // daemon's reconnect GET is what it converges on.
      }
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // flue-ping never reaches here (the auto-response answers it at the edge)
    // and a stray flue-pong is dropped silently, exactly as on the hub's legs.
    if (message === 'flue-pong') return
    // Everything else is a protocol error: this socket carries relay → daemon
    // pushes and nothing in the other direction. A daemon with something to
    // say says it with `PUT /directory`.
    try {
      ws.close(1002, 'the directory socket is push-only')
    } catch {
      // Already closing.
    }
  }
}

/** The storage prefix for blobs; the rest of the key is the digest. */
const BLOB_PREFIX = 'blob:'

/** How many entries are stored. A counter rather than a `list()` per PUT
 * because listing reads every blob back to answer a question about their
 * number, and it survives hibernation for the reason the hub's `nextChannel`
 * does: a wake finds memory empty and storage intact. */
const COUNT_KEY = 'count'

/**
 * How many times the set has changed: bumped by every PUT that stores and by
 * every reset, never by a duplicate PUT, and never reset to zero.
 *
 * It is the `ETag` on `GET /directory` and nothing else. A counter rather than
 * a digest of the contents because the question a conditional GET asks is "has
 * this changed since version N", which a monotonic counter answers exactly and
 * for the price of one integer in a write that was already happening. Storage
 * for the same reason COUNT_KEY is: a wake finds memory back at its
 * initializer and storage intact.
 */
const VERSION_KEY = 'version'

/**
 * The largest single blob. A certificate is a version, a kind, a 32-byte key,
 * a machine id of at most 63 characters, a display name, a timestamp and a
 * 64-byte signature — a couple of hundred bytes, encoded generously. 4 KiB is
 * the same bound the pairing body carries (src/hub.ts, MAX_PAIR_BYTES) and two
 * orders of magnitude of headroom over any honest cert; it is here because the
 * Worker cannot tell a cert from four megabytes of anything, and this store is
 * readable without a credential by whoever asks.
 */
const MAX_BLOB_BYTES = 4096

/**
 * How many entries the directory will hold.
 *
 * The arithmetic that picks it: entries are machines, devices, and one
 * revocation per device ever revoked, and nothing is ever removed. A
 * one-operator fleet — the model this whole design serves — is a handful of
 * machines and a handful of devices, so 512 is years of pair-and-revoke churn
 * with room to spare. The other end of the number is what it bounds: 512 ×
 * 4 KiB is 2 MiB stored and about 2.8 MiB of base64 on a credential-less GET,
 * which is the worst case a secret-holder can build and not one an honest
 * fleet comes near (512 real certs are on the order of 100 KiB).
 */
const MAX_ENTRIES = 512

/** Push sockets one directory will hold: one per machine, plus slack for
 * reconnects whose close events have not landed yet. */
const MAX_DAEMON_SOCKETS = 256

/** A stored blob: 201 when this PUT created the entry, 200 when it was already
 * there. The body is the same either way — a caller need not branch, and the
 * key is what it came for — so the status is the whole of the difference, for
 * logs and for a daemon that wants to know whether it was first. */
function stored(key: string, status: 200 | 201): Response {
  return new Response(JSON.stringify({ key }), { status, headers: JSON_NO_STORE })
}

function tooLarge(): Response {
  return new Response('{"error":"blob too large"}', { status: 413, headers: JSON_NO_STORE })
}

/**
 * The directory is full (`MAX_ENTRIES`). 507, and deliberately its own status:
 * nothing else on this leg means "your blob is fine and I will not keep it",
 * and a daemon has to be able to tell that from a 413 (this blob is wrong) or a
 * 401 (this caller is wrong) without reading prose.
 *
 * Refusing rather than evicting is the security decision here, and it is not a
 * close call. Every eviction policy — oldest first, largest first, random —
 * can drop a revocation, and a directory that silently forgets a revocation
 * re-admits the device it revoked to every machine that had not yet heard.
 * That is a compromise; a refused PUT is an operator with a full directory,
 * who is told so, loudly, at the moment it happens. Nothing in this object
 * ever deletes *an* entry, and if pruning is ever wanted — a device cert whose
 * key is revoked, say — it has to be a decision signed under the fleet key and
 * carried out by something that can read what it is deleting. That is not the
 * relay, and it must never become the relay.
 *
 * What the relay may do, and what `reset` above is, is delete the whole set at
 * once: that needs no opinion about any blob's meaning, and it is the only way
 * out of a full directory, because storage survives every redeploy. A daemon
 * that sees this status has hit a wall an operator has to take down —
 * `flue relay reset` — and no amount of retrying will move it, which is why
 * the daemon logs and drops rather than retrying (directory.go, publish).
 */
function full(): Response {
  return new Response('{"error":"directory full"}', { status: 507, headers: JSON_NO_STORE })
}

/** The storage key for a blob: SHA-256 of its exact bytes, lowercase hex. */
async function digestKey(blob: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', blob as BufferSource)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Standard base64, with padding — the alphabet Go's `encoding/json` reads a
 * `[]byte` field in and writes one out in, so the daemon's own struct decodes
 * `blob` with no help (internal/crypto keys travel the same way). Chunked
 * because `String.fromCharCode(...bytes)` on a whole blob is an argument list,
 * and argument lists have a length limit that a 4 KiB cert would find.
 */
function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}
