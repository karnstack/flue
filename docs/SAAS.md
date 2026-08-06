# flue.sh: the hosted control plane

Two Workers and a database. `app.flue.sh` is the control plane — accounts,
sign-in, the device directory, and the signed channel tokens the relay trusts.
`relay.flue.sh` is the same relay Worker as the self-hosted one
([`RELAY.md`](RELAY.md)), running in SaaS mode: it holds
`RELAY_SIGNING_SECRET`, verifies a token offline at every upgrade, and bridges
whoever the token's claims name. Nothing else changes — the terminal traffic
crossing it is still Noise ciphertext it holds no key for.

This is the operator's document. The runbook first — database, secrets,
domains, deploy, the first invite, the switch that turns an account off, and
the one piece deliberately left for you to build — then what a *browser
session* on the hosted service depends on, because two of those things are
deployment decisions that fail silently if they are made differently.

The self-hosted relay has its own runbook ([`RELAY.md`](RELAY.md)) and nothing
below applies to it. The honest limits of "the relay cannot read your
terminal", which do not improve because the relay is ours, are in
[`faq.md`](faq.md).

## Standing it up

Everything below runs from a checkout with `pnpm install` done in `app/`,
`relay/` and `web/`. **A block that begins with a `cd` starts at the
repository root**; one that does not continues from wherever the last `cd` in
its section left you. Every `wrangler` call has to run inside the package whose
config it needs — `d1` and the control plane's secrets from `app/`, the relay's
from `relay/`. `wrangler` itself is a pinned devDependency in each package, so
it is `pnpm exec wrangler` throughout: never a global install, never `npx`.

### 1. The database

```sh
cd app
pnpm exec wrangler d1 create flue
```

That prints a `database_id`. Put it in `app/wrangler.jsonc`, replacing the
`"local"` placeholder:

```jsonc
"d1_databases": [
  { "binding": "DB", "database_name": "flue", "database_id": "<the uuid>", "migrations_dir": "migrations" }
]
```

`"local"` is not a mode; it is a string nothing remote can resolve, kept so a
fresh checkout has something there. Neither local development nor the test
suite reads it — the vitest pool binds its own D1, and `--local` resolves by
name — so this value exists for `--remote` and nothing else.

Then apply the migrations to the real database:

```sh
pnpm exec wrangler d1 migrations apply flue --remote
```

Seven tables (`app/src/db/schema.ts`), and `docs/faq.md` lists every one of them
under "what does flue.sh store?" — that answer and this schema are meant to stay
the same document. Re-running is safe: wrangler records what has been applied.

### 2. The secrets — mandatory, all three

**Not optional, and not defaulted.** Each is read per request and the code
*throws* when it is missing, because in every case the fallback would be worse
than an outage: an HMAC keyed by the literal string `"undefined"` is one
well-known key shared by every deployment that forgot, and a channel token
signed under it is a token anybody can mint. `codeSecret` (`server/codes.ts`),
`relaySigningSecret` and `relayUrl` (`server/channel-token.ts`) and
`relayBrowserOrigin` (`server/refresh-token.ts`) each fail closed and name the
variable that is missing.

Generate every value with a CSPRNG — not a passphrase, not a memorable string:

```sh
openssl rand -base64 32
```

On the control plane:

```sh
cd app
pnpm exec wrangler secret put CODE_HMAC_SECRET
pnpm exec wrangler secret put RELAY_SIGNING_SECRET
pnpm exec wrangler secret put RELAY_URL           # wss://relay.flue.sh
```

On the relay, **the same `RELAY_SIGNING_SECRET` value, pasted from the same
clipboard**:

```sh
cd relay
pnpm exec wrangler secret put RELAY_SIGNING_SECRET
```

**`CODE_HMAC_SECRET` — control plane only.** Login codes are stored as
`HMAC(this, code)` and never in the clear (`server/codes.ts`). Unset, nobody
can sign in: issuing and verifying both throw. Rotating it invalidates every
outstanding code and touches nothing else, which makes it the cheap one to
rotate.

**`RELAY_SIGNING_SECRET` — both Workers, one value.** The control plane signs
channel tokens with it; the relay verifies them offline with it and asks the
control plane nothing on the hot path (`relay/src/channel-auth.ts`). It is the
entire authorization of a bridge, which is why it lives on exactly two Workers
and why no daemon ever holds it — a daemon that could sign its own tokens could
name any account on the service.

> **A mismatch between the two is the worst failure in this document.** Nothing
> warns and nothing logs a mismatch as such: every dial, from every browser and
> every daemon, is refused at the upgrade, and it looks exactly like a network
> problem. Set both in one sitting, from the same clipboard, and confirm with
> the end-to-end below rather than by reading the dashboard.

