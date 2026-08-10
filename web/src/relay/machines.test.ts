import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'

import { loadPinnedDaemonKeyFor, savePinnedDaemonKeyFor } from '@/crypto/keys'
import {
  bootMachine,
  forgetMachine,
  listMachines,
  MACHINE_ID,
  mergeMachines,
  saveMachine,
  SELECTED_KEY,
  type MachineRecord,
} from './machines'

/** A machine's static public key, as pairing would have pinned it. */
const PUB = Uint8Array.from({ length: 32 }, (_, i) => i + 1)

const MESA: MachineRecord = { id: 'blue-mesa', name: 'Blue Mesa', pairedAt: 1_700_000_000_000 }
const ATTIC: MachineRecord = { id: 'attic-pi', name: 'Attic Pi', pairedAt: 1_700_000_001_000 }

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  // jsdom ships no IndexedDB, and forgetting a machine reaches for the default
  // factory the way a browser does.
  vi.stubGlobal('indexedDB', new IDBFactory())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the machine-id grammar', () => {
  it('is the relay router’s: a lowercase hostname-shaped slug', () => {
    // The same regex the Worker routes by (relay/src/index.ts). A record this
    // grammar refuses is one the relay would answer 404 for anyway.
    expect(MACHINE_ID.test('blue-mesa')).toBe(true)
    expect(MACHINE_ID.test('a')).toBe(true)
    expect(MACHINE_ID.test('Blue-Mesa')).toBe(false)
    expect(MACHINE_ID.test('-mesa')).toBe(false)
    expect(MACHINE_ID.test('')).toBe(false)
    expect(MACHINE_ID.test('a'.repeat(64))).toBe(false)
  })
})

describe('listMachines and saveMachine', () => {
  it('round-trips a record', () => {
    saveMachine(MESA)
    expect(listMachines()).toEqual([MESA])
  })

  it('keeps one record per id, the newest', () => {
    // A device id is derived from the machine's key, so pairing twice under
    // the same id is the same machine renamed — not a second row.
    saveMachine(MESA)
    saveMachine({ ...MESA, name: 'Renamed' })
    expect(listMachines()).toEqual([{ ...MESA, name: 'Renamed' }])
  })

  it('is empty in a browser that never paired', () => {
    expect(listMachines()).toEqual([])
  })

  it('reads corrupt storage as no machines at all', () => {
    // Whatever an extension, a migration or a hand edit left behind: the
    // picker rendering [] and offering pairing beats an exception at boot.
    for (const raw of ['not json', '{"a":1}', '"a string"', '[{"id":42}]', '[null]']) {
      localStorage.setItem('flue.machines', raw)
      expect(listMachines()).toEqual([])
    }
  })

  it('drops records whose id the relay would refuse', () => {
    localStorage.setItem(
      'flue.machines',
      JSON.stringify([MESA, { id: 'Not-Valid', name: 'x', pairedAt: 1 }]),
    )
    expect(listMachines()).toEqual([MESA])
  })
})

describe('forgetMachine', () => {
  it('removes the record and the pinned key with it', async () => {
    saveMachine(MESA)
    saveMachine(ATTIC)
    await savePinnedDaemonKeyFor(MESA.id, PUB)

    await forgetMachine(MESA.id)

    expect(listMachines()).toEqual([ATTIC])
    // The key goes with the record: a browser that forgot a machine holds
    // nothing that could open a channel to it.
    expect(await loadPinnedDaemonKeyFor(MESA.id)).toBeNull()
  })

  it('leaves every other machine’s key alone', async () => {
    saveMachine(MESA)
    saveMachine(ATTIC)
    await savePinnedDaemonKeyFor(MESA.id, PUB)
    await savePinnedDaemonKeyFor(ATTIC.id, PUB)

    await forgetMachine(MESA.id)

    expect(await loadPinnedDaemonKeyFor(ATTIC.id)).toEqual(PUB)
  })

  it('keeps the record when the key will not go, so forget can be tried again', async () => {
    // The key goes first and the record only after it: a forget that failed
    // halfway must leave the half the user sees — the row — so they can try
    // again, where a record dropped first would hide a credential the browser
    // still holds.
    saveMachine(MESA)
    vi.stubGlobal('indexedDB', {
      open() {
        throw new Error('the key store is gone')
      },
    })

    await expect(forgetMachine(MESA.id)).rejects.toThrow()
    expect(listMachines()).toEqual([MESA])
  })
})

