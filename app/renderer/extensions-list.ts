// The rows of the "Extensões" screen (F9 decision 13): every extension any host knows, merged by id (the renderer's
// manifests and the ones Electron main reports), with the state it runs in now and the state the person asked for.
// The toggle writes settings.json `extensions.disabled`; a change takes effect at "Reiniciar o app" (decision 3), so
// a row whose wanted state differs from the running one says so. Pure, unit-tested.
import type { ExtensionSummary, Host } from '../../extensions/types.ts'

export type ExtensionState = 'enabled' | 'disabled' | 'failed'

export interface ExtensionRow {
  id: string
  displayName: string
  version: string
  description: string
  hosts: Host[]
  optional: boolean
  /** How it runs now (since the app started). */
  state: ExtensionState
  /** On at the next start (settings.json `extensions.disabled` does not list it). */
  wanted: boolean
  /** The next start changes it (the toggle was used since this one). */
  pending: boolean
  /** Why it failed to activate (the first host that said so). */
  error?: string
}

export const STATE_LABEL: Record<ExtensionState, string> = { enabled: 'Ligada', disabled: 'Desligada', failed: 'Falhou ao ativar' }

/**
 * `disabled`: what settings.json lists now (the wanted state); `running`: what was disabled when the app started
 * (the renderer's activation; defaults to `disabled`, nothing pending).
 */
export function extensionRows(sources: { manifests: readonly ExtensionSummary[]; failed: readonly { id: string; error: string }[] }[], disabled: readonly string[], running: readonly string[] = disabled): ExtensionRow[] {
  const byId = new Map<string, ExtensionRow>()
  for (const s of sources) for (const m of s.manifests) {
    const row = byId.get(m.id)
    if (row) { for (const h of m.hosts) if (!row.hosts.includes(h)) row.hosts.push(h); continue }
    const wanted = !disabled.includes(m.id)
    const on = !running.includes(m.id)
    byId.set(m.id, { id: m.id, displayName: m.displayName, version: m.version, description: m.description ?? '', hosts: [...m.hosts], optional: m.optional === true, state: on ? 'enabled' : 'disabled', wanted, pending: wanted !== on })
  }
  for (const s of sources) for (const f of s.failed) {
    const row = byId.get(f.id)
    if (row && row.state === 'enabled') { row.state = 'failed'; row.error = f.error }
  }
  return [...byId.values()].sort((a, b) => a.displayName.localeCompare(b.displayName, 'pt-BR'))
}
