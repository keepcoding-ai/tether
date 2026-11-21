// Subject: the thin line under a tab an owner commands (slice K1.4). The hook `tabLine(paneId, hue | undefined)`.
import type { TetherUi } from '../../../../app/renderer/ext-api.ts'
import type { IDisposable } from '../../../../app/shared/vscode-lifecycle.ts'

export function tabLine(ui: TetherUi): IDisposable[] {
  ui.test.expose('tabLine', (paneId: string, hue: number | undefined) => ui.panes.setTabLine(paneId, hue))
  return []
}
