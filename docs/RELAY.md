# Remote access: the relay

The relay is a Cloudflare Worker with one Durable Object per machine. One
Worker fronts every machine you own: each daemon dials its own slot on it,
outbound, and the Worker bridges that single WebSocket to any number of browser
tabs, forwarding bytes, the terminal traffic crossing it is Noise ciphertext
it holds no key for. The first machine deploys it into your own Cloudflare
account with `flue relay setup`; every other machine joins the same Worker with
the one line setup prints. There is no flue-operated server in the path.

This is the operator's document, the protocol in one page, what it costs, what
bounds abuse, how to read its counters, and the manual end-to-end a human runs
before a release. The honest limits of "the relay cannot read your terminal" are
in [`faq.md`](faq.md); the normative protocol is
[`spec/relay-protocol.md`](../spec/relay-protocol.md).

## The protocol in one page

```
daemon  ---- wss /daemon/<id> ---->  Worker + one DO per machine  <---- wss /client/<id> ----  browser
        [4B channel][payload]                                     [payload]
           |                                                                     |
           +------------- Noise IK: browser initiator, daemon responder ---------+
                          inside: [1B kind][wire protocol bytes]
```

- **The `<id>` in the path is routing, not identity.** It is the machine id a
  daemon joined under (`<hostname>-<4 hex>-<8 hex tag>`, minted by setup and
  join) and the Worker turns it into that machine's own Durable Object
  (`idFromName`), handing the hub the bare path. The tag is a MAC over the
  rest of the id under the daemon secret, and the Worker verifies it before
  routing — so only ids this relay's own setup or join minted exist, and a
  guessed or hand-made id wakes nothing. One lowercase slug of at most 63
  characters ending in the 8-hex tag; anything else — a bare `/daemon` or
  `/client`, a tampered tag, an id from before tags — is answered
  `404 {"error":"no such machine"}` and never with an asset.
- **The daemon leg is outbound.** Nothing on your machine listens for the
  relay's sake. Every binary message on it is `[4-byte big-endian channel]` then
  payload.
- **The browser leg carries no channel header.** The Worker knows which channel
  a socket is from the socket itself, and wraps and unwraps on the browser's
  behalf.
- **Channel 0 is control, in cleartext JSON:** `open` and `closed` (a browser
  arrived or went away), `close` (the daemon dismisses one), and `pair` /
  `pairResult`, the one part of the ceremony that is an HTTP request, parked at
  the relay while the daemon answers it.
- **Channels 1 and up are one browser each,** carrying a Noise IK handshake and
  then transport ciphertexts, forwarded without inspection. Inside a decrypted
  payload, one byte says text or binary and the rest is the ordinary wire
  protocol (`spec/protocol.md`), unchanged.
- **A daemon reconnect invalidates every live channel**, the daemon holds each
  channel's responder state in memory, so a restarted daemon has no key for a
  channel opened before the break. Live client sockets are closed `1012 daemon
  gone`; browsers reconnect and handshake again. Channel ids come from a counter
  in Durable Object storage, so an id is never reused.
- **Auth is asymmetric on purpose.** The daemon leg carries
  `Authorization: Bearer <daemon secret>`, one secret for the whole Worker,
  every machine presenting the same one ("One secret for the fleet", below);
  the browser leg carries nothing, because Noise is the confidentiality
  boundary and a browser credential would add none. What a credential-less leg
  does expose is denial of service, and that is what the caps below are for.
- **Keepalive:** either leg may send the text frame `flue-ping`, which the
  Cloudflare edge answers `flue-pong` from the Durable Object's auto-response
  without waking it. The daemon and the browser each send one every 30 s, which
  is what keeps an idle socket under the edge's roughly 100 s idle close.

## Standing one up

```sh
flue relay setup     # machine 1: paste a Cloudflare API token, watch it deploy
flue relay join …    # every other machine: the one line setup printed, verbatim
flue relay status    # what is configured, and what the fleet directory holds
```

