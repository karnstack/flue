import type { HighlighterCore } from 'shiki/core'

/*
 * Tokenizing for the file viewer, capped and themed both ways.
 *
 * Everything shiki is imported dynamically in here, and this module itself is
 * only ever loaded on demand — by the worker, or by the façade's inline
 * fallback — so the main bundle carries none of it. The engine is the
 * JavaScript one on purpose: the daemon serves its UI under script-src 'self'
 * and Chrome refuses to compile WebAssembly under that policy, and widening a
 * policy that exists to stop injected script in order to colour keywords is
 * the wrong trade.
 */

export interface PeekToken {
  text: string
  light?: string
  dark?: string
}

/**
 * Past either cap the answer is null and the viewer keeps its plain rows.
 * The size cap is measured in UTF-16 units, a close proxy for bytes in the
 * code this exists for and always within 2x of the truth.
 */
export const HIGHLIGHT_MAX_BYTES = 1 << 20
export const HIGHLIGHT_MAX_LINES = 20_000

const THEME_LIGHT = 'min-light'
const THEME_DARK = 'min-dark'

let corePromise: Promise<HighlighterCore> | null = null
const loadedLangs = new Set<string>()

function core(): Promise<HighlighterCore> {
  corePromise ??= (async () => {
    const [shiki, engine, light, dark] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
      import('shiki/themes/min-light.mjs'),
      import('shiki/themes/min-dark.mjs'),
    ])
    return shiki.createHighlighterCore({
      themes: [light.default, dark.default],
      langs: [],
      engine: engine.createJavaScriptRegexEngine(),
    })
  })()
  return corePromise
}

export async function tokenizePeek(text: string, lang: string): Promise<PeekToken[][] | null> {
  if (text.length > HIGHLIGHT_MAX_BYTES) return null
  let lines = 1
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) {
    lines++
    if (lines > HIGHLIGHT_MAX_LINES) return null
  }
  try {
    const { bundledLanguages } = await import('shiki/langs')
    const grammar = bundledLanguages[lang as keyof typeof bundledLanguages]
    if (grammar === undefined) return null
    const hl = await core()
    if (!loadedLangs.has(lang)) {
      await hl.loadLanguage(grammar)
      loadedLangs.add(lang)
    }
    const out = hl.codeToTokens(text, {
      lang,
      themes: { light: THEME_LIGHT, dark: THEME_DARK },
      defaultColor: false,
    })
    return out.tokens.map((row) =>
      row.map((t) => {
        const style = (t.htmlStyle ?? {}) as Record<string, string>
        return { text: t.content, light: style['--shiki-light'], dark: style['--shiki-dark'] }
      }),
    )
  } catch {
    // A grammar that fails to load or to run is not an error worth surfacing;
    // plain text is what the viewer showed anyway.
    return null
  }
}
