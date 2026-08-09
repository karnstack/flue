import { PageHeader } from '@/components/page-header'

/**
 * Settings, which is a promise rather than a screen.
 *
 * This was a list of six subjects with a sentence under each, and the list was
 * the problem. A roadmap printed as a screen invites the reader to look for
 * the one they came for, and every one of them was equally unavailable — so
 * the reward for reading six entries carefully was six disappointments and a
 * page that had said nothing it could not have said in a line.
 *
 * A roadmap also has to be maintained to stay honest, and the only thing worse
 * than no list of what is coming is a stale one: an entry that shipped months
 * ago still reading "coming soon", or a plan quietly abandoned that the app
 * goes on advertising. The place for that is the repository, which is linked
 * from the sidebar and is the only version of it that can be trusted.
 *
 * Nothing here is interactive, and nothing pretends to be. There are no dimmed
 * toggles and no fields that refuse to save: a control that looks operable and
 * is not is worse than no control, because the reader spends a click and a
 * moment of doubt finding out.
 */
export function SettingsRoute() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-y-6 p-4 sm:p-6 lg:p-8">
      <PageHeader crumbs={[{ label: 'Settings' }]}>
        <p className="max-w-[65ch] text-base/7 text-pretty text-zinc-600 sm:text-sm/6 dark:text-zinc-400">
          Coming soon. flue keeps almost nothing configurable on purpose — the defaults are the
          product — and the few things worth a switch are not here yet.
        </p>
      </PageHeader>
    </div>
  )
}
