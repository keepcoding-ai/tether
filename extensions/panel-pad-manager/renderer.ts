// The panel-pad-manager extension's renderer entry: the manager as the panel pad's second state (frame-pads/manager-slot.ts:
// this extension provides the view, the frame-pads extension hosts it), its two commands (switch the pad to the manager
// and back; show the loose frames), the toasts (a panel the person closed takes its frame along: "Desfazer"; a panel that
// went by itself leaves its frame loose: "Ver"; a loose frame closed), and the test hooks.
// The frames are the core's (TetherUi.pads.panelFrames); what a card does is what the guide's tab does (TetherUi.panes).
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
    mount: key => ui.pads.panelFrames.mount(key),
    menuEntries: paneId => ui.panes.tabMenuEntries(paneId, { from: 'manager' }),
    tabMenu: (paneId, x, y, opener) => ui.panes.showTabMenu(paneId, x, y, opener, { from: 'manager' }),
    beginDrag: (paneId, ev) => ui.panes.beginDrag(paneId, ev),
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

  ui.test.expose('panelPadManager', () => [...panels].filter(p => !p.element.hidden && p.element.isConnected && !!p.element.closest('.pad.shown')).map(p => p.snapshot()))
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
    ui.pads.panelFrames.onDidLoose((key, cause) => {
      if (cause === 'lost') { showToast({ text: 'O quadro da prancheta ficou solto', ms: TOAST_MS, action: { label: 'Ver', run: () => show('all', key) } }); return }
      // The person closed the panel: its guides go with it; "Desfazer" brings back only the frame, under the closed owner.
      const n = ui.pads.panelFrames.tree().loose.find(r => r.key === key)?.tabs ?? 0
      const snap = ui.pads.panelFrames.close([key])
      if (!snap.entries.length) return
      showToast({ text: n === 1 ? '1 guia da prancheta fechada' : `${n} guias da prancheta fechadas`, ms: TOAST_MS, action: { label: 'Desfazer', run: () => ui.pads.panelFrames.restore(snap) } })
    }),
  ]
}
