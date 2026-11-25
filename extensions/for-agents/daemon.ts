// The for-agents extension in tetherd: the ownership (daemon/ownership.ts), the one reconciler that turns it into the
// door's `held` and rerouted attention (daemon/reconcile.ts), and the gate of raw typing (daemon/guard.ts). The verbs and
// the notices come in their own slices and get the same three pieces from `wire`.
//
// Turned off (the store disposed), every hold of this extension and every route goes; the data stays in its file.
import { toDisposable, type IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { slotTitle } from '../../app/shared/agent-info.ts'
import type { TetherDaemon } from '../../src/daemon/ext-api.ts'
import { OwnershipStore, takesByTyping } from './daemon/ownership.ts'
import { Reconciler } from './daemon/reconcile.ts'
import { WriteGate } from './daemon/guard.ts'
import { bindDeskOwners } from './desk-owners.ts'
import { registerNotices } from './daemon/notices.ts'
import { registerVerbs } from './daemon/verbs.ts'
import { registerWatch } from './daemon/watch.ts'

export { manifest } from './manifest.ts'
/** The same pure rules the renderer draws from. */
export { effective } from './rules.ts'

/** What the next slices of the daemon (verbs, notices, the watch) build on. */
export interface ForAgentsDaemon {
  store: OwnershipStore
  reconciler: Reconciler
  gate: WriteGate
  /** Resolves when the reconciler has nothing left to apply. */
  idle(): Promise<void>
}

/**
 * Builds the pieces and hooks them to the door. The listeners land in the extension's store (the door's `own`); the
 * returned disposable undoes the door's state, and runs after them (it is added last).
 */
export function wire(api: TetherDaemon): { forAgents: ForAgentsDaemon; disposables: IDisposable[] } {
  const store = new OwnershipStore(api.objects, api.desks, undefined, (m) => api.log(m))
  const reconciler = new Reconciler({ slots: api.slots, attention: api.attention, desks: api.desks, store, log: (m) => api.log(m), ready: () => Promise.all([api.objects.ready, api.desks.ready]) })
  const gate = new WriteGate(store, api.slots)
  const typingTakes = (slotId: string): void => {
    if (!takesByTyping(store.effectiveOf(slotId))) return
    store.take({ pane: slotId }, 'taken', 'typing').catch((e: unknown) => api.log(`tomar ${slotId} digitando falhou: ${(e as Error).message}`))
  }
  const forgotten = (slotId: string, name: string): void => {
    store.markEnded(slotId, name).catch((e: unknown) => api.log(`marcar o fim de ${slotId} falhou: ${(e as Error).message}`))
  }
  const disposables: IDisposable[] = [
    ...bindDeskOwners(api.objects),
    api.objects.onDidChange((e) => { store.ownerChanged(e); reconciler.objectChanged(e) }),
    api.objects.onDidDrop((e) => { store.ownerDropped(e); if (e.kind === 'pane') reconciler.paneDropped(e.id) }),
    api.desks.onDidChange((map) => reconciler.deskMapChanged(map)),
    api.slots.onUserTyped(typingTakes),
    // The name the struck mark keeps is read here: by the time a pane object drops, its slot is no longer listed.
    api.onSlot((ev) => { if (ev.kind === 'removed') forgotten(ev.slot.slotId, slotTitle(ev.slot)) }),
    ...registerVerbs(api, { store, gate }),
    ...registerNotices(api, { store, gate }),
    ...registerWatch(api, { store, gate, reconciler }),
    api.onStarted(() => { reconciler.start().catch((e: unknown) => api.log(`a passada de partida falhou: ${(e as Error).message}`)) }),
    toDisposable(() => { reconciler.undo().catch((e: unknown) => api.log(`desfazer a posse falhou: ${(e as Error).message}`)) }),
  ]
  return { forAgents: { store, reconciler, gate, idle: () => reconciler.idle() }, disposables }
}

export function activate(api: TetherDaemon): IDisposable[] {
  return wire(api).disposables
}
