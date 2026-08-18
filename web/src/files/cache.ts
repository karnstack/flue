import type { FileMsg } from '@/client/protocol'

/*
 * Reopening a file the viewer just closed should cost nothing, and closing
 * the tab should cost the memory back.
 *
 * In memory only, on purpose: file bytes sitting on a paired phone's disk
 * is a durability question this feature has no reason to open, which is why
 * this is not IndexedDB. Keyed by the client object — the machine identity a
 * viewer already holds — inside a WeakMap, so a closed connection's entries
 * fall to the collector with it. Validity is the caller's check, against a
 * fresh stat: same size, same mtime, same bytes.
 */

export interface CachedFile {
  meta: FileMsg
  /** From the stat taken when the entry was stored; unix seconds, 0 possible. */
  mtime: number
  bytes: Uint8Array
}

export const CACHE_MAX_BYTES = 8 << 20
export const CACHE_ENTRY_MAX = 4 << 20

const byClient = new WeakMap<object, Map<string, CachedFile>>()
/**
 * Recency, oldest first, across every client. Weak references, and that is
 * load-bearing: the WeakMap above only lets a closed connection's entries
 * collect if nothing else holds its map, and a strong ref here would pin up
 * to the whole budget of a dead client's bytes while they evicted the
 * living. A collected map's entries are settled up on the next touch.
 */
let order: Array<{ files: WeakRef<Map<string, CachedFile>>; path: string; size: number }> = []
let total = 0

function compact(): void {
  const live: typeof order = []
  for (const o of order) {
    if (o.files.deref() === undefined) total -= o.size
    else live.push(o)
  }
  order = live
}

export function cachedFile(client: object, path: string): CachedFile | null {
  const files = byClient.get(client)
  const held = files?.get(path)
  if (files === undefined || held === undefined) return null
  const at = order.findIndex((o) => o.files.deref() === files && o.path === path)
  if (at !== -1) order.push(...order.splice(at, 1))
  return held
}

export function rememberFile(client: object, path: string, entry: CachedFile): void {
  if (entry.bytes.length > CACHE_ENTRY_MAX) return
  compact()
  let files = byClient.get(client)
  if (files === undefined) {
    files = new Map()
    byClient.set(client, files)
  }
  if (files.has(path)) {
    const at = order.findIndex((o) => o.files.deref() === files && o.path === path)
    if (at !== -1) {
      total -= order[at]!.size
      order.splice(at, 1)
    }
  }
  files.set(path, entry)
  order.push({ files: new WeakRef(files), path, size: entry.bytes.length })
  total += entry.bytes.length
  while (total > CACHE_MAX_BYTES && order.length > 1) {
    const oldest = order.shift()!
    oldest.files.deref()?.delete(oldest.path)
    total -= oldest.size
  }
}
