<h1 align="center">flue</h1>

<p align="center"><strong>A session manager for every machine you own — in a browser tab.</strong></p>

<p align="center">
  <a href="https://github.com/karnstack/flue/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/karnstack/flue/ci.yml?branch=main&label=ci" alt="CI status"></a>
  <a href="https://github.com/karnstack/flue/releases/latest"><img src="https://img.shields.io/github/v/release/karnstack/flue?label=release" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
</p>

<p align="center">
  <a href="https://flue.sh">flue.sh</a> ·
  <a href="docs/DEVELOPMENT.md">developing</a> ·
  <a href="docs/RELAY.md">relay runbook</a> ·
  <a href="docs/faq.md">faq</a>
</p>

flue runs a small daemon that owns your shells. It keeps them alive when you
close the tab, lists every one of them across every machine you have paired,
and hands them back — on your laptop, your phone, a second machine — exactly
where you left off.

- **Sessions outlive the tab.** Close it and the build keeps running.
  Reattaching replays what you missed.
- **One list, every machine.** Name, tag, pin, group and search the whole
  fleet from one tab. Hover a session to see what it is actually doing.
- **Reachable from anything you own.** Pair a phone with a QR code. Two
  devices on one session mirror live, and the phone's 40 columns don't shrink
  the laptop.
- **No hosted service.** Remote access runs through a relay you deploy into
  your own Cloudflare account, end-to-end encrypted with the daemon's key
  pinned at pairing. flue.sh is a landing page, never part of the data path.

One static Go binary. macOS, Linux, WSL. No Node, no Python, no toolchain.

## Install

```sh
brew install karnstack/tap/flue    # or: curl -fsSL https://flue.sh/install.sh | sh
flue enable
```

`flue enable` installs a login service, starts the daemon, and opens the UI.
Everything after that happens in the browser.

## The CLI

```
flue enable        # install the login service, start the daemon, open the UI
flue disable       # remove it
flue status        # daemon, login service, and session diagnostics
flue open [path]   # spawn a session here — handy from a shell prompt
flue relay setup   # deploy a relay to your own Cloudflare account
flue relay join    # point this machine at a relay another machine deployed
flue relay status  # show the configured relay
flue relay update  # redeploy this release's relay; secret and pairings kept
flue relay address # repoint this machine at a custom domain on the same relay
flue serve         # run the daemon in the foreground, no login service
```

## Remote access

The daemon binds loopback and nothing else, so reaching it from elsewhere is
opt-in and takes one command:

```sh
flue relay setup                                   # machine 1: paste a Cloudflare token
flue relay join wss://<your-relay> --secret <...>  # every other machine
```

That deploys a Worker **and** this web app into your own Cloudflare account,
on the free tier. The same deploy is a card on the UI's Remote screen. One
relay fronts every machine you own; pairing is per machine, once per browser,
from the QR each machine shows.

What it deploys, what it costs, what one shared secret does and does not
separate: [docs/RELAY.md](docs/RELAY.md). What a hostile relay origin could
do despite the end-to-end encryption — the honest version, because the browser
loads its JavaScript from that origin — is in the [FAQ](docs/faq.md).

<p align="center">
  <img src="docs/architecture.png" width="830"
    alt="Architecture of flue: on your machine, a browser tab talks to the flue daemon over a loopback websocket. The daemon and your other devices each dial outbound into a flue-relay Worker in your own Cloudflare account, which forwards ciphertext it holds no key for. A Noise IK channel runs end to end from the daemon to the remote browser, the daemon's key pinned at pairing. No hosted service; flue.sh is never part of the data path.">
</p>

## Status

Pre-1.0, and honest about it. The local terminal, the login service, the
fleet-wide sessions list and the end-to-end pairing all work. The Cloudflare
relay is built and deployable but has not been through its manual end-to-end
gate against a real account ([docs/RELAY.md](docs/RELAY.md)) — ready to try
rather than ready to rely on. Known rough edges live in
[docs/FOLLOW-UPS.md](docs/FOLLOW-UPS.md).

flue is open source and always free.

## Building and developing

```sh
mise install   # go, node, pnpm — pinned in mise.toml
make build     # web UI + relay Worker, embedded, into bin/flue
make test
```

The dev loop, the dev/prod split, and working on the relay are in
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## License

[MIT](LICENSE)
