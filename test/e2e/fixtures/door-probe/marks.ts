// Subject: the marks an extension puts on the desk pill (a seal) and on the tab of any pane (an emblem), slice R2, and the menu
// row whose icon name the app does not have (it must draw without an icon, not take the menu down). The hooks are in
// `window.__tether.ext['door-probe']`: `seal` / `emblem` act as the probe's extension, `emblemClicks` lists the emblem clicks and
// `raiseAttention` puts an attention seal (the orange count) on a pane.
import type { DeskSeal, TabEmblem, TetherUi } from '../../../../app/renderer/ext-api.ts'
import type { IDisposable } from '../../../../app/shared/vscode-lifecycle.ts'

export function marks(ui: TetherUi): IDisposable[] {
  const clicks: string[] = []
  ui.test.expose('seal', (deskId: string, seal: DeskSeal | undefined) => ui.desks.setSeal(deskId, seal))
  ui.test.expose('emblem', (paneId: string, emblem: (Omit<TabEmblem, 'onActivate'> & { clickable?: boolean }) | undefined) => {
    if (!emblem) { ui.panes.setEmblem(paneId, undefined); return }
    const { clickable, ...rest } = emblem
    ui.panes.setEmblem(paneId, clickable ? { ...rest, onActivate: () => { clicks.push(paneId) } } : rest)
  })
  ui.test.expose('emblemClicks', () => clicks)
  ui.test.expose('raiseAttention', (paneId: string) => { ui.attention.raise({ paneId, message: 'a sonda pede atenção', sticky: true }) })
  return [
    ui.panes.tabMenu(() => [{ icon: 'bolt', label: 'Item da sonda (ícone que não existe)', run: () => {} }]),
  ]
}
