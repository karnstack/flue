// The Worker's entry: the whole application, plus the one handler a request can
// never provide.
//
// TanStack Start ships its own Worker entry (`@tanstack/react-start/server-entry`,
// which wrangler.jsonc used to name as `main` directly) and it exports exactly
// one thing: `fetch`. That is all a web framework needs — and it leaves no way
// to export `scheduled`, which is the *only* way to run code on Cloudflare with
// no request behind it. So this file is that entry with one more export bolted
// on, and `main` points here instead. The Start vite plugin also resolves
// `src/server.ts` as the server entry by convention, so both halves of the
// build agree on this file without a second setting.
//
// The fetch handler is passed through verbatim: forwarding every argument
// rather than re-creating the handler keeps SSR, server functions, CSRF and the
// asset fallthrough exactly as the framework wires them. Nothing in this file
// gets to change what a request does.
import startEntry from '@tanstack/react-start/server-entry'
import { runScheduledSweeps } from './server/sweep'

/**
 * The cron (`triggers.crons` in wrangler.jsonc): collect every expired row.
 *
 * Awaited rather than handed to `ctx.waitUntil`: a scheduled invocation lives
 * exactly as long as the promise this returns, so backgrounding the work would
 * be asking the runtime to cancel it. Awaiting is also what makes a failure
 * visible — a rejection here is a failed scheduled invocation in the Worker's
 * logs, which is the only place anyone would notice that the tables had stopped
 * being collected.
 *
 * Typed as the runtime's own handler shape rather than inferred, so the
 * signature is checked against what Cloudflare will actually call. None of the
 * three arguments is used: `db()` takes its binding from `cloudflare:workers`'s
 * `env`, which is populated in a scheduled context exactly as in a request.
 */
const scheduled: ExportedHandlerScheduledHandler<Cloudflare.Env> = async () => {
  await runScheduledSweeps()
}

export default {
  /**
   * Every HTTP request, handed straight to Start.
   *
   * Called through `startEntry` rather than passed by reference so the entry
   * stays the receiver, exactly as in Start's own default entry — a bare
   * reference would silently drop that if the framework ever starts using
   * `this`.
   *
   * The parameter list is Start's (`(request, opts?)`), not the runtime's
   * (`(request, env, ctx)`), which is why this object is not declared as an
   * `ExportedHandler` whole: the two disagree about the second argument.
   * Everything is forwarded regardless, which is precisely what Start's own
   * default entry does — so what a request meets here is what it met when
   * `main` named that entry directly.
   */
  fetch(...args: Parameters<typeof startEntry.fetch>) {
    return startEntry.fetch(...args)
  },
  scheduled,
}
