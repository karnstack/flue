# The session switcher

A palette that goes from any session to any other session on any machine, in
one keystroke, without leaving the tab.

## The problem

A flue session *is* a tab. That is the premise the terminal route is built on —
it renders outside the app shell on purpose, because chrome around a terminal
would contradict it — and the price is that the only way to another session is
to leave: open the dashboard in a new tab, read a list, click a row. For the
thing people do most often, that is the slowest path in the app.

## The shape

`⌘K` on a Mac, `Ctrl+Shift+K` everywhere, from every screen that can see a
daemon. It opens a palette over whatever is on screen: pinned sessions first
with number chords on them, then where this browser has actually been, then the
rest. Type to narrow, arrows to move, Enter to go. The highlighted row previews
its own last fourteen lines beside the list, so the question "which one is the
build?" is answered by looking rather than by guessing from a name.

Two chords do the same job without opening anything: `Ctrl+Shift+1..9` jumps
straight to a pinned session, and `Ctrl+Shift+]` / `[` steps to the next or
previous one.

### Why those keys

| | opens the palette |
|---|---|
| macOS | `⌘K` |
| Linux, Windows, WSL | `Ctrl+Shift+K` |

Both are bound on every platform; only the printed hint changes.

`⌘K` is free inside a terminal in a way `Ctrl+K` is not: xterm sends no
Cmd-modified key to the shell, while `Ctrl+K` is readline's kill-to-end-of-line.
`Ctrl+Shift+K` is what exists where there is no Cmd at all, and it joins the
family `Ctrl+Shift+Enter` already opened for focus mode (`lib/keyboard.ts`) —
`Ctrl+Shift` is the range a terminal emulator conventionally keeps for its own
chrome.

The number chords are `Ctrl+Shift+1..9` on every platform including macOS,
because Chrome spends `⌘1..9` on tab switching and a page cannot preventDefault
it.

Shifted characters are the trap the chord matcher is written around: with Shift
held, `Ctrl+Shift+1` arrives as `!` on a US layout and `"` on a UK one, and
`Ctrl+Shift+]` arrives as `}`. So `event.code` leads and the produced character
is accepted behind it.

### The button

The chords are half the story; a phone has neither Ctrl nor Cmd. A switcher
chip joins the terminal's control strip — beside the theme menu, the dashboard
link and the `+` — with `Switch session · ⌘K` on it. That is the only way in on
touch, and it is also how the chord gets learned: the hint on the connecting
pill is gone in a hundred milliseconds on a local daemon.

## Architecture

Web-only. No new wire message, no daemon change: `fleet.onFleet` already
delivers every reachable machine's sessions, merged and polled every three
seconds, and `fleet.peekOn` already fetches a session's scrollback tail without
minting a ref or touching `lastActive`.

| file | job |
|---|---|
| `web/src/switcher/keys.ts` | Chord matching and the one platform question. Pure. |
| `web/src/switcher/recents.ts` | Where this browser has been, in localStorage. |
| `web/src/switcher/order.ts` | What the palette shows, sectioned. Pure. |
| `web/src/switcher/provider.tsx` | The chords, the navigation, the one palette. |
| `web/src/components/session-switcher.tsx` | The palette itself, fleetless and testable. |

`SwitcherProvider` mounts inside `FleetProvider` in the root route, so there is
exactly one palette per tab and it is above every screen. The two routes it does
not reach are the two with no daemon to list: `/pair`, which is how a device
gets a token in the first place, and the machine picker.

### Ghost rows

The fleet drops a machine's rows the moment it goes unreachable, deliberately:
rows from a machine nobody can reach are a claim it cannot stand behind. So a
session on a sleeping laptop is not stale in the list, it is absent from it.

