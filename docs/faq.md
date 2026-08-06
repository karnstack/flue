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

What we do about it, in order of how much it actually helps:

- **Self-host, and the origin is yours.** `flue relay setup` deploys the
  Worker and the bundle into your own Cloudflare account, out of the binary
  you installed. Nothing of ours is in the path — the trust moves to the
  binary, which you can build yourself.
- **The source is open.** The daemon, the web app, and the Worker are all in
  this repository under MIT. There is no closed component.
- **A reproducible bundle hash, published per release.** Build the release tag
  yourself and run it:

  ```sh
  cd web && pnpm build && pnpm hash
  ```

  That prints one hex line — a SHA-256 over every file in `web/dist`, path by
  path — and a per-file listing under it. Compare the line with the digest
  published for that release (`pnpm hash <expected>` does the comparison and
  exits non-zero on a mismatch). Vite's filenames are content-hashed, so the
  digest changes if and only if the output changes. Same source, same
  lockfile, same pinned toolchain (`mise.toml`), same digest.
- **Install it as an app.** flue is a PWA: once installed, the shell and its
  code are held by the service worker and not re-fetched on every load, so an
  update is the only window in which different code could arrive. That
  narrows the exposure; it does not close it.
- **A native app is the eventual fix,** and it is on the roadmap — signed,
  installed once, never re-fetched from a server, so there is no per-load
  delivery to trust at all. Until that exists, the four points above are what
  we have, and this paragraph is the reason we are not claiming more.

What a relay operator can observe even while the terminal stays unreadable —
who connected, when, how much traffic, and the whole pairing exchange — is
listed in `spec/relay-protocol.md` under "What the relay sees". Pairing
through a relay is a trust decision about that relay's operator; pair over the
daemon's own origin when you can.

## What does flue.sh store?

Today, nothing: there is no hosted service. flue.sh is docs, downloads, and
the install script, and it is not in the data path.

When the hosted relay ships — invite-only, and forward-looking as of this
writing — it will hold metadata and only metadata: the email address you sign
in with, the names you give your machines and devices, their public keys, and
a last-seen timestamp for each. That is what it takes to route a browser to
the right daemon and to show you an honest list of what is paired. It will
never hold terminal content — no scrollback, no commands, no output, no
environment — and that is not a policy promise about data we could read and
choose not to keep. The relay carries Noise ciphertext it has no key for.
Terminal content is not something it declines to store; it is something it
cannot read.

## Can I run it without flue.sh?

Yes, and that path exists first. `flue relay setup` takes a Cloudflare API
token, deploys the same Worker and the same web bundle into **your** account,
sets a fresh daemon secret, and writes the config the daemon dials. No flue
account, no flue server, nothing of ours between your browser and your
machine. Cloudflare's free plan is enough for personal use.

The runbook — what gets deployed, what it costs, what the caps are, and how to
read the relay's own counters — is [`docs/RELAY.md`](RELAY.md).
