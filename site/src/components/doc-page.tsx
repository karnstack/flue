import { ArrowLeft, ArrowRight } from 'lucide-react'
import type { ReactNode } from 'react'

import { SiteFooter } from '@/components/site-footer'
import { SiteHeader } from '@/components/site-header'
import { DOCS, type DocSlug } from '@/lib/docs'
import { cn } from '@/lib/utils'

/** The shell every document shares: rails, lede, content, and the way out. */
export function DocPage({
  slug,
  title,
  blurb,
  children,
}: {
  slug: DocSlug
  title: string
  blurb: string
  children: ReactNode
}) {
  const others = DOCS.filter((doc) => doc.slug !== slug)

  return (
    <>
      <SiteHeader />
      <main className="relative">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="mx-auto h-full max-w-3xl border-x border-dashed border-zinc-950/12 dark:border-white/12" />
        </div>

        <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6 sm:py-20 lg:px-8">
          <a
            href="/"
            className="inline-flex items-center gap-1.5 text-base text-muted-foreground hover:text-foreground sm:text-sm"
          >
            <ArrowLeft className="size-4 shrink-0" aria-hidden="true" />
            flue.sh
          </a>

          <h1 className="mt-6 max-w-[30ch] text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            {title}
          </h1>
          <p className="mt-4 max-w-[56ch] text-lg text-pretty text-muted-foreground">{blurb}</p>

          <div className="mt-12 border-t border-dashed border-border pt-12">{children}</div>

          <nav
            aria-label="Other documents"
            className="mt-20 grid gap-px overflow-hidden rounded-xl bg-border"
          >
            {others.map((doc) => (
              <a
                key={doc.slug}
                href={`/docs/${doc.slug}`}
                className="group bg-background p-6 hover:bg-accent"
              >
                <p className="flex items-center gap-1.5 text-lg font-medium">
                  {doc.title}
                  <ArrowRight
                    className="size-4 shrink-0 text-muted-foreground group-hover:text-primary"
                    aria-hidden="true"
                  />
                </p>
                <p className="mt-2 text-base/7 text-pretty text-muted-foreground sm:text-sm/6">
                  {doc.blurb}
                </p>
              </a>
            ))}
          </nav>
        </div>
      </main>
      <SiteFooter />
    </>
  )
}

/** A titled run of a document. Sections are the page's only structure. */
export function Section({
  title,
  eyebrow,
  children,
  className,
}: {
  title: string
  eyebrow?: string
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('mt-16 first:mt-0', className)}>
      {eyebrow && (
        <p className="font-mono text-sm tracking-wide text-primary uppercase">{eyebrow}</p>
      )}
      <h2 className="mt-3 max-w-[35ch] text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
        {title}
      </h2>
      <div className="mt-6 flex flex-col gap-4">{children}</div>
    </section>
  )
}

/** Body copy. One component so every paragraph on every page measures alike. */
export function P({ children }: { children: ReactNode }) {
  return <p className="max-w-[68ch] text-base/7 text-pretty text-muted-foreground">{children}</p>
}

/** The one sentence a reader should leave with. */
export function Lead({ children }: { children: ReactNode }) {
  return <p className="max-w-[60ch] text-lg/8 text-pretty text-foreground">{children}</p>
}

export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-sm bg-foreground/8 px-1.5 py-0.5 font-mono text-[0.875em]">
      {children}
    </code>
  )
}

export function Link({ href, children }: { href: string; children: ReactNode }) {
  const external = href.startsWith('http')
  return (
    <a
      href={href}
      {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
      className="text-primary underline underline-offset-4"
    >
      {children}
    </a>
  )
}

/** A shell transcript. Dark in both themes, like every terminal on the site. */
export function Shell({ lines }: { lines: string[] }) {
  return (
    <pre className="max-w-[68ch] overflow-x-auto rounded-xl bg-zinc-950 p-4 font-mono text-sm/6 text-zinc-300 ring-1 ring-zinc-950/10 dark:ring-white/10">
      {lines.map((line) => (
        <span key={line} className="block whitespace-pre">
          {line.startsWith('$') ? (
            <>
              <span className="text-teal-400">$</span>
              {line.slice(1)}
            </>
          ) : (
            <span className="text-zinc-500">{line}</span>
          )}
        </span>
      ))}
    </pre>
  )
}

/** A point worth pulling out of the flow, without being a warning. */
export function Note({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="max-w-[68ch] rounded-xl border border-dashed border-border p-5">
      <p className="text-base font-medium">{title}</p>
      <div className="mt-2 flex flex-col gap-3">{children}</div>
    </div>
  )
}
