import { describe, expect, it } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithRouter } from '@/testing/render'
import { AppShell } from './app-shell'

describe('AppShell', () => {
  it('renders its children', async () => {
    await renderWithRouter(
      <AppShell currentPath="/sessions">
        <p>route content</p>
      </AppShell>,
    )
    expect(screen.getByText('route content')).toBeTruthy()
  })

  it('lets the main region shrink below its content', async () => {
    // main is a flex-1 child beside a fixed-width sidebar. Without min-w-0 a
    // wide child (a session list row, a terminal) pushes the sidebar off
    // instead of scrolling or truncating.
    await renderWithRouter(
      <AppShell currentPath="/sessions">
        <p>route content</p>
      </AppShell>,
    )
    expect(screen.getByRole('main').className).toContain('min-w-0')
  })

  it('collapses the sidebar into a sheet below lg', async () => {
    await renderWithRouter(
      <AppShell currentPath="/sessions">
        <p>route content</p>
      </AppShell>,
    )
    // jsdom applies no CSS, so both the lg: sidebar and the below-lg header
    // are in the tree; the classes are what actually decide which is visible.
    const sidebar = screen.getByRole('complementary')
    expect(sidebar.className).toContain('lg:flex')
    expect(sidebar.className).toContain('hidden')
    expect(screen.getByRole('banner').className).toContain('lg:hidden')
  })

  it('opens the mobile sheet and closes it again when a link is activated', async () => {
    await renderWithRouter(
      <AppShell currentPath="/sessions">
        <p>route content</p>
      </AppShell>,
    )
    expect(screen.queryByRole('dialog')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'Open navigation' }))
    const sheet = await screen.findByRole('dialog')

    await userEvent.click(within(sheet).getByRole('link', { name: 'Settings' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})
