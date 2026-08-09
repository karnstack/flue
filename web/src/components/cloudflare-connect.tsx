import { useEffect, useState, type FormEvent } from 'react'
import { CheckIcon, CloudIcon } from '@heroicons/react/16/solid'

import { Copyable, Command } from '@/components/copyable'
import { TextButton, TextLink } from '@/components/text-link'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { isRelayOrigin } from '@/relay/mode'

/*
 * The Cloudflare integration: deploy and update a relay from the Remote
 * screen, against the daemon's /api/relay endpoints (internal/daemon/
 * relayui.go — the same deploy `flue relay setup` performs, shared through
 * internal/relaydeploy).
 *
 * The token never leaves this tab except to the daemon on loopback. That is
 * not a habit but a boundary: these components must never render on a relay
 * origin (useRelayUIInfo refuses there), because a token typed into a remote
 * tab would cross the relay, and the FAQ's hostile-origin analysis applies to
 * it in full. The daemon enforces the same boundary by construction — the
 * endpoints exist only on its loopback HTTP surface.
 */

const PROSE = 'text-base/7 text-pretty text-zinc-600 sm:text-sm/6 dark:text-zinc-400'
const NOTE = 'text-sm/6 text-pretty text-zinc-600 sm:text-xs/5 dark:text-zinc-400'

const INFO_ENDPOINT = '/api/relay/info'
const DEPLOY_ENDPOINT = '/api/relay/deploy'
const UPDATE_ENDPOINT = '/api/relay/update'

/** The exact template name the token page offers; a paraphrase is a hunt. */
export const TOKEN_TEMPLATE = 'Edit Cloudflare Workers'
const TOKEN_PAGE = 'https://dash.cloudflare.com/profile/api-tokens'

/** GET /api/relay/info, verbatim (daemon.RelayUIStatus). */
export interface RelayUIInfo {
  configured: boolean
  origin?: string
  worker?: string
  can_deploy: boolean
  can_deploy_reason?: string
  version: string
  deployed_version?: string
  has_token?: boolean
  account_name?: string
}

interface DeployResult {
  needs_account?: boolean
  accounts?: { id: string; name: string }[]
  steps?: string[]
  origin?: string
  join_command?: string
  restart_needed?: boolean
}

/**
 * Everything currently reading the daemon's relay answer.
 *
 * A module-level set rather than a context, because the thing being kept in
 * step is not a subtree: the Remote screen's card and the shell's standing
 * notice (relay-update.tsx) each call the hook, they are on opposite sides of
 * the tree, and an update started from either has to land on both. A deploy
 * that finished while the card still said "Update available" was the whole
 * complaint — the answer had changed and the page was showing a cached copy
 * of the question.
 */
const readers = new Set<() => void>()

/**
 * Tell them all to ask again.
 *
 * Called on every successful deploy or update rather than by whoever started
 * it. The daemon's answer is one fact about one machine, so the moment it
 * changes every reader of it is stale, including the ones on other screens
 * that had nothing to do with the change.
 */
export function relayUIChanged() {
  for (const ask of readers) ask()
}

/**
 * What the daemon can say about its relay deployability, or null while the
 * answer is on its way (or was refused — a daemon old enough to lack the
 * endpoint answers 404, and the card's fallback is the CLI it always named).
 *
 * Never asked on a relay origin: the answer would be about the wrong machine,
 * and the card this feeds must not exist there at all.
 */
export function useRelayUIInfo(): RelayUIInfo | null {
  const [info, setInfo] = useState<RelayUIInfo | null>(null)

  useEffect(() => {
    if (isRelayOrigin()) return
    let cancelled = false
    const ask = () => {
      void fetch(INFO_ENDPOINT, { credentials: 'same-origin' })
        .then((res) => (res.ok ? (res.json() as Promise<RelayUIInfo>) : null))
        .then((got) => {
          if (!cancelled && got) setInfo(got)
        })
        .catch(() => {})
    }
    ask()
    // Re-asked when the tab comes back: a deploy or update run from another
    // window (or the CLI) should be on this card the moment it is looked at.
    const run = () => {
      if (!document.hidden) ask()
    }
    window.addEventListener('focus', run)
    document.addEventListener('visibilitychange', run)
    readers.add(ask)
    return () => {
      cancelled = true
      readers.delete(ask)
      window.removeEventListener('focus', run)
      document.removeEventListener('visibilitychange', run)
    }
  }, [])
  return info
}

