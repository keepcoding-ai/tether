// The agent door on the renderer side: the one object app/renderer/main.ts hands its seams to. main.ts only calls in here
// (state applied, slots listed, layout saved, strip rendered, the two menus, the daemon's `desks` and `object` events) and
// the TetherUi blocks of the door (desks, pane emblems and menus, pick, objects) are served from here. The rules live in
// files of their own next to this one; this file wires them and stays free of DOM work at import, so the unit tests load it.
import type { ContextMenuRow, DeskSeal, DeskView, PaneHeadItem, PaneInfo, PickSpec, TabEmblem, TabMenuPlace } from '../ext-api.ts'
import type { ExtObjects } from '../../shared/api.ts'
import type { DeskMap, SlotState } from '../../../src/daemon/protocol.ts'
import { toDisposable, type IDisposable } from '../../shared/vscode-lifecycle.ts'
import type { Layout } from '../layout.ts'
import { DeskMapSender, deskMapOf } from './desk-map.ts'
import { deskSeals } from './desk-seal-rules.ts'
import { collect } from './menus.ts'
import { ObjectMirrors, rendererAsk, type DaemonAsk, type ObjectEventBody } from './objects.ts'
import { Picker } from './picker.ts'
import { applyPaneRequests, type PaneRequestPort } from './pane-requests.ts'
import { HeadItemBoard, HeadItemPainter, TabEmblemBoard, TabEmblemPainter } from './tab-emblem-rules.ts'

/** What main.ts gives the host so the daemon's pane requests and the desk map work (absent: both are inert). */
export interface DoorPort extends Omit<PaneRequestPort, 'resendMap'> {
  /** The layout as it would be saved now. */
  layout(): Layout
  /** The type a pane of that component reports in the desk map ('terminal' for a slot's pane). */
  paneType(component: string): string
  systemDeskName(deskId: string): string | undefined
  sendDeskMap(map: DeskMap): void
  /** Marks the slot's pane asleep (`asleepPanes` and `deskSleptPanes`), saving the layout when that changed something. Its process is not touched. */
  sleep(slotId: string): void
  /** Every slot the app knows. */
  slots(): Iterable<SlotState>
}

export class DoorHost {
  private readonly mapSender: DeskMapSender | undefined

  private readonly port: DoorPort | undefined
  /** The extensions' object data, mirrored from tetherd. */
  private readonly objects: ObjectMirrors
  /**
   * Slots whose pane entered asleep (a hibernated desk) and whose process is still coming up: the core wakes a pane when its
   * process goes stopped -> starting, and here the process is meant to run, so the sleep is set again until it is running.
   */
  private readonly sleepUntilRunning = new Set<string>()

  constructor(port?: DoorPort, ask: DaemonAsk = rendererAsk()) {
    this.port = port
    this.objects = new ObjectMirrors(ask)
    this.emblems = new TabEmblemBoard(paneId => this.emblemPainter.repaint(paneId))
    this.emblemPainter = new TabEmblemPainter(this.emblems)
    this.heads = new HeadItemBoard(paneId => this.headPainter.repaint(paneId))
    this.headPainter = new HeadItemPainter(this.heads)
    this.mapSender = port && new DeskMapSender(map => port.sendDeskMap(map))
  }

  private readonly deskMenus = new Set<{ ext: string; fn: (deskId: string) => ContextMenuRow[] }>()
  private readonly paneMenus = new Set<{ ext: string; fn: (pane: PaneInfo) => ContextMenuRow[]; top: boolean }>()
  private readonly deskListeners = new Set<() => void>()
  /** The desks as the last strip drawing showed them. */
  private deskSignature: string | undefined

  // ---------- seams main.ts calls ----------

  /** A slot's state was applied (the daemon's `state` event), after the pane and the strip were updated. */
  stateApplied(slot: SlotState): void {
    const port = this.port
    if (!port) return
    applyPaneRequests([slot], this.requestPort(port))
    if (!this.sleepUntilRunning.has(slot.slotId)) return
    port.sleep(slot.slotId)
    if (slot.status === 'running') this.sleepUntilRunning.delete(slot.slotId)
  }

  /** What applying a request needs: the port, the map resend, and the sleep of a pane that enters in a hibernated desk. */
  private requestPort(port: DoorPort): PaneRequestPort {
    return {
      ...port,
      resendMap: () => this.sendMap(true),
      addPane: (slot, deskId, asleep) => {
        port.addPane(slot, deskId, asleep)
        if (!asleep) return
        port.sleep(slot.slotId)
        if (slot.status !== 'running') this.sleepUntilRunning.add(slot.slotId)
      },
    }
  }

  /** The slot list was read again (`list`: at start and on every reconnection). */
  slotsListed(slots: readonly SlotState[]): void {
    this.mapSender?.reconnected()
    void this.objects.reload()
    this.restored(slots)
  }

  /** layout.json was restored (the first connection): the requests that waited for it run, and the map goes. */
  layoutRestored(): void { if (this.port) this.restored(this.port.slots()) }

  /** The requests, then the map (forced on a reconnection by `reconnected`); nothing before the layout is restored. */
  private restored(slots: Iterable<SlotState>): void {
    const port = this.port
    if (!port || !port.layoutRestored()) return
    applyPaneRequests(slots, this.requestPort(port))
    this.sendMap()
  }

