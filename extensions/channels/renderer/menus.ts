// The channel's rows in the menus of the app (U2): "Juntar a um canal…" in the tab menu of an agent, "Encerrar canal…" (or "Reabrir
// canal") in the tab menu of a channel, "Abrir o canal da mesa" in the desk pill's menu when the desk has one. A menu draws at
// once, so the rows read what the directory holds; the commands do the asking.
import type { ContextMenuRow, Disposable, TetherUi } from '../../../app/renderer/ext-api.ts'
import { CHANNEL_PANE_PREFIX, CMD, channelIdOfPane } from '../manifest.ts'
import type { Directory } from './commands.ts'
import { ICON, MENU } from './texts.ts'

export function createMenus(ui: TetherUi, dir: Directory, open: (channelId: string, name?: string) => void): Disposable[] {
  const anyOpen = (): boolean => dir.list().some(c => !c.closed)

  const tab = ui.panes.tabMenu(pane => {
    if (pane.id.startsWith(CHANNEL_PANE_PREFIX)) {
      const ch = dir.list().find(c => c.id === channelIdOfPane(pane.id))
      // The desk's channel follows the desk: it is never closed or reopened by hand (C17).
      if (!ch || ch.desk !== undefined) return []
      return ch.closed
        ? [{ icon: ICON.reopen, label: MENU.reopen, run: () => { void ui.commands.run(CMD.reopen, { channel: ch.id }) } }]
        : ['sep', { icon: ICON.close, label: MENU.close, danger: true, run: () => { void ui.commands.run(CMD.close, { channel: ch.id }) } }]
    }
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
