# The site's copy, its missing section, and its missing page

Three changes to flue.sh and the README. They share one cause. The site sells
the wrong promise, in the wrong voice, and leaves out the two things a new
user most needs to know.

## The problem

**The tagline is the weakest true reading of the product.** "Your work
shouldn't stop when you close the laptop" is false if you read it plainly. If
the daemon runs on the laptop and you close the lid, the work does stop. The
sentence only holds if you read it as being about a second machine. That makes
device mobility the headline promise. Device mobility is a good feature. It is
not the point.

The point is the opposite of what that sentence implies. Work is anchored to
the machine that owns it. You are the mobile part. The old tagline sold the
freedom of the laptop. The product sells the freedom of the person.

**The switcher is invisible.** `⌘K` goes from any screen to any session on any
machine. It shipped in #53. It is the fastest path in the app and the clearest
proof of the new promise, and the site does not mention it once.

**There is no setup guide.** `/docs/relay` explains what a relay is and what it
costs. Nothing explains the order to do things in. Nothing states the two facts
that new users get wrong: deploy exactly one relay for the whole fleet, and
pair each device exactly once for the whole fleet.

**The voice shuts readers out.** The copy is literary. "A terminal has no
memory of you." "Closing the tab detaches rather than kills." Long sentences,
inverted clauses, idiom. flue's readers are developers all over the world, and
most of them do not read English as a first language.

## The shape

### The promise

```
The desk stops mattering.

Builds, agents and SSH sessions keep running on the machine that owns them.
Every one of them is one tab away, on any screen you have.
```

The headline names the constraint that actually lifts. Machines stay where
they are. What stops gating the work is your presence at a desk. "Desk" is
about you. "Laptop lid" was about a machine, which is why the old line could be
read as false and this one cannot.

It holds in every setup. A Pi, a VPS, a sleeping laptop. None of them make it
untrue. It says nothing about lists, daemons or devices, so it states an
outcome and not a feature.

The subline carries the substance the headline leaves out on purpose: what
keeps running, where it runs, and how you reach it.

The `<title>` tag does a different job. It is a search result, so it keeps a
keyword: `flue: every terminal session you have running, one tab away`.

### The voice

Plain, global English everywhere on the site.

- Short sentences. One idea in each.
- Common words. "Owns", not "holds title to". "Starts", not "spawns", except
  in CLI output.
- No idiom. No inversion for effect.
- **No em-dashes and no en-dashes.** Use a full stop when the second half is a
  second idea, a colon when it explains the first half, commas for an aside,
  and brackets for a true parenthesis. Ranges use the word "to":
  `Ctrl+Shift+1 to 9`.
- Technical terms stay exact. Simpler English is not vaguer English.

This applies to the copy a reader sees. Code comments in `site/` keep their
current voice, because rewriting them is a large diff that changes nothing a
visitor reads. The exception is comments that quote copy being changed.

The FAQ needs care. Its argument about a hostile relay origin is precise on
purpose, and that precision is what protects the reader. Simplify its
sentences. Do not simplify its claims.

Before and after:

| now | plain |
|---|---|
| A terminal has no memory of you. | A terminal forgets you. |
| Closing the tab detaches rather than kills. | Closing the tab does not kill the session. It only detaches it. |
| the phone's 40 columns don't shrink the laptop | The phone is 40 columns wide. That does not make the laptop's terminal smaller. |
| claude — relay handshake | claude: relay handshake |

That last row is mock data in `mock/data.ts` and `mock/fleet.tsx`. It is drawn
into the app screenshots on the page, so it is copy like any other.

### The switcher section

New homepage section, between **How** and **Remote**.

```
EYEBROW   Switching
HEADING   The list comes to you.
```

The heading answers problem card three, which says "Four machines, and no
single list."

Body: `⌘K` on a Mac, `Ctrl+Shift+K` on any platform including macOS, from any screen that can
see a daemon. Pinned sessions come first, with number keys on them. Then the
sessions this browser has opened before. Then the rest. Type to narrow the
list, use the arrow keys to move, press Enter to go. The highlighted row shows
its own last fourteen lines beside the list, so you can see which one is the
build instead of guessing from its name. `Ctrl+Shift+1` to `Ctrl+Shift+9` jumps
straight to a pinned session without opening the palette at all.

Full width and centred, not a split column. The real dialog is 56rem wide and
does not survive being squeezed into half a row. Full width also keeps the
existing rhythm: **How** puts its text on the left, **Remote** puts its mock on
the left, and a full-width section between them fights neither.

### The setup page

New page at `/docs/setup`, first in the nav.

```
TITLE  Setting up your fleet
BLURB  One relay, every machine joined to it, every device paired once.
```

