import { marked } from 'marked'

import development from '../../../docs/DEVELOPMENT.md?raw'
import faq from '../../../docs/faq.md?raw'
import relay from '../../../docs/RELAY.md?raw'

import { REPO_URL } from './site'

/**
 * The docs flue.sh publishes, rendered from the repository's own markdown.
 *
 * They are imported rather than retyped. These files are the documents a
 * contributor reads in the tree and a maintainer edits when the behaviour
 * changes; a second copy written for the website would be wrong within a
 * release, and the wrong copy would be the one the public reads. Rendering
 * happens at build time — the routes are prerendered — so nothing here ships
 * to a browser.
 */

export type DocSlug = 'faq' | 'relay' | 'developing'

type Doc = {
  slug: DocSlug
  /** The nav label. The markdown's own H1 is dropped in favour of this. */
  title: string
  /** One line, for the docs index and the page's lede. */
  blurb: string
  source: string
  /** Where the file lives, so a reader can go and change it. */
  path: string
}

export const DOCS: Doc[] = [
  {
    slug: 'faq',
    title: 'FAQ',
    blurb:
      'What the end-to-end encryption does and does not protect, said plainly — including the part it cannot fix.',
    source: faq,
    path: 'docs/faq.md',
  },
  {
    slug: 'relay',
    title: 'Remote access: the relay',
    blurb:
      'The protocol in one page, what the Worker costs, what bounds abuse, and the manual end-to-end a human runs before a release.',
    source: relay,
    path: 'docs/RELAY.md',
  },
  {
    slug: 'developing',
    title: 'Developing flue',
    blurb: 'The dev loop, the dev/prod split, and working on the relay.',
    source: development,
    path: 'docs/DEVELOPMENT.md',
  },
]

export function findDoc(slug: string): Doc | undefined {
  return DOCS.find((doc) => doc.slug === slug)
}

/** Which repo-relative markdown paths have a page of their own here. */
const ROUTED: Record<string, DocSlug> = {
  'faq.md': 'faq',
  'RELAY.md': 'relay',
  'DEVELOPMENT.md': 'developing',
}

/**
 * Rewrite one link from a document written to be read inside the repository.
 *
 * Three cases. A sibling document that has a page here becomes that page, so
 * the reader stays on the site. Anything else in the tree becomes a link into
 * GitHub, because the file is real and the reader should be able to reach it.
 * Absolute URLs and same-page anchors are already correct and are left alone.
 */
function rewriteHref(href: string): string {
  if (/^[a-z]+:/i.test(href) || href.startsWith('#') || href.startsWith('/')) return href

  // Strip the `../` a doc uses to climb out of docs/, and remember it climbed:
  // that is how `../spec/relay-protocol.md` is told from `faq.md`.
  const climbed = href.startsWith('../')
  const clean = href.replace(/^(\.\/|\.\.\/)+/, '')
  const [path, hash = ''] = clean.split('#')

  if (!climbed) {
    const slug = ROUTED[path ?? '']
    if (slug) return `/docs/${slug}${hash ? `#${hash}` : ''}`
  }

  const repoPath = climbed ? path : `docs/${path}`
  return `${REPO_URL}/blob/main/${repoPath}${hash ? `#${hash}` : ''}`
}

/** GitHub's own heading slugs, so in-document anchors keep working. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
}

/**
 * Markdown to HTML, with the document's own H1 dropped — the page renders a
 * heading of its own from the title above, and two would be one too many.
 */
export function renderDoc(doc: Doc): string {
  const renderer = new marked.Renderer()

  renderer.link = ({ href, title, tokens }) => {
    const text = renderer.parser.parseInline(tokens)
    const attrs = [`href="${rewriteHref(href)}"`]
    if (title) attrs.push(`title="${title}"`)
    if (/^[a-z]+:/i.test(href)) attrs.push('target="_blank"', 'rel="noreferrer"')
    return `<a ${attrs.join(' ')}>${text}</a>`
  }

  renderer.heading = ({ tokens, depth }) => {
    const text = renderer.parser.parseInline(tokens)
    if (depth === 1) return ''
    const id = slugify(renderer.parser.parseInline(tokens, renderer.parser.textRenderer))
    return `<h${depth} id="${id}">${text}</h${depth}>`
  }

  return marked.parse(doc.source, { renderer, async: false })
}