/** True when the deployed relay reports an older flue than this daemon. */
export function updateAvailable(info: RelayUIInfo | null): boolean {
  return Boolean(
    info?.configured && info.deployed_version && info.deployed_version !== info.version,
  )
}

/**
 * The mark on the card: Cloudflare's orange, a cloud, and the name. Not the
 * trademarked logo redrawn from memory — the name and the colour identify the
 * integration; a wrong-shaped official mark would be worse than none.
 */
export function CloudflareMark() {
  return (
    <span className="flex items-center gap-x-2">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-[#f6821f]/10">
        <CloudIcon aria-hidden="true" className="size-4.5 text-[#f6821f]" />
      </span>
      <span className="text-sm/6 font-medium text-zinc-950 dark:text-white">Cloudflare</span>
    </span>
  )
}

async function post(path: string, body: unknown): Promise<DeployResult> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = (await res.text()).trim()
    throw new Error(text || `the daemon answered ${res.status}`)
  }
  return (await res.json()) as DeployResult
}

type Phase = 'form' | 'busy' | 'accounts' | 'done'

/**
 * The deploy conversation both cards share: token → (which account?) →
 * ✓ steps. The token lives in component state for exactly the flow's
 * duration; the account round trip re-sends it because the daemon holds
 * nothing between requests.
 */