  private sendMap(force = false): void {
    const port = this.port
    if (port) this.mapSender!.offer(deskMapOf(port.layout(), port.paneType, port.systemDeskName), force)
  }

  /** layout.json was just handed to main (the save timer fired, after the layout was restored). */
  layoutSaved(): void { this.sendMap() }

  /**
   * The desk strip was drawn again: the queue, the visible desk, a name, a colour, a desk's sleep or its panes may have
   * changed. The listeners hear only an actual change.
   */
  stripRendered(view: () => { desks: readonly DeskView[]; activeId: string }): void {
    const signature = JSON.stringify(view())
    if (signature === this.deskSignature) return
    this.deskSignature = signature
    for (const l of [...this.deskListeners]) { try { l() } catch (err) { console.error('desks.onDidChange', err) } }
  }

  /** The daemon's `desks` event. */
  desksEvent(_map: DeskMap): void {}

  /** The daemon's `object` event. */
  objectEvent(e: ObjectEventBody): void { this.objects.apply(e) }

  /** The extensions' rows for a desk pill's menu (empty when none registered). */
  deskMenuItems(deskId: string): ContextMenuRow[] {
    return collect(this.deskMenus, deskId, 'desks.menu')
  }

  /** The extensions' rows for a pane's menu, before its floor (empty when none registered). */
  paneMenuItems(pane: PaneInfo | undefined): ContextMenuRow[] {
    return pane ? collect([...this.paneMenus].filter(p => !p.top), pane, 'panes.tabMenu') : []
  }

  /** The extensions' rows for the top of a pane's menu (`place: 'top'`; empty when none registered). */
  paneMenuTop(pane: PaneInfo | undefined): ContextMenuRow[] {
    return pane ? collect([...this.paneMenus].filter(p => p.top), pane, 'panes.tabMenu') : []
  }

  // ---------- what TetherUi serves from here ----------

  deskMenu(ext: string, fn: (deskId: string) => ContextMenuRow[]): IDisposable {
    const entry = { ext, fn }
    this.deskMenus.add(entry)
    return toDisposable(() => { this.deskMenus.delete(entry) })
  }

  paneMenu(ext: string, fn: (pane: PaneInfo) => ContextMenuRow[], opts?: TabMenuPlace): IDisposable {
    const entry = { ext, fn, top: opts?.place === 'top' }
    this.paneMenus.add(entry)
    return toDisposable(() => { this.paneMenus.delete(entry) })
  }

  onDesksChange(listener: () => void): IDisposable {
    this.deskListeners.add(listener)
    return toDisposable(() => { this.deskListeners.delete(listener) })
  }

  /** An extension's seal on a queue desk's pill: the board is read by the desk switch, which draws again on a change. */
  setSeal(ext: string, deskId: string, seal: DeskSeal | undefined): void { deskSeals.set(ext, deskId, seal) }

  /** An extension's emblem on a pane's tab (its `.ext-emblems`): the painter fills every tab of that pane, now and when one appears. */
  setEmblem(ext: string, paneId: string, emblem: TabEmblem | undefined): void { this.emblems.set(ext, paneId, emblem) }

  /** An extension's emblems on a pane's tab, in order (up to three). */
  setEmblems(ext: string, paneId: string, emblems: readonly TabEmblem[] | undefined): void { this.emblems.setMany(ext, paneId, emblems) }

  /** An extension's line under a pane's tab, in a hue. */
  setTabLine(ext: string, paneId: string, hue: number | undefined): void { this.emblems.setLine(ext, paneId, hue) }

  /** An extension's line in a pane's status bar (a terminal panel draws it). */
  setHeadItem(ext: string, paneId: string, item: PaneHeadItem | undefined): void { this.heads.set(ext, paneId, item) }

  /** Every extension's status-bar line of a pane. */
  headItems(paneId: string): readonly PaneHeadItem[] { return this.heads.of(paneId) }

  private readonly emblemPainter: TabEmblemPainter
  private readonly emblems: TabEmblemBoard
  private readonly headPainter: HeadItemPainter
  private readonly heads: HeadItemBoard

  /** Everything an extension put through the door goes with it. */
  removeOwner(ext: string): void {
    for (const e of [...this.deskMenus]) if (e.ext === ext) this.deskMenus.delete(e)
    for (const e of [...this.paneMenus]) if (e.ext === ext) this.paneMenus.delete(e)
    deskSeals.removeOwner(ext)
    this.emblems.removeOwner(ext)
    this.heads.removeOwner(ext)
  }

  /** The list picker, drawn on first use (in a process with no document a pick resolves as closed). */
  private readonly picker = new Picker()

  pickList<T>(spec: PickSpec<T>): Promise<T | undefined> { return this.picker.list(spec) }

  pickSteps<A, B>(first: PickSpec<A>, second: (a: A) => PickSpec<B>): Promise<{ first: A; second: B } | undefined> {
    return this.picker.steps(first, second)
  }

  /** An extension's data on desks and panes. */
  objectsFor(ext: string): ExtObjects { return this.objects.apiFor(ext) }
}

export { withDeskMenuGroup, withPaneMenuItems, withPaneMenuTop } from './menus.ts'
