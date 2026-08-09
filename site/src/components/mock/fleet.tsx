import {
  ChevronDown,
  Globe,
  Lock,
  Plus,
  Search,
  Settings,
  SlidersHorizontal,
  Smartphone,
  SquareTerminal,
  Star,
} from 'lucide-react'

import { GROUPS } from '@/components/mock/data'
import { Mark } from '@/components/wordmark'
import { cn } from '@/lib/utils'

/**
 * flue's sessions screen, drawn.
 *
 * Not a screenshot: it themes with the page, stays crisp at any density, and
 * cannot rot into a picture of a version nobody ships. It is a drawing rather
 * than an import from web/ — those components need a protocol client, a
 * router and a live fleet behind them, none of which belongs on a landing
 * page — but the shape is the app's own: the inset sidebar, the panel that
 * floats on it, the page header with its one primary button, the saved-view
 * strip, and rows grouped with a running tally.
 */

const NAV: { icon: typeof Globe; label: string; active?: boolean }[] = [
  { icon: SquareTerminal, label: 'Sessions', active: true },
  { icon: Smartphone, label: 'Devices' },
  { icon: Globe, label: 'Remote access' },
  { icon: Settings, label: 'Settings' },
]

export function FleetWindow({ className }: { className?: string }) {
  return (
    <div
      /* A container, not a viewport consumer: the same window is dropped into
         hero columns of different widths, and what it can afford to show —
         sidebar, commands, paths — depends on the box it landed in rather
         than on the size of the screen. */
      className={cn(
        '@container overflow-hidden rounded-xl bg-zinc-50 shadow-2xl ring-1 ring-zinc-950/8 dark:bg-zinc-950 dark:shadow-none dark:ring-white/10',
        className,
      )}
    >
      <BrowserBar />
      {/* The sidebar surface is the gutter the content panel floats on — one
          step off the canvas in light, the canvas itself in dark, where the
          panel is the lighter of the two. */}
      <div className="flex gap-2 p-2">
        <Sidebar />
        <div className="min-w-0 flex-1 rounded-lg bg-white shadow-sm dark:bg-zinc-900 dark:shadow-none dark:inset-ring dark:inset-ring-white/5">
          <PanelHeader />
          <SessionList />
        </div>
      </div>
    </div>
  )
}

/* The address is half the argument: this tab is talking to loopback. */
function BrowserBar() {
  return (
    <div className="flex items-center gap-3 border-b border-zinc-950/8 px-3 py-2 dark:border-white/8">
      <span className="flex gap-1.5 @max-md:hidden" aria-hidden="true">
        <span className="size-2.5 rounded-full bg-zinc-950/15 dark:bg-white/15" />
        <span className="size-2.5 rounded-full bg-zinc-950/15 dark:bg-white/15" />
        <span className="size-2.5 rounded-full bg-zinc-950/15 dark:bg-white/15" />
      </span>
      <p className="mx-auto flex w-full max-w-56 items-center gap-1.5 rounded-md bg-zinc-950/5 px-2.5 py-1 font-mono text-xs text-muted-foreground dark:bg-white/5">
        <Lock className="size-3 shrink-0" aria-hidden="true" />
        127.0.0.1:7717
      </p>
      <span className="w-11 shrink-0 @max-md:hidden" aria-hidden="true" />
    </div>
  )
}

function Sidebar() {
  return (
    <div className="flex w-44 shrink-0 flex-col gap-1 @max-3xl:hidden">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <Mark className="size-4" />
        <span className="font-mono text-xs font-semibold">flue</span>
      </div>
      <nav className="flex flex-col gap-1">
        {NAV.map((item) => (
          <span
            key={item.label}
            className={cn(
              'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-xs font-medium',
              item.active
                ? 'bg-teal-500/10 text-teal-700 dark:text-teal-400'
                : 'text-muted-foreground',
            )}
          >
            <item.icon className="size-4 shrink-0" aria-hidden="true" />
            {item.label}
          </span>
        ))}
      </nav>
    </div>
  )
}

