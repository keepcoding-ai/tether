// A desk: a gridview whose cells are frames, each frame its own dockview of terminal panes. The desk is the
// one place that knows which frame a pane lives in and which frame has the focus, so the renderer keeps
// talking about panes (`getPanel`, `addPanel`, `activePanel`…) and the desk routes to the right dockview.
// Also the "+" that appears near the borders: at a frame's edge (a pane spanning that edge) and at the
// desk's edge (a new frame there); click duplicates, right-click or Shift+click opens the chooser.
import { createDockview, createGridview, GridviewPanel, type AddPanelOptions, type DockviewApi, type DockviewComponentOptions, type DockviewTheme, type GridviewApi, type IDockviewPanel, type IFrameworkPart, type SerializedDockview } from 'dockview-core'
import type { Direction, Target } from './create.ts'
import { DEFAULT_DESK_HUE } from './desks.ts'
import { icon } from './icons.ts'
import { type DeskLayout, emptyDesk, FRAME_COMPONENT, frameInsertion, isLayoutV1, nextFrameId, panelIdsOf } from './layout.ts'

/**
 * How close to a border (px) the pointer must be for the "+" to show. Frames are cards inset by half of
 * `--gap` (8 px, styles.css) inside their `.frame` box, and the desk pads another half: the desk band is the whole
 * outer gutter (8 px) up to the card's border, and the frame band (measured on the `.frame` box) is its 4 px half
 * gutter plus 14 px into the card. Any wider desk band would swallow the band of a frame on the desk's edge.
 */
const FRAME_EDGE_PX = 18
const DESK_EDGE_PX = 8

type Side = 'left' | 'right' | 'top' | 'bottom'
const SIDES: readonly Side[] = ['left', 'right', 'top', 'bottom']
const SIDE_DIRECTION: Record<Side, Direction> = { left: 'left', right: 'right', top: 'above', bottom: 'below' }

export interface DeskHost {
  /** The options of every frame's dockview (components, tab, watermark); the desk adds the theme. */
  dockviewOptions(): Omit<DockviewComponentOptions, 'theme'>
  /** `reasons`: why dockview says the layout changed (undefined when the desk itself changed it). */
  onLayoutChange(reasons?: ReadonlySet<string>): void
  /** A pane was added to or removed from some frame. */
  onPanelsChange(): void
  /** A "+" was used: `frameId` is the frame whose edge it was (undefined at the desk level). */
  onEdge(target: Target, op: 'duplicate' | 'choose', frameId: string | undefined): void
  /** The focused pane of this desk may have changed (a pane or a frame got activated). */
  onActivePanelChange?(): void
}

/** One frame: a gridview cell owning a dockview. */
class Frame extends GridviewPanel {
  dock!: DockviewApi
  private readonly desk: Desk

  constructor(id: string, desk: Desk) {
    super(id, FRAME_COMPONENT)
    this.desk = desk
    this.element.classList.add('frame')
  }

  protected getComponent(): IFrameworkPart {
    const el = document.createElement('div')
    el.className = 'frame-dock'
    this.element.append(el)
    this.dock = createDockview(el, { ...this.desk.host.dockviewOptions(), theme: this.desk.theme })
    for (const side of SIDES) this.element.append(this.desk.plusButton('frame', side, this.id))
    this.desk.wireFrame(this)
    return { update: () => {}, dispose: () => { this.dock.dispose() } }
  }
}

export class Desk {
  readonly host: DeskHost
  readonly theme: DockviewTheme
  /** Identity of the desk in the layout file (name and color are phase C's). */
  meta: Pick<DeskLayout, 'id' | 'name' | 'color'> = { id: 'desk-1', name: 'Mesa 1', color: DEFAULT_DESK_HUE }
  private readonly container: HTMLElement
  private readonly grid: GridviewApi
  readonly frames = new Map<string, Frame>()
  private activeFrameId: string | undefined
  /** Views to load into frames created by `fromJSON` (looked up by frame id as each frame initializes). */
  private pendingViews: Record<string, SerializedDockview> = {}
  private readonly deskPlus = new Map<Side, HTMLElement>()
  private readonly framePlus = new Map<string, Map<Side, HTMLElement>>()

  constructor(container: HTMLElement, host: DeskHost, theme: DockviewTheme) {
    this.container = container
    this.host = host
    this.theme = theme
    container.classList.add('desk', theme.className)
    const gridEl = document.createElement('div')
    gridEl.className = 'desk-grid'
    container.append(gridEl)
    this.grid = createGridview(gridEl, {
      orientation: 'HORIZONTAL' as GridviewApi['orientation'],
      proportionalLayout: true,
      createComponent: ({ id }) => new Frame(id, this),
    })
    this.grid.onDidAddPanel(p => { this.frames.set(p.id, p as Frame) })
    this.grid.onDidRemovePanel(p => { this.frames.delete(p.id); this.framePlus.delete(p.id); if (this.activeFrameId === p.id) this.activeFrameId = undefined })
    this.grid.onDidActivePanelChange(p => { if (p) this.activeFrameId = p.id; host.onActivePanelChange?.() })
    this.grid.onDidLayoutChange(e => host.onLayoutChange(e.reasons))
    for (const side of SIDES) container.append(this.plusButton('desk', side, undefined))
    container.addEventListener('mousemove', ev => this.onMouseMove(ev))
    container.addEventListener('mouseleave', () => this.hidePlus())
  }

