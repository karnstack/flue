import { tokenizePeek, type PeekToken } from './tokenize'

/*
 * The whole worker: one ask in, one answer out, correlated by id. Tokenizing
 * runs here so a large file colours without stealing frames from the
 * terminal it is drawn over.
 */

export interface HighlightAsk {
  id: number
  text: string
  lang: string
}

export interface HighlightAnswer {
  id: number
  lines: PeekToken[][] | null
}

self.onmessage = (e: MessageEvent<HighlightAsk>) => {
  const { id, text, lang } = e.data
  tokenizePeek(text, lang).then(
    (lines) => self.postMessage({ id, lines } satisfies HighlightAnswer),
    () => self.postMessage({ id, lines: null } satisfies HighlightAnswer),
  )
}
