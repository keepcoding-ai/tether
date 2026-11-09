// The row of desks mounted at once: one Desk (gridview of frames) per desk, each in its own layer of the same
// size inside the container. Only the active layer is visible; the others stay mounted with
// `visibility:hidden` (and `inert`), so their terminals keep their size, stay attached and keep receiving
// output: switching desks never stops, detaches or resizes anything.
//
// The renderer keeps talking about panes (getPanel, addPanel, activePanel…) and the set routes to the desk
// that has the pane, or to the active desk. A Desk stays usable on its own (the drawer mounts one without a
// strip); this file only adds the row.
import type { AddPanelOptions, DockviewTheme, IDockviewPanel } from 'dockview-core'
import type { Target } from './create.ts'
import { Desk, type DeskHost, transferFrame, transferPanel } from './desk.ts'
import { closeDesk, type DeskHue, type DeskInfo, insertDesk, moveDesk, readDeskColor, recolorDesk, renameDesk, touchMru } from './desks.ts'
import { emptyDesk, isSystemDeskId, queueDesks, resolveActiveDesk, type DeskLayout, type Layout, type SystemDeskLayout } from './layout.ts'

export interface DeskSetHost {
  /** The host of one desk's frames (each desk gets its own, so a "+" knows its desk). */
  deskHost(deskId: () => string): DeskHost
  /** The row changed (order, names, colours, active desk): repaint the strip and save. */
  onDesksChange(): void
  /** A desk became the visible one. */
  onSwitch(deskId: string): void
  /** The options to re-create a pane elsewhere (component, tab, title, params). */
  paneOptions(panel: IDockviewPanel): AddPanelOptions
}

interface Mounted { desk: Desk; layer: HTMLElement }

/** What an owner declares for a system desk (a desk outside the queue); the colour only tints the desk's own chrome. */
export interface SystemDeskInfo { id: string; name: string; color?: DeskHue }

/** The layout fields the set reads and writes: the queue, the active desk (a queue id or a declared system id) and the system desks. */
export type DeskSetLayout = Pick<Layout, 'desks' | 'activeDesk'> & Partial<Pick<Layout, 'systemDesks'>>

export class DeskSet {
  private readonly container: HTMLElement
  private readonly host: DeskSetHost
  private readonly theme: DockviewTheme
  private readonly mounted = new Map<string, Mounted>()
  /** Order, names and colours: the source of truth (each Desk's `meta` mirrors its entry). */
  private row: DeskInfo[] = []
  private activeId = ''
  /** Queue desks only: the way back from a system desk is its first entry. */
  private mru: string[] = []
  /** System desks declared in this run (declaration order), mounted next to the queue and never in `row`. */
  private readonly system = new Map<string, DeskInfo>()
  /** The system desks of the last loaded layout: what a desk declared later mounts with. */
  private saved: Record<string, SystemDeskLayout> = {}
  /** A system desk the file left active that nobody declared yet: it opens as soon as it is declared (until the person switches). */
  private pendingActive: string | undefined

  constructor(container: HTMLElement, host: DeskSetHost, theme: DockviewTheme) {
    this.container = container
    this.host = host
    this.theme = theme
    container.classList.add('desk-set')
  }

  // ---------- the row ----------

  get desks(): readonly DeskInfo[] { return this.row }
  get activeDeskId(): string { return this.activeId }
  /** The visible desk. During a load (desks being mounted) it may be none yet: the first mounted one stands in. */
  get active(): Desk { return (this.mounted.get(this.activeId) ?? this.mounted.values().next().value)!.desk }
  private get activeOrNone(): Desk | undefined { return (this.mounted.get(this.activeId) ?? this.mounted.values().next().value)?.desk }

  desk(id: string): Desk | undefined { return this.mounted.get(id)?.desk }

  /** The declared system desks, in declaration order. */
  get systemDesks(): readonly DeskInfo[] { return [...this.system.values()] }
  isSystem(id: string): boolean { return this.system.has(id) }
  /** Queue desks first, then system desks: every desk with something mounted. */
  get allDeskIds(): string[] { return [...this.row.map(d => d.id), ...this.system.keys()] }
  /** The queue desk the person was on last (where leaving a system desk goes). */
  get returnDeskId(): string { return this.mru.find(id => this.row.some(d => d.id === id)) ?? this.row[0]?.id ?? '' }

  private mount(info: DeskInfo): Mounted {
    const layer = document.createElement('div')
    layer.className = 'desk-layer'
    layer.dataset.desk = info.id
    this.container.append(layer)
    const desk = new Desk(layer, this.host.deskHost(() => info.id), this.theme)
    desk.meta = { ...info }
    const m = { desk, layer }
    this.mounted.set(info.id, m)
    return m
  }

  private paint(): void {
    for (const [id, m] of this.mounted) {
      const on = id === this.activeId
      m.layer.classList.toggle('inactive', !on)
      m.layer.toggleAttribute('inert', !on)
      m.layer.setAttribute('aria-hidden', String(!on))
    }
  }

