// The agent door on the renderer side: the one object app/renderer/main.ts hands its seams to. main.ts only calls in here
// (state applied, slots listed, layout saved, strip rendered, the two menus, the daemon's `desks` and `object` events) and
// the TetherUi blocks of the door (desks, pane emblems and menus, pick, objects) are served from here. The rules live in
// files of their own next to this one; this file wires them and stays free of DOM work at import, so the unit tests load it.
import type { ContextMenuEntry, DeskSeal, DeskView, PaneInfo, PickSpec, TabEmblem } from '../ext-api.ts'
import type { ExtObjects } from '../../shared/api.ts'
import type { DeskMap, ObjectKind, SlotState } from '../../../src/daemon/protocol.ts'
import { toDisposable, type IDisposable } from '../../shared/vscode-lifecycle.ts'
import type { Layout } from '../layout.ts'
import { DeskMapSender, deskMapOf } from './desk-map.ts'
import { applyPaneRequests, type PaneRequestPort } from './pane-requests.ts'

/** The rows an extension's provider gave, or none when it threw (one bad provider never breaks the menu). */
function collect<A>(providers: Iterable<{ ext: string; fn: (a: A) => ContextMenuEntry[] }>, arg: A, what: string): ContextMenuEntry[] {
  const out: ContextMenuEntry[] = []
  for (const p of [...providers]) {
    try {
      const rows = p.fn(arg)
      if (Array.isArray(rows)) out.push(...rows)
    } catch (err) { console.error(`${what} (${p.ext})`, err) }
  }
  return out
}

/** Leading, trailing and doubled separators of a list of rows, removed. */
function tidy<E>(entries: readonly E[], sep: E): E[] {
  const out: E[] = []
  for (const e of entries) {
    if (e === sep && (out.length === 0 || out[out.length - 1] === sep)) continue
    out.push(e)
  }
  while (out.length && out[out.length - 1] === sep) out.pop()
  return out
}

/**
 * A desk pill's menu with the extensions' rows as a group of their own before `anchor` (the first item whose label it
 * matches: "Hibernar mesa", else "Fechar mesa…"), or at the end when neither is there. No rows: the menu as it was.
 */
export function withDeskMenuGroup<E>(items: readonly E[], extra: readonly E[], sep: E, labelOf: (e: E) => string | undefined, anchors: readonly string[]): E[] {
  const rows = tidy(extra, sep)
  if (rows.length === 0) return [...items]
  let at = items.length
  for (const a of anchors) { const i = items.findIndex(e => labelOf(e) === a); if (i >= 0) { at = i; break } }
  const before = items.slice(0, at)
  const after = items.slice(at)
  return [...before, ...(before.length ? [sep] : []), ...rows, ...(after.length ? [sep] : []), ...after]
}

/**
 * A pane menu with the extensions' rows before its floor: the trailing run of the link ("Copiar link do painel") and the
 * close (any "Fechar…"), after a separator. No rows: the menu as it was.
 */
export function withPaneMenuItems<E>(entries: readonly E[], extra: readonly E[], sep: E, isFloor: (e: E) => boolean): E[] {
  const rows = tidy(extra, sep)
  if (rows.length === 0) return [...entries]
  let at = entries.length
  while (at > 0 && entries[at - 1] !== sep && isFloor(entries[at - 1]!)) at--
  const before = entries.slice(0, at)
  const floor = entries.slice(at)
  const lead = before.length && before[before.length - 1] !== sep ? [sep] : []
  const trail = floor.length ? [sep] : []
  return [...before, ...lead, ...rows, ...trail, ...floor]
}

/** An extension's data store before tetherd's objects are wired: reads are empty, writes are refused. */
function inertObjects(): ExtObjects {
  return {
    get: () => undefined,
    set: () => Promise.reject(new Error('door-unavailable: objects')),
    entries: () => [],
    onDidChange: () => toDisposable(() => {}),
  }
}

/** What main.ts gives the host so the daemon's pane requests and the desk map work (absent: both are inert). */
export interface DoorPort extends Omit<PaneRequestPort, 'resendMap'> {
  /** The layout as it would be saved now. */
  layout(): Layout
  /** The type a pane of that component reports in the desk map ('terminal' for a slot's pane). */
  paneType(component: string): string
  systemDeskName(deskId: string): string | undefined
  sendDeskMap(map: DeskMap): void
  /** Every slot the app knows. */
  slots(): Iterable<SlotState>
}

