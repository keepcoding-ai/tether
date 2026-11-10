// The settings screen's renderer entry: the pane type (the page as a tab of the active group, one at a time), the
// command settings.show (Ctrl+, and "Configurações…" in ≡), the tab menu and the test hooks. Everything it reads and
// writes goes through TetherUi.configuration (the core is settings.json's single writer).
import type { ContextMenuEntry, PaneType, TetherUi } from '../../app/renderer/ext-api.ts'
import type { SettingEntry, SettingsList } from '../../app/shared/api.ts'
import type { SettingValue } from '../../app/shared/vscode-configuration-registry.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { SETTINGS_COMPONENT, SETTINGS_TAB, SETTINGS_TITLE, newSettingsPanelId } from '../../app/shared/settings-screen.ts'
import { SETTINGS_SCREEN_LAYOUT } from './layouts.ts'
import { manifest } from './manifest.ts'
import { SettingsPanel, SettingsTab, type SettingsHost } from './panel.ts'

export { manifest }

export function activate(ui: TetherUi): IDisposable[] {
  const panels = new Map<string, SettingsPanel>()
  // e2e only: entries the test adds (a number setting, which no shipped node declares yet); their writes are counted, not sent.
  const testEntries: SettingEntry[] = []
  const testWrites: { key: string; value: SettingValue }[] = []

  const host: SettingsHost = {
    all: async (): Promise<SettingsList> => {
      const list = await ui.configuration.all()
      return testEntries.length ? { ...list, entries: [...list.entries, ...testEntries] } : list
    },
    set: async (key, value) => {
      const t = testEntries.find(e => e.key === key)
      if (t) { testWrites.push({ key, value }); t.value = value; t.configured = true; return { ok: true } }
      return ui.configuration.set(key, value)
    },
    reset: key => ui.configuration.reset(key),
    openFile: () => { void ui.configuration.openFile() },
    runCommand: id => { void ui.commands.run(id) },
    onTabMenu: (id, ev) => ui.panes.showTabMenu(id, ev.clientX, ev.clientY),
    onClose: id => ui.panes.close(id),
  }

  /** Ctrl+,: the page as a tab of the active group (one page: a second call brings it forward). `key`: the setting to show. */
  function show(key?: string): void {
    const existing = panels.keys().next().value as string | undefined
    const found = existing ? ui.panes.find(existing) : undefined
    if (existing && found) {
      found.api.setActive()
      requestAnimationFrame(() => { if (key) void panels.get(existing)?.reveal(key); else ui.panes.focus(existing) })
      return
    }
    const reference = ui.panes.activeId()
    const within = reference && ui.panes.find(reference)
    const panel = ui.panes.open(
      { id: newSettingsPanelId(), component: SETTINGS_COMPONENT, tabComponent: SETTINGS_TAB, title: SETTINGS_TITLE, params: {} },
      within ? { target: { level: 'pane', placement: 'within' }, reference } : {},
    )
    ui.layout.scheduleSave()
    requestAnimationFrame(() => { if (key) void panels.get(panel.id)?.reveal(key); else ui.panes.focus(panel.id) })
  }

  function tabMenu(id: string, x: number, y: number): void {
    const entries: ContextMenuEntry[] = [
      { icon: 'brackets-curly', label: 'Abrir settings.json', run: () => { void ui.configuration.openFile() } },
      'sep',
      { icon: 'arrow-square-out', label: 'Mover…', run: () => ui.panes.move(id) },
      'sep',
      { icon: 'x', label: 'Fechar', run: () => ui.panes.close(id) },
    ]
    ui.menus.context(x, y, entries)
  }

  /** Keeps `panels` in step with a pane's life: set on init (dockview gives the id there), removed on dispose. */
  function tracked(pane: SettingsPanel): SettingsPanel {
    const init = pane.init.bind(pane)
    pane.init = params => { init(params); panels.set(pane.id, pane) }
    const dispose = pane.dispose.bind(pane)
    pane.dispose = () => { const k = pane.id; dispose(); if (panels.get(k) === pane) panels.delete(k) }
    return pane
  }

  const type: PaneType = {
    ...SETTINGS_SCREEN_LAYOUT, hasSlot: false, icon: 'gear-six',
    create: () => tracked(new SettingsPanel(host)),
    createTab: () => new SettingsTab(host),
    has: id => panels.has(id),
    contextFlags: () => ['settings.screen'],
    tabMenu,
    focus: id => panels.get(id)?.focus(),
  }

  const refreshAll = (): Promise<void[]> => Promise.all([...panels.values()].map(p => p.refresh()))
  ui.test.expose('settingsScreen', () => [...panels.values()].map(p => p.snapshot()))
  ui.test.expose('openSettings', () => show())
  ui.test.expose('settingsScreenRefresh', () => refreshAll())
  ui.test.expose('settingsAddTestEntry', (e: SettingEntry) => { testEntries.push(e); return refreshAll() })
  ui.test.expose('settingsTestWrites', () => testWrites.map(w => ({ ...w })))

  return [
    ui.panes.register(type),
    ui.commands.registerCommand('settings.show', () => show()),
    ui.configuration.onReveal(key => show(key)),
    ui.configuration.onDidChange(() => { void refreshAll() }),
  ]
}
