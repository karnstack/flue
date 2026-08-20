import { describe, expect, it } from 'vitest'

import { machineChipFor } from './terminal'

/**
 * The fleet as the terminal route reads it: the machines that are answering
 * right now, named. `local` is the machine the tab rides, which is only the
 * machine the reader is at when the daemon served the page itself.
 */
const MESA = { id: 'local', name: 'mesa.local' }
const ATTIC = { id: 'attic-pi', name: 'Attic Pi' }

describe('machineChipFor', () => {
  it('names the machine a session runs on, once there are two to tell apart', () => {
    expect(machineChipFor([MESA, ATTIC], 'attic-pi', true)).toEqual({
      name: 'Attic Pi',
      home: false,
    })
  })

  it('calls the ridden machine this one on a tab its own daemon served', () => {
    expect(machineChipFor([MESA, ATTIC], 'local', true)).toEqual({
      name: 'mesa.local',
      home: true,
    })
  })

  it('claims no local machine on a relay tab, ride included', () => {
    // The phone case: `local` is still the machine this tab rides, and it is
    // reached over the relay exactly like the other one.
    expect(machineChipFor([MESA, ATTIC], 'local', false)).toEqual({
      name: 'mesa.local',
      home: false,
    })
  })

  it('says nothing at all when one machine is reachable', () => {
    // Which machine is not a question here, and the answer would sit over the
    // shell's output for as long as the tab is open.
    expect(machineChipFor([MESA], 'local', true)).toBeUndefined()
    expect(machineChipFor([], 'local', true)).toBeUndefined()
  })

  it('waits for the machine to have a name', () => {
    // The fleet's local source is born nameless and takes one from the
    // daemon's welcome; a chip in between would be an empty box.
    expect(machineChipFor([{ id: 'local', name: '' }, ATTIC], 'local', true)).toBeUndefined()
  })

  it('says nothing about a machine the reachable list does not hold', () => {
    // A session opened on a machine that has since gone quiet: the terminal
    // says so in its own pill, and a chip naming it would not be the fact
    // that matters.
    expect(machineChipFor([MESA, ATTIC], 'loft-9f9f', true)).toBeUndefined()
  })
})
