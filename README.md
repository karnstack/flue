<h1 align="center">flue</h1>

<p align="center"><strong>The desk stops mattering.</strong></p>

<p align="center">
  <a href="https://github.com/karnstack/flue/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/karnstack/flue/ci.yml?branch=main&label=ci" alt="CI status"></a>
  <a href="https://github.com/karnstack/flue/releases/latest"><img src="https://img.shields.io/github/v/release/karnstack/flue?label=release" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
</p>

<p align="center">
  <a href="https://flue.sh">flue.sh</a> ·
  <a href="https://flue.sh/docs/setup">setup</a> ·
  <a href="https://flue.sh/docs/how-it-works">how it works</a> ·
  <a href="https://flue.sh/docs/relay">remote access</a> ·
  <a href="https://flue.sh/docs/faq">faq</a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/hero-dark.png">
    <img src="docs/hero-light.png" width="900"
      alt="flue's sessions screen in a browser tab on 127.0.0.1:7717, listing six sessions grouped across four machines: macbook, studio, pi-4 and vps. Beside it a phone, on the relay's own address, has the same highlighted session open, showing an agent transcript and a row of terminal keys.">
  </picture>
</p>

Builds, agents and SSH sessions keep running on the machine that owns them.
Every one of them is one tab away, on any screen you have. A small Go daemon
holds the shells and their scrollback, and a web app draws them. Closing the
tab does not kill a session. It only detaches it, and reattaching replays what
you missed.

- **Sessions outlive the tab.** Close it and the build keeps running.
- **One list, every machine.** Name, tag, pin, group and search the whole
  fleet from one place. Hover a session to see what it is doing.
- **One keystroke to any of them.** `⌘K`, or `Ctrl+Shift+K` elsewhere, opens
  every session on every machine. The highlighted row shows its own last
  fourteen lines, so you can see which one is the build. `Ctrl+Shift+1` to `9`
  jumps to a pinned session.
- **Reachable from anything you own.** Pair a phone with a QR code, once for
  the whole fleet. Two devices on one session mirror live, and the size follows
  whichever view you are using.
- **No hosted service.** Remote access runs through a relay you deploy into
  your own Cloudflare account, end-to-end encrypted, with the daemon's key
  pinned at pairing. flue.sh is a landing page and is never part of the data
  path.

One static Go binary. macOS, Linux, WSL. No Node, no Python, no toolchain.

## Install

```sh
brew install karnstack/tap/flue    # or: curl -fsSL https://flue.sh/install.sh | sh
flue enable
```

`flue enable` installs a login service, starts the daemon, and opens the UI.
On Linux it also runs `loginctl enable-linger`, so the daemon and your sessions
survive your last logout. If lingering cannot be turned on, which happens in
some containers, `flue enable` warns you and names the command to run.
Everything after that happens in the browser.

## Recommended setup

One relay, every machine joined to it, every device paired once.

1. Install flue and run `flue enable` on every machine that runs work: the
   laptop, the desktop, the Pi, the VPS.
2. Run `flue relay setup` **once**, on one machine. Running it again does not
   add a relay, it replaces the one you have: every machine then has to re-join
   with the newly printed line, and every device has to pair again.
3. Run the `flue relay join` line it prints on every other machine.
4. Pair each phone or tablet once, from a QR code. That pairing covers the
   whole fleet, so there is no second ceremony per machine. It is per browser,
   so Safari and Chrome on one iPad pair separately.

Long jobs belong on a machine that stays on. A sleeping laptop's sessions are
not lost, but nothing runs until it wakes.

The full version is at [flue.sh/docs/setup](https://flue.sh/docs/setup).

## The CLI

```
flue enable        # install the login service, start the daemon, open the UI
flue disable       # remove it
flue status        # daemon, login service, and session diagnostics
flue open [path]   # spawn a session here, handy from a shell prompt
flue relay setup   # deploy a relay to your own Cloudflare account
flue relay join    # point this machine at a relay another machine deployed
flue relay status  # show the configured relay
flue relay update  # redeploy this release's relay; secret and pairings kept
flue relay address # repoint this machine at a custom domain on the same relay
flue relay leave   # take this machine off its relay; the Worker stays deployed
flue serve         # run the daemon in the foreground, no login service
flue update        # download the newest release, swap this binary, restart the daemon
flue version       # print the version (also --version, -v)
```

## Remote access

The daemon binds loopback and nothing else, so reaching it from elsewhere is
opt-in and takes one command:

```sh
flue relay setup                                                 # machine 1: paste a Cloudflare token
flue relay join wss://<your-relay> --secret <...> --fleet <...>  # every other machine
```

That deploys a Worker **and** this web app into your own Cloudflare account,
on the free tier. The same deploy is a card on the UI's Remote screen. One
relay fronts every machine you own, and pairing a device covers the whole
fleet rather than one machine.

What it deploys and what it costs is at
[flue.sh/docs/relay](https://flue.sh/docs/relay), with the operator-grade
version in [docs/RELAY.md](docs/RELAY.md). What a hostile relay origin could do
despite the end-to-end encryption, which is the honest version because the
browser loads its JavaScript from that origin, is in the
[FAQ](https://flue.sh/docs/faq) and at length in [docs/faq.md](docs/faq.md).

<p align="center">
  <img src="docs/architecture.png" width="830"
    alt="Architecture of flue: on your machine, a browser tab talks to the flue daemon over a loopback websocket. The daemon and your other devices each dial outbound into a flue-relay Worker in your own Cloudflare account, which forwards ciphertext it holds no key for. A Noise IK channel runs end to end from the daemon to the remote browser, the daemon's key pinned at pairing. No hosted service; flue.sh is never part of the data path.">
</p>

## Status

Pre-1.0, and honest about it. The local terminal, the login service, the
fleet-wide sessions list and the end-to-end pairing all work. The Cloudflare
relay is built and deployable but has not been through its manual end-to-end
gate against a real account ([docs/RELAY.md](docs/RELAY.md)), so treat it as
ready to try rather than ready to rely on. Known rough edges live in
[docs/FOLLOW-UPS.md](docs/FOLLOW-UPS.md).

flue is open source and always free.

## Building and developing

```sh
mise install   # go, node, pnpm, pinned in mise.toml
make build     # web UI + relay Worker, embedded, into bin/flue
make test
```

The dev loop, the dev/prod split, and working on the relay are in
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). The landing site is its own package
under [site/](site/), and `make site-dev` runs it.

## License

[MIT](LICENSE)

