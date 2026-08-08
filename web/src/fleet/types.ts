/*
 * What the fleet tells the UI, and nothing about how it learned it.
 *
 * These are the shapes the sessions screens consume — a row stamped with the
 * machine it came from, and a machine with a word on whether it can be
 * reached. They live apart from fleet.ts so a component can type against them
 * without importing the client machinery, and apart from client/protocol.ts
 * because nothing here is on the wire: no daemon ever sends a machineId, the
 * fleet stamps it on this side.
 */
import type { SessionInfo } from '@/client/protocol'

/**
 * The three words the UI gets about a machine, folded down from FlueClient's
 * four connection states. `connecting` is the hopeful start — nothing proven
 * either way; `online` is a connection that opened; and `reconnecting` and
 * `closed` both land on `unreachable`, because from a list's point of view
 * they are the same fact: no rows from there are current.
 */
export type MachineStatus = 'connecting' | 'online' | 'unreachable'

/**
 * One session, stamped with the machine it runs on.
 *
 * The stamp is the fleet's, not the daemon's: a daemon reports sessions with
 * no idea the browser is holding several of it side by side. `machineName` is
 * denormalized onto every row on purpose — the sessions screen sorts, groups
 * and filters by it, and a row that carried only the id would push a lookup
 * into every cell that renders.
 */
export interface FleetSession extends SessionInfo {
  machineId: string
  machineName: string
}

/** One machine the fleet holds a client for, as the UI should describe it. */
export interface MachineState {
  id: string
  name: string
  status: MachineStatus
}

/**
 * The id of the machine reached over loopback — the daemon serving this very
 * page. A constant rather than a slot id because a loopback tab has no relay
 * record to take an id from; when the daemon's welcome later names the slot
 * it also holds on a relay, the fleet folds the two into this one.
 */
export const LOCAL_MACHINE_ID = 'local'
