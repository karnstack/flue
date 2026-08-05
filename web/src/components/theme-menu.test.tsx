import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { ThemeMenu } from './theme-menu'

describe('ThemeMenu', () => {
  it('lists System plus every preset and reports a choice', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<ThemeMenu value="system" onChange={onChange} />)

    await user.click(screen.getByRole('button', { name: 'Terminal theme' }))

    // System first — the default belongs at the top — then the presets.
    const items = screen.getAllByRole('menuitemradio')
    expect(items.length).toBeGreaterThanOrEqual(4)
    expect(items[0]!.textContent).toContain('System')

    await user.click(screen.getByRole('menuitemradio', { name: /Dracula/ }))
    expect(onChange).toHaveBeenCalledWith('dracula')
  })

  it('marks the current choice checked', async () => {
    const user = userEvent.setup()
    render(<ThemeMenu value="nord" onChange={() => {}} />)

    await user.click(screen.getByRole('button', { name: 'Terminal theme' }))

    const nord = screen.getByRole('menuitemradio', { name: /Nord/ })
    expect(nord.getAttribute('aria-checked')).toBe('true')
  })
})