export class DoorHost {
  private readonly mapSender: DeskMapSender | undefined

  private readonly port: DoorPort | undefined

  constructor(port?: DoorPort) {
    this.port = port
    this.mapSender = port && new DeskMapSender(map => port.sendDeskMap(map))
  }

  private readonly deskMenus = new Set<{ ext: string; fn: (deskId: string) => ContextMenuEntry[] }>()
  private readonly paneMenus = new Set<{ ext: string; fn: (pane: PaneInfo) => ContextMenuEntry[] }>()
  private readonly deskListeners = new Set<() => void>()
  /** The desks as the last strip drawing showed them. */
  private deskSignature: string | undefined

  // ---------- seams main.ts calls ----------

  /** A slot's state was applied (the daemon's `state` event), after the pane and the strip were updated. */
  stateApplied(slot: SlotState): void { if (this.port) applyPaneRequests([slot], { ...this.port, resendMap: () => this.sendMap(true) }) }

  /** The slot list was read again (`list`: at start and on every reconnection). */
  slotsListed(slots: readonly SlotState[]): void {
    this.mapSender?.reconnected()
    this.restored(slots)
  }

  /** layout.json was restored (the first connection): the requests that waited for it run, and the map goes. */
  layoutRestored(): void { if (this.port) this.restored(this.port.slots()) }

  /** The requests, then the map (forced on a reconnection by `reconnected`); nothing before the layout is restored. */
  private restored(slots: Iterable<SlotState>): void {
    const port = this.port
    if (!port || !port.layoutRestored()) return
    applyPaneRequests(slots, { ...port, resendMap: () => this.sendMap(true) })
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
  objectEvent(_e: { ext: string; kind: ObjectKind; objectId: string; key: string; value?: unknown }): void {}

  /** The extensions' rows for a desk pill's menu (empty when none registered). */
  deskMenuItems(deskId: string): ContextMenuEntry[] {
    return collect(this.deskMenus, deskId, 'desks.menu')
  }

  /** The extensions' rows for a pane's menu (empty when none registered). */
  paneMenuItems(pane: PaneInfo | undefined): ContextMenuEntry[] {
    return pane ? collect(this.paneMenus, pane, 'panes.tabMenu') : []
  }

  // ---------- what TetherUi serves from here ----------

  deskMenu(ext: string, fn: (deskId: string) => ContextMenuEntry[]): IDisposable {
    const entry = { ext, fn }
    this.deskMenus.add(entry)
    return toDisposable(() => { this.deskMenus.delete(entry) })
  }

  paneMenu(ext: string, fn: (pane: PaneInfo) => ContextMenuEntry[]): IDisposable {
    const entry = { ext, fn }
    this.paneMenus.add(entry)
    return toDisposable(() => { this.paneMenus.delete(entry) })
  }

  onDesksChange(listener: () => void): IDisposable {
    this.deskListeners.add(listener)
    return toDisposable(() => { this.deskListeners.delete(listener) })
  }

  /** An extension's seal on a queue desk's pill. Not drawn yet: the seal board and the pill's drawing come next. */
  setSeal(_ext: string, _deskId: string, _seal: DeskSeal | undefined): void {}

  /** An extension's emblem on a pane's tab (its `.ext-emblems`). Not drawn yet: the emblem board comes next. */
  setEmblem(_ext: string, _paneId: string, _emblem: TabEmblem | undefined): void {}

  /** Everything an extension put through the door goes with it. */
  removeOwner(ext: string): void {
    for (const e of [...this.deskMenus]) if (e.ext === ext) this.deskMenus.delete(e)
    for (const e of [...this.paneMenus]) if (e.ext === ext) this.paneMenus.delete(e)
  }

  /** The list picker. Until it exists, every pick resolves as closed. */
  pickList<T>(_spec: PickSpec<T>): Promise<T | undefined> { return Promise.resolve(undefined) }

  pickSteps<A, B>(_first: PickSpec<A>, _second: (a: A) => PickSpec<B>): Promise<{ first: A; second: B } | undefined> {
    return Promise.resolve(undefined)
  }

  /** An extension's data on desks and panes. */
  objectsFor(_ext: string): ExtObjects { return inertObjects() }
}
