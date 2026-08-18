import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { MarkdownView } from './markdown'

describe('MarkdownView', () => {
  it('renders headings, lists, and emphasis', () => {
    render(<MarkdownView text={'# Title\n\n- one\n- two\n\n**bold** and *soft*'} />)
    expect(screen.getByRole('heading', { level: 1, name: 'Title' })).toBeTruthy()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByText('bold').tagName).toBe('STRONG')
  })

  it('renders a GFM table', () => {
    render(<MarkdownView text={'| a | b |\n|---|---|\n| 1 | 2 |'} />)
    expect(screen.getByRole('table')).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'a' })).toBeTruthy()
    expect(screen.getByRole('cell', { name: '2' })).toBeTruthy()
  })

  it('drops raw HTML instead of injecting it', () => {
    const { container } = render(
      <MarkdownView text={'before\n\n<script>window.pwned = true</script>\n\n<img src=x onerror="window.pwned = true">\n\nafter'} />,
    )
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect((window as { pwned?: boolean }).pwned).toBeUndefined()
    expect(screen.getByText('after')).toBeTruthy()
  })

  it('opens http links in a new tab with no referrer or opener', () => {
    render(<MarkdownView text={'[docs](https://example.com/x)'} />)
    const a = screen.getByRole('link', { name: 'docs' })
    expect(a.getAttribute('href')).toBe('https://example.com/x')
    expect(a.getAttribute('target')).toBe('_blank')
    expect(a.getAttribute('rel')).toContain('noopener')
    expect(a.getAttribute('rel')).toContain('noreferrer')
  })

  it('refuses a link that is not http(s)', () => {
    render(<MarkdownView text={'[boom](javascript:alert(1))'} />)
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText('boom')).toBeTruthy()
  })

  it('shows an image as its alt text, not as an element with nothing to load', () => {
    const { container } = render(<MarkdownView text={'![the graph](./graph.png)'} />)
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText(/the graph/)).toBeTruthy()
  })

  it('renders fenced code in a mono panel', () => {
    const { container } = render(<MarkdownView text={'```go\nfunc main() {}\n```'} />)
    const pre = container.querySelector('pre')
    expect(pre).not.toBeNull()
    expect(pre!.textContent).toContain('func main()')
  })
})
