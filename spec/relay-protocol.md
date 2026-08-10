# flue relay protocol

The relay is a Cloudflare Worker (one Durable Object per machine, plus one for
the fleet directory) that bridges each daemon's single outbound socket to any
number of browser tabs. It
forwards bytes and nothing else: it holds no Noise keys, reads no terminal traffic, and cannot
tell one keystroke from another. What it *does* see — the control channel is
cleartext — is set out under "What the relay sees" below.

This document defines the two sockets that meet at the relay and the framing on
each. It does **not** redefine the wire protocol — `spec/protocol.md` is
unchanged and travels inside, encrypted. The relay is a transport for it.

It also defines one thing the relay *stores* rather than forwards: the fleet
directory, a set of signed blobs it cannot verify (below). That leg holds no
key either, and the rule it lives under is the same one this whole document
turns on — the relay's only power is availability.

```
daemon  ---- wss /daemon/<id> ---->  Worker + one DO per machine  <---- wss /client/<id> ----  browser
        [4B channel][payload]                                     [payload]
           |                                                                     |
           +------------- Noise IK: browser initiator, daemon responder ---------+
                          inside: [1B kind][wire protocol bytes]
```

Three layers stack, outermost first:

| Layer | Bytes | Who reads it |
|---|---|---|
| Channel framing | `[4-byte big-endian channel][payload]` | daemon and relay |
| Noise IK | handshake messages, then transport ciphertexts | daemon and browser |
| Kind framing | `[1 byte kind][wire protocol bytes]` | daemon and browser |

The directory leg stacks none of them. It is HTTP plus one push socket, and
what travels on it is a signed blob in whatever encoding the fleet key signs
(`spec/fleet-trust.md`, Certificates) — bytes the relay stores, serves and
forwards without a frame of its own around them, because it cannot read them
and any framing it added would be a chance to reshape what a reader is about
to check a signature over.

The routes, in one place:

| Route | Auth | Metered | Object |
|---|---|---|---|
| `WS /daemon/<id>` | Bearer daemon secret | no | that machine's hub |
| `WS /client/<id>` | none | yes | that machine's hub |
| `POST /api/pair/<id>` | none | yes | that machine's hub |
| `PUT /directory` | Bearer daemon secret | no | the directory |
| `GET /directory` | none | yes | the directory |
| `DELETE /directory` | Bearer daemon secret | no | the directory |
| `WS /directory` | Bearer daemon secret | no | the directory |
| `GET /api/health` | none | no | none — the Worker alone |

## The daemon leg

The daemon dials `wss://<relay>/daemon/<machine-id>` **outbound** — nothing
listens on the user's machine for the relay's sake. Every **binary** WebSocket message on that
socket is laid out as:

```
[4 bytes channel, big-endian][payload]
```

A frame that is exactly a header is well formed and carries an empty payload.
A frame shorter than four bytes is a protocol error.

The only **text** messages that ever cross this socket are the keepalives
below; any other text message is a protocol error and closes the connection.

Channel `0` is the control channel (below). Channels `1` and up each carry one
browser's Noise session, opaque to the daemon's framing layer. The Durable
Object assigns ids from a **counter it keeps in its own storage**: the counter
survives hibernation and daemon reconnects, so no id is ever reused within a
DO's lifetime.

The *channels* do not survive a reconnect — only the counter does. The daemon
holds each channel's Noise responder state in memory, so a daemon that comes
back has no key for any channel opened before the break, and re-announcing one
would not help either: the browser's half of the IK handshake is already spent.
A daemon reconnect therefore **invalidates every live channel**. When the daemon
leg drops, the Durable Object closes every live client socket with close code
`1012` and reason `daemon gone`. It sends no `closed` for them — there is no
daemon left to read it, or, on a takeover, a late `closed` may still reach the
replacement daemon; a `closed` for an unknown channel is ignored — and it never
re-announces a channel with `open`.
Browsers reconnect through their ordinary retry path, handshake again, and are
assigned fresh ids that the persisted counter guarantees are new.

