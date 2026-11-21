// Rerouted attention (slice D7): a slot's `done`/`waiting` goes to another slot (its owner) instead of the person. The silence
// is made at the source, in the server's `stateOf` (the `decorate` hook): with a route to a live recipient the state carries
// `attentionFor` and no `attention`, so every consumer that reads `attention` (pill, tab badge, bell, toast, tray) falls quiet
// with no code of its own. The daemon's own attention state (turn, ronda, pause) is untouched: only the SlotState is edited.
// The route lives in the slot's meta (`attentionTo`), so it survives a restart; this service keeps only the reverse index
// recipient -> routed slots, so a recipient that leaves or returns re-emits just the slots that point to it.
import { toDisposable, type DisposableStore } from '../../../app/shared/vscode-lifecycle.ts'
import type { SlotMeta } from '../../core/event.ts'
import type { SlotState } from '../protocol.ts'
import { DoorError, doorUnavailable, type SlotPort } from './port.ts'
import type { DoorAttention } from './types.ts'

export class AttentionRouteService {
  private readonly port: () => SlotPort | undefined
  private readonly log: (msg: string) => void
  /** recipient -> slots routed to it. Built from the metas on first use, then kept by route/unroute/decorate/forgotten. */
  private readonly byRecipient = new Map<string, Set<string>>()
  /** Whether each recipient with routed slots was live at the last look: a change re-emits its routed slots. */
  private readonly wasLive = new Map<string, boolean>()
  private scanned = false

  constructor(port: () => SlotPort | undefined, log: (msg: string) => void) {
    this.port = port
    this.log = log
  }

  // ---- server hooks ------------------------------------------------------------------------------

  /** End of `stateOf`: attention of a routed slot with a live recipient moves from `attention` to `attentionFor`. */
  decorate(meta: SlotMeta, state: SlotState): void {
    const to = meta.attentionTo
    if (!to) return
    this.index(to, meta.slotId)
    if (!state.attention || !this.isLive(to)) return
    state.attentionFor = { slotId: to, value: state.attention }
    delete state.attention
  }

  /** A slot's state went out: if it is a recipient whose liveness changed (it came back, or went), its routed slots are re-sent. */
  stateChanged(state: SlotState): void {
    this.scan()
    const routed = this.byRecipient.get(state.slotId)
    if (!routed || routed.size === 0) return
    const live = this.isLive(state.slotId)
    if (this.wasLive.get(state.slotId) === live) return
    this.wasLive.set(state.slotId, live)
    this.reemit(routed)
  }

  /** The recipient's process ended: its routed slots show their attention to the person again, at once. */
  exited(slotId: string): void {
    this.scan()
    const routed = this.byRecipient.get(slotId)
    if (!routed || routed.size === 0) return
    // After the server finishes the exit: `isAlive` is false by then.
    setImmediate(() => {
      if (this.wasLive.get(slotId) === false) return
      this.wasLive.set(slotId, false)
      this.reemit(routed)
    })
  }

  /** A slot was forgotten: its own route goes, and so does every route that pointed to it. */
  async forgotten(slotId: string): Promise<void> {
    this.scan()
    this.drop(slotId)
    const routed = this.byRecipient.get(slotId)
    this.byRecipient.delete(slotId)
    this.wasLive.delete(slotId)
    const port = this.port()
    if (!port || !routed) return
    for (const id of [...routed]) {
      const meta = port.meta(id)
      if (!meta || meta.attentionTo !== slotId) continue
      delete meta.attentionTo
      try { await port.saveMeta(id) } catch (e) { this.log(`door: não gravei o meta de ${id}: ${(e as Error).message}`) }
      port.broadcastState(id)
    }
  }

  // ---- the extensions' API -----------------------------------------------------------------------

  apiFor(ext: string, own: DisposableStore): DoorAttention {
    const live = (what: string): SlotPort => {
      const port = this.port()
      if (!port) throw doorUnavailable(`${what}, extensão ${ext}`)
      return port
    }
    own.add(toDisposable(() => {}))
    return {
      route: async (slotId, to) => {
        const port = live('attention.route')
        const meta = port.meta(slotId)
        if (!meta) throw new DoorError('unknown-slot', `slot desconhecido: ${slotId}`)
        if (!port.meta(to)) throw new DoorError('unknown-slot', `slot desconhecido: ${to}`)
        if (slotId === to) throw new DoorError('bad-request', 'um slot não desvia a atenção para si mesmo')
        this.scan()
        if (meta.attentionTo === to) return
        this.drop(slotId)
        meta.attentionTo = to
        this.index(to, slotId)
        await port.saveMeta(slotId)
        port.broadcastState(slotId)
      },
      unroute: async (slotId) => {
        const port = live('attention.unroute')
        const meta = port.meta(slotId)
        if (!meta) throw new DoorError('unknown-slot', `slot desconhecido: ${slotId}`)
        if (!meta.attentionTo) return
        this.drop(slotId)
        delete meta.attentionTo
        await port.saveMeta(slotId)
        port.broadcastState(slotId)
      },
      routeOf: (slotId) => this.port()?.meta(slotId)?.attentionTo,
      seen: () => { throw doorUnavailable(`attention.seen, extensão ${ext}: falta o gancho do servidor`) },
    }
  }

  // ---- internals ---------------------------------------------------------------------------------

  /** Recipient exists, has a process and is running or starting. */
  private isLive(to: string): boolean {
    const port = this.port()
    return port !== undefined && port.meta(to) !== undefined && port.isAlive(to)
  }

  private index(to: string, slotId: string): void {
    let set = this.byRecipient.get(to)
    if (!set) { this.byRecipient.set(to, set = new Set()); this.wasLive.set(to, this.isLive(to)) }
    set.add(slotId)
  }

  /** Takes `slotId` out of whichever recipient's set holds it. */
  private drop(slotId: string): void {
    for (const [to, set] of this.byRecipient) {
      if (!set.delete(slotId)) continue
      if (set.size === 0) { this.byRecipient.delete(to); this.wasLive.delete(to) }
    }
  }

  /** Once: routes already in the metas on disk (a restarted daemon) enter the index. */
  private scan(): void {
    const port = this.port()
    if (this.scanned || !port) return
    this.scanned = true
    for (const s of port.list()) {
      const to = port.meta(s.slotId)?.attentionTo
      if (to) this.index(to, s.slotId)
    }
  }

  private reemit(routed: Set<string>): void {
    const port = this.port()
    if (!port) return
    for (const id of [...routed]) {
      if (port.meta(id)) port.broadcastState(id)
    }
  }
}