/** The header every management screen opens with: the h1, then the actions. */
function PanelHeader() {
  return (
    <div className="flex flex-col gap-3 px-4 pt-4 pb-3">
      <div className="flex items-center gap-2">
        <p className="text-base font-semibold tracking-tight">Sessions</p>
        <div className="ml-auto flex items-center gap-1.5">
          <span className="flex w-40 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground inset-ring inset-ring-zinc-950/10 @max-2xl:hidden dark:inset-ring-white/10">
            <Search className="size-3.5 shrink-0" aria-hidden="true" />
            Search sessions
          </span>
          <span className="rounded-md p-1.5 text-muted-foreground inset-ring inset-ring-zinc-950/10 @max-xl:hidden dark:inset-ring-white/10">
            <SlidersHorizontal className="size-3.5" aria-hidden="true" />
          </span>
          <span className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground">
            New session
          </span>
        </div>
      </div>

      {/* The saved-view strip: "All" is the absence of a saved view, so it has
          no ⋯ of its own, and the + is what gives the current cut a name. */}
      <div className="flex items-center gap-1">
        <span className="rounded-md bg-zinc-950/6 px-2 py-1 text-xs font-medium dark:bg-white/8">
          All
        </span>
        <span className="rounded-md px-2 py-1 text-xs text-muted-foreground">tagged</span>
        <span className="rounded-md px-2 py-1 text-xs text-muted-foreground">agents</span>
        <Plus className="ml-1 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      </div>
    </div>
  )
}

