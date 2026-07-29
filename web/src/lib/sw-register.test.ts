import { describe, expect, it, vi } from 'vitest'
import { registerServiceWorker } from './sw-register'

describe('registerServiceWorker', () => {
  it('registers the worker at the origin root', async () => {
    const register = vi.fn().mockResolvedValue({})
    await registerServiceWorker({ register })
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' })
  })

  it('does nothing when the browser has no service worker support', async () => {
    // Not a hypothetical: navigator.serviceWorker is undefined in a private
    // window in some browsers, and reading .register off it would throw
    // before React ever mounts.
    await expect(registerServiceWorker(undefined)).resolves.toBeUndefined()
  })

  it('swallows a failed registration', async () => {
    // The service worker is an enhancement. If it cannot install, the app
    // still has to boot.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const register = vi.fn().mockRejectedValue(new Error('nope'))
    await expect(registerServiceWorker({ register })).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
