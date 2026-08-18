import { describe, expect, it } from 'vitest'

import type { FileMsg } from '@/client/protocol'
import { CACHE_ENTRY_MAX, cachedFile, rememberFile } from './cache'

const meta = (over: Partial<FileMsg> = {}): FileMsg => ({
  type: 'file',
  ref: 1,
  path: '/a',
  size: 4,
  mime: 'text/plain; charset=utf-8',
  kind: 'text',
  ...over,
})

const bytes = (n: number) => new Uint8Array(n)

const entry = (over: Partial<FileMsg>, mtime: number, body: Uint8Array) => ({
  meta: meta(over),
  mtime,
  bytes: body,
})

describe('the file cache', () => {
  it('returns what it was given, keyed by client and path', () => {
    const client = {}
    rememberFile(client, '/a', entry({}, 5, bytes(4)))
    expect(cachedFile(client, '/a')?.meta.path).toBe('/a')
    expect(cachedFile(client, '/a')?.mtime).toBe(5)
    expect(cachedFile(client, '/b')).toBeNull()
  })

  it('answers null for a client it never saw', () => {
    expect(cachedFile({}, '/a')).toBeNull()
  })

  it('keeps two clients apart even for one path', () => {
    const one = {}
    const two = {}
    rememberFile(one, '/same', entry({ size: 1 }, 0, bytes(1)))
    rememberFile(two, '/same', entry({ size: 2 }, 0, bytes(2)))
    expect(cachedFile(one, '/same')?.meta.size).toBe(1)
    expect(cachedFile(two, '/same')?.meta.size).toBe(2)
  })

  it('evicts the least recently used entry once the byte budget is crossed', () => {
    const client = {}
    const M = 1 << 20
    rememberFile(client, '/a', entry({ path: '/a' }, 0, bytes(3 * M)))
    rememberFile(client, '/b', entry({ path: '/b' }, 0, bytes(3 * M)))
    rememberFile(client, '/c', entry({ path: '/c' }, 0, bytes(2 * M)))
    expect(cachedFile(client, '/a')).not.toBeNull() // touch /a, so /b is oldest
    rememberFile(client, '/d', entry({ path: '/d' }, 0, bytes(3 * M)))
    expect(cachedFile(client, '/b')).toBeNull()
    expect(cachedFile(client, '/a')).not.toBeNull()
    expect(cachedFile(client, '/c')).not.toBeNull()
    expect(cachedFile(client, '/d')).not.toBeNull()
  })

  it('refuses any single entry past its own cap', () => {
    const client = {}
    rememberFile(client, '/huge', entry({}, 0, bytes(CACHE_ENTRY_MAX + 1)))
    expect(cachedFile(client, '/huge')).toBeNull()
  })

  it('a fresh remember replaces the old bytes for the same path', () => {
    const client = {}
    rememberFile(client, '/a', entry({}, 1, bytes(2)))
    rememberFile(client, '/a', entry({ size: 9 }, 2, bytes(9)))
    expect(cachedFile(client, '/a')?.meta.size).toBe(9)
    expect(cachedFile(client, '/a')?.bytes.length).toBe(9)
    expect(cachedFile(client, '/a')?.mtime).toBe(2)
  })
})
