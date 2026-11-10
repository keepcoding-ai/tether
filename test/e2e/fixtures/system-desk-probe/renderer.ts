// The probe's renderer entry: exposes the extension API's system desk, badge and attention calls to the E2E as `window.__tether.ext['system-desk-probe']`.
import type { AttentionHandle, Badge, TetherUi } from '../../../../app/renderer/ext-api.ts'
import type { IDisposable } from '../../../../app/shared/vscode-lifecycle.ts'
import { DESK_ID, PAD_ID, manifest } from './manifest.ts'

export { manifest }

export function activate(ui: TetherUi): IDisposable[] {
  const changes: { id: string; active: boolean }[] = []
  const handles: AttentionHandle[] = []
  const activations: number[] = []
  ui.test.expose('toggle', () => { ui.systemDesks.toggle(DESK_ID) })
  ui.test.expose('isActive', () => ui.systemDesks.isActive(DESK_ID))
  ui.test.expose('changes', () => changes)
  ui.test.expose('padBadge', (badge: Badge | undefined) => { ui.pads.setBadge(PAD_ID, badge) })
  ui.test.expose('deskBadge', (badge: Badge | undefined) => { ui.systemDesks.setBadge(DESK_ID, badge) })
  ui.test.expose('raise', (paneId: string, message: string, sticky: boolean) => {
    const handle = ui.attention.raise({ paneId, message, sticky })
    const index = handles.push(handle) - 1
    handle.onDidActivate(() => { activations.push(index) })
    return index
  })
  ui.test.expose('update', (index: number, message: string) => { handles[index]!.update({ message }) })
  ui.test.expose('resolve', (index: number) => { handles[index]!.resolve() })
  ui.test.expose('activations', () => activations)
  return [
    ui.systemDesks.onDidChangeActive(e => { changes.push(e) }),
    ui.pads.register({ id: PAD_ID, create: () => { const element = document.createElement('div'); return { element, focus() {}, dispose() {} } } }),
  ]
}
