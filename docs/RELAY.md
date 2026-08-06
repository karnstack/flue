# Remote access: the relay

The relay is a Cloudflare Worker with one Durable Object per daemon. It bridges
your daemon's single outbound WebSocket to any number of browser tabs, and it
forwards bytes: the terminal traffic crossing it is Noise ciphertext it holds no
key for. You deploy it into your own Cloudflare account with `flue relay setup`;
there is no flue-operated server in the path.

This is the operator's document — the protocol in one page, what it costs, what
bounds abuse, how to read its counters, and the manual end-to-end a human runs
before a release. The honest limits of "the relay cannot read your terminal" are
in [`faq.md`](faq.md); the normative protocol is
[`spec/relay-protocol.md`](../spec/relay-protocol.md).

## The protocol in one page

```
daemon  ---- wss /daemon ---->  Worker + Durable Object  <---- wss /client ----  browser
        [4B channel][payload]                            [payload]
           |                                                            |
           +--------- Noise IK: browser initiator, daemon responder ----+
                      inside: [1B kind][wire protocol bytes]
```

- **The daemon leg is outbound.** Nothing on your machine listens for the
  relay's sake. Every binary message on it is `[4-byte big-endian channel]` then
  payload.
- **The browser leg carries no channel header.** The Worker knows which channel
  a socket is from the socket itself, and wraps and unwraps on the browser's
  behalf.
- **Channel 0 is control, in cleartext JSON:** `open` and `closed` (a browser
  arrived or went away), `close` (the daemon dismisses one), and `pair` /
  `pairResult` — the one part of the ceremony that is an HTTP request, parked at
  the relay while the daemon answers it.
- **Channels 1 and up are one browser each,** carrying a Noise IK handshake and
  then transport ciphertexts, forwarded without inspection. Inside a decrypted
  payload, one byte says text or binary and the rest is the ordinary wire
  protocol (`spec/protocol.md`), unchanged.
- **A daemon reconnect invalidates every live channel** — the daemon holds each
  channel's responder state in memory, so a restarted daemon has no key for a
  channel opened before the break. Live client sockets are closed `1012 daemon
  gone`; browsers reconnect and handshake again. Channel ids come from a counter
  in Durable Object storage, so an id is never reused.
- **Auth is asymmetric on purpose.** The daemon leg carries
  `Authorization: Bearer <daemon secret>`; the browser leg carries nothing,
  because Noise is the confidentiality boundary and a browser credential would
  add none. What a credential-less leg does expose is denial of service, and
  that is what the caps below are for.
- **Keepalive:** either leg may send the text frame `flue-ping`, which the
  Cloudflare edge answers `flue-pong` from the Durable Object's auto-response
  without waking it. The daemon and the browser each send one every 30 s, which
  is what keeps an idle socket under the edge's roughly 100 s idle close.

## Standing one up

```sh
flue relay setup     # paste a Cloudflare API token, pick an account, watch it deploy
flue relay status    # what is configured
```

Setup needs a token from the **"Edit Cloudflare Workers"** template. It verifies
the token, picks the account (asking when there is more than one), uploads the
Worker with its Durable Object migration and the whole web bundle as the
Worker's static assets, enables the `workers.dev` subdomain, sets a fresh
32-byte `DAEMON_SECRET` on the script, and writes `relay.json` (mode 0600) into
flue's config directory — `$XDG_CONFIG_HOME/flue`, or `~/.config/flue`. The API
token is never stored: its whole life is that one command, and you can delete it
afterwards. Restart the daemon to pick the relay up.

Run it from a **release binary** (`make build`, or an installed flue). The
Worker and the web app are both compiled into that binary, and a dev build
carries neither — setup refuses rather than deploying something that is not
there.

Re-running setup against the same account is safe — the deploy and the secret
are upserts. Re-running it against a *different* account leaves the old Worker
live and reachable; there is no `flue relay teardown`, so delete it in the
dashboard yourself (`docs/FOLLOW-UPS.md` §12).