## The browser leg

The browser opens `wss://<relay>/client/<machine-id>` and sends **no channel
header**. The
Worker knows which channel that socket is from the socket itself, and wraps and
unwraps on the browser's behalf: it prefixes the header on the way to the
daemon and strips it on the way back. A browser therefore sends bare handshake
messages and bare ciphertexts, and the channel id never appears in client code
above the relay adapter.

These are **binary** messages too, and the same text rule applies: apart from
the keepalives, a string message closes the socket with code `1002`. A client
that base64s its ciphertext into a text frame is not speaking this protocol —
send the bytes.

## The control channel (channel 0)

Every payload on channel `0` is a single JSON object with a `type`
discriminator, one object per frame.

| type | direction | fields | meaning |
|---|---|---|---|
| `open` | relay → daemon | `channel`, `origin` | a browser connected and was assigned this channel |
| `closed` | relay → daemon | `channel` | that browser went away |
| `close` | daemon → relay | `channel` | close that browser's socket |
| `pair` | relay → daemon | `id`, `origin`, `body` | an HTTP `POST /api/pair` arrived |
| `pairResult` | daemon → relay | `id`, `status`, `body` | the answer to write to that HTTP request |

`origin` is the Worker's **own** origin (`https://relay.example`). It is
announced rather than assumed so the daemon can check it against the relay it
dialled: a relay announcing a foreign origin is misconfigured or lying, and the
daemon refuses the channel.

`pair.body` is the browser's JSON **verbatim** — the daemon's own `/api/pair`
handler parses those bytes, so the relay must not reshape them. `pairResult`
carries the HTTP status and the response body the Worker writes back, and `id`
correlates the two: pairing is the one part of the ceremony that is an HTTP
request rather than a WebSocket message (`spec/protocol.md`, Pairing), and the
relay has to carry it without understanding it.

`pairResult.body` is a **JSON value**, always — the Worker writes it as an
`application/json` response. The daemon's local handler answers a refusal with
the bare text `pairing refused`; over the relay the same refusal travels as
`{"error":"pairing refused"}` with `status` 403.

`403` on `POST /api/pair` is **reserved for the daemon**: it means the daemon's
pairing handler ran on this body, which is what the browser reads to decide the
user's pairing window is spent. The relay's own refusals — a foreign `Origin`, a
body that is not JSON, a body over the cap, no daemon leg, a deadline, too many
parked attempts — answer `400`, `413`, `503`, `504` or `429` instead, because
none of them presented a token to anything and the window is still open.

`pair.id` is assigned by the relay and means nothing outside one relay socket's
lifetime: a daemon that reconnects must not answer a `pair` it read before the
break, because the Worker has forgotten the HTTP request it belonged to. Ids
stay within JavaScript's safe integer range (< 2^53) — the daemon parses them
as `uint64`, but a Worker's `JSON.parse` would round anything larger.

## Channels 1 and up

The first two payloads on a channel are the **Noise IK** handshake — browser
initiator → daemon responder → browser — relayed opaquely. Every payload after
them is exactly one Noise transport ciphertext. The relay forwards all of them
without inspection; it has no key with which it could do otherwise. The
handshake is the one already used for local pairing — `Noise_IK_25519_ChaChaPoly_SHA256`,
pinned by `testdata/noise/ik.json` — and the relay changes none of it.

A browser whose static key the daemon does not recognise is not attached: the
daemon answers with control `close` on that channel. Pairing first is what
makes a device known.

### Inside a decrypted payload

```
[1 byte kind][wire protocol bytes]

0x00  text    a JSON control message
0x01  binary  a wire-protocol binary frame
```

