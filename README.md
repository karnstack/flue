<h1 align="center">flue</h1>

<p align="center"><strong>Your terminal, as a browser tab. Reachable from any device you own.</strong></p>

<p align="center">
  <a href="https://flue.sh">flue.sh</a> ·
  <a href="docs/superpowers/specs/2026-07-28-flue-p1-p2-design.md">design</a>
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

Transports are adapters. Loopback for the machine you're sitting at, and a relay
you deploy to your own Cloudflare account for everywhere else.

## License

MIT
