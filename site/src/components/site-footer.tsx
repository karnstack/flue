import { GithubMark, Wordmark, XMark } from '@/components/wordmark'
import { REPO_URL, X_URL } from '@/lib/site'

export function SiteFooter() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-10 sm:px-6 sm:py-12 lg:flex-row lg:items-center lg:justify-between lg:px-8">
        <div>
          <Wordmark />
          <p className="mt-3 text-base text-muted-foreground sm:text-sm">
            Made by{' '}
            <a href={X_URL} className="text-foreground underline underline-offset-4">
              karn
            </a>{' '}
            and a few AI agents. MIT licensed. &copy; 2026 karnstack.
          </p>
        </div>

        <div className="flex items-center gap-x-6 gap-y-3 max-sm:flex-wrap">
          <nav className="flex items-center gap-x-6" aria-label="Documentation">
            <a
              href="/docs/relay"
              className="text-base font-normal text-muted-foreground hover:text-foreground sm:text-sm"
            >
              Relay
            </a>
            <a
              href="/docs/faq"
              className="text-base font-normal text-muted-foreground hover:text-foreground sm:text-sm"
            >
              FAQ
            </a>
            <a
              href="/docs/developing"
              className="text-base font-normal text-muted-foreground hover:text-foreground sm:text-sm"
            >
              Developing
            </a>
          </nav>
          <div className="flex items-center gap-1">
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              aria-label="GitHub repository"
              className="inline-flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <GithubMark className="size-4.5" />
            </a>
            <a
              href={X_URL}
              target="_blank"
              rel="noreferrer"
              aria-label="Karn on X"
              className="inline-flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <XMark className="size-4" />
            </a>
          </div>
        </div>
      </div>
    </footer>
  )
}
