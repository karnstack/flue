# flue cloud relay — Design

Date: 2026-08-06
Status: Draft — awaiting review

## What this changes

The original flue design (`2026-07-28-flue-design.md`) is provider-agnostic and
explicitly **no hosted service** — "no flue account, no flue server, no billing;
every remote path runs on infrastructure the user owns." This document
deliberately reverses that stance for the remote story:

**flue becomes a SaaS first, with self-hosting as a sideline — the dub.co model.**
The product is flue.sh: sign up, install the daemon, your machines appear, pay a
few dollars a month, reach any of them from a browser tab anywhere. Self-hosting
stays possible because the code is open source, but it is second-class: you
deploy the same Cloudflare Worker to your own account and support yourself.

The remote transport is **Cloudflare only, and compulsory.** The original
design's "no favoured provider" registry — with Tailscale, `cftunnel`, and
`cfrelay` as interchangeable options — is dropped. There is exactly one remote
path: an outbound Cloudflare Workers relay. That is a large simplification, made
on purpose.

Unchanged from the original design and reused wholesale: the session model
(daemon owns PTYs, ring buffer, mirroring), the wire protocol, the local
loopback transport, and **the entire crypto+pairing layer already built and
merged** (Noise IK handshake both sides, device keystore, `/api/pair`, the
`/pair` page, revocation, the Devices screen).

## Goals

1. **Reach your own machine from anywhere, in a browser tab, with near-zero
   setup.** The everyday client is the web tab — the "terminal as a tab" thesis
   is the product's distinctiveness and is preserved.
2. **One login, all your machines.** Email login at flue.sh shows every daemon
   you have enrolled — multiple macbooks, a home box — and their live sessions.
3. **The relay cannot read your shell.** Terminal traffic through the relay is
   Noise-encrypted end-to-end; Cloudflare and flue.sh-the-operator forward
   ciphertext only.
4. **Honest about the one thing E2E can't protect** — the served-code trust
   caveat — in plain language, in an FAQ, not buried.
5. **Self-hosting works** on the same codebase and the same Worker, deployed to
   the user's own Cloudflare account.

## Non-goals (for now)

- **Native apps** (macOS/iOS). They are the right *eventual* hardening (see
  Security), but out of scope here. The browser extension idea is dropped
  entirely.
- **Cloud-persistent shells.** flue.sh never runs your shells. Sessions live on
  your daemon and die with it, exactly as today. This is a rendezvous relay, not
  a cloud terminal host — which is what keeps it cheap and keeps us unable to
  read you.
- **Provider choice.** No Tailscale, no `cloudflared` tunnel, no pluggable
  backends. Cloudflare Workers relay, full stop.
- **Multi-user collaboration / sharing a session with other people.** Same
  non-goal as the original.

## Who this is for, and the threat model

The customer is a developer who wants to reach a terminal on their own
machine (a macbook at home, a dev box) from their phone or another laptop,
without running a VPN or exposing a port.

What their setup must defend against, and how:

| Threat | Defended by |
|---|---|
| A stranger on the internet opening a shell on your machine | Pairing / account enrollment — only devices you authorized can attach |
| Cloudflare (the company) or a network attacker reading your keystrokes | **Noise IK end-to-end** — the relay forwards ciphertext only |
| A compromised or coerced *relay* that only forwards bytes | Noise — it holds no keys and sees no plaintext |
| flue.sh leaking your session *content* if breached | Noise — flue.sh stores no plaintext; it never has it |

What it does **not** fully defend against, stated plainly:

- **flue.sh serving malicious client code.** The web UI (the JavaScript that
  performs the Noise handshake) is served by flue.sh. A compromised, coerced, or
  malicious flue.sh could serve JS that pins the wrong key or copies your
  keystrokes to plaintext before encrypting. No amount of E2E fixes this,
  because the attacker changes the *program*, not the keys — and in a browser the
  program is whatever the server just sent. The same applies to the daemon
  public key your account hands a fresh browser: a dishonest flue.sh could hand
  you the wrong one.