It gets its own page rather than a section inside `/docs/relay`. That page is
about what a relay is, what it costs, and what its operator can see. An ordered
walkthrough is a different kind of writing for a different reader, and putting
it inside the relay page buries the trust argument behind a checklist.

The page opens by stating the target shape, because every step after it is only
a way of reaching that shape: **one relay, every machine joined to it, every
device paired once.**

**01. Install flue on every machine that runs work.** Use `brew install` or the
curl line, then run `flue enable` on each machine. On Linux, `flue enable` also
runs `loginctl enable-linger`, so your sessions survive your last logout.

**02. Deploy one relay, on one machine.** Run `flue relay setup` once, on
whichever machine is convenient. It needs a Cloudflare API token.

This step holds the only real trap, so it gets a `Note`:

> Do not run `flue relay setup` a second time. On the same Cloudflare account
> it does not give you a second relay, it replaces the one you have: the deploy
> and the secret are upserts, and every run mints a fresh secret, a fresh fleet
> key and a fresh machine id. Every other machine is then holding a secret the
> relay no longer accepts, and every device has to pair again. The way back is
> the join line the most recent setup printed, run on every other machine. The
> first setup's line does not work any more.

**03. Join every other machine.** Run the `flue relay join` line that setup
printed, once on each remaining machine. Guard that line like a root password.
It carries the fleet key, so anyone who holds it holds the fleet.

**04. Pair each device once.** Open flue on the device and scan the QR code.

Then the fact the docs do not state plainly today:

> Pairing works per fleet, not per machine. The machine that runs the pairing
> signs a device certificate that every machine in the fleet accepts. A phone
> paired with your laptop can reach the Pi and the VPS with no second pairing.

Pairing does work per browser, though. Safari and Chrome on the same iPad each
pair on their own.

The existing advice about pairing over the daemon's own origin belongs here as
well. Pair over the daemon's own address when the browser can already reach the
machine, on the same network or over something like Tailscale. A phone that is
not on the network has no such path, and there the relay is the only way.

**05. Add it to the home screen, on iPhone and iPad.** It then runs fullscreen,
and the key bar stops fighting Safari's toolbar. This is a comfort step and the
page says so. Installing does not pin the code the origin serves. `docs/faq.md`
is blunt about this and the setup page must not quietly imply otherwise.

**Then: which machine should run what.** This is the section the old tagline
was avoiding.

> A laptop sleeps. The sessions on a sleeping machine are not lost. They are
> out of reach until it wakes, and the switcher still lists them, greyed, and
> still opens them. So put long jobs and agent runs on a machine that stays on:
> a desktop, a Pi, a VPS. Keep the laptop for the work you are watching.

## What this touches

| file | change |
|---|---|
| `site/src/routes/index.tsx` | headline, subline, all section prose, new switcher section |
| `site/src/components/mock/switcher.tsx` | new: the palette, drawn |
| `site/src/components/mock/data.ts` | switcher rows beside `GROUPS`, dashes out of session names |
| `site/src/components/mock/fleet.tsx` | dashes out of the drawn copy |
| `site/src/components/mock/figures.tsx` | `LidFigure` becomes `WindowFigure` |
| `site/src/routes/docs.setup.tsx` | new page |
| `site/src/routes/docs.how-it-works.tsx` | plain English |
| `site/src/routes/docs.relay.tsx` | plain English, and the pairing line says per fleet |
| `site/src/routes/docs.faq.tsx` | plain English, same claims |
| `site/src/lib/docs.tsx` | `setup` slug and entry |
| `site/src/components/doc-page.tsx` | new `Steps` primitive |
| `site/src/components/site-header.tsx` | `Setup` in the nav |
| `site/src/routes/__root.tsx` | title, description, og:image:alt |
| `site/public/llms.txt` | plain English, setup page listed |
| `README.md` | tagline, prose, switcher bullet, recommended setup block |

`LidFigure` is a rename only. The drawing was always a window going dark, never
a lid. The name was the part that was wrong.

`site/scripts/sitemap.mjs` needs no change. It reads routes back out of the
build output, so `/docs/setup` shows up on its own.

## Testing

`site/` has no test suite. `pnpm lint` runs `tsc --noEmit`. `pnpm build`
prerenders every route and writes the sitemap, so a broken route or a missing
export fails it.

```sh
cd site && pnpm lint && pnpm build
```

The build is the real gate, because it prerenders: a route that throws while
rendering fails the build.

A final check greps the built output for `—` and `–` and expects zero hits.
That catches a dash added by hand in a file nobody thought to look at.

`web/` is untouched, so its suite is out of scope.

## Out of scope

`spec/fleet-trust.md` still says `Status: draft, pre-implementation` in its
header, though it shipped across #39 to #52. Real problem, separate change.
