# flue.sh: the hosted control plane

Two Workers and a database. `app.flue.sh` is the control plane — accounts,
sign-in, the device directory, and the signed channel tokens the relay trusts.
`relay.flue.sh` is the same relay Worker as the self-hosted one
([`RELAY.md`](RELAY.md)), running in SaaS mode: it holds
`RELAY_SIGNING_SECRET`, verifies a token offline at every upgrade, and bridges
whoever the token's claims name. Nothing else changes — the terminal traffic
crossing it is still Noise ciphertext it holds no key for.

The deploy runbook (secrets, D1, custom domains, the first invite) lands here
with Task 12. What is written down below is what a *browser session* on the
hosted service depends on, because two of those things are deployment
decisions that fail silently if they are made differently.

## Opening a session, end to end

```
app.flue.sh  ── openSession ──▶  https://relay.flue.sh/#t=…&k=…&d=…&a=…
                                       │
                                 the tab reads the fragment and scrubs it
                                       │
   ┌───────────────────────────────────┴─────────────────────────────────┐
   │ t  channel token, 60s, one account, one device — first dial only    │
   │ k  the machine's Noise static public key, base64url                 │
   │ d  its device id: hex(sha256(k))[:12] — the record k is pinned under│
   │ a  the control plane's origin, for the next token                   │
   └─────────────────────────────────────────────────────────────────────┘
                                       │
   dial 1: Sec-WebSocket-Protocol: flue.v1, flue.token.<t>
   dial 2+: POST a + /api/relay-token (credentialed) ──▶ a fresh 60s token
```

Two properties of that picture are the whole reason it looks like this:

- **The daemon key is pinned per *device*, not per origin.** A hosted relay is
  one origin in front of every machine on every account. A browser that stored
  one pinned key per origin would build machine B's Noise IK handshake against
  machine A's static key: `readMessageB` throws, the socket closes like any
  outage, and the tab reconnects into the identical failure forever with
  nothing on screen to say why. The key travels with the session and is stored
  under the device id (`web/src/crypto/keys.ts`,
  `savePinnedDaemonKeyFor`). Self-hosted browsers keep the single per-origin
  pin the `/pair` ceremony writes — there, the origin *is* the machine.

  A fragment is whatever the link someone clicked put there, so the tab checks
  `k` against `d` before it pins anything (`namesItsOwnKey`,
  `web/src/relay/session.ts`): `d` is the hash of `k`, so an inconsistent pair
  is refused outright. That closes *poisoning* — a link that pins a wrong key
  under a victim's device id, leaving that machine reconnect-looping in that
  browser forever. It does not close *substitution*: a link carrying the
  attacker's own key *and* id is self-consistent and passes, and with a live
  token minted for that machine it opens one dial into a terminal the attacker
  owns, on the real relay origin. One dial rather than a session — the
  victim's next refresh names a device their cookie does not own and is
  answered 403 — but the residual is open
  ([`FOLLOW-UPS.md`](FOLLOW-UPS.md) item 14, "Left standing"). Closing it
  means not taking `k` from the fragment at all: fetch the named device's key
  from the control plane under the session cookie, which answers only for
  machines the caller owns, so a link cannot name a machine the user does not.
- **The token is fetched per dial, not captured once.** It lives sixty seconds.
  A tab that captured one at open time was refused at its first reconnect past
  a minute — a laptop lid, a tunnel — and never recovered. Each re-dial asks
  `POST /api/relay-token` for a new one, which is also where revocation lands:
  a machine or an account that has been switched off stops being given tokens,
  so an open tab loses its terminal at its next reconnect.

## Two deployment constraints

**The relay and the control plane must be same-site.** The session cookie is
`__Host-session`, `SameSite=Lax` — which rides a cross-*origin* request only
while the two hosts share a registrable domain. `relay.flue.sh` and
`app.flue.sh` both sit under `flue.sh`, so the credentialed refresh works. A
relay parked on `flue-relay.workers.dev` in front of `app.flue.sh` is
cross-site: every refresh arrives with no cookie, is answered 401, and every
session dies at its first reconnect while the first minute looks perfect. Use
custom domains under one registrable domain for both Workers.

**`RELAY_URL` is also the CORS allowance.** `POST /api/relay-token` is the one
endpoint on the control plane that answers a cross-origin browser, and the one
origin it answers is the http form of `RELAY_URL` (plus the control plane's
own). There is no second variable: setting `RELAY_URL` to the relay a
deployment actually uses is what makes the refresh work, and pointing it
somewhere else refuses the call rather than half-working.

## Pairing is self-host only

The QR `/pair` flow (`web/src/routes/pair.tsx` → the daemon's `/api/pair`) is
Plan 1's ceremony for a self-hosted deployment: a second device scans a code
shown on a first, and the daemon hands back its static key over the connection
the user themselves established. It is **not** how a machine joins a flue.sh
account. Hosted enrolment is `flue link` — device authorization against
`app.flue.sh`, approved at `/enroll` by a signed-in person — and the browser
never runs a pairing ceremony at all: the key it needs arrives with the
session, from the control plane that holds the device row.

`/pair` is still *reachable* on the hosted relay's origin, because the same
bundle is served by the daemon, by a self-hosted relay and by flue.sh, and
nothing in the page can tell the last two apart from the origin alone. What it
would do there is fail: the SaaS relay requires `Authorization: Bearer <channel
token>` on `/api/pair`, the page sends no bearer, and it renders the refusal.
That is the correct outcome — there is nothing on flue.sh for it to pair with —
but it is a dead end rather than an explanation. If the hosted UI ever
surfaces pairing, it must carry the bearer or say why it cannot.

## The manual end-to-end, before a release

The release gate for hosted browser sessions, and it needs **two real
machines** — one machine cannot fail the bug this path exists to fix.

1. Deploy both Workers to custom domains under one registrable domain
   (`app.flue.sh`, `relay.flue.sh`), with the same `RELAY_SIGNING_SECRET` on
   both and `RELAY_URL=wss://relay.flue.sh` on the control plane.
2. Sign in at `app.flue.sh`, then `flue link` on machine **A** and approve it.
3. `flue link` on machine **B**, from a genuinely different machine, and
   approve it. Both appear in the directory.
4. Open a session on **A** from the directory. A terminal, a prompt, a command
   that runs.
5. **Without closing that tab**, open a session on **B** in a second tab. A
   second terminal, its own prompt. *Both tabs still work* — this is the step
   that fails if the daemon key is pinned per origin: the older tab's next
   reconnect would build its handshake against the other machine's key.
6. Leave a tab open for **more than a minute**, then force a reconnect (turn
   the network off and on, or sleep the laptop). It comes back. This is the
   step that fails if the channel token is captured once.
7. Reload one of the tabs. It comes back too — the tab remembers which machine
   it is a session on, re-mints a token, and re-uses the key it pinned.
8. Revoke machine **B** from the directory, then force that tab to reconnect.
   It does not come back. (A session already open survives until it
   reconnects; that is stated in [`FOLLOW-UPS.md`](FOLLOW-UPS.md) item 15.)
9. From a phone, on mobile data, open a session on **A**. Same result.
