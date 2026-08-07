import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CloudflareConfiguredCard,
  CloudflareConnectCard,
  updateAvailable,
  type RelayUIInfo,
} from './cloudflare-connect'

/*
 * The deploy conversation, against a scripted daemon. What these pin, beyond
 * the happy path: the token goes exactly where it is typed to go and nowhere
 * else this component controls, the account question is a round trip that
 * re-sends it, and a daemon error lands on the screen instead of vanishing.
 */

const INFO: RelayUIInfo = { configured: false, can_deploy: true, version: 'dev' }

type FetchArgs = { url: string; body: Record<string, unknown> }

/** Stub fetch, recording every POST body, answering from a script. */
function stubFetch(answers: object[]) {
  const calls: FetchArgs[] = []
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    })
    const answer = answers.shift()
    if (!answer) throw new Error('unscripted fetch')
    if (answer instanceof Error) {
      return new Response(answer.message, { status: 502 })
    }
    return new Response(JSON.stringify(answer), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', impl)
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function typeTokenAndDeploy(token: string) {
  const user = userEvent.setup()
  await user.type(screen.getByLabelText(/API token/), token)
  await user.click(screen.getByRole('button', { name: 'Deploy to Cloudflare' }))
  return user
}

describe('CloudflareConnectCard', () => {
  it('deploys with the typed token and shows the steps and the join line once', async () => {
    const calls = stubFetch([
      {
        steps: ['token verified', 'worker deployed: flue-relay', 'secret set'],
        origin: 'https://flue-relay.karn.workers.dev',
        join_command: 'flue relay join wss://flue-relay.karn.workers.dev --secret s3cret',
      },
    ])
    render(<CloudflareConnectCard info={INFO} setupCommand="flue relay setup" />)

    await typeTokenAndDeploy('cf-token-1')

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('/api/relay/deploy')
    expect(calls[0]!.body.token).toBe('cf-token-1')
    expect(calls[0]!.body.worker).toBe('flue-relay')

    expect(await screen.findByText('worker deployed: flue-relay')).toBeTruthy()
    expect(screen.getByText(/To add another machine/)).toBeTruthy()
    expect(
      screen.getByText('flue relay join wss://flue-relay.karn.workers.dev --secret s3cret'),
    ).toBeTruthy()
    expect(screen.getByText(/also available from this screen later/)).toBeTruthy()
    // The form is gone: the flow is over and the token state was cleared.
    expect(screen.queryByLabelText(/API token/)).toBeNull()
  })

  it('asks which account when the daemon does, and re-sends the token with the answer', async () => {
    const calls = stubFetch([
      {
        needs_account: true,
        accounts: [
          { id: 'a-1', name: 'personal' },
          { id: 'a-2', name: 'work' },
        ],
      },
      { steps: ['worker deployed: flue-relay'] },
    ])
    render(<CloudflareConnectCard info={INFO} setupCommand="flue relay setup" />)

    const user = await typeTokenAndDeploy('cf-token-2')

    expect(await screen.findByText(/Which should the relay live in/)).toBeTruthy()
    await user.click(screen.getByRole('radio', { name: 'work' }))
    await user.click(screen.getByRole('button', { name: 'Deploy to Cloudflare' }))

    expect(calls).toHaveLength(2)
    expect(calls[1]!.body.account_id).toBe('a-2')
    expect(calls[1]!.body.token).toBe('cf-token-2')
    expect(await screen.findByText('worker deployed: flue-relay')).toBeTruthy()
  })

  it('shows the daemon error and keeps the form', async () => {
    stubFetch([new Error('deploy the relay worker: cloudflare said no')])
    render(<CloudflareConnectCard info={INFO} setupCommand="flue relay setup" />)

    await typeTokenAndDeploy('cf-token-3')

    expect(await screen.findByText(/cloudflare said no/)).toBeTruthy()
    expect(screen.getByLabelText(/API token/)).toBeTruthy()
  })

  it('shows the reason instead of the form when the daemon cannot deploy', () => {
    render(
      <CloudflareConnectCard
        info={{ configured: false, can_deploy: false, can_deploy_reason: 'this build carries no relay worker', version: 'dev' }}
        setupCommand="flue relay setup"
      />,
    )
    expect(screen.getByText(/carries no relay worker/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Deploy to Cloudflare' })).toBeNull()
  })
})

describe('CloudflareConfiguredCard', () => {
  it('names both versions and posts to update', async () => {
    const calls = stubFetch([{ steps: ['worker deployed: flue-relay'] }])
    const info: RelayUIInfo = {
      configured: true,
      can_deploy: true,
      version: '0.2.0',
      deployed_version: '0.1.0',
      worker: 'flue-relay',
    }
    render(<CloudflareConfiguredCard info={info} />)

    expect(screen.getByText(/deployed by flue 0\.1\.0/)).toBeTruthy()
    const user = userEvent.setup()
    await user.type(screen.getByLabelText(/API token/), 't')
    await user.click(screen.getByRole('button', { name: 'Update relay' }))

    expect(calls[0]!.url).toBe('/api/relay/update')
    expect(await screen.findByText('worker deployed: flue-relay')).toBeTruthy()
  })

  it('updates with one click when a token is stored', async () => {
    const calls = stubFetch([{ steps: ['worker deployed: flue-relay'] }])
    const info: RelayUIInfo = {
      configured: true,
      can_deploy: true,
      version: '0.2.0',
      deployed_version: '0.1.0',
      worker: 'flue-relay',
      has_token: true,
      account_name: 'personal',
    }
    render(<CloudflareConfiguredCard info={info} />)

    // No token field: the stored credential answers, named by account.
    expect(screen.queryByLabelText(/API token/)).toBeNull()
    expect(screen.getByText(/Using the stored token for personal/)).toBeTruthy()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Update relay' }))

    expect(calls[0]!.url).toBe('/api/relay/update')
    expect(calls[0]!.body.token).toBeUndefined()
    expect(await screen.findByText('worker deployed: flue-relay')).toBeTruthy()
  })

  it('shows where the relay lives when nothing needs updating', () => {
    render(
      <CloudflareConfiguredCard
        info={{
          configured: true,
          can_deploy: true,
          version: 'v1',
          deployed_version: 'v1',
          worker: 'flue-relay-dev',
          account_name: 'personal',
        }}
      />,
    )
    expect(screen.getByText(/Deployed into personal/)).toBeTruthy()
    expect(screen.getByText(/nothing to update/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Update relay' })).toBeNull()
  })
})

describe('updateAvailable', () => {
  it('is true only for a configured relay reporting a different version', () => {
    expect(updateAvailable(null)).toBe(false)
    expect(updateAvailable({ configured: false, can_deploy: true, version: 'v' })).toBe(false)
    expect(
      updateAvailable({ configured: true, can_deploy: true, version: 'v', deployed_version: 'v' }),
    ).toBe(false)
    expect(
      updateAvailable({ configured: true, can_deploy: true, version: 'v2', deployed_version: 'v1' }),
    ).toBe(true)
  })
})
