// The drawer: one quick desk shared by all desks. It is a full Desk (frames, panes, the "+" near the borders)
// inside a panel that slides over the app, 8 px from the window edges, on a dimmed and blurred backdrop.
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
  /** The backdrop (outside the panel) was clicked. */
  onBackdrop(): void
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
    root.querySelector('.drawer-backdrop')!.addEventListener('mousedown', ev => { ev.preventDefault(); host.onBackdrop() })
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
    this.current = new Desk(el, this.host.deskHost(), this.theme)
    this.current.meta = { id: 'drawer', name: 'Gaveta', color: DEFAULT_DESK_HUE }
  }

  /** Shows or hides the panel (state attribute for CSS; inert keeps focus and clicks out while closed). */
  setOpen(open: boolean): void {
    this.opened = open
    this.root.dataset.open = String(open)
    this.root.toggleAttribute('inert', !open)
    this.root.setAttribute('aria-hidden', String(!open))
    if (!open) this.current.hidePlus()
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
