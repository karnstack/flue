import type { HighlighterCore, LanguageInput } from 'shiki/core'

/*
 * Tokenizing for the file viewer, capped and themed both ways.
 *
 * Everything shiki is imported dynamically in here, and this module itself is
 * only ever loaded on demand — by the worker, or by the façade's same-thread
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

// The caps live in caps.ts so the viewer can consult them without loading a
// byte of shiki; re-exported here because they are part of this contract.
export { HIGHLIGHT_MAX_BYTES, HIGHLIGHT_MAX_LINES } from './caps'
import { HIGHLIGHT_MAX_BYTES, HIGHLIGHT_MAX_LINES } from './caps'

const THEME_LIGHT = 'min-light'
const THEME_DARK = 'min-dark'

/**
 * The grammars this viewer can load, spelled out one dynamic import each
 * rather than through shiki's bundled-languages registry: the registry names
 * every grammar it knows, which would emit two hundred chunks the build must
 * carry and lang.ts can never ask for. `hasGrammar` and the cross-check test
 * keep this list and lang.ts agreeing.
 */
const GRAMMARS: Record<string, LanguageInput> = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsonc: () => import('shiki/langs/jsonc.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  proto: () => import('shiki/langs/proto.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  svelte: () => import('shiki/langs/svelte.mjs'),
  lua: () => import('shiki/langs/lua.mjs'),
  zig: () => import('shiki/langs/zig.mjs'),
  graphql: () => import('shiki/langs/graphql.mjs'),
  docker: () => import('shiki/langs/docker.mjs'),
  make: () => import('shiki/langs/make.mjs'),
}

export function hasGrammar(lang: string): boolean {
  return GRAMMARS[lang] !== undefined
}

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
    const grammar = GRAMMARS[lang]
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
