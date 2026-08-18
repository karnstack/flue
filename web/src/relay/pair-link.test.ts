import { describe, expect, it } from 'vitest'

import { parsePairLink } from './pair-link'

/** The relay origin the page is on, as every test here sees it. */
const ORIGIN = 'https://relay.test'

/** A daemon-shaped link: token and key, no machine appended. */
const PLAIN = 'https://relay.test/pair?t=tok123&k=key456'

describe('parsePairLink', () => {
  it('accepts a daemon-shaped link and hands back its path and search', () => {
    expect(parsePairLink(PLAIN, ORIGIN)).toEqual({
      ok: true,
      target: '/pair?t=tok123&k=key456',
    })
  })

  it('keeps every parameter a relay link carries', () => {
    const link = 'https://relay.test/pair?t=tok&k=key&f=fleet&d=blue-mesa&n=Blue%20Mesa'
    expect(parsePairLink(link, ORIGIN)).toEqual({
      ok: true,
      target: '/pair?t=tok&k=key&f=fleet&d=blue-mesa&n=Blue%20Mesa',
    })
  })

  it('forgives the whitespace a copy drags along', () => {
    expect(parsePairLink(`  ${PLAIN}\n`, ORIGIN)).toEqual({
      ok: true,
      target: '/pair?t=tok123&k=key456',
    })
  })

  it('accepts a bare path, for the paste that lost its host', () => {
    expect(parsePairLink('/pair?t=tok123&k=key456', ORIGIN)).toEqual({
      ok: true,
      target: '/pair?t=tok123&k=key456',
    })
  })

  it('refuses a pairing link minted for some other origin', () => {
    const link = 'https://other.example/pair?t=tok123&k=key456'
    expect(parsePairLink(link, ORIGIN)).toEqual({ ok: false, reason: 'foreign' })
  })

  it('refuses a same-origin link that is not the pairing page', () => {
    expect(parsePairLink('https://relay.test/sessions', ORIGIN)).toEqual({
      ok: false,
      reason: 'unreadable',
    })
  })

  it('refuses prose that is not a link at all', () => {
    expect(parsePairLink('scan the code with this device', ORIGIN)).toEqual({
      ok: false,
      reason: 'unreadable',
    })
  })

  it('refuses an empty paste', () => {
    expect(parsePairLink('   ', ORIGIN)).toEqual({ ok: false, reason: 'unreadable' })
  })

  it('calls out a link that lost its token', () => {
    expect(parsePairLink('https://relay.test/pair?k=key456', ORIGIN)).toEqual({
      ok: false,
      reason: 'incomplete',
    })
  })

  it('calls out a link that lost its key', () => {
    expect(parsePairLink('https://relay.test/pair?t=tok123&k=', ORIGIN)).toEqual({
      ok: false,
      reason: 'incomplete',
    })
  })
})
