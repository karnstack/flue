# FAQ

Three questions worth answering plainly, because the honest answer to the
first one is not "no".

## Can flue — or Cloudflare — read my terminal?

**Not in transit.** Your browser and your daemon run a Noise IK handshake
directly with each other, with the daemon's static key pinned when you paired
the device. Everything after that — keystrokes, output, scrollback, the
control messages that carry them — is a Noise ciphertext. The relay forwards
those bytes and holds no key that could open them. It is a Cloudflare Worker
that moves opaque frames between one socket and another; it does not have the
keys, and adding a key to it would be a protocol change you could read in this
repository.

**Then the part that end-to-end encryption does not fix.** The web app's
JavaScript is served by the relay origin, so you are trusting whoever operates
that origin to serve the published, open-source code. An origin that shipped a
modified bundle would be shipping the code that holds your keys. End-to-end
encryption cannot remove that trust, and nothing browser-served can — this is
true of every "E2E encrypted" web app, and it is true of this one. Anyone who
tells you otherwise is selling the crypto and not the delivery.

**Concretely, here is the move that costs you.** Pairing works by the daemon
showing a QR code carrying its static public key in `?k=`, and the new device
pinning that key, so every later handshake has to prove possession of it. The
page that reads `?k=` and does the pinning is JavaScript the relay served. A
hostile or compromised relay would therefore not attack the encryption at all —
it would serve a `/pair` page that pins **its own** key and registers **itself**
as one of your devices. From then on it holds a real Noise session with your
daemon and can read what crosses it. That is the single action that turns
"carries ciphertext" into "reads your terminal", and it needs no cryptographic
weakness whatsoever.

**On flue.sh it is simpler than that, and worse.** The hosted service does not
use the pairing ceremony at all — a machine joins an account with `flue link`,
and the browser is handed that machine's public key by the control plane along
with the session (`docs/SAAS.md`). So a hostile hosted origin would not need to
pair itself as a device: the JavaScript it serves is the code that holds your
browser's Noise keys, runs the handshake and decrypts every frame, and an
origin that shipped a modified bundle would be reading the plaintext where the
plaintext already is. There is no arrangement of the cryptography that fixes
this for a web app, ours included. Using flue.sh means trusting flue.sh to
serve the published code; self-hosting moves that trust to an origin you
deployed yourself, which is why self-hosting comes first in this document.

One thing bounds the pairing version of the move, and it is not a fix: it only
works during a pairing window *you* opened, so a relay cannot enrol itself
unprompted. The device it enrols
does get written to the daemon's log and does appear on the Devices screen,
where you could revoke it — but notice that the Devices screen is also a page
that relay served you, so treat that as an audit trail you read on the machine
itself rather than as a warning you will be shown.

What we do about it, in order of how much it actually helps:

- **Self-host, and the origin is yours.** `flue relay setup` deploys the
  Worker and the bundle into your own Cloudflare account, out of the binary
  you installed. Nothing of ours is in the path — the trust moves to the
  binary, which you can build yourself.
- **The source is open.** The daemon, the web app, and the Worker are all in
  this repository under MIT. There is no closed component.
