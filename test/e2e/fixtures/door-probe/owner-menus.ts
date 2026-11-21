// Subject: what the owner's menus need from the core (slice K1.1): a heading line, a submenu row and the top of a pane's menu
// (`tabMenu(provider, { place: 'top' })`). Nothing shows until a test asks: `ownerMenus(true)` turns the rows on in every tab
// menu (top) and in every pill menu (the extensions' group), `ownerMenus(false)` takes them away. `ownerPicked()` lists what ran.
import type { ContextMenuRow, TetherUi } from '../../../../app/renderer/ext-api.ts'
import type { IDisposable } from '../../../../app/shared/vscode-lifecycle.ts'

export function ownerMenus(ui: TetherUi): IDisposable[] {
  let on = false
  const picked: string[] = []
  ui.test.expose('ownerMenus', (value: boolean) => { on = value })
  ui.test.expose('ownerPicked', () => picked)
  const rows = (where: string): ContextMenuRow[] => !on ? [] : [
    { heading: 'Sonda: comanda 4 guias, vê 2' },
    { icon: 'hand-grabbing', label: 'Tomar (sonda)', pin: 'icon', run: () => { picked.push(`${where}:tomar`) } },
    {
      icon: 'list', label: 'O que é da sonda', run: () => { picked.push(`${where}:submenu-ran`) },
      children: [
        { heading: 'Mesas' },
        { icon: 'squares-four', label: 'mesa da sonda', run: () => { picked.push(`${where}:mesa`) } },
        'sep',
        { heading: 'Guias' },
        { icon: 'terminal-window', label: 'guia da sonda', run: () => { picked.push(`${where}:guia`) } },
      ],
    },
    { icon: 'list', label: 'Submenu vazio (sonda)', run: () => {}, children: [] },
  ]
  return [
    ui.panes.tabMenu(pane => rows(`pane:${pane.id}`), { place: 'top' }),
    ui.desks.menu(deskId => rows(`desk:${deskId}`)),
  ]
}
