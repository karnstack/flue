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
  pinned?: boolean
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
        name: 'claude — relay handshake',
        command: '/bin/zsh -l',
        path: '~/code/flue',
        age: '2m ago',
        state: 'running',
        tag: 'agent',
        pinned: true,
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
