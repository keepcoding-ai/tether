// A pad that holds frames (F10b): the view a `frames: true` pad shows is a full Desk (frames, tabs, empty panes, the
// "+" near the borders, splits, any pane type), the same way the drawer hosts its quick desk (drawer.ts). Its state in
// layout.json is the drawer's shape (frames → panes), so the core prunes it and lists its panes (layout.ts
// prunePadStates/padPanelIds). Mounted once, kept mounted while hidden (sidebars.ts): its terminals never resize.
import type { DockviewTheme } from 'dockview-core'
import { Desk, type DeskHost } from './desk.ts'
import { DEFAULT_DESK_HUE } from './desks.ts'
import type { PadHost, PadView } from './ext-api.ts'
import { type DrawerLayout, emptyDrawer, isDrawerLayout } from './layout.ts'

export interface FramesPadHost {
  /** The host of this pad's frames (its "+" acts in this Desk). */
  deskHost(pad: FramesPad): DeskHost
  /** A fresh pad (no saved state) is seeded with something to start from (an empty pane: the chooser). */
  seed(pad: FramesPad): void
  /** The keyboard to a pane of the pad. */
  focusPane(id: string): void
  onCreate(pad: FramesPad): void
  onDispose(pad: FramesPad): void
}

export class FramesPad implements PadView {
  readonly element: HTMLElement
  readonly padId: string
  readonly deskId: string | undefined
  readonly desk: Desk
  private visible = false
  private readonly host: FramesPadHost

  constructor(pad: PadHost, host: FramesPadHost, theme: DockviewTheme) {
    this.padId = pad.padId
    this.deskId = pad.deskId
    this.host = host
    this.element = document.createElement('div')
    this.element.className = 'pad-frames'
    const el = document.createElement('div')
    el.className = 'pad-desk-box'
    this.element.append(el)
    this.desk = new Desk(el, host.deskHost(this), theme)
    const id = `pad:${pad.padId}${pad.deskId ? `@${pad.deskId}` : ''}`
    this.desk.meta = { id, name: id, color: DEFAULT_DESK_HUE }
    host.onCreate(this)
    const state: DrawerLayout | undefined = isDrawerLayout(pad.state) ? pad.state : undefined
    this.desk.fromJSON({ ...this.desk.meta, frames: (state ?? emptyDrawer()).frames, ...(state?.activeFrame ? { activeFrame: state.activeFrame } : {}) })
    if (!state) host.seed(this)
  }

  get isVisible(): boolean { return this.visible }

  focus(): void {
    const active = this.desk.activePanel
    if (active) this.host.focusPane(active.id)
  }

  serialize(): DrawerLayout {
    const { frames, activeFrame } = this.desk.toJSON()
    return { frames, ...(activeFrame ? { activeFrame } : {}) }
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    if (!visible) this.desk.hidePlus()
  }

  dispose(): void {
    this.host.onDispose(this)
    this.desk.dispose()
  }
}
