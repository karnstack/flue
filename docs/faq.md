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

**The deeper version of the same move needs no pairing at all.** The
JavaScript the relay origin serves is the code that holds your browser's Noise
keys, runs the handshake and decrypts every frame — an origin that shipped a
modified bundle would be reading the plaintext where the plaintext already is.
There is no arrangement of the cryptography that fixes this for a web app.
Self-hosting keeps that trust at an origin you deployed yourself, which is the
reason it is the only deployment flue has.

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

## Does flue run any servers?

No. There is no hosted service and none is planned. `flue relay setup` takes a
Cloudflare API token, deploys the Worker and the web bundle into **your**
account, sets a fresh daemon secret, and writes the config the daemon dials. No
flue account, no flue server, nothing of anyone else's between your browser and
your machine. Cloudflare's free plan is enough for personal use.

The runbook — what gets deployed, what it costs, what the caps are, and how to
read the relay's own counters — is [`docs/RELAY.md`](RELAY.md). flue.sh itself
is a landing page with instructions and the install script, and stores
nothing.
