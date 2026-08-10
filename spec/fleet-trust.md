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

**Signed pruning of superseded certificates: considered, and not built.** With
device certificates gone, the only entry that can ever be *superseded* is a
machine certificate a machine re-minted — which happens when `flue relay
setup`/`join` runs on it again, a handful of times in the life of a fleet. The
mechanism to remove them would be a fleet-signed statement naming the digests
to delete, and the relay would have to check that signature before honouring
it, which means binding the fleet public key to the Worker and giving this leg
an opinion about the blobs it holds. That reverses the invariant the whole
design rests on — the relay stores and serves and verifies nothing — for a
handful of entries out of 512. The alternative, deleting by digest on the
daemon secret alone, is worse: it hands anyone who compromises one machine the
ability to delete *any* entry, and the relay cannot tell a revocation's digest
from a certificate's, which is the "eviction can drop a revocation" failure
the no-eviction rule exists to prevent. The bounded, keyless answer to a
directory that has genuinely filled is `DELETE /directory`
(`flue relay reset`), which needs no opinion about any blob, and the status
surfaces warn from 90% of the cap so it is a decision rather than a discovery.

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
Device public keys and device labels are **not** in it, per the paragraph
above. One operator, their own Worker: acceptable, and stated.

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
