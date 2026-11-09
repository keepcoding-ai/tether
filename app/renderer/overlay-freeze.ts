// Which overlays of the interface hold the freeze signal (app/shared/freeze-rules.ts): the one place that lists them, so an
// overlay added later is one line here. The rule (design §2.3): an overlay that is MODAL or that THE PERSON OPENED freezes
// the native surfaces; a passing notification or a tooltip NEVER does (the person may be typing a password in the page). So
// the list below is a closed set of selectors and events, never "anything positioned over the page": the chord pill, the
// desk drop hint, `title` tooltips, `role=status` / `role=alert` notices and anything else not listed here stay out.
//
// Each overlay is read off the DOM state it already has (an open modal <dialog>, a menu without `hidden`, the drawer's
// `data-open`), not hooked in each open/close path: every way an overlay opens or closes (key, click, Esc, outside click, a
// command, the overlay's own code throwing halfway) ends in that state, so the hold can never be left behind by a path that
// forgot to let go. One MutationObserver; the reading runs in a microtask, before the next paint.
import type { FreezeRegistry } from '../shared/freeze-rules.ts'

/** The overlays that freeze, each with the reason it holds under. Order is irrelevant: each match is one hold. */
const FREEZING: { reason: string; matches(): Element[] }[] = [
  // Every modal dialog: the palette, the chooser ("Novo"), the profiles and terminal-theme dialogs, ask/confirm, move.
  { reason: 'dialog', matches: () => [...document.querySelectorAll('dialog[open]')].filter(d => d.matches(':modal')) },
  // Menus: the ≡ menu, the theme menu, every context menu (tab, desk, pad, status icon) and their submenus.
  { reason: 'menu', matches: () => visible('.menu[role="menu"]:not([hidden])') },
  // The "closed panes" list of the toolbar.
  { reason: 'menu', matches: () => visible('#closed-list:not([hidden])') },
  // Toolbar and status popovers pinned open by a click (a hover-only popover is a tooltip: it does not freeze).
  { reason: 'popover', matches: () => visible('.pinned .popover') },
  // The "no connection to tetherd" card covers the whole window.
  { reason: 'dialog', matches: () => visible('#overlay:not([hidden])') },
]

function visible(selector: string): Element[] {
  return [...document.querySelectorAll(selector)].filter(e => {
    const check = (e as Element & { checkVisibility?(): boolean }).checkVisibility
    return check ? check.call(e) : true
  })
}

/**
 * Starts holding the signal for the overlays above, the open drawer (sparing the surfaces inside it) and a drag of a tab,
 * pane or frame (dockview drags are HTML5 drags: dragstart to dragend/drop). Returns the stop function.
 */
export function watchOverlays(registry: FreezeRegistry<Element>, drawer: HTMLElement): () => void {
  const held = new Map<string, () => void>()
  const keys = new WeakMap<Element, string>()
  let n = 0
  const keyOf = (reason: string, el: Element): string => {
    let k = keys.get(el)
    if (!k) { k = String(++n); keys.set(el, k) }
    return `${reason}:${k}`
  }

  const read = (): void => {
    const want = new Map<string, () => () => void>()
    for (const o of FREEZING) for (const el of o.matches()) want.set(keyOf(o.reason, el), () => registry.hold(o.reason))
    // The open drawer is an overlay the person opened over the desk: the desk behind freezes, the drawer's own surfaces live.
    if (drawer.dataset.open === 'true') want.set('drawer', () => registry.hold('drawer', drawer))
    for (const [k, release] of held) if (!want.has(k) && !k.startsWith('drag')) { release(); held.delete(k) }
    for (const [k, take] of want) if (!held.has(k)) held.set(k, take())
  }

  let scheduled = false
  const schedule = (): void => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => { scheduled = false; read() })
  }
  const mo = new MutationObserver(schedule)
  mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open', 'hidden', 'class', 'data-open'] })

  // A drag is held from dragstart until it ends. dragend may never reach the document (the source element left the page,
  // dockview removes the tab it dragged), so a drop, and any mouse move with no button pressed (none fires during an HTML5
  // drag), end it too.
  const endDrag = (): void => { const r = held.get('drag'); if (r) { r(); held.delete('drag') } }
  const onStart = (): void => { if (!held.has('drag')) held.set('drag', registry.hold('drag')) }
  const onMove = (ev: MouseEvent): void => { if (ev.buttons === 0) endDrag() }
  document.addEventListener('dragstart', onStart, true)
  document.addEventListener('dragend', endDrag, true)
  document.addEventListener('drop', endDrag, true)
  document.addEventListener('mousemove', onMove, true)
  read()

  return () => {
    mo.disconnect()
    document.removeEventListener('dragstart', onStart, true)
    document.removeEventListener('dragend', endDrag, true)
    document.removeEventListener('drop', endDrag, true)
    document.removeEventListener('mousemove', onMove, true)
    for (const r of held.values()) r()
    held.clear()
  }
}
