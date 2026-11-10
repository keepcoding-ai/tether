// The panel-pad-manager extension's renderer entry: the manager as the panel pad's second state (frame-pads/manager-slot.ts:
// this extension provides the view, the frame-pads extension hosts it), its two commands (switch the pad to the manager
// and back; show the loose frames), the toasts (a frame became loose: "Ver"; a frame closed: "Desfazer"), the warning dot
// on the pad's icon while a loose frame has content, and the test hooks. The frames are the core's (TetherUi.pads.panelFrames).
import type { ContextMenuEntry, FrameFilter, FrameSnapshot, TetherUi } from '../../app/renderer/ext-api.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { padManager } from '../frame-pads/manager-slot.ts'
import type { PanelPadManagerChannels } from './ipc.ts'
import { manifest } from './manifest.ts'
import { PanelPadManager, type ManagerHost } from './panel.ts'
import { showToast, toastSnapshot } from './toast.ts'

export { manifest }

/** The pad the manager lives in (the frame-pads extension's). */
const PANEL_PAD = 'frame-pads.panel'
/** How long "Desfazer" stays on screen. */
const UNDO_MS = 8000

export function activate(ui: TetherUi): IDisposable[] {
  const ipc = ui.ipc<PanelPadManagerChannels>()
  const panels = new Set<PanelPadManager>()

  const undoable = (snap: FrameSnapshot, text: string): void => {
    if (!snap.entries.length) return
    showToast({ text, ms: UNDO_MS, action: { label: 'Desfazer', run: () => ui.pads.panelFrames.restore(snap) } })
  }

  const host: Omit<ManagerHost, 'exit'> = {
    tree: () => ui.pads.panelFrames.tree(),
    targets: () => ui.pads.panelFrames.targets(),
    read: async path => { const r = await ipc.invoke('read', path); return r.ok ? r.text : undefined },
    agent: paneId => ui.agents.list().find(a => a.paneId === paneId),
    cwdOf: paneId => ui.panes.cwdOf(paneId),
    move: (from, to) => ui.pads.panelFrames.move(from, to),
    close: (keys, what) => {
      const snap = ui.pads.panelFrames.close(keys)
      const n = snap.entries.length
      undoable(snap, what === 'one' ? 'Quadro fechado' : n === 1 ? '1 quadro vazio limpo' : `${n} quadros vazios limpos`)
    },
    // Going to a frame: the pad shows that panel's frame again (the panel takes the focus; the pad opens).
    show: key => { padManager.hide(); ui.pads.panelFrames.show(key) },
    menu: (x, y, entries: ContextMenuEntry[]) => ui.menus.context(x, y, entries),
  }

  /** The pad to the manager, on a filter, with a frame selected when given. */
  function show(filter: FrameFilter, key?: string): void {
    ui.pads.open(PANEL_PAD)
    padManager.show(filter, key)
  }

  ui.test.expose('panelPadManager', () => [...panels].filter(p => !p.element.hidden && p.element.isConnected).map(p => p.snapshot()))
  ui.test.expose('openPanelPadManager', (filter: FrameFilter = 'all', key?: string) => show(filter, key))
  ui.test.expose('panelPadManagerOn', () => padManager.isOn())
  ui.test.expose('panelPadManagerSelect', (key: string) => { for (const p of panels) p.select(key) })
  ui.test.expose('panelFramesTree', () => ui.pads.panelFrames.tree())
  ui.test.expose('panelFramesToast', () => toastSnapshot())

  return [
    padManager.provide({
      create: ({ exit }) => {
        const panel = new PanelPadManager({ ...host, exit })
        panels.add(panel)
        const dispose = panel.dispose.bind(panel)
        panel.dispose = () => { panels.delete(panel); dispose() }
        return panel
      },
    }),
    ui.commands.registerCommand('panel-pad.manager', () => { if (padManager.isOn()) padManager.hide(); else show('all') }),
    ui.commands.registerCommand('panel-pad.manager.loose', () => show('loose')),
    ui.pads.panelFrames.onDidChange(() => { for (const p of panels) p.refresh() }),
    ui.pads.panelFrames.onDidLoose(key => showToast({ text: 'O quadro da prancheta ficou solto', ms: UNDO_MS, action: { label: 'Ver', run: () => show('all', key) } })),
    ui.agents.onDidChange(() => { for (const p of panels) p.refresh() }),
  ]
}
