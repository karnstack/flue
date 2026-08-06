// The device directory, in a DOM.
//
// The `dom` project (see vitest.config.ts): jsdom, not workerd, because there
// is no DOM in a Worker. `DeviceDirectory` takes every call it makes as a prop
// — the same shape `LoginForm` and `EnrollForm` use — so nothing here boots
// Start, a router or a database.
//
// This is the screen that *acts on* machines rather than merely listing them,
// so what is tested hardest is the gap between pressing a thing and it having
// happened: a revoke is confirmed before it runs and never claimed before the
// server answers; "open a session" navigates only to a URL the server actually
// minted; and a refusal is shown as a refusal rather than swallowed under a
// spinner.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DeviceDirectory,
  ONLINE_WINDOW_S,
  type DeviceSummary,
} from '../src/components/device-directory'

// Toasts are a side effect on a singleton, which is exactly the kind of thing
// a component should not have to own a test double for. Mocked at the module
// so the assertions can be about *what was announced*, not about a portal.
const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  message: vi.fn(),
}))
vi.mock('sonner', () => ({ toast }))

afterEach(cleanup)
beforeEach(() => {
  toast.success.mockClear()
  toast.error.mockClear()
  toast.message.mockClear()
})

/** A fixed clock, so "2 hours ago" is not a function of when the suite runs. */
const NOW = 1_800_000_000

const MAC: DeviceSummary = {
  id: 'b5d05f15398a',
  label: 'mac studio',
  lastSeen: NOW - 30,
  disabled: false,
}
const PI: DeviceSummary = {
  id: 'ffffffffffff',
  label: 'kitchen pi',
  lastSeen: NOW - 2 * 86_400,
  disabled: false,
}

function setup(
  overrides: {
    devices?: Array<DeviceSummary>
    error?: string | null
    openSession?: (deviceId: string) => Promise<{ ok: true; url: string } | { ok: false; error: string }>
    revoke?: (deviceId: string) => Promise<{ ok: true } | { ok: false; error: string }>
    rename?: (deviceId: string, label: string) => Promise<{ ok: true; label: string } | { ok: false; error: string }>
  } = {},
) {
  const openSession = vi.fn(
    overrides.openSession ?? (async () => ({ ok: true as const, url: 'https://relay.test/#t=tok' })),
  )
  const revoke = vi.fn(overrides.revoke ?? (async () => ({ ok: true as const })))
  const rename = vi.fn(overrides.rename ?? (async (_id: string, label: string) => ({ ok: true as const, label })))
  const go = vi.fn()

  render(
    <DeviceDirectory
      devices={overrides.devices ?? [MAC, PI]}
      error={overrides.error ?? null}
      openSession={openSession}
      revoke={revoke}
      rename={rename}
      go={go}
      now={NOW}
    />,
  )
  return { openSession, revoke, rename, go, user: userEvent.setup() }
}

/**
 * The row a device's label is in.
 *
 * `closest('li')` because the directory is a list rather than a table — see the
 * note on the `<ul>` in device-directory.tsx: a table cannot reflow, and on a
 * phone the "Open a session" button ended up behind a horizontal scrollbar.
 */
function rowFor(label: string): HTMLElement {
  const cell = screen.getByText(label)
  const row = cell.closest('li')
  if (!row) throw new Error(`no row for ${label}`)
  return row
}

/**
 * A row's overflow menu, opened, and the item named on it.
 *
 * Rename and revoke live behind one trigger per row rather than as two loose
 * icon buttons — see `DeviceMenu`. Every item is named after its own machine,
 * which is what this asserts by finding it that way: a menu of five "Revoke"s
 * tells a screen reader nothing about which one is which.
 */
async function menuItem(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  action: 'Rename' | 'Revoke',
): Promise<HTMLElement> {
  const trigger = within(rowFor(label)).getByRole('button', { name: `More actions for ${label}` })
  await user.click(trigger)
  return await screen.findByRole('menuitem', { name: `${action} ${label}` })
}

