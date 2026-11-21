// Subject: the marks an extension puts on the desk pill (a seal) and on the tab of any pane (an emblem), slice R2, and the menu
// row whose icon name the app does not have (it must draw without an icon, not take the menu down). The hooks are
// `window.__tether.ext['door-probe']`: `seal` / `emblem` act as the probe's extension, `emblemClicks` lists the emblem clicks.
import type { TetherUi } from '../../../../app/renderer/ext-api.ts'
import type { IDisposable } from '../../../../app/shared/vscode-lifecycle.ts'

export function marks(ui: TetherUi): IDisposable[] {
  return [
    ui.panes.tabMenu(() => [{ icon: 'bolt', label: 'Item da sonda (ícone que não existe)', run: () => {} }]),
  ]
}
