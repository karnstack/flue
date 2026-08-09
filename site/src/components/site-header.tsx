import { GithubMark, Wordmark } from '@/components/wordmark'
import { ThemeToggle } from '@/components/theme-toggle'
import { Button } from '@/components/ui/button'
import { REPO_URL } from '@/lib/site'

const NAV = [
  { href: '#problem', label: 'Why' },
  { href: '#how', label: 'How it works' },
  { href: '#remote', label: 'Remote' },
  { href: '#trust', label: 'Trust' },
] as const

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/75 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4 sm:px-6 lg:px-8">
        <a href="/" aria-label="Homepage">
          <Wordmark />
        </a>

        <nav className="flex items-center gap-6 max-md:hidden">
          {NAV.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              {item.label}
            </a>
          ))}
        </nav>

        <div className="flex flex-1 items-center justify-end gap-1">
          <ThemeToggle />
          <Button asChild variant="ghost" size="icon">
            <a href={REPO_URL} target="_blank" rel="noreferrer" aria-label="GitHub repository">
              <GithubMark className="size-4.5" />
            </a>
          </Button>
        </div>
      </div>
    </header>
  )
}
