import { createElement, type ReactNode } from 'react'
import Markdown, { type Components } from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'

import { cn } from '@/lib/utils'

/*
 * Rendered markdown for the file viewer.
 *
 * react-markdown builds React elements and nothing else — no innerHTML
 * anywhere. HTML written into the file (README badge preambles, centred
 * heroes) is parsed by rehype-raw and then cut to rehype-sanitize's GitHub
 * schema, so scripts, event handlers, and javascript: URLs never survive to
 * the element tree. On top of that sit this file's own guards: links follow
 * the openTerminalLink rule — http(s) or nothing — and an image renders as
 * its alt text, because a relative source has no origin to load from and
 * the CSP would refuse a remote one anyway.
 */

/**
 * The name of the grid-of-rows element, assembled at runtime: written out it
 * is also a Tailwind utility name, and the prose scanner compiles any bare
 * utility word it sees in a scanned source. See the notes atop styles.css.
 */
const GRID_TAG = 'tab' + 'le'

const external = (href: string | undefined): href is string =>
  href !== undefined && /^https?:\/\//i.test(href)

const parts: Components = {
  h1: ({ children }) => <h1 className="mt-6 mb-3 font-heading text-xl font-semibold first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-5 mb-2 font-heading text-lg font-semibold first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-4 mb-2 font-heading text-base font-semibold first:mt-0">{children}</h3>,
  h4: ({ children }) => <h4 className="mt-4 mb-1 font-heading text-sm font-semibold first:mt-0">{children}</h4>,
  h5: ({ children }) => <h5 className="mt-3 mb-1 font-heading text-sm font-medium first:mt-0">{children}</h5>,
  h6: ({ children }) => <h6 className="mt-3 mb-1 text-sm font-medium text-muted-foreground first:mt-0">{children}</h6>,
  p: ({ children }) => <p className="my-2.5 leading-6">{children}</p>,
  ul: ({ children }) => <ul className="my-2.5 list-disc space-y-1 pl-6">{children}</ul>,
  ol: ({ children }) => <ol className="my-2.5 list-decimal space-y-1 pl-6">{children}</ol>,
  li: ({ children }) => <li className="leading-6">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-2 border-hairline pl-3 text-muted-foreground">{children}</blockquote>
  ),
  hr: () => <hr className="my-4 border-hairline" />,
  pre: ({ children }) => (
    <pre className="my-3 overflow-x-auto rounded-md bg-muted/60 px-3 py-2 text-[12.5px] leading-5 ring-1 ring-hairline">
      {children}
    </pre>
  ),
  code: ({ children, className }) => (
    <code
      className={cn(
        'font-mono',
        // No language class means a span in running text rather than the
        // body of a fence, so it gets its own chip look.
        className === undefined && 'rounded-sm bg-muted/60 px-1 py-0.5 text-[0.85em]',
        className,
      )}
    >
      {children}
    </code>
  ),
  a: ({ children, href }) =>
    external(href) ? (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className="text-accent-fg hover:opacity-80"
      >
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: ({ alt }) => <span className="text-muted-foreground italic">[{alt !== undefined && alt !== '' ? alt : 'image'}]</span>,
  [GRID_TAG]: ({ children }: { children?: ReactNode }) =>
    createElement(
      GRID_TAG,
      { className: 'my-3 w-full border-separate border-spacing-0 text-left text-sm' },
      children,
    ),
  th: ({ children }) => (
    <th className="border-b border-hairline px-2 py-1 font-medium text-muted-foreground">{children}</th>
  ),
  td: ({ children }) => <td className="border-b border-hairline px-2 py-1 align-top">{children}</td>,
} as Components

export function MarkdownView({ text }: { text: string }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      // Order is the contract: raw turns HTML text into nodes, sanitize
      // prunes those nodes, and only then does the component map render.
      rehypePlugins={[rehypeRaw, rehypeSanitize]}
      components={parts}
    >
      {text}
    </Markdown>
  )
}
