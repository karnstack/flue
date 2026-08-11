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
 * The same fleet, as the switcher's rows.
 *
 * Flat rather than pre-sectioned, because the drawn palette on the homepage
 * is typed into and the app re-sections on every keystroke: at rest the rows
 * read in three runs, and any search collapses them into one
 * (buildPalette, web/src/switcher/order.ts). A list of sections could only
 * draw the resting half of that.
 *
 * Each row carries its own tail, because the pane beside the list follows the
 * highlight. That pane is the whole argument for the palette: "which one is
 * the build?" is answered by looking rather than by reading names.
 */
export type MockSwitcherRow = {
  /** Stable identity, and what the highlight is tracked by. */
  key: string
  label: string
  cwd: string
  machine: string
  /** Which run this row rests in, before anyone types. */
  section: 'pinned' | 'recent' | 'all'
  /** The number key that jumps here, on pinned rows only. */
  badge?: string
  state: 'running' | 'exited'
  /** The session the tab is already in. */
  current?: boolean
  /**
   * The row's last lines. The app asks the machine for a scrollback tail and
   * draws the last fourteen (PEEK_LINES,
   * web/src/components/session-switcher.tsx). These are thirteen at most, so
   * the prompt row the pane draws under a running session is the fourteenth.
   */
  preview: string[]
}

/** The headings the resting palette puts over each run. */
export const SWITCHER_SECTION_LABELS: Record<MockSwitcherRow['section'], string> = {
  pinned: 'Pinned',
  recent: 'Recent',
  all: 'All sessions',
}

export const SWITCHER_ROWS: MockSwitcherRow[] = [
  {
    key: 'macbook/claude',
    label: 'claude: relay handshake',
    cwd: '~/code/flue',
    machine: 'macbook',
    section: 'pinned',
    badge: '1',
    state: 'running',
    preview: [
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
  },
  {
    key: 'studio/go-test',
    label: 'go test ./...',
    cwd: '~/code/flue',
    machine: 'studio',
    section: 'pinned',
    badge: '2',
    state: 'running',
    preview: [
      '--- PASS: TestDirectoryUpsert (0.01s)',
      '--- PASS: TestDirectoryKeepsStaleRows (0.01s)',
      '--- PASS: TestReaperSkipsPairing (0.02s)',
      'ok      github.com/karnstack/flue/relay            0.31s',
      'ok      github.com/karnstack/flue/internal/relaydeploy    0.94s',
      '',
      '=== RUN   TestEffectiveLockedFollowsLastActiveView',
      '=== RUN   TestResizeIgnoresDetachedView',
      '--- PASS: TestResizeIgnoresDetachedView (0.00s)',
      '',
    ],
  },
  {
    key: 'macbook/vitest',
    label: 'pnpm vitest --watch',
    cwd: '~/code/flue/web',
    machine: 'macbook',
    section: 'recent',
    state: 'running',
    current: true,
    preview: [
      ' ✓ src/switcher/order.test.ts (14 tests) 21ms',
      ' ✓ src/switcher/keys.test.ts (9 tests) 8ms',
      ' ✓ src/sessions/view.test.ts (22 tests) 34ms',
      '',
      ' Test Files  3 passed (3)',
      '      Tests  45 passed (45)',
      '   Duration  412ms',
      '',
      ' PASS  Waiting for file changes...',
      '       press h to show help, press q to quit',
      '',
    ],
  },
  {
    key: 'studio/ssh-prod',
    label: 'ssh prod-1',
    cwd: '~',
    machine: 'studio',
    section: 'recent',
    state: 'running',
    preview: [
      'Welcome to Ubuntu 24.04.2 LTS (GNU/Linux 6.8.0 aarch64)',
      '',
      '  System load:  0.08',
      '  Memory usage: 31%',
      '  Processes:    142',
      '',
      'Last login: Tue Aug 11 09:14:02 2026 from 10.0.0.4',
      '',
      'karn@prod-1:~$ systemctl is-active media',
      'active',
      '',
    ],
  },
  {
    key: 'pi-4/syslog',
    label: 'tail -f /var/log/syslog',
    cwd: '~',
    machine: 'pi-4',
    section: 'all',
    state: 'running',
    preview: [
      'Aug 11 09:12:03 pi-4 systemd[1]: Started flue daemon.',
      'Aug 11 09:12:03 pi-4 flue[612]: listening on 127.0.0.1:7717',
      'Aug 11 09:12:04 pi-4 flue[612]: relay dialled, 3 machines online',
      'Aug 11 09:41:19 pi-4 CRON[9033]: (karn) CMD (backup.sh)',
      'Aug 11 10:07:52 pi-4 flue[612]: session attached, device phone',
      'Aug 11 10:41:19 pi-4 CRON[9251]: (karn) CMD (backup.sh)',
      'Aug 11 11:07:55 pi-4 flue[612]: session detached, device phone',
      'Aug 11 11:41:19 pi-4 CRON[9412]: (karn) CMD (backup.sh)',
      '',
    ],
  },
  {
    key: 'vps/compose',
    label: 'docker compose up',
    cwd: '~/srv/media',
    machine: 'vps',
    section: 'all',
    state: 'exited',
    preview: [
      'media-1  | listening on :8096',
      'media-1  | library scan complete, 2411 items',
      '^C',
      'Gracefully stopping... (press Ctrl+C again to force)',
      ' Container media-1  Stopping',
      ' Container media-1  Stopped',
      ' Container media-1  Removed',
      '',
      'exit',
      '',
    ],
  },
]