  private syncMeta(): void {
    for (const info of this.row) { const m = this.mounted.get(info.id); if (m) m.desk.meta = { ...info } }
  }

  /** Shows desk `id`. Nothing in the other desks changes. */
  switchTo(id: string): void {
    if (!this.mounted.has(id)) return
    this.activeId = id
    this.pendingActive = undefined
    if (!this.system.has(id)) this.mru = touchMru(this.mru, id)
    this.paint()
    this.host.onDesksChange()
    this.host.onSwitch(id) // also when it already was the active desk: the focus goes back to its pane
  }

  /** Enters system desk `id`, or leaves it for the queue desk the person came from. */
  toggleSystem(id: string): void {
    if (!this.system.has(id)) return
    this.switchTo(this.activeId === id ? this.returnDeskId : id)
  }

  /**
   * Declares a system desk for this run: a complete desk (frames, panes) outside the queue, mounted from what the
   * layout file holds under its id. Declaring again only updates its info. If the file left it active, it opens now.
   */
  declareSystem(info: SystemDeskInfo): void {
    if (this.row.some(d => d.id === info.id)) throw new Error(`system desk id ${info.id} is a queue desk's id`)
    const full: DeskInfo = { id: info.id, name: info.name, color: readDeskColor(info.color) }
    const had = this.system.has(info.id)
    this.system.set(info.id, full)
    const m = this.mounted.get(info.id)
    if (m) m.desk.meta = { ...full }
    else this.mountSystem(full)
    if (!had && this.pendingActive === info.id) this.switchTo(info.id)
    else this.host.onDesksChange()
  }

  private mountSystem(info: DeskInfo): void {
    const m = this.mount(info)
    const saved = this.saved[info.id]
    if (saved) m.desk.fromJSON({ ...saved, ...info })
    else m.desk.fromEmpty()
    this.paint()
  }

  /** A new desk (one empty frame) before or after `relativeTo` (the active desk by default); it becomes active. */
  create(side: 'before' | 'after', relativeTo = this.activeId): string {
    const { desks, desk } = insertDesk(this.row, relativeTo, side)
    this.row = desks
    const m = this.mount(desk)
    m.desk.fromEmpty()
    this.switchTo(desk.id)
    return desk.id
  }

  // Queue-only: a system desk is never renamed, recoloured or reordered (its id is not in the row).
  rename(id: string, name: string): void { if (!this.inQueue(id)) return; this.row = renameDesk(this.row, id, name); this.syncMeta(); this.host.onDesksChange() }
  recolor(id: string, color: DeskHue): void { if (!this.inQueue(id)) return; this.row = recolorDesk(this.row, id, color); this.syncMeta(); this.host.onDesksChange() }
  move(id: string, to: number): void { if (!this.inQueue(id)) return; this.row = moveDesk(this.row, id, to); this.host.onDesksChange() }
  private inQueue(id: string): boolean { return this.row.some(d => d.id === id) }

  /**
   * Removes desk `id` and everything mounted in it. The caller moves or closes its panes first: a pane still
   * in it is closed with it (its slot stays in the daemon, under "Slots fechados"). The last desk never goes.
   */
  remove(id: string): boolean {
    if (!this.inQueue(id)) return false
    // Closing a queue desk while a system desk is showing leaves the system desk showing.
    const inSystem = this.system.has(this.activeId)
    const next = closeDesk(this.row, id, inSystem ? this.returnDeskId : this.activeId, this.mru)
    if (!next) return false
    const m = this.mounted.get(id)
    this.row = next.desks
    this.mru = next.mru
    this.mounted.delete(id)
    m?.desk.dispose()
    if (inSystem) { this.paint(); this.host.onDesksChange() }
    else this.switchTo(next.active)
    return true
  }

  // ---------- panes (the surface the renderer uses) ----------

  get panels(): IDockviewPanel[] {
    const out: IDockviewPanel[] = []
    for (const id of this.allDeskIds) out.push(...(this.mounted.get(id)?.desk.panels ?? []))
    return out
  }

  get activePanel(): IDockviewPanel | undefined { return this.activeOrNone?.activePanel }

  getPanel(slotId: string): IDockviewPanel | undefined {
    for (const m of this.mounted.values()) { const p = m.desk.getPanel(slotId); if (p) return p }
    return undefined
  }

  deskOf(slotId: string): string | undefined {
    for (const [id, m] of this.mounted) if (m.desk.getPanel(slotId)) return id
    return undefined
  }

  /** Beside/at the edge of `reference` in the reference's desk; without one, in the active desk. */
  addPanel(options: AddPanelOptions, target?: Target, reference?: string): IDockviewPanel {
    const deskId = (reference && this.deskOf(reference)) || this.activeId
    return this.mounted.get(deskId)!.desk.addPanel(options, target, reference)
  }

  removePanel(panel: IDockviewPanel): void {
    const id = this.deskOf(panel.id)
    if (id) this.mounted.get(id)!.desk.removePanel(panel)
  }

