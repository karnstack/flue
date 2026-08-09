/*
 * The machines this browser has paired with, on a relay origin that fronts
 * more than one of them.
 *
 * A hosted relay is one origin in front of every machine on every account, so
 * "the daemon this browser is paired to" stopped being a fact about the origin
 * — see DEVICE_RECORD_PREFIX in crypto/keys.ts, which holds the keys. What
 * lives here is the part a picker can show: which ids this browser holds keys
 * for, and what to call them. Names and ids in localStorage, keys in the key
 * store, and this module never holds a key — the two stores part ways at
 * exactly the line between "what the UI lists" and "what the handshake spends".
 *
 * Everything read out of storage is measured rather than believed. localStorage
 * is writable by anything on the origin and survives every deploy, so a corrupt
 * document, a foreign shape or an id the relay would refuse all parse to the
 * same answer an empty store gives: no machines, and the picker's empty state
 * says how to pair one.
 */
import { deletePinnedDaemonKeyFor } from '@/crypto/keys'

/**
 * The machine-id shape: a hostname-shaped slug of 1–63 characters, no
 * capitals. Deliberately the superset of the grammar the relay routes by —
 * relay/src/index.ts, MACHINE_ID, which additionally requires the trailing
 * 8-hex MAC tag every minted id ends in. The browser receives ids from
 * pairing links and never mints or verifies one (it holds no secret to
 * verify with), so what this expression is for is narrower: an id outside it
 * never reaches a URL from here — the Worker answers 404 for it, and a
 * record carrying one is treated as corrupt.
 */
export const MACHINE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/

/** Where the records live. A JSON array of MachineRecord, and nothing else. */
const MACHINES_KEY = 'flue.machines'

/**
 * Which machine this tab is riding, in sessionStorage rather than local: a
 * selection is a fact about the tab — two tabs on two machines is the point of
 * a picker — and a browser restart returning to the picker beats one silently
 * reopening whatever was current last week.
 */
export const SELECTED_KEY = 'flue.machine.selected'

/** One machine this browser holds a pinned key for. */
export interface MachineRecord {
  /** The relay slot — the `<id>` in `/client/<id>` — and the pin's key. */
  id: string
  /** The human label, for lists and titles. Never for URLs. */
  name: string
  /** When this browser's pairing ceremony finished, ms since epoch. */
  pairedAt: number
}

/** Whether a parsed value is a record this module is willing to list. */
function isRecord(value: unknown): value is MachineRecord {
  const r = value as MachineRecord | null
  return (
    typeof r?.id === 'string' &&
    MACHINE_ID.test(r.id) &&
    typeof r.name === 'string' &&
    typeof r.pairedAt === 'number' &&
    Number.isFinite(r.pairedAt)
  )
}

/**
 * Every machine this browser has written down, in stored order.
 *
 * Corrupt storage — unparseable JSON, a non-array, rows of the wrong shape or
 * ids outside the grammar — reads as no machines at all rather than as an
 * exception at the entry point: the picker's empty state offers pairing, which
 * is also the way back from whatever mangled the store. A storage the browser
 * will not open at all (private modes exist) lands on the same answer.
 */
export function listMachines(): MachineRecord[] {
  let raw: string | null
  try {
    raw = localStorage.getItem(MACHINES_KEY)
  } catch {
    return []
  }
  if (raw === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  // Copied field by field, so a row that smuggled extra properties in through
  // storage does not carry them back out through this module's type.
  return parsed
    .filter(isRecord)
    .map(({ id, name, pairedAt }) => ({ id, name, pairedAt }))
}

/**
 * Write one machine down, replacing any record under the same id.
 *
 * Overwrite for the reason savePinnedDaemonKeyFor gives: an id is one
 * machine's slot on the relay, so pairing again under the same id is the same
 * machine — renamed, or re-keyed — and not a second row. Throws if storage
 * refuses the write; the pairing page treats that as it treats a key store
 * that will not keep the pin.
 */
export function saveMachine(record: MachineRecord): void {
  const rest = listMachines().filter((m) => m.id !== record.id)
  localStorage.setItem(MACHINES_KEY, JSON.stringify([...rest, record]))
}

/**
 * Forget one machine: the pinned key first, the record only after it.
 *
 * The order is the promise. The record is the half the user sees — the row
 * — and the key is the credential behind it, so a forget that fails halfway
 * must fail with the row still standing: the user sees it, is told, and tries
 * again. Dropped the other way round, a refused key delete would leave a
 * browser that lists nothing and can still handshake — a credential the UI no
 * longer admits to holding. Both halves are idempotent — forgetting a machine
 * that was never written succeeds — because the state the caller asked for is
 * "not there", and it is.
 */
export async function forgetMachine(id: string): Promise<void> {
  await deletePinnedDaemonKeyFor(id)
  const rest = listMachines().filter((m) => m.id !== id)
  localStorage.setItem(MACHINES_KEY, JSON.stringify(rest))
}

/**
 * The machine this tab should boot against, or null when that is the picker's
 * question to ask.
 *
 * The tab's own selection wins when it still names a listed machine; a
 * selection pointing at a forgotten one is ignored rather than honoured into a
 * client that can never connect. With no selection, a browser holding exactly
 * one machine rides it — a picker with one row would be a door asking a
 * question with one answer — and anything else is null, which the entry point
 * renders as the picker.
 */
export function bootMachine(): MachineRecord | null {
  const machines = listMachines()
  let selected: string | null
  try {
    selected = sessionStorage.getItem(SELECTED_KEY)
  } catch {
    selected = null
  }
  const chosen = machines.find((m) => m.id === selected)
  if (chosen !== undefined) return chosen
  if (machines.length === 1) return machines[0]!
  return null
}