function DeployFlow({
  endpoint,
  action,
  workerField,
  defaultWorker,
  storedToken,
  accountName,
  onDone,
}: {
  endpoint: string
  /** The verb on the button: "Deploy" or "Update relay". */
  action: string
  /** Whether to offer the worker-name field (setup only). */
  workerField?: boolean
  defaultWorker?: string
  /** A token is stored daemon-side: the field is optional and starts hidden. */
  storedToken?: boolean
  accountName?: string
  /** Called once the deploy has landed, for a caller with something to close. */
  onDone?: () => void
}) {
  const [phase, setPhase] = useState<Phase>('form')
  const [token, setToken] = useState('')
  // With a stored token the field starts hidden; "use a different token"
  // brings it back for rotations.
  const [wantsFreshToken, setWantsFreshToken] = useState(!storedToken)
  const [worker, setWorker] = useState(defaultWorker ?? 'flue-relay')
  const [accounts, setAccounts] = useState<{ id: string; name: string }[]>([])
  const [accountID, setAccountID] = useState('')
  const [result, setResult] = useState<DeployResult | null>(null)
  const [error, setError] = useState('')

  async function run(chosenAccount: string) {
    setPhase('busy')
    setError('')
    try {
      const res = await post(endpoint, {
        token: token || undefined,
        account_id: chosenAccount || undefined,
        worker: workerField ? worker : undefined,
      })
      if (res.needs_account) {
        setAccounts(res.accounts ?? [])
        setAccountID(res.accounts?.[0]?.id ?? '')
        setPhase('accounts')
        return
      }
      setResult(res)
      setToken('')
      setPhase('done')
      // The daemon's answer about this relay is now out of date everywhere it
      // is being read, including on screens this form is not on.
      relayUIChanged()
      onDone?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPhase(accounts.length > 0 ? 'accounts' : 'form')
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    // An empty token is a real submission when one is stored: the daemon
    // falls back to it.
    if (token || storedToken) void run(accountID)
  }

  if (phase === 'done' && result) {
    return (
      <div className="flex flex-col gap-y-4">
        <ul className="flex flex-col gap-y-1">
          {(result.steps ?? []).map((step) => (
            <li key={step} className={cn(NOTE, 'flex items-start gap-x-2')}>
              <CheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-(--primary)" />
              <span className="min-w-0">{step}</span>
            </li>
          ))}
        </ul>
        {result.join_command && (
          <div className="flex flex-col gap-y-1.5">
            <p className={PROSE}>
              To add another machine, run this on it — also available from this screen later:
            </p>
            <Copyable text={result.join_command} />
          </div>
        )}
        {result.restart_needed && (
          <p className={PROSE}>
            This daemon was already connected to a relay, so the new one takes over on its next
            start: restart it (flue disable && flue enable, or restart flue serve).
          </p>
        )}
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-y-4">
      {phase === 'accounts' ? (
        <fieldset className="flex flex-col gap-y-2">
          <legend className={cn(PROSE, 'mb-1')}>
            This token reaches more than one account. Which should the relay live in?
          </legend>
          {accounts.map((a) => (
            <label key={a.id} className={cn(PROSE, 'flex items-center gap-x-2.5')}>
              <input
                type="radio"
                name="cf-account"
                value={a.id}
                checked={accountID === a.id}
                onChange={() => setAccountID(a.id)}
                className="accent-(--primary)"
              />
              {a.name}
            </label>
          ))}
        </fieldset>
      ) : (
        <>
          {workerField && (
            <div className="flex flex-col gap-y-1.5">
              <label htmlFor="cf-worker" className={NOTE}>
                Worker name — the first label of the workers.dev address
              </label>
              <Input
                id="cf-worker"
                value={worker}
                onChange={(e) => setWorker(e.target.value)}
                className="font-mono"
                spellCheck={false}
                autoComplete="off"
              />
            </div>
          )}
          {wantsFreshToken ? (
            <div className="flex flex-col gap-y-1.5">
              <label htmlFor="cf-token" className={NOTE}>
                API token — created at{' '}
                <TextLink href={TOKEN_PAGE} target="_blank">
                  dash.cloudflare.com
                </TextLink>{' '}
                with the “{TOKEN_TEMPLATE}” template
              </label>
              <Input
                id="cf-token"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="paste the token"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          ) : (
            <p className={NOTE}>
              Using the stored token{accountName ? ` for ${accountName}` : ''}.{' '}
              <TextButton onClick={() => setWantsFreshToken(true)}>
                Use a different token
              </TextButton>
            </p>
          )}
        </>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button type="submit" size="sm" disabled={phase === 'busy' || (token === '' && !storedToken)}>
          {phase === 'busy' ? 'Working…' : action}
        </Button>
        {phase === 'busy' && (
          <span className={NOTE}>Deploying — uploading the Worker and the web app…</span>
        )}
      </div>
      {/*
        Always in the tree, empty until it has something to say, for the same
        live-region reason Copyable's status line is. The daemon's error text
        is written for this screen and never carries the token.
      */}
      <p role="status" className={cn(NOTE, 'text-red-600 empty:hidden dark:text-red-400')}>
        {error}
      </p>
    </form>
  )
}

/**
 * The integration card for a daemon with no relay: what a deploy will create,
 * spelled out before any credential is asked for, then the form. The CLI
 * command stays at the bottom — same deploy, other door.
 */
export function CloudflareConnectCard({
  info,
  setupCommand,
}: {
  info: RelayUIInfo | null
  setupCommand: string
}) {
  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <div className="flex items-center justify-between gap-x-3">
          <CloudflareMark />
          <Badge variant="outline" className="shrink-0">
            Integration
          </Badge>
        </div>
        <CardTitle className="mt-2">Run your own relay</CardTitle>
        <CardDescription className={PROSE}>
          Deploying creates, in your Cloudflare account and nowhere else: a Worker named as below,
          Durable Object storage for its hubs, a fresh secret only it and this daemon hold, a
          workers.dev address, and a copy of this web app. The free tier is enough. The token is
          kept on this machine, in a file only your user can read, so updating later is one click —
          delete cloudflare.json from flue's config directory to forget it.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-y-5">
        {info !== null && !info.can_deploy ? (
          <p className={PROSE}>{info.can_deploy_reason}</p>
        ) : (
          <DeployFlow
            endpoint={DEPLOY_ENDPOINT}
            action="Deploy to Cloudflare"
            workerField
            defaultWorker={info?.worker || 'flue-relay'}
            storedToken={info?.has_token}
            accountName={info?.account_name}
          />
        )}
        <div className="flex flex-col gap-y-1.5">
          <p className={NOTE}>Prefer a terminal? The same deploy:</p>
          <Command command={setupCommand} />
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * The integration card for a daemon whose relay exists: where it lives —
 * account, worker, address — beside what can be done to it. The update flow
 * appears when the relay's /api/health names an older flue than this daemon
 * (with a stored token it is one click), and the join line for adding
 * another machine is here, behind its own click. The dashboard-cleanup
 * actions of the future belong on this card too.
 */
export function CloudflareConfiguredCard({ info }: { info: RelayUIInfo }) {
  const stale = updateAvailable(info)
  /*
    Owned by the card and not by the button, because the button is the first
    thing to go: a successful update re-asks the daemon, the answer comes back
    naming this release, `stale` turns false, and everything gated on it
    disappears — correctly, since there is nothing left to update. A window
    gated on it would take the list of steps the deploy just produced with it,
    which is the one account the reader has of what was done to their
    Cloudflare account.
  */
  const [updating, setUpdating] = useState(false)
  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <div className="flex items-center justify-between gap-x-3">
          <CloudflareMark />
          {stale ? (
            <Badge variant="secondary" className="shrink-0">
              Update available
            </Badge>
          ) : (
            <Badge variant="outline" className="shrink-0">
              Integration
            </Badge>
          )}
        </div>
        <CardTitle className="mt-2">Your relay</CardTitle>
        <CardDescription className={PROSE}>
          {info.account_name
            ? `Deployed into ${info.account_name}`
            : 'Deployed into your Cloudflare account'}
          {info.worker ? ` as the Worker ${info.worker}.` : '.'}{' '}
          {stale
            ? `It was deployed by flue ${info.deployed_version}; this daemon is ${info.version}. Updating redeploys the Worker and the web app it serves — the secret, the machine ids and every pairing stay, and everything reconnects on its own.`
            : info.deployed_version
              ? 'It is running this flue’s relay — nothing to update.'
              : ''}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-y-5">
        {stale && (
          <div>
            {/*
              The trailing ellipsis is the old menu convention and it is doing
              real work: this control opens something and asks, while the one
              at the foot of the window it opens is the one that acts. Two
              controls a click apart both reading exactly "Update relay" is
              the kind of thing a reader forgives and a screen reader does
              not.
            */}
            <Button size="sm" onClick={() => setUpdating(true)}>
              Update relay…
            </Button>
          </div>
        )}
        <RelayUpdateDialog info={info} open={updating} onOpenChange={setUpdating} />
        <JoinReveal />
        <AddressChange origin={info.origin} />
      </CardContent>
    </Card>
  )
}

/**
 * The update, in a window over whatever the reader was looking at.
 *
 * It used to be a form sitting open on the Remote card, which was fine while
 * the Remote card was the only place an update could start. It is not: the
 * shell raises a notice about a stale relay on every screen (relay-update.tsx),
 * and a notice whose only answer is "go to a different page, find the card,
 * scroll to the form" is a notice that costs the reader their place. One
 * surface for the update, opened from either door, and closing it puts them
 * back exactly where they were.
 *
 * Nothing here is dismissed on success. A deploy answers with the steps it
 * took, and those steps are the only account of what just happened to the
 * reader's Cloudflare account — a window that closed itself on the way to
 * them would be a window that hid its own receipt.
 */
export function RelayUpdateDialog({
  info,
  open,
  onOpenChange,
  onDone,
}: {
  info: RelayUIInfo
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone?: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Update the relay</DialogTitle>
          <DialogDescription className={NOTE}>
            {/*
              Only while the two still differ. The window outlives the answer
              that opened it — a successful update re-asks the daemon and the
              versions come back equal — and "deployed by flue 0.3.0; this
              daemon is 0.3.0" is a sentence that reads as a fault.
            */}
            {updateAvailable(info)
              ? `It was deployed by flue ${info.deployed_version}; this daemon is ${info.version}. `
              : ''}
            Updating redeploys the Worker and the web app it serves — the secret, the machine ids
            and every pairing stay, and everything reconnects on its own.
          </DialogDescription>
        </DialogHeader>
        <DeployFlow
          endpoint={UPDATE_ENDPOINT}
          action="Update relay"
          storedToken={info.has_token}
          accountName={info.account_name}
          onDone={onDone}
        />
      </DialogContent>
    </Dialog>
  )
}


/**
 * The custom-domain hand-off: the user routes a domain to the Worker in the
 * Cloudflare dashboard, then tells flue the new name here. A local config
 * rewrite (POST /api/relay/address), nothing minted, and the daemon dials
 * the new name on its next start — which the result says out loud.
 */
function AddressChange({ origin }: { origin?: string }) {
  const [editing, setEditing] = useState(false)
  const [address, setAddress] = useState('')
  const [said, setSaid] = useState('')
  const [error, setError] = useState('')

  async function save(e: FormEvent) {
    e.preventDefault()
    setError('')
    try {
      const res = await fetch('/api/relay/address', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ address }),
      })
      if (!res.ok) throw new Error((await res.text()).trim() || `the daemon answered ${res.status}`)
      const body = (await res.json()) as { origin?: string; restart_needed?: boolean }
      setSaid(
        `The relay address is now ${body.origin ?? address}. Restart the daemon (flue disable && flue enable, or restart flue serve) to dial it.`,
      )
      setEditing(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  if (!editing) {
    return (
      <div className="flex flex-col gap-y-1.5">
        <p className={NOTE}>
          Routed a custom domain to the Worker in the Cloudflare dashboard?{' '}
          <TextButton
            onClick={() => {
              setEditing(true)
              setSaid('')
            }}
          >
            Change the relay address
          </TextButton>
        </p>
        <p role="status" className={cn(NOTE, 'empty:hidden')}>
          {said}
        </p>
      </div>
    )
  }
  return (
    <form onSubmit={save} className="flex flex-col gap-y-2">
      <label htmlFor="cf-address" className={NOTE}>
        The relay's new address — the Worker behind it stays the same, so nothing re-pairs
      </label>
      <Input
        id="cf-address"
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        placeholder={origin ? origin.replace('https://', 'wss://') : 'wss://relay.example.com'}
        className="font-mono"
        spellCheck={false}
        autoComplete="off"
      />
      <div className="flex flex-wrap items-center gap-x-3">
        <Button type="submit" size="sm" disabled={address === ''}>
          Save address
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </div>
      <p role="status" className={cn(NOTE, 'text-red-600 empty:hidden dark:text-red-400')}>
        {error}
      </p>
    </form>
  )
}

/**
 * The join line for adding another machine, behind a click.
 *
 * Behind a click and not on the page, because it carries the fleet secret:
 * the daemon will hand it to this authenticated loopback page whenever asked
 * (/api/relay/join rebuilds it from relay.json), but a secret should cross
 * onto a screen at the moment a human asked to see it, not on every visit.
 * Never rendered on a relay origin: the endpoint does not exist there, and
 * the secret must not be offered to a remote tab.
 */
export function JoinReveal() {
  const [cmd, setCmd] = useState('')
  const [error, setError] = useState('')

  if (isRelayOrigin()) return null

  async function reveal() {
    setError('')
    try {
      const res = await fetch('/api/relay/join', { credentials: 'same-origin' })
      if (!res.ok) throw new Error((await res.text()).trim() || `the daemon answered ${res.status}`)
      const body = (await res.json()) as { join_command?: string }
      setCmd(body.join_command ?? '')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  if (cmd) {
    return (
      <div className="flex flex-col gap-y-1.5">
        <p className={NOTE}>
          Run this on another machine to add it — it carries the relay's secret, so treat it like
          one:
        </p>
        <Copyable text={cmd} />
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-y-1.5">
      <div>
        <Button size="sm" variant="outline" onClick={() => void reveal()}>
          Show the join command
        </Button>
      </div>
      <p role="status" className={cn(NOTE, 'text-red-600 empty:hidden dark:text-red-400')}>
        {error}
      </p>
    </div>
  )
}
