import type { PathEntry } from '@/client/protocol'
import type { LinkCandidate, LinkDetector } from '@/emulator/types'
import { findPaths } from '@/lib/paths'

/*
 * The judgement half of link detection: what counts as a candidate, whether
 * the daemon vouches for it, and what a click does. One of these exists per
 * mounted terminal, so the cache's lifetime is the view's.
 */

/**
 * How long a verification answer stands. Asymmetric on purpose: an agent
 * announces a file moments before writing it, and a long negative memory
 * would keep that path dead long after it turned real. A hit can afford to
 * linger — files a session names rarely vanish within the minute.
 */
export const VERIFY_HIT_MS = 30_000
export const VERIFY_MISS_MS = 2_000

/** Answers held at most; oldest fall out first. A hover asks about a line. */
const CACHE_CAP = 600

/** The protocol's ceiling on paths in one stat; a longer line asks twice. */
const STAT_BATCH = 32

export interface DetectorDeps {
  stat(paths: string[]): Promise<PathEntry[]>
  open(candidate: LinkCandidate): void
  /** The clock, injectable so tests can hold it still. */
  now?(): number
}

export function createPathDetector(deps: DetectorDeps): LinkDetector {
  const now = deps.now ?? Date.now
  const held = new Map<string, { yes: boolean; until: number }>()
  const remember = (path: string, yes: boolean) => {
    if (held.size >= CACHE_CAP) {
      for (const oldest of held.keys()) {
        held.delete(oldest)
        if (held.size < CACHE_CAP) break
      }
    }
    held.set(path, { yes, until: now() + (yes ? VERIFY_HIT_MS : VERIFY_MISS_MS) })
  }
  return {
    find: findPaths,
    open: deps.open,
    async verify(paths) {
      const t = now()
      const answers = new Map<string, boolean>()
      const unknown: string[] = []
      for (const p of paths) {
        const kept = held.get(p)
        if (kept !== undefined && kept.until > t) answers.set(p, kept.yes)
        else if (!answers.has(p) && !unknown.includes(p)) unknown.push(p)
      }
      for (let at = 0; at < unknown.length; at += STAT_BATCH) {
        const batch = unknown.slice(at, at + STAT_BATCH)
        try {
          const entries = await deps.stat(batch)
          for (let i = 0; i < batch.length; i++) {
            // Only a plain file decorates. A directory exists and still
            // refuses to open — an invitation to a click that can only fail.
            const yes = entries[i]?.exists === true && entries[i]?.kind === 'file'
            answers.set(batch[i]!, yes)
            remember(batch[i]!, yes)
          }
        } catch {
          // The daemon is unreachable or refused the batch. Nothing
          // decorates and nothing is remembered; the next hover asks again.
          for (const p of batch) answers.set(p, false)
        }
      }
      return paths.map((p) => answers.get(p) === true)
    },
  }
}