The recents store is where it survives. Each visit keeps a copy of what the row
said — its name, its machine, its directory — so the palette can draw a session
whose machine is not answering. Such a row reads greyed, says `unreachable`, and
is still selectable: the terminal route has a proper answer for a machine it
cannot reach, and refusing to navigate would be the list deciding on the
reader's behalf that a sleeping laptop is not worth waking.

A session its machine says is gone — absent from a list that machine is
currently answering — is forgotten rather than left as a ghost, so the ghosts
stay to sessions that can still be woken.

## Performance

Four decisions, each against a specific failure:

**Nothing runs while shut.** The provider holds one keydown listener and one
fleet subscription that writes to a ref and renders nothing. Closed, the palette
costs zero renders. The fleet is already polling for its own reasons, so the
rows are in memory before the key is pressed — the palette never shows a
spinner, and its first paint has real rows in it.

**Opening is one render.** The three state updates that open it — rows, recents,
open — are made in one event so React batches them. Handing the rows over in an
effect after the opening render would settle an empty arrangement, and the rows
arriving a tick later would change nothing the reader could see.

**No debounce on the filter**, deliberately opposite to the sessions screen. That
screen waits 150ms so its group headings do not re-cut under someone's typing;
the palette's list is flat and short, and a palette that trails the keyboard is
the most broken-feeling thing a screen can do. What waits is the peek.

**The highlight is a key, not an index.** `onFleet` fires every three seconds
while the palette is open. An index means "the third row", and the third row is
a different session the moment anything above it changes — press Enter between
one poll and the next and you land somewhere else. A key means the session
somebody actually chose.

**The arrangement is settled at open and on each keystroke, never on a poll.**
Polls refresh what each row says — its title, its state — but cannot reorder,
insert or remove one. A row whose session has gone keeps the last thing known
about it rather than vanishing mid-read.

**Peek is highlighted-row-only**, after a 120ms rest, cached for the palette's
lifetime. No neighbour prefetch: that is N round trips to as many machines, over
a relay, for previews nobody will look at.

**Fifty rows, and it says so.** No virtualization — nobody scrolls a palette —
but a cap that stayed quiet would read as a fleet of fifty, so the footer names
what it left out.

## Ordering

Two orders, and they are deliberately different.

The **palette** reads pinned, then recent, then everything else. Pinned is what
someone decided was worth keeping to hand. Recent is where this browser has
been, newest first, which is what makes a switcher a reflex. The remainder gets
its own heading rather than being quietly omitted.

The **cycle** — what `Ctrl+Shift+]` walks — rests on pinned, then creation order,
then id. Recency cannot be cycled: step to the most recent session and it
becomes the most recent, so "next" bounces between two rows forever and never
reaches a third. The same walk gives the same sequence every time, which is the
only thing that makes a blind chord learnable.

Pinned **badges** are numbered by creation for the same reason. `orderSessions`
sorts pinned rows by `lastActive`, which lets a busy session climb — fine for a
list somebody reads, ruinous for a number somebody has memorised.

The cycle also skips unreachable machines while the palette does not. A row
somebody deliberately picked out of a list can be a sleeping machine; they saw
what they chose. A blind hop must land somewhere usable.

## The dead end

A search that matches nothing offers `New session in <cwd>` — the directory of
the session the tab is in, on the machine it is on. Click-driven only, which is
what keeps it safe: a spawn fired from a mount effect runs twice under
StrictMode and can only ever detach one of its shells.

## Testing

- `switcher/keys.test.ts` — every chord, including the shifted-character traps
  and the platform split.
- `switcher/recents.test.ts` — ordering, the cap, revisits, and every way
  localStorage can lie.
- `switcher/order.test.ts` — sections, badges, ghosts, the cap, the cycle.
- `components/session-switcher.test.tsx` — the palette with no fleet behind it:
  keyboard navigation, filtering, peek debouncing and caching, and the two
  stillness guarantees under a re-list.
- `switcher/provider.test.tsx` — the real router over two scripted machines:
  the chords, cross-machine navigation, visit recording, and the spawn.