On the relay it is also the **mode selector**: bound, the Worker is in SaaS mode
and stops honouring `DAEMON_SECRET` altogether. A relay that holds it is a
hosted relay; a relay that does not is a self-hosted one. Rotating it
invalidates every outstanding channel token — blast radius one TTL (60s for a
browser, 300s for a daemon), after which everything re-mints.

**`RELAY_URL` — control plane only, and not a secret.** `wss://relay.flue.sh`.
It is set with `wrangler secret put` anyway, deliberately: `wrangler.jsonc`'s
`vars` are typed by the *generated* `worker-configuration.d.ts`, and this one is
declared by hand in `app/src/env.d.ts` beside the secrets, so a value in both
places is one `pnpm cf-typegen` away from a duplicate declaration. It is read
in two schemes and there is deliberately no second variable for the other one:
as `wss://` it is handed back with every channel token, and swapped to
`https://` it is **the one cross-origin allowed to call
`POST /api/relay-token`**. Point it at a relay this deployment does not use and
the token refresh is refused rather than half-working.

`wrangler secret put` needs a Worker to put the secret on. Standing this up
from nothing, deploy once first (step 4) and come back: a deployed control
plane with no secrets is inert rather than dangerous — every path that needs
one throws, so nobody can sign in — and a secret takes effect without a
redeploy.

Locally the same three live in a gitignored `app/.dev.vars`; copy
`app/.dev.vars.example`.

### 3. Custom domains — and the same-site rule

Both wrangler configs already name theirs, and they are the one line in each
file that names a specific service:

```jsonc
// app/wrangler.jsonc
"routes": [{ "pattern": "app.flue.sh", "custom_domain": true }],
// relay/wrangler.jsonc
"routes": [{ "pattern": "relay.flue.sh", "custom_domain": true }],
```

`flue.sh` has to be a zone on the same Cloudflare account; wrangler creates the
DNS record and the certificate on the first deploy.

> **The control plane and the relay MUST be same-site — two hosts under one
> registrable domain.** The session cookie is `__Host-session`, `SameSite=Lax`
> (`app/src/server/sessions.ts`), and a `Lax` cookie rides a cross-*origin*
> request only while the two hosts are same-*site*. The browser tab lives on
> the relay's origin and re-mints its 60-second channel token from the control
> plane, with credentials, before every dial. `relay.flue.sh` and `app.flue.sh`
> share `flue.sh`, so the cookie travels and the refresh works. A relay parked
> anywhere else — `flue-relay.<sub>.workers.dev` in front of `app.flue.sh`, or
> `relay.example.net` — is cross-site: every refresh arrives with no cookie at
> all, is answered 401, and **every session dies at its first reconnect while
> the first minute looks perfect**. It is the most expensive way to get this
> wrong, because nothing is broken until a minute has passed and the failure
> then looks like flaky networking.

`workers.dev` is the second half of the same problem and cannot be worked
around: it is on the Public Suffix List, so every `*.workers.dev` host is
cross-site with every other and a `__Host-` cookie there is scoped to that one
hostname and shared with nothing. There is no arrangement of workers.dev
subdomains that makes the refresh work. Custom domains are not the tidy option
here; they are the only one.

### 4. Deploy

```sh
cd app && pnpm build && pnpm exec wrangler deploy    # the control plane
cd ../relay && pnpm exec wrangler deploy             # the relay
```

**The control plane's build is not optional.** The Cloudflare Vite plugin writes
`app/.wrangler/deploy/config.json`, which redirects wrangler at the *built*
config (`dist/server/wrangler.json`, `main: index.js`) rather than at
`wrangler.jsonc`, whose `main` is `./src/server.ts` — a module graph only the
Start plugin can build. `wrangler deploy` prints which config it used
(`Using redirected Wrangler configuration`); deploying without a fresh build
ships the previous one.

**The relay's assets directory is a placeholder, and this is the easy one to get
wrong.** `relay/public/index.html` is one line telling you to deploy the web
bundle. Under flue.sh the relay origin is what serves the browser the terminal
app — `openSession` navigates a tab to `https://relay.flue.sh/#…` — so the real
`web/` bundle has to be in that directory before the deploy:

```sh
cd web && pnpm build
cp -R dist/. ../relay/public/
```

Copy *into* the directory rather than replacing it: `relay/public/_headers` has
to stay, and it is not an asset. Wrangler strips it out of the upload and sends
its contents as script metadata, and it carries the `Referrer-Policy` and the
CSP that `web/src/crypto/keys.ts` names as the compensating control for holding
a private key in IndexedDB ([`FOLLOW-UPS.md`](FOLLOW-UPS.md) §13). The copied
bundle is build output and `.gitignore` keeps it out of the repository; deploy
the relay from the same checkout that built it. Skip this and the deploy still
succeeds — the origin then serves that one-line page, and "open a session"
lands on it.

