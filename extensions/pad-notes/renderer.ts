// The pad-notes extension's renderer entry: the manager as the panel pad's second state (frame-pads/manager-slot.ts: this
// extension provides the view, the frame-pads extension hosts it), its two commands (switch the pad to the manager and
// back; show the loose notes), the toasts (a note became loose: "Ver"; a note closed: "Desfazer"), and the test hooks.
// The notes are the core's (TetherUi.pads.notes).
import type { ContextMenuEntry, NoteFilter, NoteSnapshot, TetherUi } from '../../app/renderer/ext-api.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { padManager } from '../frame-pads/manager-slot.ts'
import type { PadNotesChannels } from './ipc.ts'
import { manifest } from './manifest.ts'
import { NotesManagerPanel, type ManagerHost } from './panel.ts'
import { showToast, toastSnapshot } from './toast.ts'

export { manifest }

/** The pad the manager lives in (the frame-pads extension's). */
const PANEL_PAD = 'frame-pads.panel'
/** How long "Desfazer" stays on screen. */
const UNDO_MS = 8000

export function activate(ui: TetherUi): IDisposable[] {
  const ipc = ui.ipc<PadNotesChannels>()
  const panels = new Set<NotesManagerPanel>()

  const undoable = (snap: NoteSnapshot, text: string): void => {
    if (!snap.entries.length) return
    showToast({ text, ms: UNDO_MS, action: { label: 'Desfazer', run: () => ui.pads.notes.restore(snap) } })
  }

  const host: Omit<ManagerHost, 'exit'> = {
    tree: () => ui.pads.notes.tree(),
    targets: () => ui.pads.notes.targets(),
    read: async path => { const r = await ipc.invoke('read', path); return r.ok ? r.text : undefined },
    move: (from, to) => ui.pads.notes.move(from, to),
    close: (keys, what) => {
      const snap = ui.pads.notes.close(keys)
      const n = snap.entries.length
      undoable(snap, what === 'one' ? 'Nota fechada' : n === 1 ? '1 nota vazia limpa' : `${n} notas vazias limpas`)
    },
    // Going to a note: the pad shows that note's frame again (its panel takes the focus; the pad opens).
    show: key => { padManager.hide(); ui.pads.notes.show(key) },
    menu: (x, y, entries: ContextMenuEntry[]) => ui.menus.context(x, y, entries),
  }

  /** The pad to the manager, on a filter, with a note selected when given. */
  function show(filter: NoteFilter, key?: string): void {
    ui.pads.open(PANEL_PAD)
    padManager.show(filter, key)
  }

  /** The notes the commands look at: loose ones with content open the manager on Soltas. */
  const hasLoose = (): boolean => ui.pads.notes.tree().loose.some(r => !r.empty)

  ui.test.expose('notesManager', () => [...panels].filter(p => !p.element.hidden && p.element.isConnected).map(p => p.snapshot()))
  ui.test.expose('openNotesManager', (filter: NoteFilter = 'all', key?: string) => show(filter, key))
  ui.test.expose('notesManagerOn', () => padManager.isOn())
  ui.test.expose('notesManagerSelect', (key: string) => { for (const p of panels) p.select(key) })
  ui.test.expose('notesTree', () => ui.pads.notes.tree())
  ui.test.expose('notesToast', () => toastSnapshot())

  return [
    padManager.provide({
      create: ({ exit }) => {
        const panel = new NotesManagerPanel({ ...host, exit })
        panels.add(panel)
        const dispose = panel.dispose.bind(panel)
        panel.dispose = () => { panels.delete(panel); dispose() }
        return panel
      },
    }),
    ui.commands.registerCommand('notes.manager', () => { if (padManager.isOn()) padManager.hide(); else show('all') }),
    ui.commands.registerCommand('notes.manager.loose', () => show(hasLoose() ? 'loose' : 'all')),
    ui.pads.notes.onDidChange(() => { for (const p of panels) p.refresh() }),
    ui.pads.notes.onDidLoose(key => showToast({ text: 'A nota da prancheta ficou solta', ms: UNDO_MS, action: { label: 'Ver', run: () => show('loose', key) } })),
  ]
}
