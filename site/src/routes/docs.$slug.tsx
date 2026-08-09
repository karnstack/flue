import { createFileRoute, notFound } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'

import { SiteFooter } from '@/components/site-footer'
import { SiteHeader } from '@/components/site-header'
import { DOCS, findDoc, renderDoc } from '@/lib/docs'
import { REPO_URL } from '@/lib/site'

/**
 * One published document.
 *
 * The markdown is rendered in the loader, which runs at build time for every
 * slug the prerender crawls — so the HTML Cloudflare serves already contains
 * the prose, and no markdown parser reaches a browser.
 */
export const Route = createFileRoute('/docs/$slug')({
  loader: ({ params }) => {
    const doc = findDoc(params.slug)
    if (!doc) throw notFound()
    return { title: doc.title, blurb: doc.blurb, path: doc.path, html: renderDoc(doc) }
  },
  head: ({ loaderData }) =>
    loaderData
      ? {
          meta: [
            { title: `${loaderData.title} — flue` },
            { name: 'description', content: loaderData.blurb },
          ],
        }
      : {},
  component: DocPage,
})

function DocPage() {
  const { title, blurb, path, html } = Route.useLoaderData()

  return (
    <>
      <SiteHeader />
      <main className="relative">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="mx-auto h-full max-w-6xl border-x border-dashed border-zinc-950/12 dark:border-white/12" />
        </div>

        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20 lg:px-8">
          <a
            href="/"
            className="inline-flex items-center gap-1.5 text-base text-muted-foreground hover:text-foreground sm:text-sm"
          >
            <ArrowLeft className="size-4 shrink-0" aria-hidden="true" />
            flue.sh
          </a>

          <h1 className="mt-6 max-w-[35ch] text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            {title}
          </h1>
          <p className="mt-4 max-w-[56ch] text-lg text-pretty text-muted-foreground">{blurb}</p>

          <div className="mt-10 border-t border-dashed border-border pt-10">
            {/* Rendered from the repository's own markdown at build time. */}
            <div className="prose" dangerouslySetInnerHTML={{ __html: html }} />
          </div>

          <p className="mt-16 border-t border-dashed border-border pt-6 font-mono text-xs text-muted-foreground">
            Rendered from{' '}
            <a
              href={`${REPO_URL}/blob/main/${path}`}
              target="_blank"
              rel="noreferrer"
              className="text-primary hover:underline"
            >
              {path}
            </a>
            . Edit it there and this page follows.
          </p>

          <nav aria-label="Other documents" className="mt-10 flex flex-wrap gap-x-6 gap-y-2">
            {DOCS.map((doc) => (
              <a
                key={doc.slug}
                href={`/docs/${doc.slug}`}
                className="text-base text-muted-foreground hover:text-foreground sm:text-sm"
              >
                {doc.title}
              </a>
            ))}
          </nav>
        </div>
      </main>
      <SiteFooter />
    </>
  )
}
