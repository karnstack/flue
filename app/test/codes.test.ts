// The passwordless login primitive, tested against a real (local) D1 through
// the same `db()` production uses — the attempt counter, the TTL and the
// single-use burn are all *database* behaviour, and a fake would only prove the
// fake works.
//
// Two things every test below leans on:
//   - the pool isolates storage per test *file*, not per test, so every test
//     uses its own email address and nothing may assume an empty table;
//   - the plaintext code is never returned by `issueLoginCode`. The only way to
//     learn it is the Sender seam, which in this plan is `LogSender` — so the
//     tests capture it exactly where a developer would read it in `wrangler
//     tail`, and that doubles as the assertion that the seam is wired.
import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { db } from '../src/db/client'
import { loginCodes } from '../src/db/schema'
import { base64url, hmacHex, randomCode8, timingSafeEqual } from '../src/lib/tokens'
import { MAX_ATTEMPTS, issueLoginCode, verifyLoginCode } from '../src/server/codes'
import { LogSender, sender } from '../src/server/email/sender'

const SECRET = 'test-code-hmac-secret' // vitest.config.ts binds this

// Nothing else in the process logs JSON, but be strict anyway: a stray
// console.log must not be mistaken for a login code.
type LoginCodeEvent = { evt: string; email: string; code: string }
function loginCodeEvents(calls: unknown[][]): LoginCodeEvent[] {
  const out: LoginCodeEvent[] = []
  for (const [first] of calls) {
    if (typeof first !== 'string') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(first)
    } catch {
      continue
    }
    const e = parsed as Partial<LoginCodeEvent>
    if (e.evt === 'login_code' && typeof e.email === 'string' && typeof e.code === 'string') {
      out.push({ evt: e.evt, email: e.email, code: e.code })
    }
  }
  return out
}

// Run `body` with console.log captured, and return what it logged. (The lines
// are collected into an array rather than read off the spy afterwards:
// mockRestore forgets them.)
async function captureLogs(body: () => Promise<void>): Promise<unknown[][]> {
  const lines: unknown[][] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args)
  })
  try {
    await body()
  } finally {
    spy.mockRestore()
  }
  return lines
}

// Issue a code and read the plaintext back off the Sender seam.
async function issueAndCapture(email: string): Promise<LoginCodeEvent[]> {
  return loginCodeEvents(await captureLogs(() => issueLoginCode(email)))
}

async function issueCode(email: string): Promise<string> {
  const events = await issueAndCapture(email)
  expect(events).toHaveLength(1)
  const code = events[0]?.code
  if (code === undefined) throw new Error('the sender was never handed a code')
  return code
}

function rowsFor(email: string) {
  return db().select().from(loginCodes).where(eq(loginCodes.email, email))
}

// How many characters `body` reads. `timingSafeEqual` is the only thing in
// these paths that walks a string character by character, so this counts
// comparisons — see the two tests that use it.
async function countCharReads(body: () => unknown): Promise<number> {
  const spy = vi.spyOn(String.prototype, 'charCodeAt')
  try {
    await body()
    return spy.mock.calls.length // mockRestore forgets these
  } finally {
    spy.mockRestore()
  }
}

const now = () => Math.floor(Date.now() / 1000)

describe('randomCode8', () => {
  it('draws eight decimal digits from the CSPRNG', () => {
    const spy = vi.spyOn(crypto, 'getRandomValues') // no mockImplementation: calls through
    const codes = new Set<string>()
    let drawn = 0
    try {
      for (let i = 0; i < 200; i++) {
        const code = randomCode8()
        expect(code).toMatch(/^\d{8}$/)
        codes.add(code)
      }
      drawn = spy.mock.calls.length // mockRestore forgets these
    } finally {
      spy.mockRestore()
    }
    // The digits come from crypto.getRandomValues, not Math.random...
    expect(drawn).toBeGreaterThanOrEqual(200)
    // ...and they cover the range: over 10^8 a single collision among 200
    // draws has probability ~2e-4 and two have ~1e-8, so "at most one repeat"
    // is both effectively non-flaky and tight enough to fail on a generator
    // drawing from a small space (100 codes would repeat ~150 times).
    expect(codes.size).toBeGreaterThanOrEqual(199)
  })

  it('left-pads a small draw to eight digits', () => {
    expect(withDraws([42], randomCode8).value).toBe('00000042')
  })

  // 2^32 is not a multiple of 10^8: the top 94_967_296 values of the range fold
  // back onto 00000000-94967295 and would make those codes ~2.4% likelier than
  // the rest (43 draws map to each, against 42 for the others). The draws at
  // and above 42 * 10^8 are the ones that must be thrown away.
  it('redraws a value that would bias the modulo', () => {
    const { value, drawn } = withDraws([4_200_000_000, 4_294_967_295, 5], randomCode8)
    expect(value).toBe('00000005')
    // Both biased draws were discarded, not folded in: 4_200_000_000 % 1e8 is
    // 0 and 4_294_967_295 % 1e8 is 94_967_295, so a missing rejection would be
    // visible as '00000000' or '94967295'.
    expect(drawn).toBe(3)
  })

  it('keeps the largest unbiased draw', () => {
    const { value, drawn } = withDraws([4_199_999_999], randomCode8)
    expect(value).toBe('99999999')
    expect(drawn).toBe(1) // one draw: the boundary is exclusive
  })
})

