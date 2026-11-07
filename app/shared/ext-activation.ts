// The extension activation every host shares (F9): activates a host index's extensions at startup, in order (`requires`
// first), skipping the ones settings.json `extensions.disabled` lists (that takes effect at the next start, decision 3;
// an extension requiring a disabled one fails with "requer"). A failing `activate` is logged and leaves that extension
// out; the process never goes down for it. Pure: used by the renderer (app/renderer/main.ts) and Electron main
// (app/main/ext-host.ts), later the daemon.
import type { ExtensionEntry } from '../../extensions/types.ts'
import { DisposableStore, toDisposable } from '../shared/vscode-lifecycle.ts'

export interface ActivationResult {
  active: string[]
  disabled: string[]
  failed: { id: string; error: string }[]
}

/** Topological order by `requires`, stable by index position; an unknown or cyclic requirement fails that extension. */
export function activationOrder<A>(list: readonly ExtensionEntry<A>[]): { ordered: ExtensionEntry<A>[]; failed: { id: string; error: string }[] } {
  const byId = new Map(list.map(e => [e.manifest.id, e]))
  const ordered: ExtensionEntry<A>[] = []
  const failed: { id: string; error: string }[] = []
  const state = new Map<string, 'visiting' | 'done' | 'failed'>()
  const visit = (e: ExtensionEntry<A>): boolean => {
    const id = e.manifest.id
    const s = state.get(id)
    if (s === 'done') return true
    if (s === 'failed') return false
    if (s === 'visiting') { state.set(id, 'failed'); failed.push({ id, error: 'dependência circular' }); return false }
    state.set(id, 'visiting')
    for (const r of e.manifest.requires ?? []) {
      const dep = byId.get(r)
      if (!dep || !visit(dep)) {
        if (state.get(id) !== 'failed') failed.push({ id, error: `requer ${r}` })
        state.set(id, 'failed')
        return false
      }
    }
    state.set(id, 'done')
    ordered.push(e)
    return true
  }
  for (const e of list) visit(e)
  return { ordered, failed }
}

/** Activates `list` minus `disabled` with the api `apiFor` builds per extension; everything registered goes into `store`. */
export function activateExtensions<A>(list: readonly ExtensionEntry<A>[], apiFor: (id: string) => A, store: DisposableStore, disabled: readonly string[] = [], onFail?: (id: string, err: unknown) => void): ActivationResult {
  const off = list.filter(e => disabled.includes(e.manifest.id)).map(e => e.manifest.id)
  const { ordered, failed } = activationOrder(list.filter(e => !off.includes(e.manifest.id)))
  const active: string[] = []
  for (const e of ordered) {
    const own = new DisposableStore()
    try {
      for (const d of e.activate(apiFor(e.manifest.id)) ?? []) own.add(d)
      if (e.deactivate) { const deactivate = e.deactivate; own.add(toDisposable(() => deactivate())) }
      store.add(own)
      active.push(e.manifest.id)
    } catch (err) {
      own.dispose()
      const error = err instanceof Error ? err.message : String(err)
      console.error(`extensão ${e.manifest.id}: falha ao ativar: ${error}`)
      failed.push({ id: e.manifest.id, error })
      try { onFail?.(e.manifest.id, err) } catch { /* reporting never changes the outcome */ }
    }
  }
  return { active, disabled: off, failed }
}
