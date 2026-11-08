// A desk: a gridview whose cells are frames, each frame its own dockview of terminal panes. The desk is the
// one place that knows which frame a pane lives in and which frame has the focus, so the renderer keeps
// talking about panes (`getPanel`, `addPanel`, `activePanel`…) and the desk routes to the right dockview.
// Also the "+" at the borders: four at each frame's edges (a pane spanning that edge) and four at the desk's edges (a
// new frame there; none in a single-frame place); click ADDS an empty pane there (the chooser inside it), right-click
// opens the menu (add, duplicate the focused pane there, the chooser in focus mode). They are always in the DOM but
// shown only in the builder mode (builder-mode.ts; styles.css): no control is ever revealed on hover over a tab, a
// scrollbar or a sash.
import { createDockview, createGridview, GridviewPanel, LocalSelectionTransfer, PanelTransfer, type AddPanelOptions, type DockviewApi, type DockviewComponentOptions, type DockviewDidDropEvent, type DockviewTheme, type GridviewApi, type IDockviewPanel, type IFrameworkPart, type SerializedDockview } from 'dockview-core'
import type { Direction, Target } from './create.ts'
import { DEFAULT_DESK_HUE } from './desks.ts'
import { deskDropZone, DOCKVIEW_USED_EVENT, draggedPanes, dropPlacements, type DeskDropZone, type PanePlacement } from './frame-drop-rules.ts'
import { icon } from './icons.ts'
import { type DeskLayout, emptyDesk, FRAME_COMPONENT, frameInsertion, isLayoutV1, nextFrameId, panelIdsOf } from './layout.ts'

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
  /**
   * The place is exactly one frame (a pad): tabs and internal splits (groups) inside it, never a second frame. Every
   * path that would add a frame (the desk-level "+", "quadro na borda", Mover, a drop on the outer edge, a saved
   * layout with several frames) lands in that one frame instead.
   */
  singleFrame?: boolean
  /** A "+" was used: `frameId` is the frame whose edge it was (undefined at the desk level). `add` is the click; `menu` the right-click, at `at`. */
  onEdge(target: Target, op: 'add' | 'menu', frameId: string | undefined, at: { x: number; y: number }): void
  /** The focused pane of this desk may have changed (a pane or a frame got activated). */
  onActivePanelChange?(): void
  /**
   * How this desk marks its focused frame. `foco`: it is the Foco de Mesa (`.frame.focused`, the F6 signals in the desk
   * colour) — the desks. `keyboard`: the keyboard is in this desk now, but it never takes the Foco de Mesa (pads, the
   * pads): a neutral outline (`.frame.kbd-focused`). `drawer`: the drawer's own focus, desk-like (`.frame.drawer-focused`, the F6 folder border in the neutral --drawer-line), separate from the hidden desk's Foco de Mesa. `none`: nothing is marked. Default `foco`.
   */
  focusKind?(): 'foco' | 'keyboard' | 'drawer' | 'none'
  /** The options to re-create a pane in another frame (a tab dragged out of its frame is rebuilt from them). */
  paneOptions?(panel: IDockviewPanel): AddPanelOptions
  /** A tab dragged from another frame (of this or another Desk) landed in this Desk as `id`: it is the active pane of its frame now. */
  onPaneDropped?(id: string): void
}

/**
 * Every live Desk of the window (the desks, the drawer, the pads' frames). A tab dragged out of a frame carries only
 * the id of its dockview; the frame that receives it finds the source frame here.
 */
const liveDesks = new Set<Desk>()

