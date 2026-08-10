# flue fleet trust

Status: draft, pre-implementation. This document specifies the fleet key, the
certificates it signs, self-certifying machine ids, and the relay's fleet
directory. It changes `spec/relay-protocol.md` where noted and leaves
`spec/protocol.md` untouched: what travels inside Noise is the same wire
protocol as before.

## The problem

Pairing is per machine. A browser that paired with machine A holds A's pinned
static key and an entry in A's device registry — and knows nothing about
machine B on the same relay, however many machines the operator joins. Every
machine means another ceremony on every device, and a headless machine means
gymnastics to reach its Devices screen at all.

The operator's mental model — one person, one relay, several machines, several
devices, everything mine — wants the other shape: pair a device once, and the
fleet is the unit of trust. What blocked that shape was never the ciphering
(Noise stays end-to-end; the relay still reads nothing) but the anchor. The
only fleet-wide credential was `DAEMON_SECRET`, and the secret is the wrong
anchor: it lives as an env var on the Worker, so it is exactly as safe as the
Cloudflare account, and it gates *daemons*, not devices — `/client/<id>` is
credential-less on purpose. Hanging device trust on it would turn "someone got
into my Cloudflare account" from an availability problem into a shell on every
machine.

So the design adds one credential that Cloudflare never holds.

## The fleet key

`flue relay setup` mints an Ed25519 keypair — the **fleet key** — alongside
the daemon secret. The private key travels in the join line and lands in
`relay.json` (mode 0600) on every machine, exactly like the secret does:

```
flue relay join wss://<host> --secret <S> --fleet <base64url ed25519 seed>
```

The fleet key never touches the Worker: not as a secret, not as a binding, not
in a log. The Worker can verify nothing signed by it, and that is the point —
the layering is

| Credential | Held by | Verifies |
|---|---|---|
| `DAEMON_SECRET` | every machine, the Worker | the daemon leg; machine-id MACs |
| fleet key (private) | every machine, never the Worker | — (signs) |
| fleet key (public) | every machine, every paired device | machine certs, device certs, revocations |

Every machine holds the same private key: trust inside the fleet is symmetric,
any machine can sign for the fleet, and there is no ceremony between machines.
That is a deliberate fit for the one-operator model this product serves, and
it is the trade the join line has always embodied — the line is the deliberate
hand-off, guarded like a root credential. What changes is its weight: today a
leaked join line buys disruption; with the fleet key aboard it buys the fleet.
`docs/RELAY.md` must say so in those words.

Compromise recovery is re-setup: `flue relay setup` on any machine mints a
fresh secret *and* a fresh fleet key, and every machine re-joins with the new
line, every device pairs afresh. That is today's rotation story with one more
key riding it.

## Certificates

All certificates are detached Ed25519 signatures over a canonical CBOR (or
length-prefixed — implementer's choice, pinned by test vectors) encoding of
the named fields. All carry `iat` (unix seconds) for display; expiry is
deliberately absent — revocation is explicit, below.

**Machine cert** — minted by the machine for itself at join/setup:

```
{ v: 1, kind: "machine", id: <machine-id>, name: <display name>,
  noise: <32B daemon static X25519 pub>, iat }
```

**Device cert** — minted by whichever machine ran the pairing ceremony, at the
moment the ceremony completes:

```
{ v: 1, kind: "device", device: <32B device X25519 pub>,
  name: <device display name>, pairedOn: <machine-id>, iat }
```

**Revocation** — minted by any machine, at the moment the operator revokes:

```
{ v: 1, kind: "revoke", device: <32B device X25519 pub>, iat }
```

A revocation permanently outranks any device cert for the same key,
whatever their timestamps. Un-revoking is pairing again: new browser storage,
new device key, new cert — old cert stays dead.

## What changes in the handshake

Nothing in the Noise pattern. IK's message A already carries an encrypted
payload; it now carries the device cert. The daemon's acceptance rule for a
relay channel becomes, in order:

1. The static key is in this daemon's own registry → accept (pairing on this
   machine still works exactly as before, cert or no cert).
2. The payload carries a device cert whose signature verifies under the fleet
   public key, whose `device` equals the handshake's static key, and whose key
   is not revoked → accept, and add the key to the local registry with the
   cert's name (so the Devices screen shows it, LastSeen works, and the
   daemon serves it even if the fleet key later rotates away).
3. Otherwise → the same close an unpaired device gets today.

