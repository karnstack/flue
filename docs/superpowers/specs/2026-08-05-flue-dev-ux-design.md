# flue dev-UX round: exit overlay, session revival, terminal chrome, new-session affordance

Approved 2026-08-05 (exit UX and persistence options chosen by the user; padding
and the new-session button requested directly).

## 1. Exit overlay

When a session's state becomes `exited`, the terminal view:

- Dims the terminal (reduced opacity on the xterm container, ~60%). Scrollback
  stays scrollable and selectable — the overlay must not eat wheel or
  selection events outside its own card.
- Shows a centered card: `shell exited (N)` where N is `exitCode`. Zero is
  neutral (muted foreground); non-zero renders the code in the destructive
  color.
- Two actions:
  - **Restart** — spawns a fresh session with the dead session's `cwd` over
    the existing WebSocket `spawn` op, navigates this same browser tab to the
    new session's route, then closes the dead session. New session ID is
    accepted; the card's promise is "same tab, same directory", not "same
    scrollback".
  - **Close** — closes the dead session and navigates to the session list.
- The top-bar exited badge stays; the overlay is the primary affordance.

No daemon changes. All client: `web/src/components/terminal.tsx` plus a small
overlay component.

## 2. Session revival across daemon restarts

The daemon is the session holder (tmux-server model), so its children die
with it. Revival makes a restart cheap instead of destructive: sessions come
back with their scrollback and a fresh shell; running programs do not survive
(that is the separately-queued holder-process lane).

**Snapshot on graceful shutdown.** When `flue serve` shuts down via signal or
context cancellation, the daemon writes one snapshot per *running* session
(exited sessions are not revived) to `<config.Dir()>/sessions/<id>.json`:

```json
{
  "v": 1,
  "id": "…",
  "title": "…",
  "cwd": "/abs/path",
  "cols": 120, "rows": 32,
  "ring": "<base64 of the ring's current contents>",
  "savedAt": "RFC3339"
}
```

Directory mode 0700, file mode 0600 — scrollback is terminal output and can
contain secrets; it gets exactly the token file's treatment. Writes are
CreateTemp+Rename like every other flue state file.

**Revive on startup.** Before serving, the daemon reads `sessions/*.json`;
for each snapshot it spawns the user's login shell in the saved `cwd`
(falling back to the home directory when the cwd no longer exists), with the
ring **preloaded**: restored bytes first, then a dim marker line

```
\r\n\x1b[2m── daemon restarted · previous shell ended here ──\x1b[0m\r\n\r\n
```

then the live PTY output. Preloading happens before the PTY reader starts, so
the byte stream stays ordered and the `head` field on `attached` keeps the
client's probe-reply mute gate correct for the whole restored region. The
revived session keeps its old ID (routes and bookmarks keep working), keeps
its title, and each snapshot file is deleted as soon as its revival attempt
finishes (success or not) — a snapshot never outlives the daemon start that
consumed it, and scrollback does not accumulate on disk.

A snapshot that fails to parse is deleted and skipped; revival failures are
logged, never fatal — the daemon always comes up.

**Not persisted:** exited sessions, attachment state, primary/size state.
Clients reattach and renegotiate size exactly as after any reconnect.

## 3. Terminal chrome (design pass)

The session page renders xterm edge-to-edge; real terminals give content
breathing room. Changes, using the design system's existing tokens:

- Padding around the terminal viewport (`p-3`/12px), background matching the
  terminal canvas color so the padding reads as the terminal's own margin,
  not a frame.
- The fit addon must account for the padding (it measures the container, so
  the padding lives *on* the container, inside the measured box's parent —
  verify cols/rows still fill).
- Scrollbar styled to the terminal palette (thin, `bg-muted`-on-canvas,
  visible on hover/scroll only).
- The exit overlay from §1 uses the same tokens: `bg-card`, `border-border`,
  `rounded-lg`, `shadow-md`.
- Any further micro-polish the design skill's review of the page turns up,
  within existing tokens — no new colors, no new fonts.

## 4. New session from a session

- The session view's top bar gains a `+` (New session) control next to the
  session title/badge.
- It is a real link to `/?cwd=<current session cwd>` — the root route already
  spawns into `?cwd=` on mount and redirects to the new session.
- Default `target="_blank"`: a new session opens in a new browser tab, so the
  current session (and wherever the dashboard lives) stays put. Middle/cmd
  click behaves browser-natively for free because it is an anchor.
- The session list keeps its existing in-tab new-session behavior.

## Testing

- §1: component tests — overlay appears on `exited`, restart issues `spawn`
  with the old cwd and navigates, close issues the close op; scrollback
  container keeps `pointer-events` outside the card.
- §2: Go tests — snapshot files written 0600/0700 on shutdown for running
  sessions only; revive restores ID/title/ring-with-marker and deletes the
  snapshot; corrupt snapshot deleted+skipped; missing cwd falls back to home.
  An end-to-end registry test: spawn → write → shutdown-snapshot → new
  registry → revive → attach sees old bytes then marker.
- §3: existing styles.build.test.ts guards; visual check via the dev loop.
- §4: component test — the link carries the session's cwd and target.