## Cost model

The whole SaaS question rests on this, and the invite-phase decision should rest
on measured counters rather than on this section. Every figure below is
Cloudflare's list pricing as researched in **August 2026** — re-check it at
[the Workers pricing page](https://developers.cloudflare.com/workers/platform/pricing/)
before quoting it at anyone.

**Free plan, per day:**

| meter | free allowance |
|---|---|
| Worker requests | 100,000 / day |
| Durable Object requests | 100,000 / day |
| Durable Object duration | 13,000 GB-s / day |
| Egress (bandwidth) | free, unmetered |
| Static asset requests | free, unmetered |

**Paid rates, once past the free tier:** Durable Object duration
**$12.50 per million GB-s**, Durable Object requests **$0.15 per million**.

Four facts decide flue's shape here:

1. **Hibernation-eligible Durable Objects bill no duration.** A DO whose only
   attachment is hibernatable WebSockets, with no pending timer pinning it in
   memory, is not billed for the wall-clock time it spends asleep. This is why
   the hub uses the hibernation API throughout, why the handshake deadline is a
   storage alarm rather than a `setTimeout`, and why `flue-ping` is answered by
   the edge's auto-response instead of by code. A terminal is ~99 % idle; if
   hibernation works, an open-all-day session bills duration only for the
   milliseconds it spends forwarding frames.
2. **Without hibernation the model collapses,** and the arithmetic is worth
   keeping in view: a DO pinned awake all day is 86,400 s × 128 MB = **10,800
   GB-s per machine per day**, which is 83 % of the entire free daily allowance
   for one machine, and about **$4 per machine per month** at the paid rate.
   That is the number hibernation has to keep at zero.
3. **Incoming WebSocket messages are billed 20:1** — twenty inbound messages
   count as one Durable Object request. Messages the object *sends* are not
   requests. So a chatty session is a twentieth as expensive as a naive frame
   count suggests: a 30 s keepalive is 2,880 pings/day/socket, i.e. 144 billed
   requests; ten thousand output frames is 500. Whether an auto-responded
   `flue-ping` is metered at all is exactly the kind of question a month of real
   counters answers better than a docs page — assume it is, and the number above
   is still noise against 100,000.
4. **Egress is free and assets are free.** Relaying megabytes of build log costs
   nothing in transfer, and the web bundle the Worker serves is not a metered
   request. The cost of a session is its *request count* and its *active
   duration*, not its bytes — which is the tailwind that makes a cheap price
   possible at all.

Two limits worth knowing rather than paying for: a WebSocket message may be at
most **32 MiB** (flue's frames are orders of magnitude below that), and an idle
connection is closed at roughly **100 s**, which the 30 s keepalive covers.

**Verdict for now:** personal use, self-hosted, sits inside the free plan with
room to spare — the free daily DO request allowance is roughly two million
inbound messages. What is *not* yet proven is hibernation under real load, and
that is the go/no-go for anything hosted. Measure before pricing.

## Fair use, and the caps that exist today

The `/client` leg and `POST /api/pair` are both credential-less by design, so
the Durable Object bounds them directly. All of these are per hub — that is, per
daemon:

| bound | value | what it stops |
|---|---|---|
| concurrent client channels | 64 | a socket flood; over it, `503 relay full` |
| client message size | 1 MiB | one browser taking the daemon leg down; over it, that socket alone closes `1009` |
| handshake deadline | 30 s | channels opened and never used, reaped by alarm |
| concurrent parked pair requests | 8 | pairing attempts held open; over it, `429` |
| pairing body cap | 4 KiB | an oversized POST; over it, `413` |
| pairing answer deadline | 10 s | a daemon that never answers; `504` |

The message cap is the one whose *number* matters beyond itself: the daemon
reads the socket carrying every browser on your machine with a 2 MiB limit that
kills the connection rather than the message, so the relay's 1 MiB has to stay
under it. Anything else and one oversized frame from a stranger drops every
session on the machine, repeatedly.

**Worth adding yourself: a rate limit on `/api/pair`.** That endpoint carries no
credential by design, and the caps above bound how many attempts one caller can
*hold* rather than how fast they can arrive. A wrong token costs you nothing —
it does not spend your pairing window — so a flood cannot stop you pairing, but
it can spend a free-plan relay's daily request allowance. Cloudflare's own
**Rate Limiting rules** (dashboard → your Worker's route → Security → WAF) are
free, run at the edge before the Durable Object wakes, and are the right place
for a limit that depends on your traffic rather than on this code. Something
like 10 requests per minute per IP on `/api/pair` is far above any human
ceremony (`docs/FOLLOW-UPS.md` §13).

**What does not exist yet is an output-rate cap.** A session that streams
continuously (`yes`, `tail -f` on a firehose) pins the object active and floods
invocations, and nothing throttles it. That is the one abuse vector that turns
into a bill, it is a follow-up rather than a shipped control
(`docs/FOLLOW-UPS.md` §13), and it wants a real number from the counters below —
tuned so ordinary interactive use never touches it — rather than a guess. The
related asymmetry on the daemon's own outbound queue is §10.

## Reading the counters

The Worker deploys with observability enabled, and the hub logs one JSON line
per client channel when that channel closes:

```json
{"evt":"channel_closed","channel":7,"fwdToDaemon":412,"fwdToClient":1088,"bytesToDaemon":9130,"bytesToClient":264401}
```

`fwd*` are frame counts and `bytes*` are payload bytes, each per direction:
`toDaemon` is what the browser sent (keystrokes, resizes, control), `toClient`
is what came back (output). The line is emitted exactly once per channel, on
whichever exit path the channel takes.

Watch them live, or read them after the fact:

```sh
cd relay && pnpm exec wrangler tail flue-relay --format json
```

The same lines are in the dashboard under Workers & Pages → `flue-relay` → Logs,
and the metered totals — requests and GB-s against the daily caps — are under
Metrics on the same page. Two honest gaps: nothing is logged until a channel
*closes*, so a tab left open for a week reports nothing until it goes away; and
the line carries no duration, so a channel's lifetime has to come from tail
timestamps rather than from the record itself (`docs/FOLLOW-UPS.md` §13).

## What a month of dogfooding should record

Before any pricing decision — and before the fair-use numbers stop being
guesses — a month of real daily use should leave this behind:

- **Daily DO requests and daily GB-s**, from the dashboard, one row per day
  against the 100,000 and 13,000 free caps. The ratio between them is the whole
  story: requests should climb with use while GB-s stays near the floor.
- **Whether hibernation is actually happening.** If GB-s tracks *wall-clock
  connected time* rather than frame volume, it is not, and everything above is
  void. This is the single most important line in this list.
- **Per-channel frames and bytes each way** from `channel_closed`, kept as a
  distribution rather than a mean. Fair-use ceilings are set off the tail — the
  99th-percentile session — because the mean of a terminal's traffic is dominated
  by an idle prompt.
- **Channels per day and how long they live**, which is how a "session" converts
  into cost, and how much a phone that reconnects on every screen wake costs
  compared with a laptop that holds one socket all day.
- **Daemon reconnect frequency.** Every reconnect invalidates every live channel,
  so a flappy machine is both a cost signal and a UX one.
- **What a pairing costs.** A parked pair request holds a timer, which is the one
  thing that keeps the object out of hibernation; how often that happens matters
  more than how long each one takes.
- **The worst day, named.** One long build, one `tail -f` left running, one
  phone on a bad network — the numbers those produce are the fair-use cap's
  input, and they are worth writing down as anecdotes and not just as totals.

Cost per active machine per month, with its tail, is the output. Anything that
looks like a price before that number exists is a guess.

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