The browser's side mirrors it. Today it pins one daemon static key per
machine record; with a fleet, the browser pins the **fleet public key** once —
delivered in the pairing link the same way the daemon key rides `k=` today —
and accepts any machine whose machine cert verifies under it, pinning the
cert's `noise` key for the IK handshake. One ceremony, and the directory
(below) tells it who the fleet is.

### The second delivery of the fleet public key

The QR is where a browser meets a fleet, and it cannot be the only place. A
ceremony run while the machine held no fleet key — before this document
existed, or in the window between a relay being set up and the daemon reading
the file — pins nothing, and that browser then reads no directory and sees the
single machine it paired with, permanently. The device cert has the same
failure and the welcome is already its answer; the fleet public key rides the
same welcome, under one condition:

> A browser may keep a fleet public key off a welcome **only** when the session
> carrying it is authenticated by a daemon static key that browser pinned at a
> ceremony of its own, and only into an empty record.

That is not trust on first use, and the distinction is the pinning. IK names
the pinned key as the responder's static, so message B decrypts only for the
peer holding its private half: the relay cannot forge the session, and a
machine that could lie about the fleet key holds the fleet seed already (it is
in every machine's `relay.json`) and can therefore mint a device cert for any
key it likes — a wrong fleet key is not an escalation of anything it lacks. The
condition excludes the two channels where it would be: a machine reached on a
machine cert, whose Noise key was vouched for by the very fleet key being
supplied, and a loopback connection, which authenticates a session cookie and no
key at all.

An existing pin is never replaced. Two fleet keys differ only if the fleet was
set up again, and the browser's own device cert is then signed by a key nothing
honours — so adopting the new one would trade a browser that lists what it can
reach for one that lists what it cannot. Pairing again is what mints a
certificate, and it stays the way out of that state.

### The third delivery: a machine's own browser

Neither delivery above reaches the tab a user opened on
`http://127.0.0.1:7717`. It ran no ceremony because it never needed one — the
session cookie is its credential and it was only ever talking to the machine it
is on — so it holds no device cert to present to a sibling; and the rule above
excludes it by name, because a session cookie authenticates no key. Nor can it
be sent to the QR: a pairing link lands on the *relay's* origin, which is a
different storage partition, so the ceremony would admit a browser that is not
this one. Before this the fleet silently collapsed to one machine on a fully
joined laptop, and nothing on any screen said why.

The daemon that served the page answers instead, on its loopback HTTP surface,
behind the same session token as everything else there:

```
POST /api/fleet/enrol       body {publicKey} → {deviceId, deviceCert, fleetPub, machineId}
GET  /api/fleet/directory   the relay's own answer, byte for byte
```

**Enrolment grants no authority that the caller does not already hold.** A
client that can open `/ws` on loopback can spawn a shell, and a shell can read
`relay.json`, which holds the fleet *seed* — so it could already mint a cert for
any key it liked, valid on every machine. The endpoint collapses three steps
into one for the honest case and changes nothing for the dishonest one. For the
same reason it is HTTP on loopback and **must never acquire a wire-protocol
equivalent**: a relay-origin device cannot read `relay.json`, so a `wire.Enrol`
*would* be an escalation — admission to one machine becoming the power to
manufacture admission to every machine, for keys nobody has proved they hold.
It is idempotent by lookup, so a browser asks on every load rather than
remembering.

**Why the browser may pin a fleet key here.** The rule above is about a
connection to a *peer*, and the danger it guards against is an intermediary or
an unknown party choosing the anchor every machine cert hangs from. On loopback
there is no such party: the socket goes to one process on this computer, the one
that owns the key and served the page. The pin *is* replaced here, unlike
above, and for a reason that is the mirror of the one given there — the cert
arrives with the key, from the process that minted both, so the pair is coherent
on arrival; and a loopback tab has no ceremony to be sent back to.

**The directory route is transport and not trust.** It exists because the relay
answers `GET /directory` without an `Access-Control-Allow-Origin` header, so a
loopback tab's cross-origin fetch is discarded before it can be read — and
`readDirectory` reports every fault as "no machines", so the tab showed a fleet
of one. The daemon forwards the bytes unchanged and the browser verifies every
blob under the pinned fleet key exactly as it does when it reads the relay
directly. A directory the daemon had "checked" would be one the browser could be
tempted to trust on the daemon's say-so, which is the property the fleet key
exists to keep out of every intermediary's reach.

## The fleet directory

Auto-pair needs one piece of distribution: a device paired on machine A must
become visible to machine B (its cert must reach B) and to the browser (the
machine list must reach the device). Daemons do not talk to each other, and
should not start to. The relay already sits in the middle, and everything
that needs distributing is a *public* signed artifact — so the relay hosts a
directory and verifies none of it.

One additional Durable Object per fleet (`idFromName("directory")`, one relay
is one fleet) with three routes:

```
PUT    /directory          daemon leg auth (Bearer secret); body: one cert or revocation
GET    /directory          credential-less; the full set: machine certs and revocations
DELETE /directory          daemon leg auth; empties the whole set (`flue relay reset`)
WS     /directory (daemons)  daemon leg auth; push on write, so daemons learn of new
                           revocations without polling
```

**Device certificates are deliberately not in the directory.** A device gets
its own certificate from the machine that minted it — in the pairing answer,
and again in the welcome of every connection it opens anywhere in the fleet —
both channels on which it is already authenticated, and the second of which is
inside Noise. Publishing them as well bought one thing, a browser being able to
find its own, and cost two: `GET /directory` needs no credential, so it became
a public roster of the operator's device keys and the human labels beside them;
and nothing in the directory is ever deleted one entry at a time, so each
ceremony ever performed spent one of 512 permanent entries. No daemon ever read
one from there — a machine admits a roaming device on the certificate the
device *presents* in its handshake, which is rule 2 — so nothing needed them.

What the directory still owes a stored certificate is the other half of the
rule: a browser reads the revocations and stops presenting a certificate whose
key the fleet has cut off.

**Pruning superseded entries: considered, and not built.** The reason is that
there is almost nothing left to prune, not that a delete would be dangerous.

Count what can ever be *superseded* now. A revocation never is: it is the
final word about a key and outranks everything, forever. A device certificate
is not in here at all. That leaves a machine certificate a machine re-minted,
which happens when `flue relay setup`/`join` runs on that machine again — a
handful of times in the life of a fleet, and one entry each. Against a cap of
512, the growth term this would reclaim is single digits. A mechanism, its
failure modes and its tests, to win back a fraction of a percent of a store
that no longer grows with use, is not a trade worth making.

The failure it would guard against is already covered, and covered by
something with no opinion about any blob: `DELETE /directory`
(`flue relay reset`) empties the store, and every daemon re-publishes
everything it holds on its next connect and every 30 minutes thereafter, so
the fleet refills itself. The status surfaces warn from 90% of the cap, so
arriving at the wall is a decision rather than a discovery. What a wipe
genuinely costs — a blob whose only remaining holder never reconnects — is
stated with the route itself in `docs/RELAY.md` rather than hidden here.

Two arguments that would be tempting here are **not** the reason, and are
written down so nobody re-derives them as one:

- *"A targeted delete on the daemon secret would let one compromised machine
  delete any entry."* True, and this design already ships `DELETE /directory`
  on that same secret, which lets that machine delete **every** entry
  including every revocation. A targeted delete would be strictly weaker than
  what the secret already buys, and self-healing for the same reason the wipe
  is. The secret is a fleet-wide credential; a compromised machine holding one
  is the case `spec/relay-protocol.md` treats under re-setup, not a case
  pruning would change.
- *"A signed delete would need the relay to verify."* Also true, and it is a
  real cost — but it is the cost of the *signed* variant only, so it is an
  argument about which mechanism, not about whether to have one.

**Future work, deliberately not built: a verify-only deletion gate.** The
fleet *public* key could be bound to the Worker so that a `DELETE` naming
digests is honoured only when a fleet-signed statement authorises it. The
private key still never goes near the relay, so this does not weaken minting.
It is not built because it makes the Worker a policy engine — today it stores
bytes and serves them, and every rule about what those bytes mean lives in the
readers — and because it creates a rotation problem the rest of this design
does not have: rotating the fleet key would leave a Worker bound to the old
public half, unable to honour a delete signed by the new one and still willing
to honour one signed by the old. Either shape of that fix (a rotation
ceremony, or a Worker that accepts two keys during an overlap) is a bigger
change than the entries it would reclaim.

The Worker stores blobs it cannot check; every reader verifies every
signature under the fleet public key and drops what fails. A hostile relay
can serve a stale or truncated directory — it always could refuse to route —
but cannot mint a machine or a device, because it does not hold the fleet
key. Availability remains the relay's only power; that invariant is the spine
of `spec/relay-protocol.md` and survives intact.

Privacy note for `docs/RELAY.md`: the directory makes machine names and ids
visible to the relay, and to anyone who reads the credential-less route (they
are signed, not secret). The relay already routes by machine id, so the delta
is machine *names* and the revocation history — who was cut off and when.
One operator, their own Worker: acceptable, and stated.

State the device-certificate delta precisely, because it is easy to overclaim.
The relay *operator* still sees every device certificate: a relayed pairing
posts through the Worker in cleartext and the certificate comes back in the
answer (`spec/relay-protocol.md`, "What the relay sees"), and no directory
arrangement changes that, since the request is the ceremony. What keeping them
out of the directory removes is the **anonymous reader**: `GET /directory`
takes no credential, so a published certificate was a device public key and its
owner's label readable by anyone who knew the relay's address, permanently.
"Not published to strangers", not "not seen by the operator".

Flows, end to end:

- **New machine.** `flue relay join` (one line) → daemon mints its machine
  cert, PUTs it, opens the directory socket. Every paired browser's next
  directory read shows the machine, and presents the certificate it already
  holds to be let in. No ceremony.
- **New device.** Pair once, on any machine (that machine's `/pair` page,
  reached through the relay as today). The ceremony's machine mints the device
  cert and hands it to the device in the pairing answer, which the browser
  verifies under the fleet key it pinned from the QR seconds earlier and keeps.
  The phone's next directory read gives it the whole fleet's machines, and its
  stored certificate is what those machines admit it on. Any machine it can
  reach re-offers the same certificate in its welcome, so losing it is not
  losing the fleet.
- **A device the QR reached too early.** A browser paired while its machine
  held no fleet key holds neither record, so it sees one machine. The first
  welcome from a machine it paired with carries both — the key first, since the
  certificate verifies under it — and the fleet fills in without a ceremony.
  See "The second delivery of the fleet public key" for the condition on that,
  which is the whole of why it is safe.
- **Revoke.** The Devices screen on any machine revokes any fleet device: PUT
  the revocation, push to every daemon, each drops the key from its local
  registry and closes its channels — the existing `revoked{reason}` flow, now
  fleet-wide.

## Self-certifying machine ids

The Worker instantiates a Durable Object for any grammar-valid id today,
because a stateless router cannot know which ids exist — the id namespace is
open. Close it with the one credential the Worker does hold:

```
machine-id  =  <slug> "-" <tag>
slug        =  hostname slug + "-" + 4 random hex, exactly as MintMachineID
               builds ids today (the randomness is what keeps two machines
               named "mac" distinct — the tag below is deterministic and
               cannot do that job)
tag         =  first 8 lowercase hex of HMAC-SHA256(DAEMON_SECRET, "flue-machine-id/" + slug)
```

`machineIdFrom` grows a MAC check beside the grammar check: an id whose tag
does not verify is the same 404 as an id whose shape does not parse, and no
object wakes. Forging an id means either holding the secret or driving 2^32
online guesses through the Worker — each one a billed request the rate rule
(below) throttles, to win nothing but the DO wake that any request got
before.

Two consequences, accepted: ids grow nine characters (`mac-a1b2-3f9a12cd`),
and rotating the secret invalidates every id — which re-setup does anyway,
since every machine re-joins. Today's id becomes the slug, verbatim; the tag
is appended.

## Rate rule

MAC ids close the *fake*-id surface. The *real* id is semi-public (it rides
pairing links), and `run_worker_first` bills every request before any of this
runs — so the Worker also gets a Cloudflare rate-limiting binding, one rule,
keyed by connecting IP, over `/client/*`, `/api/pair/*` and `GET /directory`.
Limits generous enough that a fleet of tabs never sees them (order of 100/min
per IP), tight enough that quota-burning needs a botnet. The daemon leg is
not rate-limited: it is secret-gated and one socket per machine.

## Compatibility

None kept, deliberately (pre-adoption; the operator redeploys and re-pairs):

- Ids without MAC tags are refused by the updated Worker.
- Daemons without machine certs never appear in the directory; browsers on
  the new bundle require certs for machines they did not pair directly.
- The `--fleet` flag is required by `join` when the relay was set up with a
  fleet key; `setup` always mints one.
- Test vectors: the cert encodings and the id MAC get committed vectors under
  `testdata/`, exercised from Go and TS both, like `testdata/noise/ik.json`
  and `testdata/relay/frames.json` before them.

## What this deliberately does not do

- No per-machine fleet sub-keys, no signing hierarchy, no cross-machine
  ceremonies: one operator, one key, symmetric trust.
- No expiry on certs: revocation is explicit and the directory is small.
- No relay-verified certificates: the Worker stays unable to admit anyone.
- No change to `spec/protocol.md`: sessions, refs, frames — untouched.
