import type { PeekToken } from './tokenize'
import type { HighlightAnswer } from './highlight.worker'

/*
 * The viewer's one question: colour this text, or say you cannot.
 *
 * Where module workers exist the tokenizing runs in one, off the thread the
 * terminal is painting on; where they do not (jsdom, and any browser without
 * them) the same code runs on the calling thread instead. Either way the
 * shiki chunks load on the first file of a given language and never ride the
 * main bundle. Every failure — a worker that dies, a grammar that will not
 * load, an ask that outlives its deadline — answers null, because plain text
 * is what the viewer was showing anyway.
 *
 * The deadline is not a nicety. File bytes are attacker-influenced, the
 * grammars run on a native regex engine whose single exec cannot be
 * interrupted, and the worker is a shared singleton: one catastrophic
 * backtracking would otherwise wedge it forever and queue every later ask
 * behind the wedge. Past the deadline the worker is terminated outright,
 * every open ask answers null, and the next ask builds a fresh one.
 */

const HIGHLIGHT_TIMEOUT_MS = 10_000

let worker: Worker | null = null
let nextAsk = 1
const waiting = new Map<
  number,
  { settle: (lines: PeekToken[][] | null) => void; deadline: ReturnType<typeof setTimeout> }
>()

/** Every open ask answers plain, and the singleton is gone; the next ask
 * starts over rather than leaning on a corpse. */
function collapse() {
  const open = [...waiting.values()]
  waiting.clear()
  worker?.terminate()
  worker = null
  for (const w of open) {
    clearTimeout(w.deadline)
    w.settle(null)
  }
}

function workerFor(): Worker | null {
  if (typeof Worker === 'undefined') return null
  if (worker !== null) return worker
  try {
    worker = new Worker(new URL('./highlight.worker.ts', import.meta.url), { type: 'module' })
  } catch {
    return null
  }
  worker.onmessage = (e: MessageEvent<HighlightAnswer>) => {
    const ask = waiting.get(e.data.id)
    if (ask === undefined) return
    waiting.delete(e.data.id)
    clearTimeout(ask.deadline)
    ask.settle(e.data.lines)
  }
  worker.onerror = collapse
  worker.onmessageerror = collapse
  return worker
}

export async function highlight(text: string, lang: string | null): Promise<PeekToken[][] | null> {
  if (lang === null) return null
  const w = workerFor()
  if (w === null) {
    const { tokenizePeek } = await import('./tokenize')
    return tokenizePeek(text, lang)
  }
  return new Promise((resolve) => {
    const id = nextAsk++
    const deadline = setTimeout(collapse, HIGHLIGHT_TIMEOUT_MS)
    waiting.set(id, { settle: resolve, deadline })
    w.postMessage({ id, text, lang })
  })
}
