// The panel-pad-manager extension's renderer entry: the manager as the panel pad's second state (frame-pads/manager-slot.ts:
// this extension provides the view, the frame-pads extension hosts it), its two commands (switch the pad to the manager
// and back; show the loose frames), the toasts (a frame became loose: "Ver"; a loose frame closed), and the test hooks.
// The frames are the core's (TetherUi.pads.panelFrames); what a row does is what the panel's tab does (TetherUi.panes).
import type { FrameFilter, TetherUi } from '../../app/renderer/ext-api.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { padManager } from '../frame-pads/manager-slot.ts'
import { manifest } from './manifest.ts'
import { PanelPadManager, type ManagerHost } from './panel.ts'
import { showToast, toastSnapshot } from './toast.ts'

export { manifest }

/** The pad the manager lives in (the frame-pads extension's). */
const PANEL_PAD = 'frame-pads.panel'
/** How long a toast stays on screen. */
const TOAST_MS = 8000

export function activate(ui: TetherUi): IDisposable[] {
  const panels = new Set<PanelPadManager>()

  const host = {
    tree: () => ui.pads.panelFrames.tree(),
    agent: paneId => ui.agents.get(paneId) ?? ui.agents.list().find(a => a.paneId === paneId),
    describe: paneId => ui.panes.describe(paneId),
    reveal: panelId => ui.panes.reveal(panelId),
    menuEntries: panelId => ui.panes.tabMenuEntries(panelId, { from: 'manager' }),
    tabMenu: (panelId, x, y, opener) => ui.panes.showTabMenu(panelId, x, y, opener, { from: 'manager' }),
    beginDrag: (panelId, ev) => ui.panes.beginDrag(panelId, ev),
    beginLooseDrag: (key, ev) => ui.pads.panelFrames.beginDrag(key, ev),
    revivable: key => ui.pads.panelFrames.revivable(key),
    close: (keys, what) => {
      const snap = ui.pads.panelFrames.close(keys)
      const n = snap.entries.length
      if (n) showToast({ text: what === 'one' ? 'Quadro fechado' : n === 1 ? '1 quadro vazio limpo' : `${n} quadros vazios limpos`, ms: TOAST_MS })
    },
  } satisfies Omit<ManagerHost, 'exit'>

  /** The pad to the manager, on a filter, with a row selected when given. */
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

  const refresh = (): void => { for (const p of panels) p.refresh() }
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
    ui.pads.panelFrames.onDidChange(refresh),
    ui.agents.onDidChange(refresh),
    ui.panes.onDidChangeActive(refresh),
    ui.pads.panelFrames.onDidLoose(key => showToast({ text: 'O quadro da prancheta ficou solto', ms: TOAST_MS, action: { label: 'Ver', run: () => show('all', key) } })),
  ]
}
