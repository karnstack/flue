/** The subset of `ServiceWorkerContainer` registration needs. */
type Registrar = Pick<ServiceWorkerContainer, 'register'>

/**
 * Register the app-shell service worker.
 *
 * Scope is the origin root, which is why the worker is emitted to `/sw.js`
 * rather than into the hashed asset directory: a worker's default scope is its
 * own URL's directory, and `/assets/sw-abc123.js` could only ever control
 * `/assets/`.
 *
 * Every failure is swallowed. The worker is an enhancement — it is what lets
 * the UI load and say "can't reach the daemon" instead of showing a blank tab
 * — and an enhancement that cannot install must not take the app down with it.
 * The container itself is optional because `navigator.serviceWorker` is
 * undefined outside a secure context and in some private-browsing modes.
 */
export async function registerServiceWorker(
  container: Registrar | undefined,
  url = '/sw.js',
): Promise<void> {
  if (!container) return
  try {
    await container.register(url, { scope: '/' })
  } catch (err) {
    console.warn('flue: service worker registration failed', err)
  }
}
