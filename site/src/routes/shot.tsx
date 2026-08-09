import { createFileRoute } from '@tanstack/react-router'

import { FleetWindow, PhoneFrame } from '@/components/mock/fleet'

/**
 * The scene the README's screenshot is taken from.
 *
 * A crop of the landing page makes a bad README image: it lands as a bare
 * rectangle with the page's own edges cut through it, and GitHub gives it no
 * frame of its own. This composes the shot deliberately instead, with the
 * padding, corner radius, glow and shadow that a product image wants, so what
 * gets captured is a finished picture rather than an excerpt.
 *
 * It is a development tool, not a page: nothing links here, so the prerender
 * never crawls it and it does not exist on the deployed site. To regenerate
 * the README's images, run `make site-dev`, open /shot in each theme, and
 * capture the #shot element into docs/hero-light.png and docs/hero-dark.png.
 *
 * The page background is left transparent and the capture is taken with
 * alpha, so the rounded corners are really rounded in the PNG rather than
 * filled with whatever this page happened to be sitting on.
 */
export const Route = createFileRoute('/shot')({
  head: () => ({
    meta: [{ title: 'flue shot' }, { name: 'robots', content: 'noindex' }],
  }),
  component: Shot,
})

function Shot() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-transparent p-10">
      {/* The document itself has to be transparent as well, or the capture's
          alpha is filled in by the body before it reaches the corners. */}
      <style>{'html,body{background:transparent !important}'}</style>
      <div
        id="shot"
        className="relative w-[76rem] overflow-hidden rounded-3xl p-14 shadow-2xl ring-1 ring-zinc-950/10 dark:ring-white/10"
      >
        {/* The ground the scene sits on: the page's own canvas, plus the
            scanline texture and the teal bloom from the hero. */}
        <div className="absolute inset-0 -z-20 bg-background" />
        <div className="backdrop-scan absolute inset-0 -z-10" aria-hidden="true" />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-24 left-1/2 -z-10 h-72 w-3/4 -translate-x-1/2 rounded-[50%] bg-primary/25 blur-[120px]"
        />

        <div className="flex items-stretch gap-6">
          <FleetWindow className="min-w-0 flex-1" />
          <PhoneFrame />
        </div>
      </div>
    </div>
  )
}
