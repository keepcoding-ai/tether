// The drawer: one quick desk shared by all desks. It is a full Desk (frames, panes, the builder mode's "+" at the borders)
// inside an elevated card 16 px from every window edge, over the toolbar, with no backdrop: the cards behind fade
// (styles.css) and a click on the 16 px margin closes it. The card has its own slim bar (index.html).
//
// Closed it stays mounted at the same size (`visibility:hidden`, `inert`; no `display:none`), so its terminals keep
// receiving output and never get a `resize`: opening it shows terminals that are already up to date. This is the
// same technique as the inactive desks (desk-set.ts). The markup lives in index.html (#drawer); the motion in
// styles.css (reduced motion respected there).
import type { DockviewTheme } from 'dockview-core'
import { Desk, type DeskHost } from './desk.ts'
import { DEFAULT_DESK_HUE } from './desks.ts'
import { type DrawerLayout, emptyDrawer } from './layout.ts'

export interface DrawerHost {
  /** The host of the drawer's frames. */
  deskHost(): DeskHost
  /** The margin around the card (where a backdrop used to be) was clicked. */
  onMargin(): void
}

export class Drawer {
  readonly root: HTMLElement
  private readonly body: HTMLElement
  private readonly host: DrawerHost
  private readonly theme: DockviewTheme
  private current!: Desk
  private opened = false

  constructor(root: HTMLElement, host: DrawerHost, theme: DockviewTheme) {
    this.root = root
    this.host = host
    this.theme = theme
    this.body = root.querySelector<HTMLElement>('.drawer-body')!
    // The layer is transparent and only the card is on top of it: a press that lands on the layer itself is the margin.
    root.addEventListener('mousedown', ev => { if (ev.target === root) { ev.preventDefault(); host.onMargin() } })
    this.mountDesk()
    this.current.fromEmpty()
    this.setOpen(false)
  }

  /** The Desk inside (replaced by `load`/`fromEmpty`: never keep a reference across them). */
  get desk(): Desk { return this.current }
  get isOpen(): boolean { return this.opened }

  private mountDesk(): void {
    const el = document.createElement('div')
    el.className = 'drawer-desk'
    this.body.append(el)
    el.toggleAttribute('inert', this.root.dataset.empty === 'true')
    this.current = new Desk(el, this.host.deskHost(), this.theme)
    this.current.meta = { id: 'drawer', name: 'Gaveta', color: DEFAULT_DESK_HUE }
  }

  /** Shows or hides the panel (state attribute for CSS; inert keeps focus and clicks out while closed). */
  setOpen(open: boolean): void {
    this.opened = open
    this.root.dataset.open = String(open)
    this.root.toggleAttribute('inert', !open)
    this.root.setAttribute('aria-hidden', String(!open))
  }

  /**
   * Shows the invitation of an empty drawer (and hides the desk under it; it keeps its box, so nothing resizes).
   * The desk is `inert` meanwhile: nothing in it is worth a Tab stop.
   */
  setEmpty(empty: boolean): void {
    // Called on every strip repaint: an unchanged value writes nothing (toggleAttribute to the state it has is a no-op).
    if (this.root.dataset.empty !== String(empty)) this.root.dataset.empty = String(empty)
    this.body.querySelector('.drawer-desk')?.toggleAttribute('inert', empty)
  }

  toJSON(): DrawerLayout {
    const { frames, activeFrame } = this.current.toJSON()
    return { frames, ...(activeFrame ? { activeFrame } : {}) }
  }

  /** Replaces the content with a (pruned) layout; each frame restores loss-proof like a desk's (Desk.fromJSON). */
  load(layout: DrawerLayout): void {
    this.current.dispose()
    this.mountDesk()
    this.current.fromJSON({ id: 'drawer', name: 'Gaveta', color: DEFAULT_DESK_HUE, frames: layout.frames, ...(layout.activeFrame ? { activeFrame: layout.activeFrame } : {}) })
  }

  fromEmpty(): void { this.load(emptyDrawer()) }
}
