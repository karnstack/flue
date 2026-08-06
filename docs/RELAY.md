# Remote access: the relay

*(Runbook and protocol one-pager land here in Task 15. What follows is the
one thing that cannot be automated.)*

## Release gate: the manual end-to-end

The relay's test suites all run against fakes — a scripted Cloudflare API, an
in-memory Durable Object, a loopback daemon. That is the right shape for CI,
and it means no automated test has ever seen a real Worker, a real workers.dev
subdomain, or a phone on a different network. This checklist is what covers
that gap, and it is a **human gate on every release that touches the relay**,
not a task anything can tick on its own.

Run it from a release binary (`make build && bin/flue …`), never a dev build:
a dev build carries no Worker to deploy.

- [ ] `flue relay setup` against a real Cloudflare account, with a token made
      from the "Edit Cloudflare Workers" template. Every ✓ line appears; the
      token is nowhere in the output.
- [ ] Restart the daemon (`flue disable && flue enable`, or restart
      `flue serve`). `flue status` reports the relay; the daemon's log says it
      connected.
- [ ] Open the printed `https://flue-relay.<sub>.workers.dev` in a browser on
      the **same** machine. The web app loads — that is the assets binding and
      the SPA fallback working.
- [ ] Pair a phone from the QR code, over cellular rather than the house
      Wi-Fi, so the traffic genuinely crosses the internet.
- [ ] Type a command in a session on the phone; see the output. Type in the
      same session on the desktop; see both sides mirror.
- [ ] Kill the daemon (`kill -9`), watch the phone report the drop, restart the
      daemon, and watch the session come back without re-pairing.
- [ ] Re-run `flue relay setup` on the same account. It succeeds — the deploy
      and the secret are upserts — and the phone re-pairs against the new
      secret after the daemon restarts.
