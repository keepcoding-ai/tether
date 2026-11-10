// The frame pads' renderer entry: each pad's view is the core's frames view (a Desk hosted like the drawer's). The panel
// pad's "⋯" menu also carries "Notas das pranchetas…", which opens the notes manager (the pad-notes extension) on the
// loose notes, or on all of them when none is loose; the same opener sits pinned in the pad's header, before the frame's
// own buttons. Without that extension neither is offered.
import type { PadView, TetherUi } from '../../app/renderer/ext-api.ts'
import { icon } from '../../app/renderer/icons.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { manifest } from './manifest.ts'

export { manifest }

const PANEL_PAD = 'frame-pads.panel'
const MANAGER_COMMAND = 'notes.manager.loose'
const MANAGER_LABEL = 'Notas das pranchetas…'

/** The panel pad's "⋯" gets one item that opens the notes manager (no counter: the manager itself shows the numbers). */
function withManagerItem(ui: TetherUi, view: PadView): PadView {
  const own = view.menu?.bind(view)
  view.menu = () => {
    const base = own?.() ?? []
    if (!ui.commands.ids().includes(MANAGER_COMMAND)) return base
    return [...base, { icon: 'clipboard-text', label: MANAGER_LABEL, run: () => { void ui.commands.run(MANAGER_COMMAND) } }]
  }
  // The pinned button: one per tab strip of the pad's frames (a split adds a strip; the observer catches it).
  const pin = (): void => {
    const on = ui.commands.ids().includes(MANAGER_COMMAND)
    for (const bar of view.element.querySelectorAll<HTMLElement>('.tab-actions')) {
      let b = bar.querySelector<HTMLButtonElement>(':scope > [data-action="notes-manager"]')
      if (!b) {
        b = document.createElement('button')
        b.type = 'button'; b.className = 'tab-act'; b.dataset.action = 'notes-manager'
        b.title = MANAGER_LABEL.replace('…', ''); b.setAttribute('aria-label', b.title)
        b.append(icon('clipboard-text'))
        b.addEventListener('mousedown', ev => ev.preventDefault())
        b.addEventListener('click', ev => { ev.stopPropagation(); void ui.commands.run(MANAGER_COMMAND) })
        bar.prepend(b)
      }
      b.hidden = !on
    }
  }
  const mo = new MutationObserver(pin)
  mo.observe(view.element, { childList: true, subtree: true })
  pin()
  const dispose = view.dispose.bind(view)
  view.dispose = () => { mo.disconnect(); dispose() }
  return view
}

export function activate(ui: TetherUi): IDisposable[] {
  return (manifest.contributes?.pads ?? []).map(pad => ui.pads.register({
    id: pad.id,
    create: host => { const view = ui.pads.frames(host); return pad.id === PANEL_PAD ? withManagerItem(ui, view) : view },
  }))
}
