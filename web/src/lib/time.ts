/*
 * Time as a screen tells it: coarse, past-tense, and honest about skew.
 *
 * Lifted out of the devices screen once the sessions list wanted the same
 * words, so that "5m ago" cannot drift into "5 min ago" between two screens
 * describing the same instant.
 */

const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * How long ago, in the coarsest unit that still says something.
 *
 * `seen` is unix seconds, as `wire.DeviceInfo` reports both of its stamps —
 * multiplying rather than dividing there would put every device three thousand
 * years in the future and read "just now" forever. A caller holding an ISO
 * stamp divides `Date.parse` by a thousand on its way in.
 *
 * The clamp is for clock skew between two machines: a stamp a few seconds
 * ahead of this one's clock is ordinary, and "-2m ago" is not a sentence.
 */
export function ago(seen: number, now: number = Date.now()): string {
  const secs = Math.max(0, Math.round(now / 1000 - seen))
  if (secs < MINUTE) return 'just now'
  if (secs < HOUR) return `${Math.floor(secs / MINUTE)}m ago`
  if (secs < DAY) return `${Math.floor(secs / HOUR)}h ago`
  return `${Math.floor(secs / DAY)}d ago`
}