The wire protocol distinguishes text frames from binary ones and gets that
distinction from the WebSocket for free on the local transport. Through the
relay every message is one binary WebSocket frame of ciphertext, so the
distinction would be lost. This byte carries it, and the layer above the relay
reads the same `(text, data)` pair it reads locally. An empty payload, or any
kind byte other than `0x00` or `0x01`, is a protocol error.

## The fleet directory

One more Durable Object, and the only one that is not per machine: the fleet
directory, `idFromName("directory")`, because one relay is one fleet
(`spec/fleet-trust.md`, "The fleet directory"). It holds the signed artifacts
that have to reach every machine and every device — machine certs, device
certs, revocations — and it holds them as **blobs it cannot verify**, because
the fleet key never touches the Worker.

That is the invariant this leg exists to preserve, and it must survive every
future change to it: **the relay stores and serves, and never verifies.** Every
reader — daemon and browser both — checks every signature under the fleet
public key and drops what fails. A hostile relay can therefore serve a stale,
truncated or empty directory, exactly as it could always refuse to route; what
it cannot do is mint a machine or a device, because minting needs a key it does
not hold. The cost of a hostile relay stays availability, and nothing else.

```
PUT    /directory  Bearer daemon secret; body is one signed blob, raw bytes
GET    /directory  credential-less, rate limited; the whole set
DELETE /directory  Bearer daemon secret; empties the whole set
WS     /directory  Bearer daemon secret; relay → daemon pushes, on write
```

Nothing lives under the prefix: `/directory/<anything>` is the Worker's own
`404 {"error":"not found"}` — not the machine 404, because nothing here names a
machine — and a method other than `GET`, `PUT` or `DELETE` is `405` with
`Allow: GET, PUT, DELETE`.

**Entries are content-addressed.** An entry's key is the lowercase hex SHA-256
of the blob's exact bytes, and there is no other name for it. That is the only
key a Worker that cannot read a blob is entitled to compute: a caller-supplied
name would put the relay in charge of a namespace it cannot check, and one
buggy or hostile secret-holder could then PUT a machine cert over a revocation
with the relay's help. Content addressing makes that structurally impossible —
a PUT can only ever *add* — and two properties fall out of it:

- **Idempotence.** The same bytes PUT again are the same key and the same
  value: no second entry, no push. A daemon may re-announce everything it holds
  on every reconnect, and a PUT replayed from the wire changes nothing.
- **Byte-exactness.** A blob comes back exactly as it went in. Bytes the relay
  had altered would not hash to the name it filed them under, and every reader
  verifies a signature over these bytes.

`PUT` answers `201 {"key":"<hex>"}` when it created the entry and
`200 {"key":"<hex>"}` when the blob was already there; the body is the same
either way, so the status is the whole of the difference. An empty body is
`400 {"error":"empty blob"}` — not a signed anything under any encoding.

`GET` answers, as `application/json`, no-store:

```json
{ "v": 1, "entries": [ { "key": "<hex sha-256>", "blob": "<base64>" } ] }
```

`blob` is standard base64 with padding — the alphabet Go's `encoding/json`
reads a `[]byte` field in, so a daemon's struct decodes it with no help. **No
order is promised.** Storage hands entries back sorted by key, which is to say
by digest, which is to say by nothing; a reader that inferred "newest last"
would be reading a property of SHA-256. Ordering that means anything lives
inside the blobs, in `iat`, where a reader that has checked a signature can
trust it. Neither is any *ranking* the relay's: a revocation outranks a device
cert for the same key whatever their timestamps, and that is a rule about
meaning, which readers hold and the relay does not.

**The push socket** carries one binary message per new entry, and that message
is exactly the blob's bytes — no envelope, no key, no framing, for the reason
the whole leg is unframed. The fan-out reaches every connected daemon including
the one whose machine made the PUT (an HTTP request carries no socket identity,
and a push a receiver already holds is a no-op). Duplicates push nothing: the
set did not change.

Unlike `/daemon`, there is no takeover here: every machine in the fleet holds
one of these at once, which is the point. At most 256 are held, answered
`503 {"error":"too many directory sockets"}` over that — not a DoS bound, since
the leg is secret-gated, but a bound on what one PUT costs, which is one send
per socket.

