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
 * The registrar itself is optional because `navigator.serviceWorker` is
 * undefined outside a secure context and in some private-browsing modes.
 *
 * The parameter is named `registrar` for a reason that has nothing to do with
 * English: the obvious name is also a Tailwind utility name, and Tailwind's
 * scanner treats `<word>:` in a type annotation as a candidate exactly as it
 * treats a class attribute. It shipped six dead rules of that name. Measured
 * with the scanner itself, not reasoned about — see the guard in
 * styles.build.test.ts, which is what stops the next one.
 */
export async function registerServiceWorker(
  registrar: Registrar | undefined,
  url = '/sw.js',
): Promise<void> {
  if (!registrar) return
  try {
    await registrar.register(url, { scope: '/' })
  } catch (err) {
    console.warn('flue: service worker registration failed', err)
  }
}
