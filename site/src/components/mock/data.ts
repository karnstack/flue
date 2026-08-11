/**
 * The fleet the drawn app shows.
 *
 * Invented, but shaped like a real one and grouped the way the app groups it:
 * a laptop being worked on, a desktop running the slow jobs, a Pi that has
 * been tailing a log for six hours, and a VPS with something that has already
 * exited. The point of the picture is that these four machines are one list.
 */

export type MockSession = {
  /** What the row reads as. Sessions carry the shell's own name until renamed. */
  name: string
  /** The command behind it, set in the dim mono the app uses. */
  command: string
  path: string
  age: string
  state: 'running' | 'exited'
  tag?: string
  /** Kept to hand, and starred for it. The app's own mark (session-table.tsx). */
  pinned?: boolean
  /**
   * The session the phone beside the window has open. Not a state the app
   * draws: it is how the hero's two figures are shown to be one session, and
   * the ring is the site's own mark for it.
   */
  held?: boolean
}

export type MockGroup = {
  machine: string
  tally: string
  sessions: MockSession[]
}

export const GROUPS: MockGroup[] = [
  {
    machine: 'macbook',
    tally: '2 running',
    sessions: [
      {
        name: 'claude: relay handshake',
        command: '/bin/zsh -l',
        path: '~/code/flue',
        age: '2m ago',
        state: 'running',
        tag: 'agent',
        pinned: true,
        held: true,
      },
      {
        name: 'pnpm vitest --watch',
        command: '/bin/zsh -l',
        path: '~/code/flue/web',
        age: '14m ago',
        state: 'running',
        tag: 'web',
      },
    ],
  },
  {
    machine: 'studio',
    tally: '2 running',
    sessions: [
      {
        name: 'go test ./...',
        command: '/bin/zsh -l',
        path: '~/code/flue',
        age: '1m ago',
        state: 'running',
        tag: 'ci',
        pinned: true,
      },
      {
        name: 'ssh prod-1',
        command: '/bin/zsh -l',
        path: '~',
        age: '3h ago',
        state: 'running',
      },
    ],
  },
  {
    machine: 'pi-4',
    tally: '1 running',
    sessions: [
      {
        name: 'tail -f /var/log/syslog',
        command: '/bin/zsh -l',
        path: '~',
        age: '6h ago',
        state: 'running',
      },
    ],
  },
  {
    machine: 'vps',
    tally: '1 exited',
    sessions: [
      {
        name: 'docker compose up',
        command: '/bin/zsh -l',
        path: '~/srv/media',
        age: '2d ago',
        state: 'exited',
      },
    ],
  },
]

/**
 * The same fleet, arranged the way the switcher arranges it.
 *
 * Pinned first with number keys on them, then where this browser has been,
 * then the rest. That is the app's own order (web/src/switcher/order.ts) and
 * the reason the palette is a reflex rather than a search.
 */
export type MockSwitcherRow = {
  label: string
  cwd: string
  machine: string
  /** The number key that jumps here, on pinned rows only. */
  badge?: string
  state: 'running' | 'exited'
  /** The row the keyboard is on. Exactly one row has this. */
  active?: boolean
  /** The session the tab is already in. */
  current?: boolean
}

export type MockSwitcherSection = {
  label: string
  rows: MockSwitcherRow[]
}

export const SWITCHER_SECTIONS: MockSwitcherSection[] = [
  {
    label: 'Pinned',
    rows: [
      {
        label: 'claude: relay handshake',
        cwd: '~/code/flue',
        machine: 'macbook',
        badge: '1',
        state: 'running',
        active: true,
      },
      {
        label: 'go test ./...',
        cwd: '~/code/flue',
        machine: 'studio',
        badge: '2',
        state: 'running',
      },
    ],
  },
  {
    label: 'Recent',
    rows: [
      {
        label: 'pnpm vitest --watch',
        cwd: '~/code/flue/web',
        machine: 'macbook',
        state: 'running',
        current: true,
      },
      { label: 'ssh prod-1', cwd: '~', machine: 'studio', state: 'running' },
    ],
  },
  {
    label: 'All sessions',
    rows: [
      { label: 'tail -f /var/log/syslog', cwd: '~', machine: 'pi-4', state: 'running' },
      { label: 'docker compose up', cwd: '~/srv/media', machine: 'vps', state: 'exited' },
    ],
  },
]

/**
 * What the pane beside the list shows for the highlighted row.
 *
 * The app asks the machine for a scrollback tail and draws the last fourteen
 * lines of it (PEEK_LINES, web/src/components/session-switcher.tsx). This is
 * that, invented: thirteen lines here and the prompt row the component draws
 * under them, which is the fourteenth. And it is the whole argument for the
 * pane: "which one is the build?" is answered by looking.
 */
export const SWITCHER_PREVIEW: { title: string; machine: string; lines: string[] } = {
  title: 'claude: relay handshake',
  machine: 'macbook',
  lines: [
    'Read relay/handshake.go, relay/reaper.go and the two',
    'tests around them.',
    '',
    'Handshake fails when the reaper fires mid-pairing. The',
    'pairing side never sees the ack. Add the guard?',
    '',
    '> yes, with a test',
    '',
    'Added TestReaperSkipsPairing. Running it now.',
    '',
    '--- PASS: TestReaperSkipsPairing (0.02s)',
    'ok      github.com/karnstack/flue/relay   0.31s',
    // The blank before the prompt row under it. Between content rather than
    // trailing it, which is the only kind of blank the app's own reader keeps
    // (previewLines, web/src/sessions/preview.ts).
    '',
  ],
}