// Feed randomCode8 a scripted sequence of 32-bit draws, and report how many of
// them it consumed.
function withDraws<T>(draws: number[], body: () => T): { value: T; drawn: number } {
  const spy = vi.spyOn(crypto, 'getRandomValues')
  let i = 0
  spy.mockImplementation(((array: ArrayBufferView) => {
    const next = draws[i++]
    if (next === undefined) throw new Error('randomCode8 drew more values than the test scripted')
    new Uint32Array(array.buffer, array.byteOffset, 1)[0] = next
    return array
  }) as unknown as typeof crypto.getRandomValues)
  try {
    return { value: body(), drawn: spy.mock.calls.length }
  } finally {
    spy.mockRestore()
  }
}

describe('timingSafeEqual', () => {
  it('matches equal strings and rejects a single differing character', () => {
    expect(timingSafeEqual('a'.repeat(64), 'a'.repeat(64))).toBe(true)
    expect(timingSafeEqual(`${'a'.repeat(63)}b`, 'a'.repeat(64))).toBe(false)
    expect(timingSafeEqual('', '')).toBe(true)
  })

  it('rejects a length mismatch without throwing or short-circuiting', () => {
    expect(timingSafeEqual('abc', 'abcd')).toBe(false)
    expect(timingSafeEqual('abcd', 'abc')).toBe(false)
    expect(timingSafeEqual('abc', '')).toBe(false)
    expect(timingSafeEqual('', 'abc')).toBe(false)
  })

  // The property that matters: the work done cannot depend on *where* the
  // strings diverge, or the comparison leaks a prefix oracle one byte at a
  // time. A wall-clock assertion would be flaky, so this counts the character
  // reads instead — the loop's only per-character operation.
  it('reads every character whether the mismatch is first or last', async () => {
    const a = 'a'.repeat(64)
    const early = `b${'a'.repeat(63)}`
    const late = `${'a'.repeat(63)}b`

    const earlyReads = await countCharReads(() => timingSafeEqual(a, early))
    const lateReads = await countCharReads(() => timingSafeEqual(a, late))

    expect(earlyReads).toBe(lateReads)
    // `a === b` would read nothing at all, and an early return on the first
    // mismatch would read 1.
    expect(earlyReads).toBeGreaterThanOrEqual(64)
  })
})

