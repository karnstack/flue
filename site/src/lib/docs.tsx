import type { ReactNode } from 'react'

/**
 * The documents flue.sh publishes, written for the web rather than pulled
 * from the repository's markdown.
 *
 * These are the reader-facing versions: short answers, drawn diagrams, and
 * only the depth a visitor wants. The operator-grade detail stays in the
 * repository, and each page links to it. An agent reading the site is served
 * by /llms.txt, which is why nothing here has to double as machine-readable
 * plain text.
 */

export type DocSlug = 'how-it-works' | 'relay' | 'faq'

export type Doc = {
  slug: DocSlug
  /** Nav label, short enough for a footer. */
  label: string
  title: string
  blurb: string
}

export const DOCS: Doc[] = [
  {
    slug: 'how-it-works',
    label: 'How it works',
    title: 'How flue works',
    blurb:
      'A daemon owns the shells. A tab renders them. What that buys you, and what it costs.',
  },
  {
    slug: 'relay',
    label: 'Remote access',
    title: 'Remote access',
    blurb:
      'How a machine becomes reachable from anywhere, on infrastructure you own, in one command.',
  },
  {
    slug: 'faq',
    label: 'FAQ',
    title: 'Questions worth a straight answer',
    blurb:
      'Including the one where the honest answer is not the flattering one.',
  },
]

export function findDoc(slug: string): Doc | undefined {
  return DOCS.find((doc) => doc.slug === slug)
}

/** A question and its answer. The verdict leads; the reasoning follows. */
export type QA = {
  q: string
  /** One line. Bolded on the page, because it is the whole answer for most readers. */
  verdict: string
  body?: ReactNode
}
