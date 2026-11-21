// Subject: an extension's line in a terminal panel's status bar (slice K1.5). The hooks: `headItem(paneId, item & { menu? })`
// puts the probe's line (undefined takes it away; with `menu` a click opens the pane's tab menu by the item, as the owner's ▾
// does), `headItems(paneId)` reads every extension's line back (what a manager shows), `headClicks()` lists the clicks.
import type { PaneHeadItem, TetherUi } from '../../../../app/renderer/ext-api.ts'
import type { IDisposable } from '../../../../app/shared/vscode-lifecycle.ts'

export function headItem(ui: TetherUi): IDisposable[] {
  const clicks: string[] = []
  ui.test.expose('headClicks', () => clicks)
  ui.test.expose('headItems', (paneId: string) => ui.panes.headItems(paneId).map(i => ({ text: i.text, hue: i.hue ?? null, clickable: !!i.onActivate })))
  ui.test.expose('headItem', (paneId: string, item: (Omit<PaneHeadItem, 'onActivate'> & { menu?: boolean }) | undefined) => {
    if (!item) { ui.panes.setHeadItem(paneId, undefined); return }
    const { menu, ...rest } = item
    ui.panes.setHeadItem(paneId, menu ? {
      ...rest,
      onActivate: anchor => {
        clicks.push(paneId)
        const r = anchor.getBoundingClientRect()
        ui.panes.showTabMenu(paneId, r.left, r.bottom + 2, anchor)
      },
    } : rest)
  })
  return []
}
