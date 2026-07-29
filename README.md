<h1 align="center">flue</h1>

<p align="center"><strong>Your terminal, as a browser tab. Reachable from any device you own.</strong></p>

<p align="center">
  <a href="https://flue.sh">flue.sh</a> ·
  <a href="docs/superpowers/specs/2026-07-28-flue-design.md">design</a>
</p>

> Status: local terminal works and `flue enable` installs the login service.
> Remote transports and pairing are next.

## Why

Two apps get used all day: a terminal and a browser. The cost is switching
between them. Browsers have tab groups, tab search, splits, session restore, and
URL addressing. Terminals have none of it and cannot join in.

flue makes a terminal session a browser tab, so it inherits all of that for free
— and makes the same live session reachable from a phone, an iPad, or another
laptop.

## Shape

A small Go daemon owns the PTYs and their scrollback. A web app renders them. A
tab close detaches; the build keeps running. Reattach replays what you missed.
Attach from two devices and they mirror live — typing on the phone shows up in
the laptop's browser, and the phone's 40 columns don't shrink the laptop.

## Setup

```
brew install karnstack/tap/flue
flue enable
```

That's it. `flue enable` installs a login service and opens the UI. Everything
after that — sessions, devices, pairing, remote access, settings — happens in the
browser.

Single static binary. No Node, no Python, no toolchain, ever.

The CLI stays at four commands on purpose:

```
flue enable       # install the login service, start the daemon, open the UI
flue disable      # remove it
flue status       # diagnostics
flue open [path]  # spawn a session here — handy from a shell prompt
```

## Reaching it from elsewhere

Remote access is opt-in and provider-agnostic. flue has no preferred option; the
UI orders them by what you already have installed.

| provider | what it needs | intermediary |
|---|---|---|
| local | nothing, always on | none |
| Tailscale | Tailscale on each device | none, often direct peer-to-peer |
| Cloudflare | a Cloudflare account, free tier is enough | your own Worker, ciphertext only |
| Cloudflare + your domain | a domain on Cloudflare | Cloudflare |

Setup happens in the UI. For Cloudflare you paste one API token; flue deploys the
Worker to *your* account over the REST API, then deletes the token. Pairing a
phone renders a QR on your laptop's screen — scan it and you're in.

Anything through an intermediary is end-to-end encrypted by default (Noise IK,
with the daemon's key pinned at pairing), so the Worker forwards ciphertext and
can never read your shell.

**There is no hosted service.** No flue account, no flue server, no billing.
Every remote path runs on infrastructure you own. `flue.sh` is docs and
downloads, never part of the data path.

## License

MIT