- **A bundle digest you can recompute yourself.** Build the tag and run it:

  ```sh
  cd web && pnpm build && pnpm hash
  ```

  That prints one hex line — a SHA-256 over every file in `web/dist`, path by
  path — and a per-file listing under it. The digest is taken over the file
  *bytes*, so any change to what would be shipped changes it. Same source,
  same lockfile, same pinned toolchain (`mise.toml`), same digest — *on the
  same platform*. That last clause is a real limit and not boilerplate: the
  lockfile pins per-platform native binaries (esbuild, Tailwind's oxide) and
  `mise.toml` pins no OS or CPU, so reproducibility across platforms is
  **not verified**. The digests we have were produced on macOS/arm64. A
  mismatch against a bundle built on another OS may be those native binaries
  differing rather than anyone tampering, so compare like for like. Making the
  digest portable would take a pinned container build, which is not written.

  **And the half that does not exist yet:** no release publishes a digest. So
  today this answers "does this source build to this bundle", which you can
  check alone; it does not yet answer "is that origin serving me the release",
  which needs a value you did not produce. A digest published and attested per
  release — the `<expected>` in `pnpm hash <expected>`, which does the
  comparison and exits non-zero on a mismatch — is roadmap, tracked in
  [`FOLLOW-UPS.md`](FOLLOW-UPS.md) §13.
- **Install it as an app — which does nothing for this, and used to be listed
  here as though it did.** flue is a PWA and it has a service worker, but the
  worker is an offline fallback and a speed-up, not a pin on the bundle. Its
  policy is network-first for navigations, with the cache as the fallback
  (`web/src/lib/sw-strategy.ts`), and hash-named assets are fetched on a cache
  miss. So an ordinary load asks the origin for `index.html` and then fetches
  whatever bundle that document names — installed or not, update or no update.
  An origin serving different code is serving it to you on your next load.
  Pinning would mean refusing to run a bundle whose digest changed, which is a
  different service worker with a different failure mode when a real update
  ships; it is not what this one does, and the word "installed" should not be
  allowed to do work it cannot.
- **A native app is the eventual fix,** and it is on the roadmap — signed,
  installed once, never re-fetched from a server, so there is no per-load
  delivery to trust at all. Until that exists, the first three points above are
  what we have — the fourth is there to say that it is not one — and this
  paragraph is the reason we are not claiming more.

What a relay operator can observe even while the terminal stays unreadable: who
connected, when, and how much traffic went each way — enough for traffic
analysis of a session, never its content — and the whole pairing exchange.

That last item deserves naming rather than filing under "metadata". The relay's
control channel — channel 0, alongside the encrypted ones — is **cleartext**,
and a pairing request crosses it carrying your single-use **pairing token in the
clear**. The relay can read that token. It cannot read your daemon's private
key, and it cannot read a byte of any session. But a relay that spent a live
token with a key of its own would register itself as a paired device, which is
the move described above by a shorter route: it does not even need to tamper
with the page for that one, only to be handed a live token. The token is
single-use and lives two minutes, which bounds when it can happen and not
whether. The full list is in `spec/relay-protocol.md` under "What the relay
sees".

Pairing through a relay is a trust decision about that relay's operator; pair
over the daemon's own origin when you can — which means when the browser can already
reach the machine directly: same LAN, or a private network like Tailscale.
A phone that is off the network has no such path, and there the relay is the
only way to pair at all.

## What does flue.sh store?

The hosted service is built — invite-only, two Workers and a database — and not
yet open. So this stops being a promise about a design and becomes a list you
can check against the source: its whole database is seven tables
(`app/src/db/schema.ts`), and this is all of them.

- **`users`** — an email address, a created-at, and a disabled flag. No name,
  no password (there are none), no billing, nothing else.
- **`invites`** — the invite code, optionally the one address it was issued to,
  and who redeemed it.
- **`login_codes`** — an address and an **HMAC** of the eight-digit code, never
  the code. Ten-minute expiry, five guesses, then the row is gone.
- **`sessions`** — a **SHA-256 of the session cookie**, the account it belongs
  to, and an eight-hour expiry. Never the cookie itself, so a dump of this
  table cannot be replayed at the front door.
- **`devices`** — one row per machine you enrol: its id (which *is*
  `sha256(public key)[:12]`), the account it belongs to, the label you gave it,
  its **public** Noise key, a SHA-256 of its enrollment token, a created-at, a
  last-seen column that nothing writes yet, and a disabled flag.
- **`device_auth`** — the `flue link` handshake while it is in flight, for ten
  minutes: the short code you type, a digest of the daemon's code, and the
  label that machine proposed. Single-use.
- **`rate_limits`** — a count and a window under a **digest** of what is being
  counted, so the table is counters rather than a list of every address and IP
  that has touched the service.

That is the lot, and rows are collected rather than kept: an hourly cron
deletes expired login codes, expired sessions, spent or expired link grants,
and rate-limit counters past their window. What persists is your account, your
invites, and your machines — a machine until you remove it from the directory,
which deletes the row.

**No terminal content, ever** — no scrollback, no commands, no output, no
environment, no working directory. That is not a policy promise about data we
could read and choose not to keep. The relay carries Noise ciphertext it holds
no key for; terminal content is not something it declines to store, it is
something the bytes crossing it cannot be turned into. What the relay does see
is the same metadata a self-hosted one sees: which account and machine a
channel belongs to, when it opened and closed, and how many frames and bytes
went each way — enough for traffic analysis of a session, never its content.

The qualifier from the first answer stays attached to every sentence above,
because it is the same trust boundary and the hosted service is the case it was
written for. The guarantee is about what crosses the relay, not about the
JavaScript the origin serves you — and on flue.sh that JavaScript is the code
holding your keys. It is stated plainly up there rather than softened here.

One more thing worth knowing, since it is about your machines rather than your
data: flue.sh can switch an account or a single machine off, and both are
`update` statements an operator runs by hand ([`SAAS.md`](SAAS.md)). It stops
new connections — within a minute for a browser, five for a daemon — and it
does not reach into a session that is already open. `/terms` says the same
thing, and it is the last thing this project would want to overstate.

## Can I run it without flue.sh?

Yes, and that path exists first. `flue relay setup` takes a Cloudflare API
token, deploys the same Worker and the same web bundle into **your** account,
sets a fresh daemon secret, and writes the config the daemon dials. No flue
account, no flue server, nothing of ours between your browser and your
machine. Cloudflare's free plan is enough for personal use.

The runbook — what gets deployed, what it costs, what the caps are, and how to
read the relay's own counters — is [`docs/RELAY.md`](RELAY.md).

That the hosted service now exists changes nothing here. Self-hosting is not a
fallback for people who did not get an invite: it is the deployment with the
smaller trust boundary, and the one the second answer above keeps pointing at.
flue.sh is for the case where running a Worker yourself is not the part you
wanted to do. The whole of it is open in this repository — the control plane is
`app/`, the relay is `relay/` — so "run it yourself" includes running the
hosted stack yourself if you ever want to ([`SAAS.md`](SAAS.md)).