Setup needs a token from the **"Edit Cloudflare Workers"** template. It verifies
the token, picks the account (asking when there is more than one), uploads the
Worker with its Durable Object migration and the whole web bundle as the
Worker's static assets, served under the same `Referrer-Policy` and
`Content-Security-Policy` the daemon serves its own UI with, minus the loopback
sockets a relay origin has no use for, enables the `workers.dev` subdomain, sets a fresh
32-byte `DAEMON_SECRET` on the script, mints a fresh **fleet key** it uploads
nowhere, mints this machine an id and a display name, and writes `relay.json`
(mode 0600) into flue's config directory,
`$XDG_CONFIG_HOME/flue` or `~/.config/flue`. The API token is never stored:
its whole life is that one command, and you can delete it afterwards. Restart
the daemon to pick the relay up.

Setup ends by printing the line every other machine joins with:

```
flue relay join wss://flue-relay.<sub>.workers.dev --secret <...> --fleet <...>
```

Run it there and restart that daemon. That is the whole of adding a machine.
Join never touches the Cloudflare API — the Worker already exists — so
everything it does is local: check the address, take the two credentials off
the line, mint this machine a fresh id (`<hostname>-<4 hex>-<8 hex tag>`, its
slot on the relay and the `<id>` in both wss paths — the tag is a MAC under
the secret from the join line, which is why an id minted with a mistyped
secret dials into `404 no such machine`), and write the same `relay.json`
shape setup writes. Both flags are required and `--fleet` is refused when
missing rather than defaulted: a machine that joined without the fleet key
would dial the relay fine and trust nothing its fleet signed, which is a
worse failure than not joining.
`--name` sets the label the machine picker shows; it defaults to the hostname
and rides the pairing link's query (`n=`) so the pairing browser can write it
down, never a path, and never anything the Worker routes on.

Join also mints this machine's own **machine certificate** — its id, its name
and its Noise static key, signed under the fleet key — and stores it. That is
what a browser reads out of the directory to reach a machine it never paired
with, so a machine that joined and was never restarted is a machine the fleet
cannot see; the restart is not optional.

Run it from a **release binary** (`make build`, or an installed flue). The
Worker and the web app are both compiled into that binary, and a dev build
carries neither, setup refuses rather than deploying something that is not
there.

Re-running setup against the same account is safe for the Worker (the deploy
and the secret are upserts) but it is a reset, not a repair: every run mints
a fresh secret, a fresh fleet key *and* a fresh machine id. The fresh secret
is deliberate: setup is the recovery path for a leaked one, and a run that
reused the old could never rotate it, and it means every machine that joined
is now presenting a stale secret and has to run the newly printed join line —
and, because ids carry a MAC tag minted under the secret, every old id stops
routing at the same moment (the re-join each machine runs anyway mints its
fresh one). The fresh fleet key is deliberate for the same reason and cuts
deeper: it retires every device certificate the old key signed, so no device
walks into any machine on a cert from before the reset, and every device
pairs again. The
fresh id means the old hub slot is simply abandoned: a browser that paired
against it is dialling a slot no daemon dials, answered `503 daemon offline`
until it pairs this machine again and forgets the old row in the picker. To
*add* a machine, the join line is the whole of it, setup is never the command
to run on machine two. Re-running setup against a *different* account leaves
the old Worker live and reachable; there is no `flue relay teardown`, so
delete it in the dashboard yourself (`docs/FOLLOW-UPS.md` item 12).

### What the join line is worth

It carries two credentials, and they are not the same kind of thing.
`--secret` is the `DAEMON_SECRET`, which Cloudflare holds too: it gates the
daemon leg, so it is exactly as safe as your Cloudflare account. `--fleet` is
the **fleet key** ([`spec/fleet-trust.md`](../spec/fleet-trust.md)) — the
private half of one Ed25519 keypair, held by every machine on this relay and
by nothing else, which signs the certificates that say "this device is one of
ours". It reaches the Worker in no binding, no secret and no log, and that is
the entire point: the Worker gates *routing*, the fleet key gates *trust*, and
the two fail independently. Someone who gets into your Cloudflare account can
take remote access away; they cannot admit a device.

Which is why the line's weight changed when the fleet key came aboard: **a
leaked join line used to buy disruption; with the fleet key aboard it buys the
fleet.** With the secret alone, whoever holds it can squat a machine's slot,
knock its daemon off, and accept new pairings while pretending to be it
("One secret for the fleet", below) — bad, and bounded by the ceremony a
human still has to perform. With the fleet key too, they can sign a device
certificate for a key they already hold, and every daemon on the relay will
admit that device as one you paired: no ceremony, no prompt, on machines they
have never touched.

