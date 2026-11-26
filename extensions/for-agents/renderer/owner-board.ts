// The owner board of for-agents: who owns each desk and each pane, for anyone to read (the Regency does). Pure: no runtime
// import of the app or the daemon, and it knows nothing of its readers. `marks.ts` publishes into it on every pass.
// With for-agents off the board is inactive and empty.
import type { Ownership } from '../rules.ts'

export interface OwnerBoard {
  /** for-agents is on and publishing in this process. */
  readonly active: boolean
  deskOwner(deskId: string): Ownership | undefined
  paneOwner(paneId: string): Ownership | undefined
  /** Fires when what the board holds changes (an equal publication does not fire). */
  onDidChange(listener: () => void): { dispose(): void }
}

export interface OwnerBoardPublisher extends OwnerBoard {
  /** Replaces the whole board. Equal content does not notify. */
  publish(desks: ReadonlyMap<string, Ownership>, panes: ReadonlyMap<string, Ownership>): void
  /** Off clears the board without notifying (the readers keep what they have). */
  setActive(on: boolean): void
}

const signature = (m: ReadonlyMap<string, Ownership>): string => JSON.stringify([...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))

export function createOwnerBoard(): OwnerBoardPublisher {
  let desks = new Map<string, Ownership>()
  let panes = new Map<string, Ownership>()
  let sig = ''
  let active = false
  const listeners = new Set<() => void>()
  return {
    get active() { return active },
    deskOwner: (id) => desks.get(id),
    paneOwner: (id) => panes.get(id),
    onDidChange(listener) {
      listeners.add(listener)
      return { dispose: () => { listeners.delete(listener) } }
    },
    publish(d, p) {
      if (!active) return
      const next = signature(d) + signature(p)
      if (next === sig) return
      sig = next
      desks = new Map(d)
      panes = new Map(p)
      for (const l of [...listeners]) l()
    },
    setActive(on) {
      if (on === active) return
      active = on
      if (!on) { desks = new Map(); panes = new Map(); sig = '' }
    },
  }
}

/** The one of the process: for-agents feeds it, any reader may read it. */
export const ownerBoard: OwnerBoardPublisher = createOwnerBoard()
