// The guard every protected server function composes.
//
// It is *function* middleware, not request middleware, and that is the whole
// design: request middleware runs on every request the Worker sees — documents,
// assets, the login page itself — so a redirect there would either loop or
// have to grow a list of exceptions, and an exception list is how a route ends
// up unprotected by accident. Function middleware runs only where a server
// function asks for it, which makes "this call requires a user" a property of
// the call, written next to it:
//
//   const listDevices = createServerFn().middleware([requireUser]).handler(
//     async ({ context }) => devicesFor(context.user.id),
//   )
//
// A route that also needs the user for rendering asks `currentUser()` in its
// loader; the middleware is what stops the *mutation* underneath it.
import { redirect } from '@tanstack/react-router'
import { createMiddleware } from '@tanstack/react-start'
import { currentUser } from './sessions'

/**
 * Require a logged-in user, and put them in `context.user`.
 *
 * Throwing a redirect rather than returning an error is deliberate: Start turns
 * it into a browser navigation for a document request and into a client-side
 * redirect for an RPC, so an expired session lands the visitor on /login in
 * both cases instead of failing silently under a spinner.
 *
 * `href` rather than `to`: `to` is checked against the generated route tree,
 * which has no /login in it until the login route lands (Task 5). `href` is the
 * already-resolved form — it goes straight into the redirect's Location header —
 * and can be swapped for the type-checked `to` once that route exists.
 *
 * The handler downstream can treat `context.user` as a fact — there is no path
 * through here that calls `next()` without one.
 */
export const requireUser = createMiddleware({ type: 'function' }).server(async ({ next }) => {
  const user = await currentUser()
  if (!user) throw redirect({ href: '/login' })
  return next({ context: { user } })
})
