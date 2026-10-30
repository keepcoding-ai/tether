// The system tray: the app icon (a dot on it while an agent runs), left click toggles the window, the context
// menu comes from the model in app/shared/tray.ts. The tray owns no state of its own: main.ts feeds it the slot
// states and handles the actions.
import { Menu, nativeImage, Tray } from 'electron'
import { join } from 'node:path'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { trayModel, type TrayCommand, type TrayModel } from '../shared/tray.ts'

export interface TrayActions {
  toggle(): void
  command(id: TrayCommand): void
  pane(slotId: string): void
}

export interface TrayController {
  update(slots: Iterable<SlotState>): void
  model(): TrayModel
  destroy(): void
}

/** Windows reads `&` in a menu label as a mnemonic marker. */
const escapeLabel = (label: string): string => label.replace(/&/g, '&&')

export function createTray(assetDir: string, actions: TrayActions): TrayController {
  const idle = nativeImage.createFromPath(join(assetDir, 'tray.png'))
  const active = nativeImage.createFromPath(join(assetDir, 'tray-active.png'))
  const attention = nativeImage.createFromPath(join(assetDir, 'tray-attention.png'))
  const tray = new Tray(idle)
  let current = trayModel([])

  const build = (model: TrayModel): Menu => Menu.buildFromTemplate(model.items.map((item): Electron.MenuItemConstructorOptions => {
    switch (item.kind) {
      case 'separator': return { type: 'separator' }
      case 'info': return { label: escapeLabel(item.label), enabled: false }
      case 'command': return { label: item.label, click: () => actions.command(item.id) }
      case 'pane': return { label: escapeLabel(item.label), click: () => actions.pane(item.slotId) }
    }
  }))

  const apply = (): void => {
    tray.setImage(current.badge === 'attention' ? attention : current.badge === 'active' ? active : idle)
    tray.setToolTip(current.tooltip)
    tray.setContextMenu(build(current))
  }
  tray.on('click', () => actions.toggle())
  apply()

  return {
    update(slots) { current = trayModel(slots); apply() },
    model: () => current,
    destroy() { tray.destroy() },
  }
}