This is the identical trust position of **every** web SaaS (dub.co can read your
links; your bank's site can serve you bad JS). It is a stronger-than-typical
posture because the code is open source and the traffic is E2E — but it is not
cryptographic zero-knowledge, and we will not claim it is.

**Mitigations we ship now:**
- Noise E2E (keeps the relay and the network blind — the substantive protection).
- **Open source + reproducible builds with a published bundle hash per release**,
  so tampering is *detectable* rather than silent.
- **PWA install**, so the everyday web client runs from a cached bundle rather
  than a fresh server fetch every load (shrinks exposure to install/update
  moments).
- **A plain-language FAQ** ("Can flue read my terminal?") stating exactly the
  above: we forward ciphertext and cannot read you passively; the one caveat is
  that you trust us to serve honest, published, open-source client code.

**The future hardening (documented, not built): native apps.** A macOS/iOS app
delivers the crypto in signed, installed code that flue.sh cannot swap per-load —
the real "you don't even have to trust our servers" tier, and the correct fix
for the phone case. The architecture keeps the pinning/handshake behind a clean
seam so a native client drops in later without a protocol change. It is
explicitly a later chapter.

## Architecture

Two transports, and only two:

- **`local`** — the existing loopback server, for same-machine use and dev.
  Unchanged.
- **`cfrelay`** — the daemon dials **outbound** to a Cloudflare Worker; browsers
  connect to that Worker; the Worker bridges them. This is the one remote path.

The daemon runs both concurrently: loopback is always on, the relay attaches when
configured.

### Introducing the transport seam

The original design's `Transport` interface was never built — `cmd/flue` wires
the loopback server directly (`daemon.New(...)` + `srv.ListenAndServe`). This
work introduces the seam for the first time, minimally: an interface that
"produces authenticated, (for the relay) end-to-end-encrypted connections that
speak the existing wire protocol," satisfied by both `local` and `cfrelay`, run
concurrently by the daemon. We do **not** rebuild the full `Provider` registry
from the original design — there is one remote provider, so the registry
abstraction is unwarranted (YAGNI). The seam is the interface plus a small
runner that starts the transports the config enables.

### The relay data path

```
daemon  --- outbound wss --->  Cloudflare Worker (Durable Object)  <--- wss ---  browser tab
   |                                   (bridges channels,                    (flue.sh UI)
   |                                    forwards ciphertext)                       |
   +------------------- Noise IK, browser=initiator, daemon=responder --------------+
                        (daemon static key pinned; relay sees only ciphertext)
```

- **Daemon side.** On enrollment the daemon holds a relay URL and a credential
  (SaaS: an account/device token; self-host: the Worker's deploy-time secret). It
  dials `wss://<relay>/daemon`, authenticates, and registers its presence in the
  Durable Object. For each browser channel the Worker announces, the daemon runs
  a **Noise IK responder** handshake and then speaks the ordinary wire protocol
  inside that encrypted channel — the same protocol it serves locally.
- **Worker + Durable Object.** One DO per daemon (keyed by daemon/device id).
  Responsibilities: authenticate who may open a channel (daemon vs browser),
  assign channel ids, and forward `[4B channel][ciphertext]` frames in both
  directions. It reads no plaintext and holds no Noise keys. **WebSocket
  Hibernation** is mandatory — an idle session's DO sleeps and stops billing
  duration, waking on a frame (see Cost).
- **Browser side.** Loads the UI from flue.sh (or the self-hoster's Worker
  origin), opens `wss://<relay>/client?...`, runs the **Noise IK initiator**
  against the daemon's pinned static key, then speaks the wire protocol inside
  the channel. The channel-multiplexing header (`[4B channel]`) is confined to
  this adapter; nothing above it knows a relay exists.

### Channel auth: the one SaaS/self-host difference

The Worker's forwarding core is identical in both modes. The *only* difference is
the front-end that decides who may open a channel:

- **Self-host:** a deploy-time shared secret. The daemon that deployed the Worker
  knows it; browsers loading that Worker's UI get a scoped secret (a DoS/
  enumeration control, not a confidentiality one — confidentiality is Noise).
- **SaaS (flue.sh):** flue.sh account tokens. The daemon authenticates as
  "user X's device D"; the browser authenticates with the logged-in user's
  session. The DO checks both belong to the same account before bridging.

This is the seam that makes SaaS and self-host the same binary and the same
Worker. It is designed in from day one even though the SaaS front-end is built in
a later phase.

### The SaaS layer (flue.sh)

Beyond the relay, the hosted product adds:

- **Accounts / identity.** Email login. A user record owns a set of enrolled
  daemons.
- **Device directory.** The list of a user's daemons and their live sessions,
  with labels and last-seen. Stored server-side (metadata, never content). This
  is the "one login, all your machines" surface.
- **Enrollment.** A daemon links to an account via a device-authorization flow
  (a short code shown by `flue enable`, confirmed in the logged-in web UI),
  rather than the QR-per-device pairing of the local build. The daemon's static
  **public** key is registered to the account, so any browser the user logs into
  can pin it. (QR pairing remains for the self-host / no-account path.)
- **Billing.** ~$5/mo, Stripe. Fair-use limits tied to the cost model below.
- **Abuse controls + ToS.** A shell relay is dual-use; we need per-account rate
  limits, a kill switch, and terms. See Open Items.

### Self-host (the sideline)

Open source. A self-hoster runs `flue` and points it at their own Cloudflare
account: flue deploys the Worker via the Cloudflare REST API (script upload with
the DO migration, enable the `workers.dev` subdomain, set the shared secret,
delete the API token), then the daemon dials it. No flue.sh account, no billing,
QR pairing for devices. Same Worker source, same daemon, same web bundle —
second-class only in that you operate and support it yourself.

### Onboarding UX

- **SaaS:** sign up → `flue enable` prints a device-authorization code → confirm
  in the web UI → the machine appears in your directory → open a session in a
  tab. The relay is baked in; there is no Cloudflare setup for the SaaS user.
- **Self-host:** a guided flow to paste a scoped Cloudflare API token, watch flue
  deploy the Worker step by step, then the token is discarded.
- **Fix the loopback-QR bug:** the Devices "Pair device" affordance must be gated
  on a live remote transport. Over `local` only, it currently prints a
  `127.0.0.1` QR that no other device can reach; the button should be disabled or
  relabeled until a relay is active.

## Cost model (a go/no-go gate, not an afterthought)

The economics live or die here, so this is a measured gate before the SaaS
front-end is built, not a guess we launch on.

- **Bandwidth is free.** Cloudflare does not bill egress, so relaying megabytes of
  terminal output costs nothing in transfer. This is the tailwind that makes a
  cheap price possible at all.
- **What is metered:** Durable Object **requests** (each forwarded message is an
  invocation) and DO **active duration**.
- **Hibernation is the business.** Terminals are ~99% idle. With WebSocket
  Hibernation, an open-all-day session's DO sleeps between frames and bills
  almost nothing for duration. Without it, we pay per connected second and the
  model collapses. Confirming hibernation resumes cleanly mid-stream is the top
  technical risk.
- **Abuse vector on cost:** a session that streams output continuously (`yes`,
  `tail -f` on a firehose) pins a DO active and floods invocations. Per-session
  output rate caps / fair-use are required so one user cannot eat a month of
  margin.
- **Gate:** verify *current* Cloudflare Workers/DO list pricing, then measure real
  DO duration and request counts from actual daily use (dog-fooding the self-host
  relay) before committing to $5/mo. Only then decide the price and the fair-use
  ceilings.

## Implementation phasing

One design, decomposed into sequenced implementation plans (each its own
`writing-plans` pass):

- **Plan 1 — the relay substrate + web client, single-tenant.** The transport
  seam, `internal/cloudflare` REST client, the `cfrelay` adapter (outbound dial,
  Noise responder per channel, `[4B channel]` framing), the `relay/` Worker + DO
  with hibernation and the pluggable channel-auth front-end (self-host secret
  now), the web client's relay path, the Pair-button gating, reproducible-bundle
  hash + PWA, and the honest-MITM FAQ. **Ends with a working self-host relay you
  can reach your own machine through** — and it is the exact substrate the SaaS
  sits on. This is also the cost-measurement vehicle.
- **Plan 2 — flue.sh SaaS.** Accounts/email login, the device directory,
  account-based enrollment (device-authorization flow), the multi-tenant Worker
  auth front-end, Stripe billing, per-account rate limits, abuse kill switch, and
  ToS. Built on Plan 1's substrate; the relay core is untouched.
- **Later — native apps.** macOS/iOS as the hardened, no-need-to-trust-our-servers
  tier, dropping into the pinning seam Plan 1 leaves.

"SaaS-ready from day one" means Plan 1 builds every seam the SaaS needs (channel
auth, daemon-to-relay auth config, the pinning seam) so Plan 2 adds a front-end
rather than a rewrite. It does **not** mean Plan 1 ships accounts and billing.

## Testing

- **Reuse the Noise vectors** (`testdata/noise/ik.json`) — the relay path uses the
  same handshake, so the same cross-language fixture guards it. Add relay
  transport-message coverage (multiple channels, hibernation resume).
- **Worker + DO** with `@cloudflare/vitest-pool-workers`, including hibernation
  and resumption mid-stream.
- **`internal/cloudflare` REST client** against recorded fixtures (script-upload
  multipart shape with the DO migration, subdomain enable, secret set, error
  surfacing), plus one manual end-to-end deploy per release against a real
  account.
- **cfrelay adapter** against a fake relay: outbound dial, per-channel Noise
  responder, channel framing, reconnect with backoff.
- **End-to-end** via a real deploy: browser tab → relay → daemon, type a command,
  assert output; kill and reattach.
- **Cost-measurement harness**: capture DO duration/request counts from a real
  session over a representative day (feeds the go/no-go gate).

## Open items to resolve during implementation

1. **Exact Cloudflare Workers/DO pricing** (verify current list prices) and the
   measured per-session cost — the go/no-go for the SaaS price and fair-use caps.
2. **Hibernation semantics under load** — confirm a hibernating DO resumes
   cleanly mid-stream and that the daemon's outbound socket survives it.
3. **Cloudflare API token permissions** for self-host deploy (minimum set for
   script upload + DO migration + subdomain enable); the UI instructions must
   match exactly.
4. **Account selection** for self-hosters with multiple Cloudflare accounts.
5. **Rate-limit thresholds** — the output rate at which a session is throttled,
   tuned so normal interactive use never hits it.
6. **Abuse handling + ToS** — a shell relay is dual-use; define the kill switch,
   the abuse-report path, and confirm Cloudflare's ToS permits this use.
7. **Fresh-browser key pinning in the SaaS** — the account hands a new browser the
   daemon's public key; confirm this is covered by the disclosed trust posture and
   documented in the FAQ.
8. **Carry-forwards from part 1** (`FOLLOW-UPS.md` §8) that become load-bearing
   once a real connection exists: `registerDeviceConn` races, store-error
   disclosure to clients, `LastSeen` updates on connect.
