// The channel's rows in the menus of the app (U2): "Juntar a um canal…" in the tab menu of an agent, "Abrir o canal da mesa" in
// the desk pill's menu when the desk has one (the channel's own tab menu is `channelMenu`, drawn by the pane type). A menu draws at
// once, so the rows read what the directory holds; the commands do the asking.
import type { ContextMenuRow, Disposable, TetherUi } from '../../../app/renderer/ext-api.ts'
import { CHANNEL_PANE_PREFIX, CMD } from '../manifest.ts'
import type { Directory } from './commands.ts'
import { ICON, MENU } from './texts.ts'

export function createMenus(ui: TetherUi, dir: Directory, open: (channelId: string, name?: string) => void): Disposable[] {
  const anyOpen = (): boolean => dir.list().some(c => !c.closed)

  const tab = ui.panes.tabMenu(pane => {
    // A channel's own menu (join, mute, close, reopen...) is drawn whole by the pane type from `channelMenu`: nothing is added here.
    if (pane.id.startsWith(CHANNEL_PANE_PREFIX)) return []
    const agent = ui.agents.list().find(a => a.paneId === pane.id)
    if (!agent || !anyOpen()) return []
    return [{ icon: ICON.join, label: MENU.join, run: () => { void ui.commands.run(CMD.join, { agent: agent.slotId }) } }]
  })

  const pill = ui.desks.menu((deskId): ContextMenuRow[] => {
    const rows: ContextMenuRow[] = []
    const here = dir.list().find(c => c.desk === deskId && !c.closed)
    if (here) rows.push({ icon: ICON.channel, label: MENU.openDesk(here.name), run: () => open(here.id, here.name) })
    if (dir.list().length > 0) rows.push({ icon: ICON.channel, label: MENU.openAny, run: () => { void ui.commands.run(CMD.open) } })
    return rows
  })

  return [tab, pill]
}
