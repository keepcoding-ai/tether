// The pad-notes extension's renderer entry: the manager's pane type (one per window, a tab of the active group), its two
// commands (open it; open it on the loose notes), the toasts (a note became loose: "Ver"; a note closed: "Desfazer"), and
// the test hooks. The notes are the core's (TetherUi.pads.notes).
import type { ContextMenuEntry, NoteFilter, NoteSnapshot, PaneType, TetherUi } from '../../app/renderer/ext-api.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { PadNotesChannels } from './ipc.ts'
import { NOTES_MANAGER_COMPONENT, NOTES_MANAGER_LAYOUT, NOTES_MANAGER_TAB, NOTES_MANAGER_TITLE, newNotesManagerId } from './layouts.ts'
import { manifest } from './manifest.ts'
import { NotesManagerPanel, NotesManagerTab, type ManagerHost } from './panel.ts'
import { showToast, toastSnapshot } from './toast.ts'

export { manifest }

/** How long "Desfazer" stays on screen. */
const UNDO_MS = 8000

export function activate(ui: TetherUi): IDisposable[] {
  const ipc = ui.ipc<PadNotesChannels>()
  const panels = new Map<string, NotesManagerPanel>()
  /** What the panel opens on once dockview creates it (the filter and the note to select). */
  let pending: { filter: NoteFilter; key?: string } | undefined

  const undoable = (snap: NoteSnapshot, text: string): void => {
    if (!snap.entries.length) return
    showToast({ text, ms: UNDO_MS, action: { label: 'Desfazer', run: () => ui.pads.notes.restore(snap) } })
  }

  const host: ManagerHost = {
    tree: () => ui.pads.notes.tree(),
    targets: () => ui.pads.notes.targets(),
    read: async path => { const r = await ipc.invoke('read', path); return r.ok ? r.text : undefined },
    move: (from, to) => ui.pads.notes.move(from, to),
    close: (keys, what) => {
      const snap = ui.pads.notes.close(keys)
      const n = snap.entries.length
      undoable(snap, what === 'one' ? 'Nota fechada' : n === 1 ? '1 nota vazia limpa' : `${n} notas vazias limpas`)
    },
    show: key => ui.pads.notes.show(key),
    menu: (x, y, entries: ContextMenuEntry[]) => ui.menus.context(x, y, entries),
    onTabMenu: (id, ev) => ui.panes.showTabMenu(id, ev.clientX, ev.clientY),
    onClose: id => ui.panes.close(id),
  }

  /** Opens the manager (or brings the open one forward) on a filter, with a note selected when given. */
  function show(filter: NoteFilter, key?: string): void {
    const existing = [...panels.keys()].find(id => ui.panes.find(id))
    if (existing) {
      ui.panes.reveal(existing)
      panels.get(existing)?.open(filter, key)
      return
    }
    pending = { filter, ...(key ? { key } : {}) }
    // Always on the desk (the Foco de Mesa), never inside a pad: opened from a pad's menu, the pad has the focus.
    const reference = ui.panes.deskActiveId()
    const within = reference && ui.panes.find(reference)
    const panel = ui.panes.open(
      { id: newNotesManagerId(), component: NOTES_MANAGER_COMPONENT, tabComponent: NOTES_MANAGER_TAB, title: NOTES_MANAGER_TITLE, params: {} },
      within ? { target: { level: 'pane', placement: 'within' }, reference } : {},
    )
    ui.layout.scheduleSave()
    requestAnimationFrame(() => ui.panes.focus(panel.id))
  }

  /** Keeps `panels` in step with a pane's life: set on init, removed on dispose. */
  function tracked(pane: NotesManagerPanel): NotesManagerPanel {
    const init = pane.init.bind(pane)
    pane.init = params => {
      init(params)
      panels.set(pane.id, pane)
      if (pending) { pane.open(pending.filter, pending.key); pending = undefined }
    }
    const dispose = pane.dispose.bind(pane)
    pane.dispose = () => { const k = pane.id; dispose(); if (panels.get(k) === pane) panels.delete(k) }
    return pane
  }

  function tabMenu(id: string, x: number, y: number): void {
    ui.menus.context(x, y, [
      { icon: 'arrow-square-out', label: 'Mover…', run: () => ui.panes.move(id) },
      'sep',
      { icon: 'x', label: 'Fechar', run: () => ui.panes.close(id) },
    ])
  }

  const type: PaneType = {
    ...NOTES_MANAGER_LAYOUT, hasSlot: false, icon: 'clipboard-text',
    create: () => tracked(new NotesManagerPanel(host)),
    createTab: () => new NotesManagerTab(host),
    has: id => panels.has(id),
    tabMenu,
    focus: id => panels.get(id)?.focus(),
  }

  /** The notes the counter and the commands look at: loose ones with content open the manager on Soltas. */
  const hasLoose = (): boolean => ui.pads.notes.tree().loose.some(r => !r.empty)

  ui.test.expose('notesManager', () => [...panels.values()].map(p => p.snapshot()))
  ui.test.expose('openNotesManager', (filter: NoteFilter = 'all', key?: string) => show(filter, key))
  ui.test.expose('notesManagerSelect', (key: string) => { for (const p of panels.values()) p.select(key) })
  ui.test.expose('notesTree', () => ui.pads.notes.tree())
  ui.test.expose('notesToast', () => toastSnapshot())

  return [
    ui.panes.register(type),
    ui.commands.registerCommand('notes.manager', () => show('all')),
    ui.commands.registerCommand('notes.manager.loose', () => show(hasLoose() ? 'loose' : 'all')),
    ui.pads.notes.onDidChange(() => { for (const p of panels.values()) p.refresh() }),
    ui.pads.notes.onDidLoose(key => showToast({ text: 'A nota da prancheta ficou solta', ms: UNDO_MS, action: { label: 'Ver', run: () => show('loose', key) } })),
  ]
}