Pushes are best effort, and the socket is **push-only** — a write is `PUT
/directory`, an HTTP request that answers with the key it filed, so any message
from a daemon on this socket other than the keepalive below is a protocol error
and closes it with `1002`. A daemon converges the rest of the way by reading
`GET /directory`, and the order that closes the gap is: **open the socket
first, then GET.** A write that lands in between arrives by one path or the
other — or by both, which content addressing makes harmless.

**Bounds.** The directory is written by secret-holders and readable without a
credential, so it is bounded at both ends: a blob is at most **4 KiB**
(`413 {"error":"blob too large"}`), and the directory holds at most **512**
entries. At the cap a PUT of a new blob is refused with
`507 {"error":"directory full"}` — its own status, so a daemon can tell "your
blob is fine and I will not keep it" from a 413 or a 401 without reading prose
— while a PUT of a blob already stored still answers 200, because it asks for
no room.

Refusing rather than evicting is deliberate and is a security decision, not a
capacity one. Every eviction policy can drop a revocation, and a directory that
silently forgets a revocation re-admits the device it revoked to every machine
that had not yet heard. Nothing in this leg ever deletes *an* entry. If pruning
is ever wanted — a device cert whose key is revoked, say — it has to be a
decision signed under the fleet key and carried out by something that can read
what it is deleting. That is not the relay, and it must not become the relay.

**The reset**, and why the cap needs one. Refusal is permanent: nothing evicts,
the object is named by a constant, and Durable Object storage survives every
redeploy of the script — so a directory that has reached 512 stays there
forever, and a fleet whose directory is full is a fleet whose *revocations* have
stopped crossing machines. `DELETE /directory` is the way out. It empties the
whole set and the entry count, answers `200 {"reset":true,"removed":<n>}`, and
closes every push socket with `1012` so that each daemon reconnects and
re-publishes at once rather than at its next half-hourly republish.

All-or-nothing is what makes it a thing a relay may do: a wipe needs no opinion
about what any blob means, where a prune would need the fleet key. It is gated
by the daemon secret — the same credential a PUT presents, held by exactly the
machines that could fill the directory in the first place — and it is
`flue relay reset` on the operator's side.

Convergence after a reset is the daemons' own: each re-offers everything it
holds on every connect and every 30 minutes, so the fleet refills the set. The
residual, which readers of this spec are owed: **a blob whose only remaining
holder never reconnects is lost by a wipe** — in practice a revocation
published by a machine that has since been decommissioned. Every machine that
already ingested it still holds it and re-publishes it, so the window is narrow;
it is not zero, and re-revoking from any surviving machine closes it.

## Keepalive

Any socket the relay holds — either leg of a machine hub, and the directory
socket — may send the **text** frame `flue-ping`; the Cloudflare edge answers
`flue-pong` from the Durable Object's auto-response, without waking it. No leg
ever has to answer a ping itself — the edge does, so neither the daemon nor a
browser sees one — and a received `flue-pong` is dropped silently. Neither
string ever carries a channel header: they are text frames, and everything
channel-framed is binary. Any other text frame is a protocol error, on all
three.

This is the one place the relay adds something `spec/protocol.md` says does not
exist ("WebSocket ping/pong frames only. There is no application-level ping").
That rule still holds for the local transport. Hibernation is why it does not
hold here: a hibernating DO must be able to answer liveness without being woken,
and `setWebSocketAutoResponse` matches a text request against a text response.
An application-level ping is what buys an idle terminal a sleeping,
almost-free Durable Object.

## Auth

The daemon's upgrade request carries `Authorization: Bearer <daemon secret>` —
the Worker's deploy-time `DAEMON_SECRET`, shared by every machine that joined
this Worker. A browser upgrade carries **nothing**.

