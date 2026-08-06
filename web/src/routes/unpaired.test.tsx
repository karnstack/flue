import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { UnpairedRoute } from './unpaired'

describe('the unpaired screen', () => {
  it('says what is wrong rather than spinning on a connection', () => {
    render(<UnpairedRoute />)
    expect(screen.getByRole('heading', { name: 'Not paired with a daemon yet' })).toBeTruthy()
  })

  it('says the one thing that gets the user out of it', () => {
    // The way in is a ceremony that starts on another screen, so the copy has
    // to name that screen. A page that only reported the problem would leave
    // the user with nowhere to go.
    render(<UnpairedRoute />)
    expect(screen.getByText(/Pair device/)).toBeTruthy()
    expect(screen.getByText(/Devices/)).toBeTruthy()
  })

  it('carries no chrome, because there is nothing here to navigate to', () => {
    // The same layout decision /pair makes, for the same reason: a sidebar of
    // links to sessions this browser cannot open would be chrome promising
    // what it does not have.
    render(<UnpairedRoute />)
    expect(screen.queryByRole('navigation')).toBeNull()
    expect(screen.queryAllByRole('link')).toHaveLength(0)
    expect(document.querySelector('[data-slot="sidebar"]')).toBeNull()
  })
})
