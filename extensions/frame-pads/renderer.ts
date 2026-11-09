// The frame pads' renderer entry: each pad's view is the core's frames view (a Desk hosted like the drawer's). The panel
// pad's view also carries the notes counter ("≡ n", with a dot while some note is loose): a click opens the notes manager
// (the pad-notes extension) on the loose notes, or on all of them when none is loose. Without that extension the counter
// stays hidden.
import type { NoteTree, PadView, TetherUi } from '../../app/renderer/ext-api.ts'
import { icon } from '../../app/renderer/icons.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { manifest } from './manifest.ts'

export { manifest }

const PANEL_PAD = 'frame-pads.panel'
const MANAGER_COMMAND = 'notes.manager.loose'

/** The counter's numbers: notes with something in them, and how many of those are loose. */
export function counterOf(tree: NoteTree): { notes: number; loose: number } {
  const all = [...tree.loose, ...tree.desks.flatMap(d => [...(d.deskPad ? [d.deskPad] : []), ...d.panels]), ...tree.global]
  return { notes: all.filter(r => !r.empty).length, loose: tree.loose.filter(r => !r.empty).length }
}

function withCounter(ui: TetherUi, view: PadView): PadView {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'pad-notes-count'
  b.dataset.notesCounter = ''
  const n = document.createElement('span')
  const dot = document.createElement('span')
  dot.className = 'dot'
  b.append(icon('list'), n, dot)
  b.addEventListener('mousedown', ev => ev.preventDefault())
  b.addEventListener('click', ev => { ev.stopPropagation(); void ui.commands.run(MANAGER_COMMAND) })
  const paint = (): void => {
    const on = ui.commands.ids().includes(MANAGER_COMMAND)
    b.hidden = !on
    if (!on) return
    const { notes, loose } = counterOf(ui.pads.notes.tree())
    n.textContent = String(notes)
    dot.hidden = loose === 0
    b.classList.toggle('warn', loose > 0)
    const what = loose ? `${notes} ${notes === 1 ? 'nota' : 'notas'}, ${loose} ${loose === 1 ? 'solta' : 'soltas'}` : `${notes} ${notes === 1 ? 'nota' : 'notas'}`
    b.title = `Notas das pranchetas: ${what}. Clique para abrir o gerenciador.`
    b.setAttribute('aria-label', `Notas das pranchetas: ${what}`)
  }
  view.element.append(b)
  // One panel pad view per panel: only the one on screen repaints; a hidden one repaints when it shows.
  let visible = false
  const setVisible = view.setVisible?.bind(view)
  view.setVisible = v => { visible = v; setVisible?.(v); if (v) paint() }
  const sub = ui.pads.notes.onDidChange(() => { if (visible) paint() })
  const dispose = view.dispose.bind(view)
  view.dispose = () => { sub.dispose(); b.remove(); dispose() }
  return view
}

export function activate(ui: TetherUi): IDisposable[] {
  return (manifest.contributes?.pads ?? []).map(pad => ui.pads.register({
    id: pad.id,
    create: host => { const view = ui.pads.frames(host); return pad.id === PANEL_PAD ? withCounter(ui, view) : view },
  }))
}
