import type { PeekToken } from './tokenize'
import type { HighlightAnswer } from './highlight.worker'

/*
 * The viewer's one question: colour this text, or say you cannot.
 *
 * Where module workers exist the tokenizing runs in one, off the thread the
 * terminal is painting on; where they do not (jsdom, and any browser without
 * them) the same code runs inline via dynamic import. Either way the shiki
 * chunks load on the first file of a given language and never ride the main
 * bundle. Every failure — a worker that dies, a grammar that will not load —
 * answers null, because plain text is what the viewer was showing anyway.
 */

let worker: Worker | null = null
let nextAsk = 1
const waiting = new Map<number, (lines: PeekToken[][] | null) => void>()

function workerFor(): Worker | null {
  if (typeof Worker === 'undefined') return null
  if (worker !== null) return worker
  try {
    worker = new Worker(new URL('./highlight.worker.ts', import.meta.url), { type: 'module' })
  } catch {
    return null
  }
  worker.onmessage = (e: MessageEvent<HighlightAnswer>) => {
    const settle = waiting.get(e.data.id)
    if (settle === undefined) return
    waiting.delete(e.data.id)
    settle(e.data.lines)
  }
  worker.onerror = () => {
    // The worker is gone; every open ask answers plain, and the next call
    // builds a fresh one rather than leaning on a corpse.
    const open = [...waiting.values()]
    waiting.clear()
    worker?.terminate()
    worker = null
    for (const settle of open) settle(null)
  }
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
    waiting.set(id, resolve)
    w.postMessage({ id, text, lang })
  })
}