function frameOfView(viewId: string): { desk: Desk; frame: Frame } | undefined {
  for (const desk of liveDesks) {
    for (const frame of desk.frames.values()) if ((frame.dock as DockviewApi | undefined)?.id === viewId) return { desk, frame }
  }
  return undefined
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
  private focusedFrameId: string | undefined
  /** The frame with the focus; every assignment repaints the `focused` class the signal modes style (borda na guia, dim). */
  private get activeFrameId(): string | undefined { return this.focusedFrameId }
  private set activeFrameId(id: string | undefined) { this.focusedFrameId = id; this.paintFocus() }
  /** Views to load into frames created by `fromJSON` (looked up by frame id as each frame initializes). */
  private pendingViews: Record<string, SerializedDockview> = {}

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
    this.grid.onDidAddPanel(p => { this.frames.set(p.id, p as Frame); this.paintFocus() })
    this.grid.onDidRemovePanel(p => {
      this.frames.delete(p.id)
      // The focused frame left: the mark goes to the frame that takes over (activeFrame's fallback) once the grid settles.
      if (this.activeFrameId === p.id) { this.activeFrameId = undefined; queueMicrotask(() => this.paintFocus()) }
    })
    this.grid.onDidActivePanelChange(p => { if (p) this.activeFrameId = p.id; host.onActivePanelChange?.() })
    this.grid.onDidLayoutChange(e => host.onLayoutChange(e.reasons))
    liveDesks.add(this)
    if (!host.singleFrame) for (const side of SIDES) container.append(this.plusButton('desk', side, undefined))
    // Whatever takes the focus inside a frame makes it the focused frame (dockview only reports a change of the active
    // group, so a click into the already-active group of another frame would leave the signals on the old one).
    const follow = (ev: Event): void => {
      const f = [...this.frames.values()].find(fr => fr.element.contains(ev.target as Node))
      if (f && f.id !== this.activeFrameId) { this.activeFrameId = f.id; host.onActivePanelChange?.() }
    }
    container.addEventListener('focusin', follow)
    container.addEventListener('pointerdown', follow, true)
    // Drop anywhere: a tab dragged over the outer edge of this place (a new frame there) or over an empty frame (its
    // first pane) is claimed here, in the capture phase, before any dockview drop target sees the event.
    container.addEventListener('dragover', ev => this.onPlaceDragOver(ev), true)
    container.addEventListener('drop', ev => this.onPlaceDrop(ev), true)
    container.addEventListener('dragleave', ev => { if (!container.contains(ev.relatedTarget as Node | null)) this.hideDropHint() })
    document.addEventListener('dragend', () => this.hideDropHint(), true)
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
    // A tab (or a whole group) dragged from another frame: dockview moves tabs natively only within one dockview, so a
    // drag from another one is accepted here (its drop overlay shows) and moved by dropFromFrame.
    frame.dock.onUnhandledDragOver(e => {
      const data = e.getData()
      const source = data ? frameOfView(data.viewId) : undefined
      if (source && source.frame !== frame && this.host.paneOptions) e.accept()
    })
    frame.dock.onDidDrop(e => this.dropFromFrame(frame, e))
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

  /**
   * Moves what was dragged from another frame into `frame`, where it was dropped. The move runs once the drag is over
   * (its dragend reaches the source tab while it is still in the page, so dockview releases its drag state); each pane
   * is removed from its frame and re-created here (a terminal detaches, then re-attaches with the daemon's scrollback;
   * a note writes what it still holds first), the way "Mover…" moves panes. The slot's process is never touched.
   */
  private dropFromFrame(frame: Frame, e: DockviewDidDropEvent): void {
    const data = e.getData()
    const source = data ? frameOfView(data.viewId) : undefined
    if (!data || !source || source.frame === frame || !this.host.paneOptions) return
    const group = source.frame.dock.getGroup(data.groupId)
    const ids = draggedPanes(data.panelId, group?.panels.map(p => p.id) ?? [])
    const placements = dropPlacements(ids, e.position, e.group?.id, e.index)
    if (!placements) return
    this.movePanes(source, ids, () => frame, placements)
  }

  /**
   * Moves `ids` (panes of `source.frame`) into the frame `target()` gives, once the drag is over. `placements` says where
   * each lands (undefined: tabs of the frame's active group, or its first group when the frame is empty). `target` runs
   * when the move does, so a frame created for the drop (a desk edge) only exists if the move happens.
   */
  private movePanes(source: { desk: Desk; frame: Frame }, ids: readonly string[], target: () => Frame, placements?: readonly PanePlacement[], edge?: Direction): void {
    let done = false
    const run = (): void => {
      if (done) return
      done = true
      document.removeEventListener('dragend', run, true)
      LocalSelectionTransfer.getInstance<PanelTransfer>().clearData(PanelTransfer.prototype)
      const frame = target()
      let last: IDockviewPanel | undefined
      ids.forEach((id, i) => {
        const panel = source.frame.dock.getPanel(id)
        if (!panel) return
        const options = this.host.paneOptions!(panel)
        source.frame.dock.removePanel(panel)
        const at = placements?.[i]
        // The reference group (or the first moved pane) may be gone by now (the frame emptied meanwhile): then a tab of the frame.
        const valid = !at ? false : 'referenceGroup' in at ? !!frame.dock.getGroup(at.referenceGroup) : !!frame.dock.getPanel(at.referencePanel)
        try {
          // `edge`: the first pane opens a new group on that edge of the frame (its root), the others join it as tabs.
          const position = valid ? at : edge && frame.dock.panels.length > 0 ? (last ? { referencePanel: last.id, direction: 'within' } : { direction: edge }) : undefined
          last = frame.dock.addPanel({ ...options, ...(position ? { position } : {}) } as AddPanelOptions)
        } catch (err) {
          console.error(`arrastar painel ${id}: falhou, voltando ao quadro de origem`, err)
          source.frame.dock.addPanel(options)
        }
      })
      if (!last) return
      last.api.setActive()
      this.activeFrameId = frame.id
      this.host.onPaneDropped?.(last.id)
      if (source.desk !== this) source.desk.paintFocus()
    }
    document.addEventListener('dragend', run, true)
    setTimeout(run, 100) // no dragend (the source left the page): move anyway
  }

  // ---------- drop anywhere (the outer edge of this place, an empty frame) ----------

  private dropHint: HTMLElement | undefined
  private dropZone: DeskDropZone | undefined

  /** The pane drag in progress, when it comes from a frame of some live Desk (dockview's own transfer data). */
  private draggedFromFrame(): { source: { desk: Desk; frame: Frame }; ids: string[] } | undefined {
    const transfer = LocalSelectionTransfer.getInstance<PanelTransfer>()
    if (!transfer.hasData(PanelTransfer.prototype)) return undefined
    const data = transfer.getData(PanelTransfer.prototype)?.[0]
    const source = data ? frameOfView(data.viewId) : undefined
    if (!data || !source || !this.host.paneOptions) return undefined
    const ids = draggedPanes(data.panelId, source.frame.dock.getGroup(data.groupId)?.panels.map(p => p.id) ?? [])
    return ids.length > 0 ? { source, ids } : undefined
  }

  /** The zone under the pointer: this place's outer edge, an empty frame, or none (dockview's own targets handle it). */
  private zoneAt(ev: DragEvent): DeskDropZone | undefined {
    const r = this.container.getBoundingClientRect()
    const emptyFrame = [...this.frames.values()].find(f => {
      if ((f.dock as DockviewApi | undefined)?.panels.length !== 0) return false
      const fr = f.element.getBoundingClientRect()
      return ev.clientX >= fr.left && ev.clientX <= fr.right && ev.clientY >= fr.top && ev.clientY <= fr.bottom
    })
    const zone = deskDropZone({ left: r.left, top: r.top, width: r.width, height: r.height }, ev.clientX, ev.clientY, emptyFrame?.id)
    // One frame only: its outer edge is the frame's own (dockview splits inside it), never a new frame.
    return zone
  }

  private onPlaceDragOver(ev: DragEvent): void {
    const zone = this.draggedFromFrame() ? this.zoneAt(ev) : undefined
    if (!zone) { this.hideDropHint(); return }
    // Claimed: every dockview drop target under the pointer sees the event as used and takes its overlay away.
    const marked = ev as unknown as Record<string, boolean>
    marked[DOCKVIEW_USED_EVENT] = true
    ev.preventDefault()
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move'
    this.showDropHint(zone)
  }

  private onPlaceDrop(ev: DragEvent): void {
    const drag = this.draggedFromFrame()
    const zone = drag ? this.zoneAt(ev) : undefined
    this.hideDropHint()
    if (!drag || !zone) return
    ev.preventDefault()
    ev.stopPropagation()
    if (zone.kind === 'empty') {
      const id = zone.frameId
      this.movePanes(drag.source, drag.ids, () => this.frames.get(id) ?? this.frameForNew('right'))
      return
    }
    const direction = SIDE_DIRECTION[zone.side]
    // One frame only: its outer edge splits inside it (a new group on that side), never a new frame.
    const single = this.singleFrameOrUndefined()
    if (single) { this.movePanes(drag.source, drag.ids, () => this.singleFrameOrUndefined() ?? single, undefined, direction); return }
    this.movePanes(drag.source, drag.ids, () => this.frameForNew(direction))
  }

  private showDropHint(zone: DeskDropZone): void {
    if (this.dropZone && JSON.stringify(this.dropZone) === JSON.stringify(zone) && this.dropHint?.isConnected) return
    this.dropZone = zone
    const hint = this.dropHint ?? document.createElement('div')
    hint.className = 'desk-drop-hint'
    this.dropHint = hint
    const box = this.container.getBoundingClientRect()
    const area = zone.kind === 'empty' ? this.frames.get(zone.frameId)?.element.getBoundingClientRect() : undefined
    const r = area ?? box
    let left = r.left - box.left
    let top = r.top - box.top
    let width = r.width
    let height = r.height
    if (zone.kind === 'edge') {
      // The new frame's side of the place, a quarter of it (the share the new frame gets is the grid's, not this hint's).
      if (zone.side === 'left' || zone.side === 'right') { const w = width / 4; if (zone.side === 'right') left += width - w; width = w }
      else { const h = height / 4; if (zone.side === 'bottom') top += height - h; height = h }
    }
    hint.dataset.zone = zone.kind === 'edge' ? zone.side : 'empty'
    Object.assign(hint.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` })
    if (!hint.isConnected) this.container.append(hint)
  }

  private hideDropHint(): void {
    this.dropZone = undefined
    this.dropHint?.remove()
  }

  /** The one frame of a single-frame place (undefined for a desk, or before the frame exists). */
  private singleFrameOrUndefined(): Frame | undefined {
    if (!this.host.singleFrame) return undefined
    const id = this.frameIds[0]
    return id ? this.frames.get(id) : undefined
  }

  /** The panes a serialized frame names, added to `frame`: the first as a new group on its right edge, the rest as its tabs. */
  private addViewPanes(frame: Frame, view: SerializedDockview): void {
    let first: string | undefined
    for (const id of panelIdsOf(view)) {
      const p = view.panels[id]!
      const position = first ? { referencePanel: first, direction: 'within' } : frame.dock.panels.length > 0 ? { direction: 'right' } : undefined
      frame.dock.addPanel({ id, component: p.contentComponent ?? 'terminal', tabComponent: p.tabComponent, title: p.title, params: p.params, ...(position ? { position } : {}) } as AddPanelOptions)
      first ??= id
    }
  }

  /**
   * A single-frame place restored with several frames (saved before the rule): the panes of every other frame move into
   * the first, each frame's panes as a new group on its right; the emptied frames go. Panes are re-created from their
   * options (terminals re-attach with the daemon's scrollback; the processes are never touched).
   */
  private mergeFrames(): void {
    const [keep, ...rest] = this.frameIds.map(id => this.frames.get(id)).filter((f): f is Frame => !!f)
    if (!keep || rest.length === 0 || !this.host.paneOptions) return
    for (const frame of rest) {
      let first: string | undefined
      for (const panel of [...frame.dock.panels]) {
        const options = this.host.paneOptions(panel)
        frame.dock.removePanel(panel)
        const position = first ? { referencePanel: first, direction: 'within' } : keep.dock.panels.length > 0 ? { direction: 'right' } : undefined
        keep.dock.addPanel({ ...options, ...(position ? { position } : {}) } as AddPanelOptions)
        first ??= options.id
      }
      if (this.frames.has(frame.id)) this.grid.removePanel(frame)
    }
    this.activeFrameId = keep.id
    this.host.onLayoutChange()
  }

  private removeIfEmpty(frame: Frame): void {
    if (!this.frames.has(frame.id) || frame.dock.panels.length > 0 || this.frames.size <= 1) return
    this.grid.removePanel(frame)
    this.host.onLayoutChange()
  }

  get frameIds(): string[] { return this.grid.panels.map(p => p.id) }

  /** Marks the focused frame's element: `.focused` (the Foco de Mesa, the F6 signals hang on it) or `.kbd-focused` (a pad's or the drawer's, neutral), per the host's focusKind. */
  paintFocus(): void {
    const kind = this.host.focusKind?.() ?? 'foco'
    const active = kind === 'none' ? undefined : this.activeFrame
    for (const f of this.frames.values()) {
      f.element.classList.toggle('focused', kind === 'foco' && f === active)
      f.element.classList.toggle('kbd-focused', kind === 'keyboard' && f === active)
      f.element.classList.toggle('drawer-focused', kind === 'drawer' && f === active)
    }
  }

  get activeFrame(): Frame | undefined {
    return (this.activeFrameId && this.frames.get(this.activeFrameId)) || this.grid.panels.map(p => this.frames.get(p.id)).find(f => f !== undefined)
  }

  frameOf(slotId: string): Frame | undefined {
    for (const f of this.frames.values()) if (f.dock.getPanel(slotId)) return f
    return undefined
  }

  /** A new frame at a desk edge, spanning the whole desk on that side. */
  addFrame(direction: Direction): Frame {
    const single = this.singleFrameOrUndefined()
    if (single) return single
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
    const single = this.singleFrameOrUndefined()
    if (single && single.dock.panels.length > 0) {
      // One frame that already has panes: the frame's panes join it as a new group on its right (its own split is not kept).
      this.addViewPanes(single, view)
      this.activeFrameId = single.id
      return
    }
    const only = this.frames.size === 1 ? [...this.frames.values()][0] : undefined
    const frame = only && only.dock.panels.length === 0 ? only : this.addFrame('right')
    this.loadView(frame, view)
    this.activeFrameId = frame.id
  }

  /** A new frame beside `referenceFrame` (the "Mover…" dialog's "ao lado do quadro"). */
  addFrameBeside(referenceFrame: string, direction: Direction): Frame {
    const single = this.singleFrameOrUndefined()
    if (single) return single
    const id = nextFrameId(this.grid.toJSON().grid)
    return this.grid.addPanel({ id, component: FRAME_COMPONENT, position: { referencePanel: referenceFrame, direction } }) as Frame
  }

  /** Where something moved to this desk's `direction` edge goes: the only frame when it is empty, else a new frame there. */
  frameForNew(direction: Direction): Frame {
    const only = this.frames.size === 1 ? [...this.frames.values()][0] : undefined
    return only && only.dock.panels.length === 0 ? only : this.addFrame(direction)
  }

  /** The frame whose element is `el` or holds it (a double click in the builder mode names a `.frame` element). */
  frameIdAt(el: Element): string | undefined {
    for (const f of this.frames.values()) if (f.element === el || f.element.contains(el)) return f.id
    return undefined
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
    if (target?.level === 'desk' && direction && this.host.singleFrame) return this.addPanel(options, { level: 'frame', placement: direction }, reference)
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

  /**
   * Puts a new pane where `oldId` is (same group, same tab index) and removes the old one: how an empty pane
   * becomes what the person chose in it. Undefined when `oldId` is not here.
   */
  replacePanel(oldId: string, options: AddPanelOptions): IDockviewPanel | undefined {
    const frame = this.frameOf(oldId)
    const old = frame?.dock.getPanel(oldId)
    if (!frame || !old) return undefined
    const index = old.group.panels.indexOf(old)
    const panel = frame.dock.addPanel({ ...options, position: { referencePanel: oldId, direction: 'within', ...(index >= 0 ? { index } : {}) } } as AddPanelOptions)
    frame.dock.removePanel(old)
    this.activeFrameId = frame.id
    return panel
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
    liveDesks.delete(this)
    this.grid.clear()
    this.grid.dispose()
    this.frames.clear()
    this.container.remove()
  }

  clear(): void {
    this.grid.clear()
    this.frames.clear()
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
    if (this.host.singleFrame) this.mergeFrames()
    this.activeFrameId = desk.activeFrame && this.frames.has(desk.activeFrame) ? desk.activeFrame : this.frameIds[0]
  }

  /** A desk with one empty frame. */
  fromEmpty(): void {
    const desk = emptyDesk(this.meta.id, this.meta.name)
    this.pendingViews = {}
    try { this.grid.fromJSON({ grid: desk.frames.grid, activePanel: desk.activeFrame }) } catch { this.clear(); this.addFrame('right') }
    this.activeFrameId = this.frameIds[0]
  }

  // ---------- the "+" at the borders (shown only in the builder mode) ----------

  plusButton(level: 'frame' | 'desk', side: Side, frameId: string | undefined): HTMLElement {
    const btn = document.createElement('button')
    btn.className = `edge-plus ${level}`
    btn.dataset.side = side
    btn.dataset.level = level
    if (frameId) btn.dataset.frame = frameId
    btn.append(icon('plus'))
    const direction = SIDE_DIRECTION[side]
    const what = level === 'desk' ? 'Novo quadro' : 'Novo painel na borda do quadro'
    btn.title = `${what}: escolha dentro dele o que abrir · clique direito: duplicar`
    btn.setAttribute('aria-label', what)
    btn.addEventListener('mousedown', ev => ev.preventDefault()) // the keyboard moves only when the new pane's chooser takes it
    // The builder mode stays on after a "+" was used: the person builds several things in one go.
    btn.addEventListener('click', ev => { ev.stopPropagation(); this.host.onEdge({ level, placement: direction }, 'add', frameId, { x: ev.clientX, y: ev.clientY }) })
    btn.addEventListener('contextmenu', ev => { ev.preventDefault(); ev.stopPropagation(); this.host.onEdge({ level, placement: direction }, 'menu', frameId, { x: ev.clientX, y: ev.clientY }) })
    return btn
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
