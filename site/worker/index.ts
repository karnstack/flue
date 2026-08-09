/**
 * flue.sh's Worker.
 *
 * The site is fully prerendered, so this never renders a page: it exists to
 * fold www.flue.sh onto the apex, which an assets-only Worker cannot do.
 * Everything else falls through to the static assets binding.
 */
type AssetsBinding = { fetch(request: Request): Promise<Response> }

export default {
  async fetch(request: Request, env: { ASSETS: AssetsBinding }): Promise<Response> {
    const url = new URL(request.url)
    if (url.hostname === 'www.flue.sh') {
      url.hostname = 'flue.sh'
      return Response.redirect(url.toString(), 301)
    }
    return env.ASSETS.fetch(request)
  },
}
