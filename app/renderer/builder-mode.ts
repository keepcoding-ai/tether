// The builder mode ("Montar a mesa"): the only state in which the "+" at the edges of frames and desks exist. Outside it
// nothing reveals a control on hover over another target (a tab, a scrollbar, a sash); inside it the panes' content is
// inert and the tabs are only drag handles, so the "+" (always shown, styles.css `body[data-builder="true"]`) own the
// clicks. The state belongs to the window, not to a desk: switching desks, opening the drawer or a pad keeps it, so the
// person can build several places in one go. It is never persisted (the app starts out of it).
//
// The DOM side lives here: `<body data-builder>` for CSS, and the capture-phase guard that keeps a press on a tab from
// activating it (its native drag still works) and turns a double click on a frame into "leave, with this frame in focus".

let on = false
const listeners = new Set<(on: boolean) => void>()

export function isBuilder(): boolean { return on }

/** Turns the mode on or off; `<body data-builder>` follows and every listener hears the change. No-op when unchanged. */
export function setBuilder(next: boolean): void {
  if (next === on) return
  on = next
  if (on) document.body.dataset.builder = 'true'
  else delete document.body.dataset.builder
  for (const fn of listeners) fn(on)
}

export function onBuilderChange(fn: (on: boolean) => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** What stays clickable inside a frame's dockview in the builder: the tab bar's buttons (a tab's ×, "+ Nova aba", "+N", ⋯) and the internal sashes. */
const LIVE_IN_FRAME = 'button, input, .tab-act, .tab-more, .dv-sash'

export interface BuilderGuardHost {
  /** A double click landed on `frame` (a `.frame` element of any Desk) while in the builder. */
  onFrameDoubleClick(frame: HTMLElement): void
}

/**
 * Installs the guard (once, at startup). In the builder a press inside a frame's dockview (a tab, the empty part of the
 * tab bar, the dimmed content behind) never reaches dockview or the focus followers: the event stops in the capture
 * phase at the document, before any target sees it. Only propagation is stopped, never the press's default action, so
 * the native drag of a tab (dockview's html5 drag starts from dragstart) and of a group still runs. That default still
 * focuses a tab or the content box (both tabIndex -1): a focus that follows a guarded press is stopped the same way
 * (dockview's focus tracking and the desk's frame follower never hear it), so the Foco de Mesa stays put. It is not
 * given up (a blur while the press is down cancels Chromium's drag start): the tab or the box holds the keyboard, never
 * a terminal. A focus the app gives (the chooser of a pane a "+" just added) is left alone.
 */
export function installBuilderGuard(host: BuilderGuardHost): void {
  const inert = (ev: Event): Element | undefined => {
    if (!on) return undefined
    const t = ev.target instanceof Element ? ev.target : null
    if (!t?.closest('.frame-dock') || t.closest(LIVE_IN_FRAME)) return undefined
    return t
  }
  /** A guarded press is in progress: its default action (the focus) runs right after the mousedown, in the same task. */
  let pressing = false
  document.addEventListener('pointerdown', ev => { if (inert(ev)) ev.stopPropagation() }, true)
  document.addEventListener('mousedown', ev => {
    if (!inert(ev)) return
    ev.stopPropagation()
    pressing = true
    setTimeout(() => { pressing = false })
  }, true)
  document.addEventListener('click', ev => { if (inert(ev)) { ev.preventDefault(); ev.stopPropagation() } }, true)
  for (const type of ['focus', 'focusin'] as const) {
    document.addEventListener(type, ev => { if (pressing && inert(ev)) ev.stopPropagation() }, true)
  }
  // Anywhere on a frame but its "+" and the tab bar's buttons: the tab's own double click (rename) never runs.
  document.addEventListener('dblclick', ev => {
    if (!on) return
    const t = ev.target instanceof Element ? ev.target : null
    const frame = t?.closest<HTMLElement>('.frame')
    if (!frame || t!.closest('.edge-plus') || t!.closest(LIVE_IN_FRAME)) return
    ev.preventDefault()
    ev.stopPropagation()
    host.onFrameDoubleClick(frame)
  }, true)
}
