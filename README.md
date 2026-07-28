<h1 align="center">flue</h1>

<p align="center"><strong>Your terminal, as a browser tab. Reachable from any device you own.</strong></p>

<p align="center">
  <a href="https://flue.sh">flue.sh</a> ·
  <a href="docs/superpowers/specs/2026-07-28-flue-design.md">design</a>
</p>

> Status: design stage. No code yet. The spec is the product right now.

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
the laptop's browser.

## Local, in ten seconds

```
$ cd ~/code/myproject
$ flue open

  daemon started on 127.0.0.1:7717
  session 1a2b · ~/code/myproject · zsh
  opening http://127.0.0.1:7717/d/local/s/1a2b
```

No config, no account, no cloud, no network.

## Everywhere else

Transports are adapters, and you pick one — nothing is forced on you.

| adapter | what it needs | intermediary |
|---|---|---|
| `loopback` | nothing | none |
| `relay` | a Cloudflare account, free tier is enough | your own Worker, ciphertext only |
| `tunnel` | a domain on Cloudflare | Cloudflare |
| `tailnet` | Tailscale on each device | none |

```
$ flue relay deploy      # deploys to YOUR Cloudflare account
$ flue serve --relay     # outbound only, no ports opened
$ flue pair              # scan the QR with your phone
```

Traffic through a relay is end-to-end encrypted by default (Noise IK, with the
daemon's key pinned at pairing), so the Worker forwards ciphertext and can never
read your shell.

**There is no hosted service.** No flue account, no flue server, no billing.
Every remote path runs on infrastructure you own. `flue.sh` is docs and
downloads, never part of the data path.

## License

MIT