(`flue relay setup`, the self-host path, reads none of this: it builds its own
deploy request in `cmd/flue/relay.go` and uploads the bundle compiled into the
binary. Nothing about this step applies there.)

### 5. The first invite

flue.sh is invite-only (`app/src/server/invites.ts`) and there is no admin UI to
mint one: an invite is a row, and the first one is written by hand. It converts
to exactly one account and is burned in the same statement that creates the
user.

**The code must come out of a CSPRNG.**

```sh
openssl rand -hex 16
```

Unbound — a ticket, and whoever holds the string gets in:

```sh
cd app
pnpm exec wrangler d1 execute flue --remote --command \
  "insert into invites (code, created_at) values ('<the code>', unixepoch())"
```

Bound to one address — a letter nobody else can open, and the shape to prefer:

```sh
pnpm exec wrangler d1 execute flue --remote --command \
  "insert into invites (code, email, created_at) values ('<the code>', 'person@example.com', unixepoch())"
```

Type the address the way the application stores it: lowercased and trimmed
(`normalizeEmail`). SQLite compares TEXT byte for byte, so `Person@…` binds an
invite to an address that will never match.

The two behave differently at the front door, which is worth knowing before
sending one out. A **bound** invite means the person types only their email
address at `app.flue.sh/login` — the gate finds the invite by address. An
**unbound** one means they also paste the code into the "Invite code" field.

Why the entropy is load-bearing: `requestCode` is an online oracle for an
unbound invite. It answers `{ok:true}` to everyone, deliberately — that is what
keeps an unauthenticated endpoint from being a membership oracle for the whole
user list — so a guesser learns nothing from the response. What they do learn is
whether a login code turns up in their own inbox, and that is the entire gate.
The rate limits (`server/ratelimit.ts`) bound how fast anyone can guess; the
keyspace is what makes guessing hopeless, and it is the only thing that does.
128 bits of `openssl rand -hex 16` is hopeless. `spring-2026` is not.

What is outstanding:

```sh
pnpm exec wrangler d1 execute flue --remote \
  --command "select code, email, redeemed_by from invites"
```

### 6. Email is a placeholder — the one thing left to build

`app/src/server/email/sender.ts` ships a `Sender` interface and one
implementation, `LogSender`, which **prints the login code to the Worker's
log**. That is the only place a plaintext code is written anywhere; everything
else hashes it before storing and never logs it.

So on a deployment as it stands, a login code is visible only here:

```sh
cd app && pnpm exec wrangler tail --format pretty
# {"evt":"login_code","email":"…","code":"…"}
```

That is enough for the operator to sign themselves in and prove the stack works.
It is **not** a service you can hand to another person: anyone who can read the
logs can log in as anyone.

Going live means writing a `Sender` that talks to a provider and returning it
from `sender()`. Nothing else in the application changes — that is what the seam
is for. The provider needs the ordinary list: an API key (a fourth
`wrangler secret put`), a sending domain with SPF, DKIM and DMARC, and somewhere
for bounces to go. This repository takes no position on which provider. One
thing to watch for once it is wired: `requestCode` deliberately swallows a send
failure and answers `{ok:true}` like every other branch — an error page for
exactly the addresses that have accounts is the oracle, handed over — so a
broken provider announces itself only as `login_code_send_failed` in the logs.

### 7. The kill switch

There is no admin UI, deliberately: an endpoint that can disable any account is
an endpoint worth attacking, and the operator has `wrangler`. The tested
definition of what the switch does is `app/src/server/kill-switch.ts`
(`disableUser`, `disableDevice`); what follows is how it is actually thrown.

**Switch an account off** — flag first, so nothing can be minted while the
sessions are being deleted (D1 has no interactive transactions from the CLI
either):

```sh
cd app
pnpm exec wrangler d1 execute flue --remote --command \
  "update users set disabled = 1 where email = 'someone@example.com'"
pnpm exec wrangler d1 execute flue --remote --command \
  "delete from sessions where user_id in (select id from users where email = 'someone@example.com')"
```

Both halves matter. The flag gates every authenticated path in the same SQL
predicate as the thing it guards — `currentUser`, both channel-token mints, and
`requestCode`, which refuses a disabled address a login code at all. Deleting
the sessions is the half a flag cannot do: without it, re-enabling the account
hands back every cookie that was live when it was switched off, for up to eight
hours.

**Switch one machine off**, leaving its owner signed in:

```sh
pnpm exec wrangler d1 execute flue --remote --command \
  "update devices set disabled = 1 where id = '<device id>'"
```