describe('DeviceDirectory', () => {
  it('lists every machine on the account, by name and by id', () => {
    setup()
    expect(screen.getByRole('heading', { name: /machines/i })).toBeDefined()
    expect(screen.getByText('mac studio')).toBeDefined()
    expect(screen.getByText('kitchen pi')).toBeDefined()
    // The id is what the daemon calls itself and what every other surface
    // (the relay's hub key, `flue devices`) names — so it is on screen.
    expect(screen.getByText('b5d05f15398a')).toBeDefined()
  })

  it('says which machines are reachable right now', () => {
    setup()
    // Derived from last-seen: a daemon holds its relay connection open and
    // stamps the row, so a recent stamp is what "connected" looks like from
    // here. The window is stated in the component, not guessed at here.
    expect(NOW - (MAC.lastSeen as number)).toBeLessThan(ONLINE_WINDOW_S)
    expect(within(rowFor('mac studio')).getByText('Online')).toBeDefined()

    expect(within(rowFor('kitchen pi')).getByText('Offline')).toBeDefined()
    expect(within(rowFor('kitchen pi')).getByText(/2d ago/)).toBeDefined()
  })

  it('says so plainly when a machine has never connected', () => {
    setup({ devices: [{ ...MAC, lastSeen: null }] })
    expect(screen.getByText(/never connected/i)).toBeDefined()
  })

  it('flags a machine whose kill switch has been flipped', () => {
    setup({ devices: [{ ...MAC, disabled: true }] })
    const row = rowFor('mac studio')
    expect(within(row).getByText('Disabled')).toBeDefined()
    // And there is nothing to open: a disabled device cannot be minted a token,
    // so offering the button would be offering a click that can only fail.
    expect(within(row).queryByRole('button', { name: /open a session/i })).toBeNull()
  })

  it('offers no revoke on a machine flue switched off, and says why', async () => {
    // `revokeDevice` scopes its delete `disabled = false` on purpose — an
    // operator's revocation outranks its owner's — so a live Revoke here is a
    // click whose only possible outcome is a refusal toast. It is shut, and
    // the reason is attached to it rather than left somewhere else on the page.
    const { revoke, user } = setup({ devices: [{ ...MAC, disabled: true }] })

    const item = await menuItem(user, 'mac studio', 'Revoke')
    expect(item.getAttribute('data-disabled')).not.toBeNull()

    const describedBy = item.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy as string)?.textContent).toContain(
      'Contact support',
    )

    // Pressing it does nothing at all — no call, and so no refusal to explain.
    await user.click(item)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(revoke).not.toHaveBeenCalled()
  })

  it('still lets a switched-off machine be renamed', async () => {
    // The rename is not scoped by `disabled` — only the delete is — so the row
    // keeps the one action that still works rather than being inert.
    const { rename, user } = setup({ devices: [{ ...MAC, disabled: true }] })

    await user.click(await menuItem(user, 'mac studio', 'Rename'))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: /save/i }))

    await waitFor(() => expect(rename).toHaveBeenCalledWith('b5d05f15398a', 'mac studio'))
  })

  it('points a new account at `flue link`', () => {
    setup({ devices: [] })
    expect(screen.getByText(/no machines yet/i)).toBeDefined()
    expect(screen.getByText(/flue link/)).toBeDefined()
    // The empty state has to lead somewhere, and enrolment is where.
    const link = screen.getByRole('link', { name: /connect a machine/i })
    expect(link.getAttribute('href')).toBe('/enroll')
  })

  it('says when the list itself could not be read', () => {
    // Not an empty account — a failure. Rendering "no machines yet" for a
    // database outage would tell somebody their machines are gone.
    setup({ devices: [], error: 'devices: could not read your machines' })
    expect(screen.getByRole('alert').textContent).toContain('could not read your machines')
    expect(screen.queryByText(/no machines yet/i)).toBeNull()
  })
})

describe('opening a session', () => {
  it('mints a token and sends the browser to the URL the server returned', async () => {
    const { openSession, go, user } = setup()

    await user.click(within(rowFor('mac studio')).getByRole('button', { name: /open a session/i }))

    expect(openSession).toHaveBeenCalledWith('b5d05f15398a')
    // The URL verbatim, fragment included. `location.assign` is what carries a
    // `#t=` across an origin boundary without putting it on the wire, and a
    // component that trimmed, re-parsed or re-encoded the URL on the way past
    // would take the credential off the end of it.
    await waitFor(() => expect(go).toHaveBeenCalledWith('https://relay.test/#t=tok'))
    expect(toast.success).toHaveBeenCalled()
  })

  it('goes nowhere when the mint is refused', async () => {
    // The URL is the credential — a navigation the server did not authorize is
    // a navigation to a relay that will refuse the upgrade, with a spinner and
    // no explanation on the other side.
    const { go, user } = setup({
      openSession: async () => ({ ok: false, error: 'devices: no such machine' }),
    })

    await user.click(within(rowFor('mac studio')).getByRole('button', { name: /open a session/i }))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(go).not.toHaveBeenCalled()
  })

  it('goes nowhere when the call itself fails', async () => {
    const { go, user } = setup({
      openSession: async () => {
        throw new Error('offline')
      },
    })

    await user.click(within(rowFor('mac studio')).getByRole('button', { name: /open a session/i }))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(go).not.toHaveBeenCalled()
  })

  it('mints one token however many times the button is pressed', async () => {
    // A client token is a bearer credential with a sixty-second life; a
    // double-click that mints two puts a second one somewhere nobody will use
    // it, and races two navigations.
    let release: (r: { ok: true; url: string }) => void = () => {}
    const pending = new Promise<{ ok: true; url: string }>((resolve) => {
      release = resolve
    })
    const { openSession, go, user } = setup({ openSession: async () => pending })

    const button = within(rowFor('mac studio')).getByRole('button', { name: /open a session/i })
    await user.click(button)
    await user.click(button)

    expect(openSession).toHaveBeenCalledTimes(1)
    release({ ok: true, url: 'https://relay.test/#t=tok' })
    await waitFor(() => expect(go).toHaveBeenCalledTimes(1))
  })
})

