// The probe's renderer side: TetherUi.agents as `window.__tether.ext['agents-probe']`.
import type { AgentPane, TetherUi } from '../../../../app/renderer/ext-api.ts'
import type { IDisposable } from '../../../../app/shared/vscode-lifecycle.ts'
import { manifest } from './manifest.ts'

export { manifest }

export function activate(ui: TetherUi): IDisposable[] {
  const changes: AgentPane[] = []
  ui.test.expose('list', () => ui.agents.list())
  ui.test.expose('get', (slotId: string) => ui.agents.get(slotId) ?? null)
  ui.test.expose('focus', (slotId: string) => ui.agents.focus(slotId))
  ui.test.expose('changes', () => changes)
  return [ui.agents.onDidChange(p => { changes.push(p) })]
}
