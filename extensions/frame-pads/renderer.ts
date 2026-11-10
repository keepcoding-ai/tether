// The frame pads' renderer entry: each pad's view is the core's frames view (a Desk hosted like the drawer's). The panel
// pad has a second state, the notes manager (manager-slot.ts; the pad-notes extension provides the view): its header
// carries the switch, pinned before the frame's own buttons, and its "⋯" menu carries "Notas das pranchetas…". In the
// manager state the pad shows the manager in place of the frame; the frame stays mounted (its terminals never resize).
// Without the pad-notes extension the pad has one state and offers neither.
import type { PadView, TetherUi } from '../../app/renderer/ext-api.ts'
import { icon } from '../../app/renderer/icons.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { padManager, type ManagerView } from './manager-slot.ts'
import { manifest } from './manifest.ts'

export { manifest }

const PANEL_PAD = 'frame-pads.panel'
const MANAGER_COMMAND = 'notes.manager.loose'
const MANAGER_LABEL = 'Notas das pranchetas…'
const BACK_LABEL = 'Voltar ao quadro do painel'

/** The panel pad's two states: the frame (the view the core gave) and the manager, switched by the header's button. */
function withManager(ui: TetherUi, view: PadView): PadView {
  let manager: ManagerView | undefined
  const own = view.menu?.bind(view)
  view.menu = () => {
    const base = own?.() ?? []
    if (!padManager.provider()) return base
    return [...base, padManager.isOn()
      ? { icon: 'push-pin', label: BACK_LABEL, run: () => padManager.hide() }
      : { icon: 'clipboard-text', label: MANAGER_LABEL, run: () => { void ui.commands.run(MANAGER_COMMAND) } }]
  }
  // The pinned switch: one per tab strip of the pad's frames (a split adds a strip; the observer catches it).
  const pin = (): void => {
    const has = !!padManager.provider()
    const on = padManager.isOn()
    for (const bar of view.element.querySelectorAll<HTMLElement>('.tab-actions')) {
      let b = bar.querySelector<HTMLButtonElement>(':scope > [data-action="notes-manager"]')
      if (!b) {
        b = document.createElement('button')
        b.type = 'button'; b.className = 'tab-act'; b.dataset.action = 'notes-manager'
        b.append(icon('clipboard-text'))
        b.addEventListener('mousedown', ev => ev.preventDefault())
        b.addEventListener('click', ev => { ev.stopPropagation(); if (padManager.isOn()) padManager.hide(); else void ui.commands.run(MANAGER_COMMAND) })
        bar.prepend(b)
      }
      b.hidden = !has
      b.title = on ? BACK_LABEL : MANAGER_LABEL.replace('…', '')
      b.setAttribute('aria-label', b.title)
      b.setAttribute('aria-pressed', String(on))
    }
  }
  /** The state onto the pad: the manager mounted (once, on first need) and shown, or the frame. */
  const sync = (): void => {
    const on = padManager.isOn()
    if (on && !manager) {
      manager = padManager.provider()?.create({ exit: () => padManager.hide() })
      if (manager) { manager.element.classList.add('pad-manager'); view.element.append(manager.element) }
    }
    if (manager && !padManager.provider()) { manager.element.remove(); manager.dispose(); manager = undefined }
    view.element.classList.toggle('manager-on', on)
    if (manager) manager.element.hidden = !on
    if (on) { const r = padManager.request(); manager?.open(r.filter, r.key) }
    pin()
  }
  const focus = view.focus.bind(view)
  view.focus = () => { if (padManager.isOn() && manager) manager.focus(); else focus() }
  const mo = new MutationObserver(pin)
  mo.observe(view.element, { childList: true, subtree: true })
  const sub = padManager.onDidChange(() => {
    const was = view.element.classList.contains('manager-on')
    sync()
    // The keyboard follows the switch while this is the pad on screen.
    const shown = view.element.closest('.pad')?.classList.contains('shown')
    if (shown && was !== padManager.isOn()) requestAnimationFrame(() => view.focus())
  })
  sync()
  const dispose = view.dispose.bind(view)
  view.dispose = () => { mo.disconnect(); sub.dispose(); manager?.dispose(); dispose() }
  return view
}

export function activate(ui: TetherUi): IDisposable[] {
  return (manifest.contributes?.pads ?? []).map(pad => ui.pads.register({
    id: pad.id,
    create: host => { const view = ui.pads.frames(host); return pad.id === PANEL_PAD ? withManager(ui, view) : view },
  }))
}
