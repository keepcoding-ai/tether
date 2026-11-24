// The daemon's half of a suspended pane. The app suspends an idle agent's pane to save resources: it stops the slot (the
// same `stop` hibernation uses) and marks the pane `suspended` in the desk map. Unlike a hibernated pane, a suspended one
// still counts as working: anything from outside that needs it (a delivery, a verb of its owner, its ronda) resumes it
// first with the slot's `start` (which resumes the session), and the act goes on once the agent is up.
//
// The map is the only source of "suspended" (the daemon keeps it in desks.json, so this works with the app closed). A
// resume that arrives while the slot is still stopping is remembered and runs when the process is gone. No timer per slot:
// waiters are settled by the `stateChanged` edge the server already fires, and each waiter has its own give-up timeout.
import type { SlotState } from '../protocol.ts'
import type { SlotPort } from './port.ts'

/** How long `awake` waits for a resumed agent to come up before giving the caller the state as it is. */
export const AWAKE_TIMEOUT_MS = 120_000

/** What resuming a suspended pane needs to know of the desk map. */
export interface SuspendedPanes {
  isSuspended(paneId: string): boolean
}

export interface SuspendWakerOptions {
  port(): SlotPort | undefined
  panes(): SuspendedPanes | undefined
  log(msg: string): void
}

const LIVE = new Set(['running', 'starting', 'queued'])
/** States after which waiting longer brings nothing: the start failed or needs the person. */
const SETTLED = new Set(['error', 'unconfirmed'])

interface Waiter { resolve: (s: SlotState | undefined) => void; timer: ReturnType<typeof setTimeout> }

export class SuspendWaker {
  private readonly opts: SuspendWakerOptions
  /** Slots whose start is in flight: one start per slot, however many callers asked. */
  private readonly starting = new Map<string, Promise<void>>()
  /** Slots asked to resume while their process was still going away (the stop of the suspension under way). */
  private readonly pendingAfterExit = new Set<string>()
  /** Callers waiting for a resumed slot to be up, by slot. */
  private readonly waiters = new Map<string, Set<Waiter>>()

  constructor(opts: SuspendWakerOptions) {
    this.opts = opts
  }

  /** The pane is suspended in the app (desk map). */
  isSuspended(slotId: string): boolean {
    return this.opts.panes()?.isSuspended(slotId) === true
  }

  /**
   * Resumes the slot when its pane is suspended and its process is gone; nothing otherwise. Returns whether a resume is
   * under way (started now, already starting, or deferred until the stopping process exits).
   */
  resume(slotId: string, why: string): boolean {
    const port = this.opts.port()
    if (!port || !this.isSuspended(slotId)) return false
    if (this.starting.has(slotId)) return true
    const state = port.stateOf(slotId)
    if (!state) return false
    if (port.isAlive(slotId) || LIVE.has(state.status)) {
      // Live and marked suspended: the suspension's stop is still under way. Resume once the process is gone.
      if (state.stopping || port.isAlive(slotId)) { this.pendingAfterExit.add(slotId); return true }
      return false
    }
    this.opts.log(`door: guia suspensa ${slotId} retomada (${why})`)
    const run = port.start(slotId).then(() => undefined, (e: unknown) => {
      this.opts.log(`door: retomar a guia suspensa ${slotId} falhou: ${e instanceof Error ? e.message : String(e)}`)
      this.settle(slotId, port.stateOf(slotId))
    }).finally(() => { this.starting.delete(slotId) })
    this.starting.set(slotId, run)
    return true
  }

  /**
   * Resumes a suspended pane and resolves once its agent is up ('running'), the start settles without it ('error',
   * 'unconfirmed') or `timeoutMs` passes; then with the slot's state at that moment. A pane that is not suspended (or a
   * slot that is already running) resolves at once with its state.
   */
  awake(slotId: string, why: string, timeoutMs = AWAKE_TIMEOUT_MS): Promise<SlotState | undefined> {
    const port = this.opts.port()
    const now = port?.stateOf(slotId)
    if (!port || !now || now.status === 'running' && !now.stopping) return Promise.resolve(now)
    if (!this.resume(slotId, why) && !LIVE.has(now.status)) return Promise.resolve(now)
    return new Promise((resolve) => {
      const set = this.waiters.get(slotId) ?? new Set<Waiter>()
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => { set.delete(waiter); if (set.size === 0) this.waiters.delete(slotId); resolve(port.stateOf(slotId)) }, timeoutMs),
      }
      waiter.timer.unref?.()
      set.add(waiter)
      this.waiters.set(slotId, set)
    })
  }

  /** The server's `stateChanged`: a deferred resume runs once the process is gone; waiters settle once the agent is up. */
  stateChanged(state: SlotState): void {
    const slotId = state.slotId
    if (this.pendingAfterExit.has(slotId) && !LIVE.has(state.status) && !this.opts.port()?.isAlive(slotId)) {
      this.pendingAfterExit.delete(slotId)
      this.resume(slotId, 'pedido durante a suspensão')
    }
    if (state.status === 'running' && !state.stopping) this.settle(slotId, state)
    else if (SETTLED.has(state.status)) this.settle(slotId, state)
  }

  /** The slot was forgotten: nothing of it stays here. */
  forgotten(slotId: string): void {
    this.pendingAfterExit.delete(slotId)
    this.settle(slotId, undefined)
  }

  private settle(slotId: string, state: SlotState | undefined): void {
    const set = this.waiters.get(slotId)
    if (!set) return
    this.waiters.delete(slotId)
    for (const w of set) { clearTimeout(w.timer); w.resolve(state) }
  }
}