  // ---------- frames ----------

  /** Dockview events of a frame, wired once its dockview exists (during the frame's init). */
  wireFrame(frame: Frame): void {
    this.frames.set(frame.id, frame)
    frame.dock.onDidLayoutChange(e => this.host.onLayoutChange(e.reasons))
    frame.dock.onDidAddPanel(() => this.host.onPanelsChange())
    frame.dock.onDidRemovePanel(() => {
      this.host.onPanelsChange()
      // The last pane of a frame leaves: the frame goes with it, once dockview is done with the removal.
      queueMicrotask(() => this.removeIfEmpty(frame))
    })
    frame.dock.onDidActivePanelChange(p => { if (p) this.activeFrameId = frame.id; this.host.onActivePanelChange?.() })
    const view = this.pendingViews[frame.id]
    if (view) { delete this.pendingViews[frame.id]; this.loadView(frame, view) }
  }

  /** Restores a frame's dockview; if its JSON is refused, every pane it names is still opened, one by one. */
  loadView(frame: Frame, view: SerializedDockview): void {
    try { frame.dock.fromJSON(view); return } catch (err) { console.error(`quadro ${frame.id}: layout inválido, reabrindo os painéis um a um`, err) }
    frame.dock.clear()
    for (const id of panelIdsOf(view)) {
      const p = view.panels[id]!
      frame.dock.addPanel({ id, component: p.contentComponent ?? 'terminal', tabComponent: p.tabComponent, title: p.title, params: p.params })
    }
  }

  private removeIfEmpty(frame: Frame): void {
    if (!this.frames.has(frame.id) || frame.dock.panels.length > 0 || this.frames.size <= 1) return
    this.grid.removePanel(frame)
    this.host.onLayoutChange()
  }

  get frameIds(): string[] { return this.grid.panels.map(p => p.id) }

  get activeFrame(): Frame | undefined {
    return (this.activeFrameId && this.frames.get(this.activeFrameId)) || this.grid.panels.map(p => this.frames.get(p.id)).find(f => f !== undefined)
  }

  frameOf(slotId: string): Frame | undefined {
    for (const f of this.frames.values()) if (f.dock.getPanel(slotId)) return f
    return undefined
  }

  /** A new frame at a desk edge, spanning the whole desk on that side. */
  addFrame(direction: Direction): Frame {
    const json = this.grid.toJSON().grid
    const id = nextFrameId(json)
    const ins = frameInsertion(json, direction)
    if (ins.kind === 'beside') {
      return this.grid.addPanel({ id, component: FRAME_COMPONENT, position: { referencePanel: ins.referenceFrame, direction } }) as Frame
    }
    // dockview-core keeps the root wrap private; it is the move its own edge drops make (see frameInsertion).
    if (ins.wrapRoot) (this.grid as unknown as { component: { gridview: { insertOrthogonalSplitviewAtRoot(): void } } }).component.gridview.insertOrthogonalSplitviewAtRoot()
    return this.grid.addPanel({ id, component: FRAME_COMPONENT, location: ins.location }) as Frame
  }

  /**
   * Takes a frame out of this desk (moving it to another desk): its dockview JSON, then its panes are removed
   * (the frame goes with its last pane, unless it is the desk's only frame). Undefined when it does not exist.
   */
  takeFrame(frameId: string): SerializedDockview | undefined {
    const frame = this.frames.get(frameId)
    if (!frame) return undefined
    const view = frame.dock.toJSON()
    for (const p of [...frame.dock.panels]) frame.dock.removePanel(p)
    return view
  }

  /** Puts a frame taken from another desk here: into the only frame when it is empty, else a new frame at the right edge. */
  putFrame(view: SerializedDockview): void {
    const only = this.frames.size === 1 ? [...this.frames.values()][0] : undefined
    const frame = only && only.dock.panels.length === 0 ? only : this.addFrame('right')
    this.loadView(frame, view)
    this.activeFrameId = frame.id
  }

  /** A new frame beside `referenceFrame` (the "Mover…" dialog's "ao lado do quadro"). */
  addFrameBeside(referenceFrame: string, direction: Direction): Frame {
    const id = nextFrameId(this.grid.toJSON().grid)
    return this.grid.addPanel({ id, component: FRAME_COMPONENT, position: { referencePanel: referenceFrame, direction } }) as Frame
  }

