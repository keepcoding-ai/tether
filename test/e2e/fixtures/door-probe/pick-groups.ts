// Subject: groups in the list picker and the number keys (slice K1.6), the first step of "Dar a … a um agente…". The hooks:
// `pickGroups()` opens the picker without waiting (the test drives the keys), `pickGroupResults()` lists how each one resolved.
import type { PickItem, TetherUi } from '../../../../app/renderer/ext-api.ts'
import type { IDisposable } from '../../../../app/shared/vscode-lifecycle.ts'

const owners: PickItem<string>[] = [
  { value: 'atrium', label: 'Atrium · Claude', icon: 'sparkle', hue: 300, detail: 'mora em atrium · dona de 1 mesa', group: 'Recentes' },
  { value: 'kai', label: 'kai · Claude', icon: 'sparkle', hue: 200, detail: 'ocioso', group: 'Nesta mesa' },
  { value: 'soul', label: 'soul · bancada', icon: 'terminal-window', detail: 'trabalhando', group: 'Nesta mesa' },
  { value: 'codex', label: 'codex · revisão', icon: 'terminal-window', detail: 'geral', group: 'Outras mesas' },
]

export function pickGroups(ui: TetherUi): IDisposable[] {
  const results: unknown[] = []
  ui.test.expose('pickGroupResults', () => results)
  ui.test.expose('pickGroups', () => { void ui.pick.list({ title: 'Dar a mesa kai-aware a…', placeholder: 'buscar agente', items: owners }).then(r => { results.push(r ?? null) }) })
  return []
}