describe('revoking a machine', () => {
  it('asks before it does anything', async () => {
    const { revoke, user } = setup()

    await user.click(await menuItem(user, 'mac studio', 'Revoke'))

    const dialog = await screen.findByRole('alertdialog')
    // Named, because "are you sure?" over a list of machines is a question
    // about which one.
    expect(dialog.textContent).toContain('mac studio')
    expect(revoke).not.toHaveBeenCalled()
  })

  it('does not promise that open terminals close, because they do not', async () => {
    // It used to say "sessions already open close within a minute or two".
    // Nothing closes them: the relay verifies a channel token at the upgrade
    // and never re-reads it (app/src/server/kill-switch.ts), so a terminal
    // somebody already has open survives until it is closed or the machine
    // reconnects. A person revoking a stolen laptop reads that sentence at the
    // one moment they most need it to be true.
    const { user } = setup()

    await user.click(await menuItem(user, 'mac studio', 'Revoke'))
    const dialog = await screen.findByRole('alertdialog')

    expect(dialog.textContent).not.toMatch(/minute or two/i)
    expect(dialog.textContent).toMatch(/already open/i)
    // And it says the one thing that does end a session now.
    expect(dialog.textContent).toMatch(/stop the daemon/i)
  })

  it('does nothing when the question is answered no', async () => {
    const { revoke, user } = setup()

    await user.click(await menuItem(user, 'mac studio', 'Revoke'))
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: /cancel/i }))

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(revoke).not.toHaveBeenCalled()
  })

  it('revokes the machine that was asked about, and says so', async () => {
    const { revoke, user } = setup()

    await user.click(await menuItem(user, 'kitchen pi', 'Revoke'))
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: /^revoke/i }))

    await waitFor(() => expect(revoke).toHaveBeenCalledWith('ffffffffffff'))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
  })

  it('reports a refusal rather than claiming the machine is gone', async () => {
    const { user } = setup({ revoke: async () => ({ ok: false, error: 'devices: no such machine' }) })

    await user.click(await menuItem(user, 'mac studio', 'Revoke'))
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: /^revoke/i }))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(toast.success).not.toHaveBeenCalled()
  })
})

describe('renaming a machine', () => {
  it('sends the new name and says so', async () => {
    const { rename, user } = setup()

    await user.click(await menuItem(user, 'mac studio', 'Rename'))
    const dialog = await screen.findByRole('dialog')
    const field = within(dialog).getByLabelText(/name/i)
    await user.clear(field)
    await user.type(field, 'studio upstairs')
    await user.click(within(dialog).getByRole('button', { name: /save/i }))

    await waitFor(() => expect(rename).toHaveBeenCalledWith('b5d05f15398a', 'studio upstairs'))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
  })

  it('starts from the name the machine already has', async () => {
    const { user } = setup()
    await user.click(await menuItem(user, 'mac studio', 'Rename'))
    const dialog = await screen.findByRole('dialog')
    expect((within(dialog).getByLabelText(/name/i) as HTMLInputElement).value).toBe('mac studio')
  })

  it('reports a refusal without closing the door on a second try', async () => {
    const { user } = setup({
      rename: async () => ({ ok: false, error: 'devices: a machine needs a name' }),
    })

    await user.click(await menuItem(user, 'mac studio', 'Rename'))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: /save/i }))

    expect(await within(dialog).findByRole('alert')).toBeDefined()
    expect(toast.success).not.toHaveBeenCalled()
    // Still open, with the field still there: a refused rename is a correction,
    // not a dead end.
    expect(within(dialog).getByLabelText(/name/i)).toBeDefined()
  })
})