  /** Where something moved to this desk's `direction` edge goes: the only frame when it is empty, else a new frame there. */
  frameForNew(direction: Direction): Frame {
    const only = this.frames.size === 1 ? [...this.frames.values()][0] : undefined
    return only && only.dock.panels.length === 0 ? only : this.addFrame(direction)
  }

  /** Marks a frame as the one with the focus (after something was moved into it). */
  focusFrame(frameId: string): void {
    if (this.frames.has(frameId)) this.activeFrameId = frameId
  }

  private ensureFrame(): Frame {
    return this.activeFrame ?? this.addFrame('right')
  }

  // ---------- panes (the dockview surface the renderer uses) ----------

  get panels(): IDockviewPanel[] {
    const out: IDockviewPanel[] = []
    // A frame the grid already lists may not have its dockview yet (its init is still to run): it has no panes.
    // Restoring one frame's layout fires onPanelsChange while a later frame is in that state; throwing here made
    // dockview refuse the saved layout and fall back to reopening the panes one by one.
    for (const id of this.frameIds) out.push(...((this.frames.get(id)?.dock as DockviewApi | undefined)?.panels ?? []))
    return out
  }

  get activePanel(): IDockviewPanel | undefined { return this.activeFrame?.dock.activePanel }

  getPanel(slotId: string): IDockviewPanel | undefined {
    for (const f of this.frames.values()) { const p = f.dock.getPanel(slotId); if (p) return p }
    return undefined
  }

  /**
   * Adds a pane: beside `reference` (pane level), at the edge of its frame (frame level), or in a new frame at
   * the desk's edge. Without a target, in the active group of the reference's frame (or the active frame).
   */
  addPanel(options: AddPanelOptions, target?: Target, reference?: string): IDockviewPanel {
    const refFrame = reference ? this.frameOf(reference) : undefined
    const frame = refFrame ?? this.ensureFrame()
    const direction = target && target.placement !== 'within' ? target.placement : undefined
    if (target?.level === 'desk' && direction) {
      const panel = this.addFrame(direction).dock.addPanel(options)
      this.activeFrameId = this.frameOf(panel.id)?.id
      return panel
    }
    let position: AddPanelOptions['position']
    if (target?.level === 'pane' && refFrame && reference) position = { referencePanel: reference, direction: target.placement }
    else if (direction) position = { direction } as AddPanelOptions['position'] // the frame's edge: no reference = the grid's root
    const panel = frame.dock.addPanel(Object.assign({}, options, position ? { position } : {}) as AddPanelOptions)
    this.activeFrameId = frame.id
    return panel
  }

  removePanel(panel: IDockviewPanel): void {
    this.frameOf(panel.id)?.dock.removePanel(panel)
  }

  // ---------- persistence ----------

  toJSON(): DeskLayout {
    const views: Record<string, SerializedDockview> = {}
    for (const id of this.frameIds) { const f = this.frames.get(id); if (f) views[id] = f.dock.toJSON() }
    const grid = this.grid.toJSON().grid
    return { ...this.meta, frames: { grid, views }, ...(this.activeFrame ? { activeFrame: this.activeFrame.id } : {}) }
  }

  /** Disposes every frame (and their panes: each terminal detaches) and removes the desk's element. */
  dispose(): void {
    this.grid.clear()
    this.grid.dispose()
    this.frames.clear()
    this.framePlus.clear()
    this.container.remove()
  }

  clear(): void {
    this.grid.clear()
    this.frames.clear()
    this.framePlus.clear()
    this.activeFrameId = undefined
  }

  /** Restores a desk (already pruned). If the grid JSON is refused, the frames are re-created one beside the other. */
  fromJSON(desk: DeskLayout): void {
    this.meta = { id: desk.id, name: desk.name, color: desk.color }
    this.pendingViews = { ...desk.frames.views }
    try {
      this.grid.fromJSON({ grid: desk.frames.grid, ...(desk.activeFrame ? { activePanel: desk.activeFrame } : {}) })
    } catch (err) {
      console.error('grade de quadros inválida, recriando os quadros lado a lado', err)
      this.clear()
      this.pendingViews = {}
      for (const view of Object.values(desk.frames.views)) {
        if (isLayoutV1(view)) this.loadView(this.addFrame('right'), view)
      }
    }
    this.pendingViews = {}
    if (this.frames.size === 0) this.fromEmpty()
    this.activeFrameId = desk.activeFrame && this.frames.has(desk.activeFrame) ? desk.activeFrame : this.frameIds[0]
  }

  /** A desk with one empty frame. */
  fromEmpty(): void {
    const desk = emptyDesk(this.meta.id, this.meta.name)
    this.pendingViews = {}
    try { this.grid.fromJSON({ grid: desk.frames.grid, activePanel: desk.activeFrame }) } catch { this.clear(); this.addFrame('right') }
    this.activeFrameId = this.frameIds[0]
  }

