import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'

import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@/components/ui/sheet'

// A smoke test for the whole scaffold rather than for shadcn: rendering these
// two exercises the `@/*` alias, the jsdom environment, the test-setup
// globals, cva, cn()'s tailwind-merge behaviour and the Radix primitives in
// one go. Every later task builds on all of it.
describe('Button', () => {
  it('renders through the @/ alias', () => {
    render(<Button>Run</Button>)
    expect(screen.getByRole('button', { name: 'Run' })).toBeTruthy()
  })

  it('lets a caller class override a conflicting base class via cn()', () => {
    render(<Button className="rounded-none">Run</Button>)
    const el = screen.getByRole('button', { name: 'Run' })
    expect(el.className).toContain('rounded-none')
    // The base radius, named exactly: an assertion against a class the button
    // stopped carrying would pass forever without proving anything.
    expect(el.className).not.toContain('rounded-md')
  })

  it('renders as the child element when asChild is set', () => {
    render(
      <Button asChild>
        <a href="/sessions">Sessions</a>
      </Button>,
    )
    expect(screen.getByRole('link', { name: 'Sessions' })).toBeTruthy()
  })
})

describe('Sheet', () => {
  it('portals its content and keeps an accessible title', () => {
    render(
      <Sheet defaultOpen>
        <SheetContent>
          <SheetTitle>Sessions</SheetTitle>
          <SheetDescription>Pick a session.</SheetDescription>
        </SheetContent>
      </Sheet>,
    )
    expect(screen.getByRole('dialog', { name: 'Sessions' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
  })
})