function SessionList() {
  return (
    <div className="flex flex-col gap-4 px-4 pb-4">
      {GROUPS.map((group) => (
        <section key={group.machine}>
          <p className="flex items-center gap-1.5 py-1">
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="text-xs font-medium">{group.machine}</span>
            <span className="text-xs text-muted-foreground">{group.tally}</span>
          </p>
          <ul role="list" className="flex flex-col">
            {group.sessions.map((session) => (
              <li
                key={session.name}
                className={cn(
                  'flex items-center gap-2 rounded-md py-1.5 pr-2 pl-3',
                  /* The row the phone beside this window is holding open. */
                  session.pinned && 'bg-teal-500/6 inset-ring inset-ring-teal-500/30',
                )}
              >
                {session.pinned ? (
                  <Star
                    className="size-3 shrink-0 fill-current text-muted-foreground"
                    aria-hidden="true"
                  />
                ) : (
                  <span className="size-3 shrink-0" aria-hidden="true" />
                )}
                <span
                  aria-hidden="true"
                  className={cn(
                    'size-1.5 shrink-0 rounded-full',
                    session.state === 'running'
                      ? 'bg-zinc-950 dark:bg-white'
                      : 'bg-zinc-950/30 dark:bg-white/30',
                  )}
                />
                <span className="min-w-0 truncate text-xs">{session.name}</span>
                <span className="truncate font-mono text-xs text-muted-foreground @max-2xl:hidden">
                  {session.command}
                </span>

                <span className="ml-auto flex shrink-0 items-center gap-2">
                  {session.tag && (
                    <span className="rounded bg-zinc-950/6 px-1.5 py-0.5 font-mono text-[0.625rem] text-muted-foreground @max-xl:hidden dark:bg-white/8">
                      {session.tag}
                    </span>
                  )}
                  <span className="font-mono text-xs text-muted-foreground @max-3xl:hidden">
                    {session.path}
                  </span>
                  <span className="text-xs tabular-nums text-muted-foreground">{session.age}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

/* The app's own key bar, in its own order: the keys a soft keyboard does not
   have. */
const KEYS = ['esc', 'tab', '←', '↓', '↑', '→']

/** The status bar's right cluster, drawn rather than written. */
function StatusIcons() {
  return (
    <span className="flex items-center gap-1" aria-hidden="true">
      {/* Signal: four bars, tallest last. */}
      <span className="flex items-end gap-px">
        <span className="h-1 w-0.5 rounded-xs bg-current" />
        <span className="h-1.5 w-0.5 rounded-xs bg-current" />
        <span className="h-2 w-0.5 rounded-xs bg-current" />
        <span className="h-2.5 w-0.5 rounded-xs bg-current" />
      </span>
      <svg viewBox="0 0 16 12" className="h-2.5 w-3.5 fill-current">
        <path d="M8 10.5 5.9 8.4a3 3 0 0 1 4.2 0L8 10.5Zm-4.2-4.2L2.4 4.9a8 8 0 0 1 11.2 0l-1.4 1.4a6 6 0 0 0-8.4 0Z" />
      </svg>
      {/* Battery: shell, cap, and a fill that stops short of full. */}
      <span className="flex items-center gap-px">
        <span className="relative h-2.5 w-5 rounded-[3px] ring-1 ring-current/50">
          <span className="absolute inset-[1.5px] right-1.5 rounded-[1px] bg-current" />
        </span>
        <span className="h-1 w-0.5 rounded-r-xs bg-current/50" />
      </span>
    </span>
  )
}

/**
 * The same session, on a phone.
 *
 * Two things this is careful to get right. It is a *browser* — there is no
 * flue app to install, so the phone is Safari with the web app in it, and
 * the address it is on is the relay the machine deployed rather than the
 * loopback address the window beside it shows. And it wears the page's
 * theme, chrome and terminal alike, because the app on a phone is the same
 * app that follows the system's light or dark setting anywhere else.
 *
 * It stretches to the window's height rather than sitting in a corner of it,
 * and the transcript grows into whatever height that turns out to be.
 */
export function PhoneFrame({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'flex w-60 shrink-0 flex-col rounded-[2.75rem] p-[3px] shadow-2xl',
        'bg-zinc-300 ring-1 ring-zinc-950/15',
        'dark:bg-zinc-800 dark:shadow-none dark:ring-white/15',
        className,
      )}
    >
      <div
        className={cn(
          'flex min-h-0 flex-1 flex-col overflow-hidden rounded-[2.625rem]',
          'bg-white ring-1 ring-zinc-950/10',
          'dark:bg-zinc-950 dark:ring-white/10',
        )}
      >
        {/* Status bar, with the island floating over it. The island is the
            one part that is black in both themes — it is a cutout, not a
            surface. */}
        <div className="relative flex shrink-0 items-center justify-between px-4 pt-3.5 pb-2.5 text-foreground">
          <span className="font-mono text-[0.6875rem] font-medium tabular-nums">9:41</span>
          {/* The island is a cutout, so it is black in both themes — and it is
              sized to leave real air on both sides of it rather than crowding
              the clock and the status cluster. */}
          <span
            aria-hidden="true"
            className="absolute top-2.5 left-1/2 flex h-5 w-16 -translate-x-1/2 items-center justify-end rounded-full bg-zinc-600 pr-1.5 dark:bg-black"
          >
            <span className="size-1.5 rounded-full bg-zinc-700 dark:bg-zinc-900" />
          </span>
          <StatusIcons />
        </div>

        {/* Safari. The address is the relay this machine deployed — the
            window beside it is on loopback, and that difference is the whole
            remote-access story. */}
        <div className="shrink-0 px-3 pb-2">
          <p className="flex items-center gap-1.5 rounded-lg bg-zinc-950/6 px-2.5 py-1 dark:bg-white/8">
            <Lock className="size-2.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="truncate font-mono text-[0.625rem] text-muted-foreground">
              flue-relay.you.workers.dev
            </span>
          </p>
        </div>

        {/* The session's own header, as the app draws it. */}
        <div className="flex shrink-0 items-center gap-1.5 border-t border-border px-4 py-2">
          <span
            aria-hidden="true"
            className="size-1.5 shrink-0 rounded-full bg-zinc-950 dark:bg-white"
          />
          <p className="truncate text-[0.6875rem] font-medium">claude — relay handshake</p>
          <span className="ml-auto shrink-0 font-mono text-[0.625rem] text-muted-foreground">
            macbook
          </span>
        </div>

        {/* The terminal, wearing the theme the emulator resolves from the
            system. Hugs the bottom, so the newest line sits above the keys. */}
        <div
          className={cn(
            'flex min-h-0 flex-1 flex-col justify-end overflow-hidden px-4 py-3',
            'font-mono text-[0.6875rem]/5',
            'bg-zinc-50 text-zinc-800 dark:bg-zinc-950 dark:text-zinc-300',
          )}
        >
          <p className="text-pretty text-muted-foreground">
            Read relay/handshake.go, relay/reaper.go and the two tests around them.
          </p>
          <p className="mt-2.5 text-pretty text-muted-foreground">
            Handshake fails when the reaper fires mid-pairing. The pairing side never sees the
            ack. Add the guard?
          </p>
          <p className="mt-2.5 text-pretty">
            <span className="text-teal-600 dark:text-teal-400">&gt; </span>yes, with a test
          </p>
          <p className="mt-2.5 text-pretty text-muted-foreground">
            Added TestReaperSkipsPairing. Running it now.
          </p>
          <p className="mt-2.5 whitespace-pre">
            <span className="text-teal-600 dark:text-teal-400">$ </span>
            <span className="term-cursor bg-teal-600 dark:bg-teal-400" aria-hidden="true" />
          </p>
        </div>

        {/* The key bar wears the terminal's theme too, then the home
            indicator under it. */}
        <div className="shrink-0 border-t border-border bg-zinc-100 px-2 pt-2 pb-2 dark:bg-black">
          <div className="flex justify-between gap-1">
            {KEYS.map((key) => (
              <span
                key={key}
                className="rounded-md bg-zinc-950/8 px-2 py-1.5 font-mono text-[0.625rem] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
              >
                {key}
              </span>
            ))}
          </div>
          <span
            aria-hidden="true"
            className="mx-auto mt-2 mb-1 block h-1 w-24 rounded-full bg-zinc-950/40 dark:bg-white/40"
          />
        </div>
      </div>
    </div>
  )
}