  // ---------- the "+" near the borders ----------

  plusButton(level: 'frame' | 'desk', side: Side, frameId: string | undefined): HTMLElement {
    const btn = document.createElement('button')
    btn.className = `edge-plus ${level}`
    btn.dataset.side = side
    btn.dataset.level = level
    if (frameId) btn.dataset.frame = frameId
    btn.hidden = true
    btn.append(icon('plus'))
    const direction = SIDE_DIRECTION[side]
    const what = level === 'desk' ? 'Novo quadro' : 'Novo painel na borda do quadro'
    btn.title = `${what}: clique duplica o painel em foco; clique direito (ou Shift+clique) escolhe.`
    btn.setAttribute('aria-label', what)
    btn.addEventListener('mousedown', ev => ev.preventDefault()) // the terminal keeps the keyboard focus
    btn.addEventListener('click', ev => { ev.stopPropagation(); this.hidePlus(); this.host.onEdge({ level, placement: direction }, ev.shiftKey ? 'choose' : 'duplicate', frameId) })
    btn.addEventListener('contextmenu', ev => { ev.preventDefault(); ev.stopPropagation(); this.hidePlus(); this.host.onEdge({ level, placement: direction }, 'choose', frameId) })
    if (level === 'desk') this.deskPlus.set(side, btn)
    else if (frameId) {
      if (!this.framePlus.has(frameId)) this.framePlus.set(frameId, new Map())
      this.framePlus.get(frameId)!.set(side, btn)
    }
    return btn
  }

  private onMouseMove(ev: MouseEvent): void {
    // Over a "+" already shown: keep it. Its centre may lie outside the band that revealed it (the desk's "+"
    // overhangs the gutter), and re-arbitrating there would swap it for a frame's "+" under the pointer.
    if ((ev.target as Element | null)?.closest?.('.edge-plus')) return
    const { clientX: x, clientY: y } = ev
    const near = nearestSide(this.container.getBoundingClientRect(), x, y)
    if (near && near.distance <= DESK_EDGE_PX) { this.showOnly(this.deskPlus, near.side); for (const m of this.framePlus.values()) this.showOnly(m, undefined); return }
    this.showOnly(this.deskPlus, undefined)
    for (const [id, buttons] of this.framePlus) {
      const frame = this.frames.get(id)
      const r = frame?.element.getBoundingClientRect()
      const inside = r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
      const n = inside ? nearestSide(r, x, y) : undefined
      this.showOnly(buttons, n && n.distance <= FRAME_EDGE_PX ? n.side : undefined)
    }
  }

  private showOnly(buttons: Map<Side, HTMLElement>, side: Side | undefined): void {
    for (const [s, b] of buttons) b.hidden = s !== side
  }

  hidePlus(): void {
    this.showOnly(this.deskPlus, undefined)
    for (const m of this.framePlus.values()) this.showOnly(m, undefined)
  }
}

/**
 * Moves a pane from one Desk to another (a desk to the drawer and back, or desk to desk): a tab in the target's
 * active frame. The pane is removed first, so its terminal detaches before the new one attaches (the daemon
 * keeps one subscription per client and slot); if the add fails, the pane goes back where it was. The slot's
 * process is never touched.
 */
export function transferPanel(source: Desk, target: Desk, slotId: string, options: AddPanelOptions): boolean {
  const panel = source.getPanel(slotId)
  if (!panel || source === target) return false
  source.removePanel(panel)
  try { target.addPanel(options) } catch (err) {
    console.error(`mover painel ${slotId}: falhou, voltando ao lugar de origem`, err)
    source.addPanel(options)
    return false
  }
  return true
}

/** Moves a whole frame (its split layout and panes) to another Desk, as a new frame at its right edge (or into its only, empty frame). */
export function transferFrame(source: Desk, target: Desk, frameId: string): boolean {
  if (source === target) return false
  const view: SerializedDockview | undefined = source.takeFrame(frameId)
  if (!view) return false
  try { target.putFrame(view) } catch (err) {
    console.error(`mover quadro ${frameId}: falhou, voltando ao lugar de origem`, err)
    source.putFrame(view)
    return false
  }
  return true
}

function nearestSide(r: DOMRect, x: number, y: number): { side: Side; distance: number } | undefined {
  if (r.width === 0 || r.height === 0) return undefined
  const candidates: Array<{ side: Side; distance: number }> = [
    { side: 'left', distance: x - r.left }, { side: 'right', distance: r.right - x },
    { side: 'top', distance: y - r.top }, { side: 'bottom', distance: r.bottom - y },
  ]
  return candidates.reduce((a, b) => b.distance < a.distance ? b : a)
}
