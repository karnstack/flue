import { SELF } from 'cloudflare:test'
import { expect, it } from 'vitest'

it('serves the index route', async () => {
  const res = await SELF.fetch('https://app.flue.sh/')
  expect(res.status).toBe(200)
  expect(await res.text()).toContain('flue')
})
