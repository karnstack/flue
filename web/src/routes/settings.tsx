import {
  BellAlertIcon,
  CommandLineIcon,
  KeyIcon,
  PaintBrushIcon,
  SwatchIcon,
  UserGroupIcon,
} from '@heroicons/react/16/solid'

import { PageHeader } from '@/components/page-header'
import { cn } from '@/lib/utils'

/*
 * The screen's shared class strings, spelled out rather than assembled: every
 * token has to stay hyphenated for styles.build.test.ts to find it inside a
 * `className`, which is also why this is not pasted together from parts.
 */
const PROSE = 'text-base/7 text-pretty text-zinc-600 sm:text-sm/6 dark:text-zinc-400'

/**
 * What settings will hold, named and dated as honestly as a roadmap can be.
 *
 * This screen was a bare heading over one sentence promising that settings
 * "arrive with the next build step" — which was true, said nothing about
 * *what* would arrive, and left the fourth item in the sidebar as the one that
 * does nothing. Naming the list costs nothing and is worth more than the
 * sentence: a reader who came here looking for a scrollback setting learns
 * that it is coming rather than that they missed it, and one who came looking
 * for something not on this list learns that it is not planned, which is the
 * thing a roadmap is actually for.
 *
 * Each entry names something a person would come here to change, not a
 * component somebody intends to build. The list is short on purpose; a
 * settings screen padded out to look busy is how settings screens become
 * places nothing can be found.
 */
const PLANNED = [
  {
    icon: CommandLineIcon,
    title: 'Terminal',
    blurb:
      'How much scrollback a session keeps, whether the cursor blinks, and the font the emulator draws with.',
  },
  {
    icon: KeyIcon,
    title: 'Keyboard',
    blurb:
      'Rebind the shortcuts, and choose which keys the mobile key bar carries — today it ships one fixed row.',
  },
  {
    icon: SwatchIcon,
    title: 'Terminal theme',
    blurb:
      'Pick the sixteen colours a session is drawn in. The app chrome follows the system light or dark setting and will keep doing so.',
  },
  {
    icon: PaintBrushIcon,
    title: 'Appearance',
    blurb: 'Row density, and whether a hovered session shows a preview of what it is doing.',
  },
  {
    icon: BellAlertIcon,
    title: 'Notifications',
    blurb:
      'Be told when a long command finishes or a session exits non-zero, on the device you are holding rather than the one it ran on.',
  },
  {
    icon: UserGroupIcon,
    title: 'Machines',
    blurb:
      'Rename the machines in your fleet and reorder them, without editing relay.json by hand.',
  },
] as const

/**
 * Settings, which is a plan rather than a screen.
 *
 * Nothing here is interactive, and nothing pretends to be: there are no dimmed
 * toggles and no fields that refuse to save. A control that looks operable and
 * is not is worse than no control, because the reader spends a click and a
 * moment of doubt finding out. What is on the page is a list of subjects and
 * one badge saying they are not here yet.
 */
export function SettingsRoute() {
  return (
    /*
      Capped and centred, at the same 3xl Devices and Remote use. Everything
      on this page is a line of text, so without a cap the rows keep their
      hover band all the way to the right edge of a wide display — a highlight
      three times the width of the words in it, moving under a pointer that is
      nowhere near them.
    */
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-y-6 p-4 sm:p-6 lg:p-8">
      <PageHeader crumbs={[{ label: 'Settings' }]}>
        <p className={cn(PROSE, 'max-w-[65ch]')}>
          flue keeps almost nothing configurable on purpose — the defaults are the product. These
          are the few things worth a switch, and none of them is here yet.
        </p>
      </PageHeader>

      <ul className="flex flex-col">
        {PLANNED.map(({ icon: Icon, title, blurb }) => (
          <li
            key={title}
            className="flex items-start gap-x-3 rounded-md px-2 py-2.5 transition-colors hover:bg-row-hover"
          >
            <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-zinc-950/5 dark:bg-white/5">
              <Icon aria-hidden="true" className="size-3.5 text-zinc-500 dark:text-zinc-400" />
            </span>
            <div className="flex min-w-0 flex-col gap-y-0.5">
              {/*
                No "Coming soon" badge, and there was one on every row here.
                A badge earns its place by telling rows apart, which needs at
                least two kinds of row; when every entry carries it the badge
                distinguishes nothing and six of them is just six more things
                to read past. The sentence above the list already says none of
                these has shipped. Put the badge back the day one of them
                does, when the list becomes mixed and the label starts
                answering a question.
              */}
              <span className="text-base/6 font-medium text-zinc-950 sm:text-control dark:text-white">
                {title}
              </span>
              {/*
                A step down from the page's own paragraph, and below the title
                beside it rather than above: at PROSE's 14px the explanation
                came out larger than the thing it explains, which reads as a
                list of paragraphs with labels rather than a list of subjects.
              */}
              <p className={cn(PROSE, 'max-w-[60ch] sm:text-control')}>{blurb}</p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
