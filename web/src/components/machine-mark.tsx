import { CloudIcon, ComputerDesktopIcon } from '@heroicons/react/16/solid'

import { cn } from '@/lib/utils'

/**
 * The two words a machine mark can say, spelled once because three screens
 * say them: the sessions list on its headings, the same list on every row's
 * machine badge, and the terminal's own corner chip. A pair of glyphs that
 * meant one thing on one screen and another elsewhere would teach nobody
 * anything.
 */
export const THIS_MACHINE_LABEL = 'This machine'
export const RELAY_MACHINE_LABEL = 'Machine reached over the relay'

/**
 * Which kind of machine this is: the one the browser is running on, or one
 * reached the long way round.
 *
 * The question it answers is not "which machine" — the name beside it already
 * does that — but "is that name the box in front of me". Machines are named
 * after their hostnames by default (the join line takes `os.Hostname`), and a
 * hostname is exactly the kind of string nobody has memorised.
 *
 * The glyphs are the two the app already uses for these facts: a desktop for
 * the local machine, and the cloud that stands for Cloudflare everywhere else
 * in this UI — remote access is a Worker on the reader's own account, so a
 * session on another machine really is reached through it. The cloud keeps
 * Cloudflare's orange, as it does on the Remote access screen. The desktop
 * takes whatever colour it lands in, because the ordinary case should not
 * shout and because this mark rides two very different grounds: a muted badge
 * on the sessions list, and a translucent chip over a terminal.
 *
 * `home` is the caller's judgement, never derived here. Only the route knows
 * whether this page came off the daemon's own origin — a relay tab reaches
 * every machine on the fleet, including the one it rides, over the relay.
 */
export function MachineMark({ home, className }: { home: boolean; className?: string }) {
  const Icon = home ? ComputerDesktopIcon : CloudIcon
  const label = home ? THIS_MACHINE_LABEL : RELAY_MACHINE_LABEL
  return (
    // A labelled image rather than a decorative one: the glyph carries a fact
    // no text beside it repeats, so dropping it from the accessibility tree
    // would drop the fact. Same treatment the pinned star gets.
    <span role="img" aria-label={label} title={label} className={cn('flex shrink-0', className)}>
      <Icon aria-hidden="true" className={cn('size-3.5', !home && 'text-[#f6821f]')} />
    </span>
  )
}
