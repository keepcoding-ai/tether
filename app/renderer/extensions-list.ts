// The rows of the "Extensões" screen (F9 decision 13): every extension any host knows, merged by id (the renderer's
// manifests and the ones Electron main reports), with its state. Read-only in slice 0b; the toggle comes in slice 1
// (it writes settings.json `extensions.disabled` and asks for "Reiniciar o app"). Pure, unit-tested.
import type { ExtensionManifest, Host } from '../../extensions/types.ts'

export type ExtensionState = 'enabled' | 'disabled' | 'failed'

export interface ExtensionRow {
  id: string
  displayName: string
  version: string
  description: string
  hosts: Host[]
  optional: boolean
  state: ExtensionState
  /** Why it failed to activate (the first host that said so). */
  error?: string
}

export const STATE_LABEL: Record<ExtensionState, string> = { enabled: 'Ligada', disabled: 'Desligada', failed: 'Falhou ao ativar' }

export function extensionRows(sources: { manifests: readonly ExtensionManifest[]; failed: readonly { id: string; error: string }[] }[], disabled: readonly string[]): ExtensionRow[] {
  const byId = new Map<string, ExtensionRow>()
  for (const s of sources) for (const m of s.manifests) {
    const row = byId.get(m.id)
    if (row) { for (const h of m.hosts) if (!row.hosts.includes(h)) row.hosts.push(h); continue }
    byId.set(m.id, { id: m.id, displayName: m.displayName, version: m.version, description: m.description ?? '', hosts: [...m.hosts], optional: m.optional === true, state: disabled.includes(m.id) ? 'disabled' : 'enabled' })
  }
  for (const s of sources) for (const f of s.failed) {
    const row = byId.get(f.id)
    if (row && row.state === 'enabled') { row.state = 'failed'; row.error = f.error }
  }
  return [...byId.values()].sort((a, b) => a.displayName.localeCompare(b.displayName, 'pt-BR'))
}
