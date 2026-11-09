// The probe's renderer entry: exposes the extension API's system desk calls to the E2E as `window.__tether.ext['system-desk-probe']`.
import type { TetherUi } from '../../../../app/renderer/ext-api.ts'
import type { IDisposable } from '../../../../app/shared/vscode-lifecycle.ts'
import { DESK_ID, manifest } from './manifest.ts'

export { manifest }

export function activate(ui: TetherUi): IDisposable[] {
  const changes: { id: string; active: boolean }[] = []
  ui.test.expose('toggle', () => { ui.systemDesks.toggle(DESK_ID) })
  ui.test.expose('isActive', () => ui.systemDesks.isActive(DESK_ID))
  ui.test.expose('changes', () => changes)
  return [ui.systemDesks.onDidChangeActive(e => { changes.push(e) })]
}
