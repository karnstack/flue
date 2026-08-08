import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'

import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

/*
 * These are library components, and nothing here is trying to test Radix.
 *
 * What it pins is that the five files `shadcn add` wrote compile under this
 * tsconfig and mount under this jsdom setup — which is not free: the
 * generated source is written for the registry's assumptions, not ours, and
 * each one reaches for browser APIs jsdom only partly implements. Each case
 * opens the primitive without any interaction, because an unopened Radix root
 * renders nothing at all and would assert only that an import resolved.
 */

describe('generated primitives', () => {
  it('opens a dropdown menu onto its item', () => {
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Rename</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    )
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeTruthy()
  })

  it('portals popover content', () => {
    render(
      <Popover defaultOpen>
        <PopoverTrigger>Display</PopoverTrigger>
        <PopoverContent>Grouping</PopoverContent>
      </Popover>,
    )
    expect(screen.getByText('Grouping')).toBeTruthy()
  })

  it('opens a select onto its option', () => {
    render(
      <Select defaultOpen defaultValue="idle">
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="idle">Idle</SelectItem>
        </SelectContent>
      </Select>,
    )
    expect(screen.getByRole('option', { name: 'Idle' })).toBeTruthy()
  })

  it('reports a checked checkbox as checked', () => {
    render(<Checkbox defaultChecked aria-label="Select all" />)
    const box = screen.getByRole('checkbox', { name: 'Select all' })
    expect(box.getAttribute('aria-checked')).toBe('true')
  })

  it('names an open dialog by its title', () => {
    render(
      <Dialog defaultOpen>
        <DialogContent>
          <DialogTitle>Rename session</DialogTitle>
          <DialogDescription>Pick a new name.</DialogDescription>
        </DialogContent>
      </Dialog>,
    )
    expect(screen.getByRole('dialog', { name: 'Rename session' })).toBeTruthy()
  })
})