That is deliberate: Noise is the confidentiality boundary, and a browser
credential would add none — an attacker who could open a channel still cannot
complete an IK handshake against a daemon that has not paired their key, and one
who could complete it would not have needed the credential. What an
unauthenticated `/client` does expose is denial of service, so the Durable
Object bounds it directly: a cap on concurrent channels, a deadline on
completing the handshake, after which the channel is closed, and a cap on the
size of one client message.

The directory's legs are gated by the same one secret: `PUT /directory` and the
`/directory` upgrade present the bearer, and `GET /directory` presents nothing,
for the same reason `/client` presents nothing — what the directory holds is
signed, public by design, and worthless to forge without the fleet key. The
secret is what says who may *write*, and it is all the Worker has to say it
with, since it cannot verify a single blob it stores.

Both legs, and `POST /api/pair`, carry a **machine id** in the path —
`/daemon/<id>`, `/client/<id>`, `/api/pair/<id>` — and the Worker routes on it:
`idFromName(id)` selects that machine's Durable Object, and the hub receives
the bare prefix, never the id. (`/directory` carries none: one relay is one
fleet, so its object's name is a constant.) The id is **self-certifying**:

```
machine-id  =  <slug> "-" <tag>
slug        =  lowercase hostname slug + "-" + 4 random hex, minted at setup
               or join time (the randomness is what keeps two machines named
               "mac" distinct — the tag is deterministic and cannot)
tag         =  first 8 lowercase hex of
               HMAC-SHA256(DAEMON_SECRET, "flue-machine-id/" + slug)
```

The whole id matches `^[a-z0-9][a-z0-9-]{0,53}-[0-9a-f]{8}$` — at most 63
characters, tag included. The Worker checks the tag statelessly beside the
grammar: an id whose tag does not verify is answered the same
`404 {"error":"no such machine"}` a malformed id gets — a bare prefix, an
empty id, an embedded segment, a pre-tag id — and no hub wakes. That is what
closes the open id namespace a stateless router would otherwise have: forging
a routable id means holding the secret, or driving 2^32 online guesses
through a Worker whose credential-less routes are rate limited (below). On
the daemon leg the tag is checked *after* the bearer secret, deliberately:
that leg is the one route the rate rule does not meter, and checking the tag
first would hand it an unthrottled tag oracle (404 for a bad tag, 401 for a
good one) plus an HMAC per anonymous probe — while a caller past the bearer
check holds the very secret tags are minted from, so the check behind it only
catches an id minted under a secret that has since rotated away. Rotating
`DAEMON_SECRET` (re-setup) therefore invalidates every id, which re-setup's
re-join re-mints anyway.

The id is routing, not identity: the one bearer secret authorizes the daemon
leg of *every* machine's hub, and what keeps a machine's sessions its own is
the per-machine Noise key a browser pins at pairing, not the path. The honest
limit of that shared secret is `docs/RELAY.md`, "One secret for the fleet".
The tag changes none of that — it authenticates the *mint*, not the caller.

The real id is semi-public (it rides pairing links), and the Worker bills
every request before any of this runs, so the credential-less routes also sit
behind a **rate rule**: one Cloudflare rate-limiting binding, keyed by
connecting IP, over `/client/*`, `POST /api/pair/*` and every request to
`/directory` that does not present the secret — 300 requests per
60 s per IP per Cloudflare location, answered `429 {"error":"rate limited"}`
over it. Generous enough that a fleet of tabs never sees it; tight enough
that burning quota, or walking the tag space, needs a botnet. The daemon legs
are not rate limited: they are secret-gated, one socket per machine. The
metering on `/directory` is decided by the credential rather than the method
on purpose — otherwise an anonymous caller waving an `Upgrade` header would
have a cheaper road to the 401 than the metered `GET` beside it. The rule
is fail-open by design — a Worker deployed without the binding routes rather
than refuses — because it bounds cost, not access.

The size cap is **1 MiB**, and it is the relay's to enforce rather than the
daemon's. A client frame over it closes that socket alone with `1009`
`message too big` and is never forwarded. That matters because the daemon reads
its leg — the socket carrying *every* browser on that machine — with a single
2 MiB read limit that its WebSocket library enforces by dropping the connection
rather than the message: an oversized frame passed through would take every
channel on the machine down with it and do so again on every redial. The two
numbers are ordered deliberately (relay 1 MiB < daemon 2 MiB) so that a frame an
honest relay forwards, header and all, can never reach the daemon's limit.

`POST /api/pair`
is credential-less for the same reason and bounded the same way: a cap on the
body's size, a deadline the parked request answers `504` at, and a cap on
concurrent parked requests — over it the relay answers `429`
`{"error":"too many pairing attempts"}` without spending a `pair` id or waking
the daemon.

## What the relay sees

Terminal traffic is Noise ciphertext and the relay has no key for it. Channel 0
is **not** encrypted, and the honest list of what a relay operator can therefore
observe is:

- who is connected, when, and for how long;
- channel ids, message counts and message sizes — enough for traffic analysis
  of a session, not its content;
- the whole pairing exchange: the single-use pairing token, the device's public
  key, and the daemon's;
- everything in the fleet directory. The blobs are opaque to the *code*, not to
  the operator of the machine running it: machine ids and display names, device
  public keys and their names, and who revoked what and when are all in there,
  signed rather than secret. The relay already routed by machine id; the delta
  is names and device keys. One operator on their own Worker is why that is
  acceptable, and `docs/RELAY.md` states it rather than leaving it to be
  discovered.

Public-key material is public by design. The **token is not**: a hostile relay
could spend a live one with a key of its own and register itself as a paired
device, which is a real capability and not a theoretical one. Two things bound
it — the token is single-use and lives two minutes (`spec/protocol.md`,
Pairing) — and one thing does not: a relay that also serves the `/pair` page
serves the JavaScript that reads the pinned key, so pinning is no defence
against it (`docs/FOLLOW-UPS.md` §8). Pairing through a relay is a trust
decision about that relay's operator. Pair over the daemon's own origin when
you can.

## Conformance

`testdata/relay/frames.json` pins both framings as base64, generated from
`internal/relaywire` and walked by the Go, Worker and web test suites — the same
role `testdata/noise/ik.json` plays for the handshake and
`testdata/wire/control.json` for the wire protocol. It has two arrays:

- `channelFrames` — `{name, channel, payloadB64, encodedB64}`: an implementation
  must encode `(channel, payload)` to exactly `encoded`, and decode `encoded`
  back to that pair. The cases include an empty payload and channel
  `4294967295`, which a decoder that shifts rather than reading an unsigned
  32-bit integer gets wrong. The channel-0 cases carry one of every control
  message, so the JSON a Worker must parse and produce is pinned by the same
  file (`internal/relaywire` re-derives those payloads from its own encoder on
  every run, which is what catches a renamed field).
- `plainFrames` — `{name, text, dataB64, encodedB64}`: the same contract for the
  kind byte, including empty data and multi-byte UTF-8.

Regenerate with `go test ./internal/relaywire/ -update`; the committed file is
the artifact, and every case in it is asserted on every ordinary test run.

`testdata/relay/machine-ids.json` plays the same role for the machine-id MAC:
`{name, secret, slug, tag, id}` cases, generated from `internal/config`
(`go test ./internal/config/ -update`, which also re-derives every committed
case on ordinary runs) and walked by the Worker suite
(`relay/test/machineid.test.ts`). An implementation must derive `tag` from
`(secret, slug)` exactly, and accept `id` under `secret` and under nothing
else. The cases include the hostname-fallback slug, the 24-character
truncation ceiling, inner double dashes, a hex-shaped slug — the case a
parser that hunts for "the hex part" instead of "the last nine characters"
gets wrong — and one slug tagged under two secrets.