describe('hmacHex', () => {
  it('is HMAC-SHA-256, hex-encoded', async () => {
    // RFC-style known vector, so a refactor to a different primitive (or to a
    // bare digest) cannot pass.
    expect(await hmacHex('key', 'The quick brown fox jumps over the lazy dog')).toBe(
      'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
    )
  })

  it('is keyed: the same message under a different secret is a different hash', async () => {
    const a = await hmacHex('secret-a', '12345678')
    const b = await hmacHex('secret-b', '12345678')
    expect(a).not.toBe(b)
    expect(a).toHaveLength(64)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('base64url', () => {
  it('uses the url alphabet and drops the padding', () => {
    expect(base64url(new Uint8Array([0xfb, 0xff, 0xfe]))).toBe('-__-')
    expect(base64url(new Uint8Array([0x01]))).toBe('AQ')
    expect(base64url(new Uint8Array())).toBe('')
    expect(base64url(new Uint8Array([0x66, 0x6c, 0x75, 0x65]))).toBe('Zmx1ZQ')
  })
})

describe('the sender seam', () => {
  it('is a LogSender, and it logs the code as one json line', async () => {
    expect(sender()).toBeInstanceOf(LogSender)

    const lines = await captureLogs(() => new LogSender().sendLoginCode('a@b.com', '12345678'))
    expect(lines).toEqual([
      [JSON.stringify({ evt: 'login_code', email: 'a@b.com', code: '12345678' })],
    ])
  })
})

describe('issueLoginCode', () => {
  it('writes exactly one row, keyed by the normalized email, with a ten-minute ttl', async () => {
    const before = now()
    const events = await issueAndCapture('  ONE@Example.COM  ')
    const rows = await rowsFor('one@example.com')

    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row?.attempts).toBe(0)
    expect(row?.createdAt).toBeGreaterThanOrEqual(before)
    expect((row?.expiresAt ?? 0) - (row?.createdAt ?? 0)).toBe(600)
    // The address the code was mailed to is the address the row is filed
    // under; anything else makes verification unreachable.
    expect(events[0]?.email).toBe('one@example.com')
    expect(events[0]?.code).toMatch(/^\d{8}$/)
    // The unnormalized spelling is not a second account.
    expect(await rowsFor('  ONE@Example.COM  ')).toHaveLength(0)
  })

  it('stores the hmac, never the code', async () => {
    const code = await issueCode('hash@example.com')
    const [row] = await rowsFor('hash@example.com')

    expect(row?.codeHash).toBe(await hmacHex(SECRET, code))
    expect(row?.codeHash).not.toBe(code)
    // Not merely "the hash column is a hash": no column anywhere in the row
    // carries the plaintext, and a bare SHA-256 (brute-forceable over 10^8 in
    // seconds if D1 leaks) would not match the keyed digest above.
    expect(JSON.stringify(row)).not.toContain(code)
  })

  it('invalidates the prior code for that email', async () => {
    const first = await issueCode('rotate@example.com')
    const second = await issueCode('rotate@example.com')
    expect(second).not.toBe(first) // 1 in 10^8 flake, and a real failure if it repeats

    expect(await rowsFor('rotate@example.com')).toHaveLength(1)
    expect(await verifyLoginCode('rotate@example.com', first)).toEqual({ ok: false })
    expect(await verifyLoginCode('rotate@example.com', second)).toEqual({
      ok: true,
      email: 'rotate@example.com',
    })
  })

  it('leaves another address’s code alone', async () => {
    const mine = await issueCode('mine@example.com')
    await issueCode('yours@example.com')
    expect(await rowsFor('mine@example.com')).toHaveLength(1)
    expect(await verifyLoginCode('mine@example.com', mine)).toEqual({
      ok: true,
      email: 'mine@example.com',
    })
  })

  it('issues for an address with no account at all', async () => {
    // Anti-enumeration: this function does not know or ask whether the address
    // has a user, so it cannot behave differently for one that does. (The
    // *caller* decides whether an address is allowed to receive mail.)
    await issueCode('stranger@example.com')
    expect(await rowsFor('stranger@example.com')).toHaveLength(1)
  })

  it('fails closed when the hmac secret is missing', async () => {
    const bindings = env as unknown as Record<string, unknown>
    const saved = bindings.CODE_HMAC_SECRET
    delete bindings.CODE_HMAC_SECRET
    try {
      // An unset secret must not degrade to hashing under "undefined": that
      // would be a single well-known key for every deployment.
      await expect(issueLoginCode('nosecret@example.com')).rejects.toThrow(/CODE_HMAC_SECRET/)
    } finally {
      bindings.CODE_HMAC_SECRET = saved
    }
    expect(await rowsFor('nosecret@example.com')).toHaveLength(0)
  })
})

describe('verifyLoginCode', () => {
  it('accepts the right code once and burns it', async () => {
    const code = await issueCode('ok@example.com')
    expect(await verifyLoginCode('ok@example.com', code)).toEqual({
      ok: true,
      email: 'ok@example.com',
    })
    expect(await rowsFor('ok@example.com')).toHaveLength(0)
    // Single use: the same code presented again is worth nothing.
    expect(await verifyLoginCode('ok@example.com', code)).toEqual({ ok: false })
  })

  it('normalizes the submitted email the same way issuing did', async () => {
    const code = await issueCode('norm@example.com')
    expect(await verifyLoginCode('  NORM@Example.com ', code)).toEqual({
      ok: true,
      email: 'norm@example.com',
    })
  })

  it('counts a wrong code against the attempt cap', async () => {
    const code = await issueCode('wrong@example.com')
    const wrong = code === '00000000' ? '11111111' : '00000000'

    expect(await verifyLoginCode('wrong@example.com', wrong)).toEqual({ ok: false })
    const [row] = await rowsFor('wrong@example.com')
    expect(row?.attempts).toBe(1)
    // A wrong guess does not invalidate the real code.
    expect(await verifyLoginCode('wrong@example.com', code)).toEqual({
      ok: true,
      email: 'wrong@example.com',
    })
  })

  it('burns the code after five wrong guesses', async () => {
    const code = await issueCode('cap@example.com')
    const wrong = code === '00000000' ? '11111111' : '00000000'

    for (let i = 1; i <= 4; i++) {
      expect(await verifyLoginCode('cap@example.com', wrong)).toEqual({ ok: false })
      const [row] = await rowsFor('cap@example.com')
      expect(row?.attempts).toBe(i)
    }
    // The fifth wrong guess reaches the cap, and the row goes with it: 5
    // guesses out of 10^8 is the whole security argument for an 8-digit code.
    expect(await verifyLoginCode('cap@example.com', wrong)).toEqual({ ok: false })
    expect(await rowsFor('cap@example.com')).toHaveLength(0)
    // Even the correct code is worthless now.
    expect(await verifyLoginCode('cap@example.com', code)).toEqual({ ok: false })
  })

  it('rejects and deletes a row that is already at the cap', async () => {
    // Belt and braces for a row written by an older build (or a partially
    // applied batch): at-or-over the cap is refused on sight, and swept.
    const code = '31415926'
    await db().insert(loginCodes).values({
      id: 'over-cap',
      email: 'overcap@example.com',
      codeHash: await hmacHex(SECRET, code),
      expiresAt: now() + 600,
      attempts: 9,
      createdAt: now(),
    })
    expect(await verifyLoginCode('overcap@example.com', code)).toEqual({ ok: false })
    expect(await rowsFor('overcap@example.com')).toHaveLength(0)
  })

  it('rejects an expired code and sweeps the row', async () => {
    const code = '27182818'
    await db()
      .insert(loginCodes)
      .values({
        id: 'expired',
        email: 'expired@example.com',
        codeHash: await hmacHex(SECRET, code),
        expiresAt: now() - 1, // one second past the ten-minute window
        createdAt: now() - 601,
      })
    expect(await verifyLoginCode('expired@example.com', code)).toEqual({ ok: false })
    expect(await rowsFor('expired@example.com')).toHaveLength(0)
  })

  it('rejects when no code was ever issued', async () => {
    expect(await verifyLoginCode('nobody@example.com', '12345678')).toEqual({ ok: false })
  })

  it('does not accept another address’s code', async () => {
    const code = await issueCode('a@example.com')
    await issueCode('b@example.com')
    expect(await verifyLoginCode('b@example.com', code)).toEqual({ ok: false })
    // ...and the failed cross-use spent one of b's five guesses, not one of a's:
    // the rows are found by address, so nothing leaks sideways.
    const [a] = await rowsFor('a@example.com')
    const [b] = await rowsFor('b@example.com')
    expect(a?.attempts).toBe(0)
    expect(b?.attempts).toBe(1)
  })

  it('lets exactly one of two simultaneous submissions win', async () => {
    // Two tabs, one code. D1 has no interactive transactions, so "read the row
    // then delete it" could hand a session to both; the burn has to be the
    // thing that decides.
    const code = await issueCode('race@example.com')
    const results = await Promise.all([
      verifyLoginCode('race@example.com', code),
      verifyLoginCode('race@example.com', code),
    ])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(await rowsFor('race@example.com')).toHaveLength(0)
  })

  it('spends the guess before it compares, so parallel guesses cannot beat the cap', async () => {
    // The attack the cap exists to stop: fire many submissions at once and hope
    // they all read `attempts` before any increment commits. If the compare
    // happens against a snapshot, every one of them gets a free shot at the
    // code and "5 guesses out of 10^8" becomes "as many as you can hold open".
    //
    // Counted rather than timed, and calibrated against one known comparison so
    // the bound does not depend on how many reads a compare costs.
    const perCompare = await countCharReads(() =>
      timingSafeEqual('a'.repeat(64), 'b'.repeat(64)),
    )
    expect(perCompare).toBeGreaterThan(0)

    const code = await issueCode('burst@example.com')
    const wrong = code === '00000000' ? '11111111' : '00000000'
    const reads = await countCharReads(() =>
      Promise.all(Array.from({ length: 20 }, () => verifyLoginCode('burst@example.com', wrong))),
    )

    // Five compares, not twenty: the burst bought exactly the attempts the cap
    // allows. A snapshot-then-increment implementation lets all 20 through.
    expect(reads).toBeLessThanOrEqual(perCompare * MAX_ATTEMPTS)
    // ...and the code is dead afterwards, cap reached.
    expect(await rowsFor('burst@example.com')).toHaveLength(0)
    expect(await verifyLoginCode('burst@example.com', code)).toEqual({ ok: false })
  })

  it('fails closed when the hmac secret is missing', async () => {
    const code = await issueCode('nosecret2@example.com')
    const bindings = env as unknown as Record<string, unknown>
    const saved = bindings.CODE_HMAC_SECRET
    delete bindings.CODE_HMAC_SECRET
    try {
      await expect(verifyLoginCode('nosecret2@example.com', code)).rejects.toThrow(
        /CODE_HMAC_SECRET/,
      )
    } finally {
      bindings.CODE_HMAC_SECRET = saved
    }
    // Throwing is not the same as burning: the code still works afterwards.
    expect(await verifyLoginCode('nosecret2@example.com', code)).toEqual({
      ok: true,
      email: 'nosecret2@example.com',
    })
  })
})