That one is sticky by construction, which is what makes leaving the owner signed
in safe: `devices.id` is `sha256(publicKey)[:12]`, so re-running `flue link` on
that machine lands on the same row and the enrolment upsert carries the flag
over, and the owner cannot delete the row out from under it — the dashboard's
"remove" refuses a machine an operator has switched off, and says so. An
operator's revocation outranks its owner's.

Turning either back on is an operator action and nothing else. Re-enabling a
user does **not** restore their sessions; they sign in again, which is the
point.

```sh
pnpm exec wrangler d1 execute flue --remote --command \
  "update users set disabled = 0 where email = 'someone@example.com'"
pnpm exec wrangler d1 execute flue --remote --command \
  "update devices set disabled = 0 where id = '<device id>'"
```

Finding the row first, if you are not certain:

```sh
pnpm exec wrangler d1 execute flue --remote --command \
  "select id, email, disabled from users where email like '%example.com'"
pnpm exec wrangler d1 execute flue --remote --command \
  "select id, label, disabled, last_seen from devices where user_id = '<user id>'"
```

> **What the switch does not reach: a channel that is already open.** Both mints
> re-read both flags, so a revocation stops the *next* dial immediately and the
> next refresh within one token TTL — 60 seconds for a browser, 300 for a
> daemon. The relay verifies a token once, at the WebSocket upgrade, and never
> asks again for the life of that connection, so a terminal somebody already has
> open outlives the revocation. **To end a live session now, stop the daemon on
> that machine.** That is the honest bound, it is what `/terms` says, and
> closing it properly is [`FOLLOW-UPS.md`](FOLLOW-UPS.md) §15.

### 8. Then prove it

The deploy is done and nothing has been tested. No suite in this repository has
ever seen a real Worker, a real custom domain, or two machines — they all run
against fakes, which is the right shape for CI — so the release gate at the
bottom of this document is what covers the gap, and a human runs it on every
release that touches this stack.

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

Both are steps in the runbook above. They are here a second time because they
are the two that fail *silently* — no error at deploy, nothing in a log saying
what is wrong — and a thing worth reading twice is worth writing twice.

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

**Never in CI.** It deploys real Workers to real domains, enrols real machines
and spends a real invite; every automated test in this repository runs against
a fake — an in-memory Durable Object, a workers-pool D1, a loopback daemon — and
that is the right shape for CI and the reason this checklist exists. It is a
human gate on every release that touches the control plane or the relay.

1. Deploy both Workers to custom domains under one registrable domain
   (`app.flue.sh`, `relay.flue.sh`), with the same `RELAY_SIGNING_SECRET` on
   both and `RELAY_URL=wss://relay.flue.sh` on the control plane.
2. Open `https://relay.flue.sh/` directly. The flue web app loads — that is the
   assets binding, the SPA fallback, and the bundle copy in step 4 of the
   runbook. A one-line "deploy the web bundle" page here means the relay was
   deployed without it, and every session will land on that page.
3. Sign in at `app.flue.sh` with the seeded invite. Unless a real `Sender` is
   wired, the code is in `pnpm exec wrangler tail` and nowhere else.
4. `flue link` on machine **A** and approve it at `/enroll`.
5. `flue link` on machine **B**, from a genuinely different machine, and
   approve it. Both appear in the directory.
6. Open a session on **A** from the directory. A terminal, a prompt, a command
   that runs. (A terminal that never appears, on a deploy that is otherwise
   healthy, is the `RELAY_SIGNING_SECRET` mismatch: the two Workers do not hold
   the same string.)
7. **Without closing that tab**, open a session on **B** in a second tab. A
   second terminal, its own prompt. *Both tabs still work* — this is the step
   that fails if the daemon key is pinned per origin: the older tab's next
   reconnect would build its handshake against the other machine's key.
8. Leave a tab open for **more than a minute**, then force a reconnect (turn
   the network off and on, or sleep the laptop). It comes back. This is the
   step that fails if the channel token is captured once — and the step that
   fails if the two Workers are not same-site, because the refresh that carries
   it is the credentialed one.
9. Reload one of the tabs. It comes back too — the tab remembers which machine
   it is a session on, re-mints a token, and re-uses the key it pinned.
10. Revoke machine **B** from the directory, then force that tab to reconnect.
    It does not come back. (A session already open survives until it
    reconnects; that is stated in [`FOLLOW-UPS.md`](FOLLOW-UPS.md) item 15.)
11. Switch the account off with the recipe in step 7 of the runbook. The
    dashboard stops on the next request. Switch it back on — and expect to sign
    in again, because that recipe deletes the sessions and is meant to.
12. From a phone, on mobile data, open a session on **A**. Same result.
