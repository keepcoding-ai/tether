// The frame pads' renderer entry: each pad's view is the core's frames view (a Desk hosted like the drawer's). The panel
// pad has a second state, the manager of its frames (manager-slot.ts; the panel-pad-manager extension provides the view):
// its header carries the switch, pinned before the frame's own buttons, and its "⋯" menu carries "Quadros dos painéis…". In the
// manager state the pad shows the manager under the frame's tab bar, in place of the frame's content: the tab bar stays
// (the same tabs, the same buttons; the switch lit), the content stays mounted underneath (its terminals never resize).
// Without the panel-pad-manager extension the pad has one state and offers neither.
import type { PadView, TetherUi } from '../../app/renderer/ext-api.ts'
import { icon } from '../../app/renderer/icons.ts'
import { guideGroups } from '../../app/renderer/panel-frames.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { padManager, type ManagerView } from './manager-slot.ts'
import { manifest } from './manifest.ts'

export { manifest }

const PANEL_PAD = 'frame-pads.panel'
const MANAGER_COMMAND = 'panel-pad.manager'
const MANAGER_LABEL = 'Quadros dos painéis…'
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
      : { icon: 'squares-four', label: MANAGER_LABEL, run: () => { void ui.commands.run(MANAGER_COMMAND) } }]
  }
  // The pinned switch: one per tab strip of the pad's frames (a split adds a strip; the observer catches it).
  const pin = (): void => {
    const has = !!padManager.provider()
    const on = padManager.isOn()
    for (const bar of view.element.querySelectorAll<HTMLElement>('.tab-actions')) {
      let b = bar.querySelector<HTMLButtonElement>(':scope > [data-action="frames-manager"]')
      if (!b) {
        b = document.createElement('button')
        b.type = 'button'; b.className = 'tab-act'; b.dataset.action = 'frames-manager'
        b.append(icon('squares-four'))
        b.addEventListener('mousedown', ev => ev.preventDefault())
        b.addEventListener('click', ev => { ev.stopPropagation(); if (padManager.isOn()) padManager.hide(); else void ui.commands.run(MANAGER_COMMAND) })
        bar.prepend(b)
      }
      b.hidden = !has
      b.title = on ? BACK_LABEL : MANAGER_LABEL.replace('…', '')
      b.setAttribute('aria-label', b.title)
      b.setAttribute('aria-pressed', String(on))
      b.classList.toggle('attention', has && guideGroups(ui.pads.panelFrames.tree(), 'loose').length > 0)
    }
  }
  /** The manager sits under the frame's first tab bar: its top follows the bar's height. */
  const ro = new ResizeObserver(() => place())
  let bar: HTMLElement | undefined
  const place = (): void => {
    if (!manager) return
    const first = view.element.querySelector<HTMLElement>('.dv-tabs-and-actions-container') ?? undefined
    if (first !== bar) { if (bar) ro.unobserve(bar); bar = first; if (bar) ro.observe(bar) }
    const top = bar ? bar.getBoundingClientRect().bottom - view.element.getBoundingClientRect().top : 0
    manager.element.style.top = `${Math.max(0, Math.round(top))}px`
  }
  /** The state onto the pad: the manager mounted (once, on first need) and shown under the tab bar, or the frame. */
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
    place()
  }
  const focus = view.focus.bind(view)
  view.focus = () => { if (padManager.isOn() && manager) manager.focus(); else focus() }
  const mo = new MutationObserver(() => { pin(); place() })
  mo.observe(view.element, { childList: true, subtree: true })
  // A tab of the frame clicked in the manager state: the person asked for that tab, the pad goes back to the frame.
  view.element.addEventListener('click', ev => {
    if (!padManager.isOn()) return
    const t = ev.target as HTMLElement | null
    if (t?.closest('.dv-tabs-container .dv-tab') && !t.closest('.close')) padManager.hide()
  }, true)
  const dot = ui.pads.panelFrames.onDidChange(pin)
  const sub = padManager.onDidChange(() => {
    const was = view.element.classList.contains('manager-on')
    sync()
    // The keyboard follows the switch while this is the pad on screen.
    const shown = view.element.closest('.pad')?.classList.contains('shown')
    if (shown && was !== padManager.isOn()) requestAnimationFrame(() => view.focus())
  })
  sync()
  const dispose = view.dispose.bind(view)
  view.dispose = () => { mo.disconnect(); ro.disconnect(); sub.dispose(); dot.dispose(); manager?.dispose(); dispose() }
  return view
}

export function activate(ui: TetherUi): IDisposable[] {
  return (manifest.contributes?.pads ?? []).map(pad => ui.pads.register({
    id: pad.id,
    create: host => { const view = ui.pads.frames(host); return pad.id === PANEL_PAD ? withManager(ui, view) : view },
  }))
}