So treat the printed line as the root credential it is. Paste it into the
other machine's terminal, not into a chat that keeps history — and shell
history keeps it just as well as chat history does. The line lands in the
other machine's history file with the secret *and* the fleet key in it, so
clear that entry on any machine whose history someone else can read. If it
does get out, recovery is re-setup: `flue relay setup` mints a fresh secret
*and* a fresh fleet key, every machine re-joins with the new line, and every
device pairs again. There is no way to retire one machine's copy of a fleet
key while keeping the fleet — every machine holds the same key, deliberately
(that trade is the one that buys pair-once-per-fleet).

### The Remote screen runs the same deploys

Setup and update are also cards on the UI's Remote screen: a token field, a
plain list of what will be created, a Deploy button, and (when the relay's
`/api/health` reports an older flue than the daemon) an update card. They
POST to the daemon's `/api/relay/*` endpoints, which call the same
`internal/relaydeploy` code the CLI calls; there is one deploy, with two
doors.

The boundary that makes a token in a browser acceptable: those endpoints
exist only on the daemon's loopback HTTP surface, and the form only renders
on a loopback origin (`useRelayUIInfo` refuses elsewhere). A remote tab,
served by the relay and speaking the Noise channel, is never offered the form
and has no wire operation that could reach the endpoints. A Cloudflare API
token must never ride the relay; the FAQ's hostile-origin analysis is the
reason.

### Updating a deployed relay

The command for a relay that should catch up with a newer flue is not setup,
it is:

```sh
flue relay update
```

