// Subject: the rows an extension puts in the desk pill's menu and in every pane's menu (slice R3). Two providers per menu:
// one that answers, one that throws (it must never break the menu). `managerRows` is what the "Painéis da mesa" manager asks.
import type { TetherUi } from '../../../../app/renderer/ext-api.ts'
import type { IDisposable } from '../../../../app/shared/vscode-lifecycle.ts'

export function menus(ui: TetherUi): IDisposable[] {
  const picked: string[] = []
  ui.test.expose('menuPicked', () => picked)
  ui.test.expose('managerRows', (paneId: string) => ui.panes.tabMenuEntries(paneId, { from: 'manager' }).map(e => (e === 'sep' ? '-' : e.label)))
  return [
    ui.desks.menu(() => { throw new Error('sonda: a mesa lança') }),
    ui.desks.menu(deskId => [{ icon: 'x', label: 'Item da sonda (mesa)', run: () => { picked.push(`desk:${deskId}`) } }]),
    ui.panes.tabMenu(() => { throw new Error('sonda: a guia lança') }),
    ui.panes.tabMenu(pane => [{ icon: 'x', label: 'Item da sonda (guia)', run: () => { picked.push(`pane:${pane.id}:${pane.type}`) } }]),
  ]
}