  /** A new pane in the place of `oldId` (Desk.replacePanel), in whichever desk holds it. */
  replacePanel(oldId: string, options: AddPanelOptions): IDockviewPanel | undefined {
    const id = this.deskOf(oldId)
    return id ? this.mounted.get(id)!.desk.replacePanel(oldId, options) : undefined
  }

  /**
   * Moves a pane to desk `to` (a tab in the target's active frame). The pane is removed first, so its terminal
   * detaches before the new one attaches (the daemon keeps one subscription per client and slot); if the add
   * fails, the pane goes back where it was. The slot's process is never touched.
   */
  movePanel(slotId: string, to: string): boolean {
    const from = this.deskOf(slotId)
    const target = this.mounted.get(to)?.desk
    const source = from ? this.mounted.get(from)!.desk : undefined
    const panel = source?.getPanel(slotId)
    if (!source || !target || !panel || from === to) return false
    if (!transferPanel(source, target, slotId, this.host.paneOptions(panel))) return false
    this.host.onDesksChange()
    return true
  }

  /** The options to re-create a pane elsewhere (the drawer moves use them too). */
  paneOptions(panel: IDockviewPanel): AddPanelOptions { return this.host.paneOptions(panel) }

  /** Moves a whole frame (its split layout and panes) of desk `from` to desk `to`, as a new frame at its right edge. */
  moveFrame(from: string, frameId: string, to: string): boolean {
    const source = this.mounted.get(from)?.desk
    const target = this.mounted.get(to)?.desk
    if (!source || !target || from === to) return false
    if (!transferFrame(source, target, frameId)) return false
    this.host.onDesksChange()
    return true
  }

  // ---------- frames of the active desk ----------

  get frames(): Desk['frames'] { return this.active.frames }
  get frameIds(): string[] { return this.active.frameIds }
  get activeFrame(): ReturnType<Desk['frameOf']> { return this.active.activeFrame }
  frameOf(slotId: string): ReturnType<Desk['frameOf']> { const id = this.deskOf(slotId); return id ? this.mounted.get(id)!.desk.frameOf(slotId) : undefined }

  // ---------- persistence ----------

  /** The queue and the active desk; `systemDesks` holds the declared system desks only (the file's other entries are the caller's to keep). */
  toJSON(): Pick<Layout, 'desks' | 'activeDesk' | 'systemDesks'> {
    const desks: DeskLayout[] = []
    for (const info of this.row) { const m = this.mounted.get(info.id); if (m) desks.push({ ...m.desk.toJSON(), ...info }) }
    const systemDesks: Layout['systemDesks'] = {}
    for (const id of this.system.keys()) {
      const m = this.mounted.get(id)
      if (!m) continue
      const { frames, activeFrame } = m.desk.toJSON()
      systemDesks[id] = { frames, ...(activeFrame ? { activeFrame } : {}) }
    }
    return { desks, activeDesk: this.activeId, systemDesks }
  }

  private disposeAll(): void {
    for (const m of this.mounted.values()) m.desk.dispose()
    this.mounted.clear()
    this.row = []
    this.mru = []
  }

  /** Mounts every desk of the layout (already pruned); each desk restores loss-proof (Desk.fromJSON). */
  load(layout: DeskSetLayout): void {
    this.disposeAll()
    const systemDesks = layout.systemDesks ?? {}
    this.saved = systemDesks
    const file = { desks: layout.desks, activeDesk: layout.activeDesk, systemDesks }
    const seen = new Set<string>()
    for (const d of queueDesks(file)) {
      if (seen.has(d.id)) continue // a duplicated id would make two desks share one name: keep the first
      seen.add(d.id)
      const info: DeskInfo = { id: d.id, name: d.name || d.id, color: readDeskColor(d.color) }
      this.row.push(info)
      this.mount(info).desk.fromJSON(d)
    }
    if (this.row.length === 0) { this.fromEmpty(); return }
    for (const info of this.system.values()) this.mountSystem(info)
    const active = resolveActiveDesk({ ...file, desks: queueDesks(file) }, new Set(this.system.keys()))
    this.pendingActive = isSystemDeskId(file, layout.activeDesk) && !this.system.has(layout.activeDesk) ? layout.activeDesk : undefined
    this.mru = [this.system.has(active) ? this.row[0]!.id : active]
    this.activeId = this.mounted.has(active) ? active : this.row[0]!.id
    this.paint()
    this.host.onDesksChange()
  }

  /** One desk with one empty frame. */
  fromEmpty(): void {
    this.disposeAll()
    const d = emptyDesk()
    const info: DeskInfo = { id: d.id, name: d.name, color: d.color }
    this.row = [info]
    this.mount(info).desk.fromEmpty()
    for (const sys of this.system.values()) this.mountSystem(sys)
    this.activeId = info.id
    this.mru = [info.id]
    this.paint()
    this.host.onDesksChange()
  }
}