It redeploys the Worker and the web bundle this binary embeds over the
script `relay.json` records (`flue relay setup --worker` chose it; older
files without the record fall back to the workers.dev host's first label),
and it rotates nothing: the deploy preserves the bound `DAEMON_SECRET`, no
machine id is minted, and `relay.json` is never written. Every joined daemon
and every paired browser reconnects on its own. It asks for an API token the
same way setup does, uses it for the deploy alone, and stores nothing.

A relay's version is the version of the flue that deployed it, the Worker
ships inside the binary, so `brew upgrade flue && flue relay update` is the
whole upgrade story.

**A relay deployed before the fleet directory needs this run once.** The
directory is a second Durable Object class (`FleetDirectory`), and a Worker
that predates it has no such binding: `/directory` answers
`503 {"error":"directory unavailable"}`, and `flue relay status` says so in
as many words —

```
fleet:    unreachable (this relay has no directory; run `flue relay update` to redeploy it)
```

— which is the whole of the flag day. Until it is run, no device certificate
or revocation is distributed and no browser learns of a machine it did not
pair with by hand. Nothing else is affected: sessions, pairing and every
machine you already paired keep working exactly as before, which is what makes
this an upgrade rather than an outage. `flue relay update` adds the class (the
deploy reads the migration tag the account's copy of the script already
carries and sends only the steps behind it), and the daemons publish
everything they hold on their next connect.

### A custom domain

Route a domain to the Worker in the Cloudflare dashboard (Workers → your
relay → Domains & Routes), then tell flue the new name:

```sh
flue relay address wss://relay.example.com
```

or use "Change the relay address" on the Remote screen's card. Either way it
is a local rewrite of relay.json's URL and origin, the worker, the secret
and this machine's id are untouched, because the Worker behind the name is
the same one. Restart the daemon to dial the new name.

What the move does cost: **every paired browser pairs again, on the new
origin.** A pairing is pinned to the origin the browser performed it on. The
hub announces, on every channel, the origin the browser actually connected
through, and the daemon refuses any channel or pairing request announced on
an origin it did not dial (`internal/transport/relay/channel.go`) — that
refusal is what stops a relay lying about where a browser came from, and
what keeps a live pairing token from being spent on an origin the user never
opened, so it does not soften for the origin *you* used to dial. The old
workers.dev origin still routes to the Worker, but a tab paired there now
reconnects into that refusal forever, and a pairing attempt from it is
refused the same way (which the pair page can only report as a spent
window). The fix is the front door: open the new address, scan a fresh QR,
and the browser mints its keys and records under the origin the daemon now
serves — they live per origin in the browser anyway.

### One account, several relays

The script name is the unit of separation. `--worker flue-relay-dev` on
setup deploys a second, fully independent relay beside the default
`flue-relay`: its own workers.dev hostname, its own secret, its own hubs.
That is how a development relay lives in the same account as the one your
installed flue depends on without being able to touch it
([DEVELOPMENT.md](DEVELOPMENT.md)).

## One secret for the fleet

Daemon-leg auth, v1: one `DAEMON_SECRET` per Worker, shared by every machine
that joined it. The machine id in the path is routing, not identity, the
Worker checks the secret and nothing else before giving a dial the hub it
asked for.

The honest limit follows directly. A compromised machine holds the secret,
and the secret opens *any* machine's daemon leg, so it can dial a sibling's
slot and impersonate that machine's daemon. What it cannot do is read the
sibling's sessions: Noise keys are per machine, a browser's handshake only
completes against the static key it pinned when it paired that machine, and
the impostor does not hold that key. What it can do is squat the slot, the
hub gives the daemon leg to the newcomer and closes the incumbent
(`4000 replaced`), so the real daemon is knocked off and its browsers see it
drop, and accept *new* pairings as if it were the sibling, which is the
capability to take seriously.

Two things keep that in proportion, and neither is a fix. The secret is shared
only across machines you already trust with each other, so the blast radius is
your own fleet, which matters exactly on the day one of them stops deserving
the trust. And recovery is one command: `flue relay setup` on any machine
mints a fresh secret the compromised machine does not hold; re-join the
machines that still deserve it. The upgrade path (a per-machine secret,
learned by each hub on its first daemon connect) changes no wire format and
is deliberately deferred; until it lands, this section is the honest statement
of what the shared secret does and does not separate.

### And one key the Worker never holds

The secret stopped being the only fleet-wide credential when the fleet key
arrived. The layering, in full:

| credential | held by | what it decides |
|---|---|---|
| `DAEMON_SECRET` | every machine, **and Cloudflare** | the daemon leg; which machine ids route |
| fleet key (private) | every machine, nobody else | signs machine certs, device certs, revocations |
| fleet key (public) | every machine, every paired device | verifies all three |

That split is what makes "someone got into my Cloudflare account" an
availability problem rather than a shell on every machine: the Worker can
refuse to route, and it cannot admit a device, because it holds nothing that
signs.

The honest cost sits on the other side of the same line. Every machine holds
the same private key — trust inside the fleet is symmetric, any machine can
sign for the fleet, and there is no ceremony between machines — so a
compromised machine can mint a device certificate every other machine will
honour — and a *machine* certificate naming a Noise key of its own, which a
browser that has never paired the machine it names will pin and dial. (A
browser that did pair it keeps the key from its own ceremony, which is
stronger evidence than anything read off the relay, so that one is not
repointed.) The shared-secret analysis above understates what a compromised
machine can do by exactly that much. That is the trade that buys pairing once
for a fleet instead of once per machine, for the one-operator model this is
built for, and it is why re-setup (fresh secret, fresh fleet key, everyone
re-joins and re-pairs) is the whole of compromise recovery.

### The fleet directory

Certificates only mean something once they reach the machines and devices
that check them. Daemons do not talk to each other and should not start to,
so the relay carries them: one more Durable Object, not per machine, holding
the signed blobs the fleet has produced — machine certificates, device
certificates, revocations.

```
PUT    /directory  the daemon secret; one signed blob
GET    /directory  no credential at all; the whole set
DELETE /directory  the daemon secret; empties the whole set (`flue relay reset`)
WS     /directory  the daemon secret; one push per new entry
```

**The relay stores and serves, and verifies nothing.** It holds no fleet key,
so it cannot tell a machine certificate from a revocation from 200 bytes of
noise — and must not try. Every reader, daemon and browser both, checks every
signature under the fleet public key and drops what fails. What a hostile
relay can do here is serve the set stale, cut short or empty, which is the
same power it always had (it could refuse to route); what it cannot do is mint
an entry. The cost of a hostile relay stays availability, and nothing else.

Three things follow that an operator sees:

- **A machine joined later needs no ceremony.** `flue relay join` mints that
  machine's certificate and publishes it; the next directory read on every
  paired browser puts the machine in the list, and every device certificate
  already in the directory lets those devices straight in.
- **Pair a device once, for the fleet.** The ceremony's machine signs the
  device certificate and publishes it. The browser being paired takes the
  fleet *public* key out of the same QR that carries the daemon's own
  (`f=` beside `k=`) and pins it — the QR is the one leg of the ceremony no
  intermediary can sit in — and from then on it accepts any machine whose
  certificate verifies under that key, pinning the Noise key the certificate
  names. The device presents its own certificate in the handshake, which is
  how a machine that has never seen it admits it.
- **A revoke crosses machines.** Revoking on any machine's Devices screen
  publishes a revocation; every connected daemon hears the push within
  seconds, drops the key from its own registry and closes that device's
  channels. A revocation permanently outranks a device certificate for the
  same key whatever the timestamps say, on every reader — un-revoking is
  pairing again, under a new key.

**Entries are content-addressed and no single entry is ever deleted.** The
storage key is the SHA-256 of the exact bytes, so a `PUT` can only add, a blob
comes back byte for byte, and re-publishing costs nothing. Nothing prunes,
deliberately: every eviction policy can drop a revocation, and a directory that
forgets a revocation re-admits the device it revoked to every machine that had
not yet heard. The whole set can be emptied at once — see the reset below —
because that needs no opinion about what any one blob means, which is the only
kind of deletion a relay holding no fleet key is entitled to perform.

Which is why it can fill up. A blob is capped at 4 KiB and the set at **512
entries**, and at the cap a new blob is refused with
`507 {"error":"directory full"}` rather than making room. What that means to
you: nothing already published stops working — every certificate and every
revocation in there keeps being served and honoured — but the *next* thing
your fleet signs **is not stored and is not pushed to anybody**. The refusal
comes before both: the relay does not keep the blob, so there is no new entry
to fan out, and the push socket carries new entries and nothing else. Nobody is
notified, including the machines that are connected right now.

So a device paired after that point works on the machine that paired it and
nowhere else. And, far more seriously, a revocation made after that point takes
effect **only on the machine it was typed on** — that machine drops the key
from its own registry and closes that device's channels, because a revoke is
local first — while every other machine in the fleet goes on admitting the
device on the certificate it already holds. Re-publishing does not rescue it
either: the machine re-offers that revocation on every reconnect and every half
hour, and is answered 507 every time. The daemon that hit it logs

```
the fleet directory is full; this artifact was not stored and was not pushed
to anyone, so no machine will learn of it from here — run `flue relay reset`
to empty the directory
```

and `flue relay status` shows the count sitting at 512. 512 is years of
pair-and-revoke churn for one operator (entries are machines, devices, and one
revocation per device ever revoked), so reaching it is a signal worth reading:
either something is publishing in a loop, or the relay is shared with a fleet
it should not be.

**The way out is `flue relay reset`**, and it is the only way out. Redeploying
does not clear the directory and neither does re-running setup: the Durable
Object is named by a constant, its storage outlives every deploy of the script,
and a fresh fleet key does not delete the blobs it orphans — it just leaves 512
signatures nobody can verify occupying the cap. So there is one command:

```
$ flue relay reset
this empties the relay's fleet directory: every machine certificate,
every device certificate and every revocation the relay is holding.
...
type yes to continue: yes
  ✓ fleet directory reset (512 entries cleared)
```

It empties the set — never a chosen part of it, because choosing needs the
fleet key the relay must never hold — and the fleet then puts itself back:
every machine re-publishes everything it holds on connect and every 30 minutes,
and the reset disconnects the push sockets so that reconnect happens in seconds
rather than at the next half hour. A machine that is switched off republishes
its share when it next starts.

What a wipe costs, stated rather than buried: **a blob whose only remaining
holder never reconnects is gone.** The one that matters is a revocation
published by a machine that has since been decommissioned — every machine that
already heard it still holds it in its own `revocations.json` and re-publishes
it from there, so this is a narrow window and not a general loss, but it is not
an empty one. If you are not sure, revoke the device again from any machine
after the reset; a revocation is idempotent everywhere it lands.

**What the relay learns from it.** The blobs are opaque to the *code* and not
to whoever runs the Worker: machine ids and display names, device public keys
and device names, and who revoked what and when are all in there, signed
rather than secret. The relay already routed by machine id; the delta is names
and device keys. Public-key material is public by design and none of it opens
anything — reaching a machine still needs the private half of a device key
that never leaves the browser holding it — but it is a real change in what a
relay operator can see, and on your own Worker, in front of your own machines,
that is the trade this document would rather state than leave to be
discovered. The full list of what a relay sees is in
[`spec/relay-protocol.md`](../spec/relay-protocol.md), "What the relay sees".

**Reading it.** `flue relay status` asks the relay directly and verifies every
blob locally, which is why the second number is the one that means anything:

```
relay:    configured (wss://flue-relay.<sub>.workers.dev), status unknown from here
fleet:    7 entries, 7 verified under this fleet key (2 machines, 3 devices, 2 revocations)
```

`entries` is what the relay claims to hold; `verified` is how much of it this
machine's fleet key actually signed. A gap between them is worth looking at —
it is a fleet key that has rotated, or a relay that is not the one this machine
thinks it is — and status says so on a second line when it happens. It also
says when this machine's own certificate is missing from the set, which is the
one fault a freshly joined machine really has: other devices will not discover
it. The same counts ride `GET /api/relay/info`, which is where the Remote
screen reads them.

## Cost model

The whole free-tier promise rests on this, and it should rest on measured
counters rather than on this section. Every figure below is
Cloudflare's list pricing as researched in **August 2026**, re-check it at
[the Workers pricing page](https://developers.cloudflare.com/workers/platform/pricing/)
before quoting it at anyone.

**Free plan, per day:**

| meter | free allowance |
|---|---|
| Worker requests | 100,000 / day |
| Durable Object requests | 100,000 / day |
| Durable Object duration | 13,000 GB-s / day |
| Egress (bandwidth) | free, unmetered |
| Static asset requests | free, unmetered |

**Paid rates, once past the free tier:** Durable Object duration
**$12.50 per million GB-s**, Durable Object requests **$0.15 per million**.

Four facts decide flue's shape here:

1. **Hibernation-eligible Durable Objects bill no duration.** A DO whose only
   attachment is hibernatable WebSockets, with no pending timer pinning it in
   memory, is not billed for the wall-clock time it spends asleep. This is why
   the hub uses the hibernation API throughout, why the handshake deadline is a
   storage alarm rather than a `setTimeout`, and why `flue-ping` is answered by
   the edge's auto-response instead of by code. A terminal is ~99 % idle; if
   hibernation works, an open-all-day session bills duration only for the
   milliseconds it spends forwarding frames.
2. **Without hibernation the model collapses,** and the arithmetic is worth
   keeping in view: a DO pinned awake all day is 86,400 s × 128 MB = **10,800
   GB-s per machine per day**, which is 83 % of the entire free daily allowance
   for one machine, and about **$4 per machine per month** at the paid rate.
   That is the number hibernation has to keep at zero.
3. **Incoming WebSocket messages are billed 20:1**, twenty inbound messages
   count as one Durable Object request. Messages the object *sends* are not
   requests. So a chatty session is a twentieth as expensive as a naive frame
   count suggests: a 30 s keepalive is 2,880 pings/day/socket, i.e. 144 billed
   requests; ten thousand output frames is 500. Whether an auto-responded
   `flue-ping` is metered at all is exactly the kind of question a month of real
   counters answers better than a docs page, assume it is, and the number above
   is still noise against 100,000.
4. **Egress is free and assets are free.** Relaying megabytes of build log costs
   nothing in transfer, and the web bundle the Worker serves is not a metered
   request. The cost of a session is its *request count* and its *active
   duration*, not its bytes, which is the tailwind that keeps a personal
   fleet inside the free tier at all.

Two limits worth knowing rather than paying for: a WebSocket message may be at
most **32 MiB** (flue's frames are orders of magnitude below that), and an idle
connection is closed at roughly **100 s**, which the 30 s keepalive covers.

**Verdict for now:** personal use, self-hosted, sits inside the free plan with
room to spare, the free daily DO request allowance is roughly two million
inbound messages. What is *not* yet proven is hibernation under real load, and
that is the difference between a free relay and a metered one. Measure before
trusting it.

## Fair use, and the caps that exist today

The `/client` leg and `POST /api/pair` are both credential-less by design, so
the Durable Object bounds them directly. All of these are per hub, meaning per
machine:

| bound | value | what it stops |
|---|---|---|
| concurrent client channels | 64 | a socket flood; over it, `503 relay full` |
| client message size | 1 MiB | one browser taking the daemon leg down; over it, that socket alone closes `1009` |
| handshake deadline | 30 s | channels opened and never used, reaped by alarm |
| concurrent parked pair requests | 8 | pairing attempts held open; over it, `429` |
| pairing body cap | 4 KiB | an oversized POST; over it, `413` |
| pairing answer deadline | 10 s | a daemon that never answers; `504` |

Two more run in the Worker itself, before any hub is picked:

- **MAC machine ids.** An id only routes if its 8-hex tag verifies under the
  daemon secret (`spec/relay-protocol.md`, Auth), so the whole space of
  guessed, scanned or hand-made ids answers `404` without waking a Durable
  Object. What used to be "any grammar-valid id wakes an object" is now "only
  ids this relay minted exist".
- **A per-IP rate rule.** A Cloudflare rate-limiting binding covers
  `/client/*` and `POST /api/pair/*`: 300 requests per minute per IP (per
  Cloudflare location), `429 {"error":"rate limited"}` over it. A fleet of
  tabs — reconnect storms included — never sees it; spending a free-plan
  relay's daily request allowance, or brute-walking the 2^32 tag space,
  needs a botnet. The daemon leg is exempt: secret-gated, one socket per
  machine. Wired by `flue relay setup`/`update` (internal/relaydeploy) and
  by `relay/wrangler.jsonc` for dev, so a deployed relay and the one under
  `pnpm dev` carry the same rule. Cloudflare's own WAF rate-limiting rules
  (dashboard → Security) remain available on top if your traffic wants a
  tighter number.

The message cap is the one whose *number* matters beyond itself: the daemon
reads the socket carrying every browser on your machine with a 2 MiB limit that
kills the connection rather than the message, so the relay's 1 MiB has to stay
under it. Anything else and one oversized frame from a stranger drops every
session on the machine, repeatedly.

The credential-less legs also leak presence: a valid machine id answers
differently with its daemon connected than without (`503 daemon offline`), so
anyone holding the relay URL can probe which of your machines are up, which
machines exist and when they are online, never what they carry, because
everything a channel forwards is still behind Noise.

The rate rule above is the shipped answer to the flood that used to be worth
adding a WAF rule for: a wrong pairing token still costs you nothing (it does
not spend your pairing window), and now the arrival *rate* is bounded too,
not just how many attempts one caller can hold. What the in-code rule cannot
be is traffic-aware — 300/min/IP is a ceiling for abuse, not a fit to your
usage — so a WAF Rate Limiting rule on `/api/pair` (something like 10
requests per minute per IP, far above any human ceremony) remains a sensible
addition on a relay that sees hostile traffic (`docs/FOLLOW-UPS.md` item 13).

**What does not exist yet is an output-rate cap.** A session that streams
continuously (`yes`, `tail -f` on a firehose) pins the object active and floods
invocations, and nothing throttles it. That is the one abuse vector that turns
into a bill, it is a follow-up rather than a shipped control
(`docs/FOLLOW-UPS.md` item 13), and it wants a real number from the counters below,
tuned so ordinary interactive use never touches it rather than guessed at. The
related asymmetry on the daemon's own outbound queue is item 10.

## Reading the counters

`GET /api/health` answers `200 {"ok":true}` from the Worker alone, no
Durable Object wakes, no machine is named. It is the address to give an
uptime monitor: it proves the deploy is live and routing, and deliberately
nothing more. Whether a *machine* is up is a different question with a
different cost, a `/client/<id>` dial answers it, and the presence note
under fair use is the reason it stays off this endpoint.

The Worker deploys with observability enabled, and the hub logs one JSON line
per client channel when that channel closes:

```json
{"evt":"channel_closed","channel":7,"fwdToDaemon":412,"fwdToClient":1088,"bytesToDaemon":9130,"bytesToClient":264401}
```

`fwd*` are frame counts and `bytes*` are payload bytes, each per direction:
`toDaemon` is what the browser sent (keystrokes, resizes, control), `toClient`
is what came back (output). The line is emitted exactly once per channel, on
whichever exit path the channel takes.

Watch them live, or read them after the fact:

```sh
cd relay && pnpm exec wrangler tail flue-relay --format json
```

The same lines are in the dashboard under Workers & Pages → `flue-relay` → Logs,
and the metered totals (requests and GB-s against the daily caps) are under
Metrics on the same page. Two honest gaps: nothing is logged until a channel
*closes*, so a tab left open for a week reports nothing until it goes away; and
the line carries no duration, so a channel's lifetime has to come from tail
timestamps rather than from the record itself (`docs/FOLLOW-UPS.md` item 13).

## What a month of dogfooding should record

Before the fair-use numbers stop being guesses, a month of real daily use
should leave this behind:

- **Daily DO requests and daily GB-s**, from the dashboard, one row per day
  against the 100,000 and 13,000 free caps. The ratio between them is the whole
  story: requests should climb with use while GB-s stays near the floor.
- **Whether hibernation is actually happening.** If GB-s tracks *wall-clock
  connected time* rather than frame volume, it is not, and everything above is
  void. This is the single most important line in this list.
- **Per-channel frames and bytes each way** from `channel_closed`, kept as a
  distribution rather than a mean. Fair-use ceilings are set off the tail (the
  99th-percentile session) because the mean of a terminal's traffic is dominated
  by an idle prompt.
- **Channels per day and how long they live**, which is how a "session" converts
  into cost, and how much a phone that reconnects on every screen wake costs
  compared with a laptop that holds one socket all day.
- **Daemon reconnect frequency.** Every reconnect invalidates every live channel,
  so a flappy machine is both a cost signal and a UX one.
- **What a pairing costs.** A parked pair request holds a timer, which is the one
  thing that keeps the object out of hibernation; how often that happens matters
  more than how long each one takes.
- **The worst day, named.** One long build, one `tail -f` left running, one
  phone on a bad network, the numbers those produce are the fair-use cap's
  input, and they are worth writing down as anecdotes and not just as totals.

Cost per active machine per month, with its tail, is the output. Any fair-use
cap set before that number exists is a guess.

## Release gate: the manual end-to-end

The relay's test suites all run against fakes, a scripted Cloudflare API, an
in-memory Durable Object, a loopback daemon. That is the right shape for CI,
and it means no automated test has ever seen a real Worker, a real workers.dev
subdomain, or a phone on a different network. This checklist is what covers
that gap, and it is a **human gate on every release that touches the relay**,
not a task anything can tick on its own.

Run it from a release binary (`make build && bin/flue …`), never a dev build:
a dev build carries no Worker to deploy.

- [ ] `flue relay setup` against a real Cloudflare account, with a token made
      from the "Edit Cloudflare Workers" template. Every ✓ line appears; the
      token is nowhere in the output.
- [ ] Restart the daemon (`flue disable && flue enable`, or restart
      `flue serve`). `flue status` reports the relay; the daemon's log says it
      connected.
- [ ] Open the printed `https://flue-relay.<sub>.workers.dev` in a browser on
      the **same** machine. The web app loads (that is the assets binding) and
      the SPA fallback working.
- [ ] Pair a phone from the QR code, over cellular rather than the house
      Wi-Fi, so the traffic genuinely crosses the internet.
- [ ] Type a command in a session on the phone; see the output. Type in the
      same session on the desktop; see both sides mirror.
- [ ] Kill the daemon (`kill -9`), watch the phone report the drop, restart the
      daemon, and watch the session come back without re-pairing.
- [ ] `flue relay join` on a second machine, with the exact line setup printed.
      Restart its daemon: both daemons' logs say connected, to the same host,
      each under its own machine id.
- [ ] Pair the phone with the second machine too, its own QR, one more scan.
      Opening the relay URL now lands on the machine picker; both machines are
      listed, and switching between them lands in each machine's own sessions.
- [ ] The isolation check, by hand: stop machine A's daemon, leave B's up, and
      `curl -si --http1.1 -H 'Upgrade: websocket' https://<relay>/client/<A's id>`
      answers `503` `{"error":"daemon offline"}`. B's daemon being up must
      never answer for A. The same command against a bare `/client`, an id
      with a capital in it, or A's id with one tag character changed, answers
      `404` `{"error":"no such machine"}`.
- [ ] Re-run `flue relay setup` on the same account. It succeeds (the deploy
      and the secret are upserts) and it is a reset: the phone pairs this
      machine again (the fresh machine id abandons the slot its old row
      names), and the second machine re-joins with the newly printed line.
