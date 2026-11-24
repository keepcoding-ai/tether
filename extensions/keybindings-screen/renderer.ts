// The keybindings screen's renderer entry: the pane type (the screen in the peek card or as a tab, one at a time), the
// commands keybindings.show / keybindings.record, the tab menu and the test hooks. What it edits is the core's key table
// (TetherUi.keybindings); the file it writes goes through its main side.
import type { TetherUi, PaneType, ContextMenuEntry } from '../../app/renderer/ext-api.ts'
import { formatKeybindingsFile, overridesFor } from '../../app/renderer/keybindings-rules.ts'
import type { Keybinding } from '../../app/renderer/shortcuts.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { KeybindingsScreenChannels } from './ipc.ts'
import { KEYBINDINGS_SCREEN_LAYOUT } from './layouts.ts'
import { manifest } from './manifest.ts'
import { KeybindingsPanel, KeybindingsTab, type KeybindingsHost } from './panel.ts'

export { manifest }

export function activate(ui: TetherUi): IDisposable[] {
  const ipc = ui.ipc<KeybindingsScreenChannels>()
  const panels = new Map<string, KeybindingsPanel>()

  /** Applies the bindings in force and writes the smallest file for them (the core's watcher echoes it back). */
  function change(bindings: Keybinding[]): void {
    ui.keybindings.apply(bindings)
    void ipc.invoke('write', formatKeybindingsFile(overridesFor(bindings))).then(r => { if (!r.ok) console.error(`keybindings.json: ${r.message}`) })
  }

  /** "Abrir keybindings.json": the file in an editor tab beside the screen (an empty file is created first so the tab has something to show). */
  function openFile(): void {
    // The file opens in a tab behind the card: the card's screen closes so the person sees it.
    const peeked = ui.panes.peekedScreen()
    if (peeked && panels.has(peeked)) ui.panes.close(peeked)
    void ipc.invoke('ensure', formatKeybindingsFile([])).then(r => {
      if (r.ok) void ui.openers.open(r.path, { side: false, root: '', source: true })
    })
  }

  const host: KeybindingsHost = {
    commands: () => ui.keybindings.commands(),
    table: () => ui.keybindings.table(),
    apply: change,
    resetAll: () => change(ui.keybindings.defaults()),
    fileState: () => ui.keybindings.file(),
    openFile,
    fixedBindings: () => ui.keybindings.fixed(),
    onTabMenu: (id, ev) => ui.panes.showTabMenu(id, ev.clientX, ev.clientY),
    onClose: id => ui.panes.close(id),
  }

  /**
   * Ctrl+K Ctrl+S: the screen in the peek card (one screen: a tab of it already open is brought forward; the one in the
   * card gets the keyboard). The card's "Abrir nesta mesa" makes it a tab.
   */
  function show(): void {
    const id = ui.panes.peekScreen(KEYBINDINGS_SCREEN_LAYOUT.id)
    if (id) requestAnimationFrame(() => ui.panes.focus(id))
  }

  /** The screen the keys act on: the one in the peek card, else the active pane when it is this screen. */
  function target(): KeybindingsPanel | undefined {
    for (const id of [ui.panes.peekedScreen(), ui.panes.activeId()]) if (id && panels.has(id)) return panels.get(id)
    return undefined
  }

  function tabMenu(id: string, x: number, y: number): void {
    const entries: ContextMenuEntry[] = [
      { icon: 'note-pencil', label: 'Abrir keybindings.json', run: openFile },
      'sep',
      { icon: 'arrow-square-out', label: 'Mover…', run: () => ui.panes.move(id) },
      'sep',
      { icon: 'x', label: 'Fechar', run: () => ui.panes.close(id) },
    ]
    ui.menus.context(x, y, entries)
  }

  /** Keeps `panels` in step with a pane's life: set on init (dockview gives the id there), removed on dispose. */
  function tracked(pane: KeybindingsPanel): KeybindingsPanel {
    const init = pane.init.bind(pane)
    pane.init = params => { init(params); panels.set(pane.id, pane) }
    const dispose = pane.dispose.bind(pane)
    pane.dispose = () => { const k = pane.id; dispose(); if (panels.get(k) === pane) panels.delete(k) }
    return pane
  }

  const type: PaneType = {
    // The tab's icon: the hidden-tabs list and the peek card's header show it too.
    ...KEYBINDINGS_SCREEN_LAYOUT, hasSlot: false, icon: 'keyboard',
    create: () => tracked(new KeybindingsPanel(host)),
    createTab: () => new KeybindingsTab(host),
    has: id => panels.has(id),
    contextFlags: () => ['keybindings.screen'],
    tabMenu,
    focus: id => panels.get(id)?.focus(),
  }

  ui.test.expose('keybindings', () => [...panels.values()].map(s => s.snapshot()))
  ui.test.expose('keybindingsFile', () => ui.keybindings.file())
  ui.test.expose('openKeybindings', () => show())

  return [
    ui.panes.register(type),
    ui.commands.registerCommand('keybindings.show', () => show()),
    ui.commands.registerCommand('keybindings.record', () => { target()?.recordSelected() }),
    ui.keybindings.onDidChangeFile(() => { for (const p of panels.values()) p.refresh() }),
  ]
}