describe('bootMachine', () => {
  it('is null with nothing paired', () => {
    expect(bootMachine()).toBeNull()
  })

  it('auto-selects the only machine there is', () => {
    // One machine is the common case, and a picker with one row would be a
    // door that asks a question with one answer.
    saveMachine(MESA)
    expect(bootMachine()).toEqual(MESA)
  })

  it('is null with two machines and no selection — the picker decides', () => {
    saveMachine(MESA)
    saveMachine(ATTIC)
    expect(bootMachine()).toBeNull()
  })

  it('honours the tab’s selection', () => {
    saveMachine(MESA)
    saveMachine(ATTIC)
    sessionStorage.setItem(SELECTED_KEY, ATTIC.id)
    expect(bootMachine()).toEqual(ATTIC)
  })

  it('ignores a selection pointing at a machine that was forgotten', () => {
    saveMachine(MESA)
    saveMachine(ATTIC)
    sessionStorage.setItem(SELECTED_KEY, 'gone-machine')
    expect(bootMachine()).toBeNull()
  })
})

describe('mergeMachines', () => {
  it('lists the stored records when the fleet named none', () => {
    expect(mergeMachines([MESA, ATTIC], [])).toEqual([
      { id: 'blue-mesa', name: 'Blue Mesa', via: 'pairing' },
      { id: 'attic-pi', name: 'Attic Pi', via: 'pairing' },
    ])
  })

  it('adds a machine the fleet named and this browser never paired with', () => {
    // The whole point of the directory: a machine that ran `flue relay join`
    // last week appears without anybody scanning anything.
    expect(mergeMachines([MESA], [{ id: 'loft-9f9f', name: 'Loft' }])).toEqual([
      { id: 'blue-mesa', name: 'Blue Mesa', via: 'pairing' },
      { id: 'loft-9f9f', name: 'Loft', via: 'directory' },
    ])
  })

  it('does not list a machine twice when both know it', () => {
    const merged = mergeMachines([MESA], [{ id: 'blue-mesa', name: 'Blue Mesa' }])
    expect(merged).toHaveLength(1)
    expect(merged[0]!.via).toBe('pairing')
  })

  it('takes the fleet’s name for a machine that was renamed', () => {
    // The stored name was copied out of a pairing link at some past moment;
    // the fleet's is the machine's own word, signed and re-minted when it is
    // renamed. The machine knows what it is called.
    const merged = mergeMachines([MESA], [{ id: 'blue-mesa', name: 'Mesa Verde' }])
    expect(merged[0]).toEqual({ id: 'blue-mesa', name: 'Mesa Verde', via: 'pairing' })
  })

  it('keeps the stored name when the fleet’s is empty', () => {
    const merged = mergeMachines([MESA], [{ id: 'blue-mesa', name: '' }])
    expect(merged[0]!.name).toBe('Blue Mesa')
  })

  it('falls back to the id for a fleet machine with no name at all', () => {
    expect(mergeMachines([], [{ id: 'loft-9f9f', name: '' }])[0]).toEqual({
      id: 'loft-9f9f',
      name: 'loft-9f9f',
      via: 'directory',
    })
  })

  it('refuses a fleet id outside the grammar the relay routes', () => {
    // A certificate is signed, not sanitised. An id the Worker answers 404
    // for is a row that could only ever fail to connect, wherever it came
    // from — and one carrying a slash would be a path, not an id.
    expect(
      mergeMachines([], [
        { id: 'Loft', name: 'capitals' },
        { id: 'a/b', name: 'a path' },
        { id: '', name: 'nothing' },
        { id: 'loft-9f9f', name: 'Loft' },
      ]).map((m) => m.id),
    ).toEqual(['loft-9f9f'])
  })

  it('holds no key of any kind', () => {
    // The line this module lives on: what the UI lists, never what the
    // handshake spends. The `noise` key stays with whoever verified it.
    const merged = mergeMachines([MESA], [{ id: 'loft-9f9f', name: 'Loft' }])
    for (const row of merged) expect(Object.keys(row).sort()).toEqual(['id', 'name', 'via'])
  })
})
