// Codec of the arrangement (layout.json, v4): a pure projection of the working file into one entity per desk plus a
// few small layout entities (export) and back (import). The arrangement is treated as tolerant JSON: what the codec
// does not understand travels (desks) or stays (machine fields) byte for byte. Machine paths never travel: under the
// keys in PATH_KEYS an absolute path becomes a PlaceRef, and comes back as a path through this machine's place map.
// What stays on the machine: activeDesk, drawer, sidebars, systemDesks, asleepPanes, deskSleptPanes, each desk's
// `asleep` and any unknown top-level key.
import { ensureRef, fromRef, type PlaceMap, type PlaceOpts, type PlaceRef } from '../places.ts'

/** collection → id → value */
export type SyncEntities = Record<string, Record<string, unknown>>
/** A v4 layout.json, loosely typed. */
export type LayoutJson = Record<string, unknown>

/**
 * Keys whose string value is a machine path inside a desk or the workspace: `hint.cwd` of a terminal pane,
 * `note.cwd` and `empty.cwd`, `note.path` and `preview.path` (note, markdown/HTML/image preview panes) and
 * `workspace.pinned[].path`. Matching is by key name at any depth, but only a string that looks like an absolute
 * path is converted (never a URL).
 */
export const PATH_KEYS: readonly string[] = ['cwd', 'path']

const ID_RE = /^[a-z0-9][a-z0-9._@:-]*$/ // same rule as the entity store's names
const DESKS = 'desks'
const LAYOUT = 'layout'

type Obj = Record<string, unknown>

const isObject = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x)

/** Own-property write that is safe for a `__proto__` key coming from JSON. */
function put(out: Obj, key: string, value: unknown): void {
  Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true })
}

/** Absolute by the form of the text: `X:\`, `X:/` or a leading `/` (not `//`, which is a URL tail). URLs never match. */
function isAbsolutePath(s: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(s) || /^\/(?!\/)/.test(s)
}

function isPlaceRefShape(x: unknown): x is PlaceRef {
  if (!isObject(x)) return false
  const keys = Object.keys(x)
  return keys.length === 2 && keys.includes('place') && keys.includes('rel') && typeof x.place === 'string' && typeof x.rel === 'string'
}

interface Walk { map: PlaceMap; opts?: PlaceOpts; unmapped: Set<string> }

/** A copy of `value` with the absolute paths under PATH_KEYS as PlaceRefs; `w.map` grows with the new places. */
function toPlaces(value: unknown, w: Walk): unknown {
  if (Array.isArray(value)) return value.map((v) => toPlaces(v, w))
  if (!isObject(value)) return value
  const out: Obj = {}
  for (const [k, v] of Object.entries(value)) {
    if (PATH_KEYS.includes(k) && typeof v === 'string' && isAbsolutePath(v)) {
      const r = ensureRef(v, w.map, w.opts)
      w.map = r.map
      put(out, k, { place: r.ref.place, rel: r.ref.rel })
    } else put(out, k, toPlaces(v, w))
  }
  return out
}

/** A copy of `value` with the PlaceRefs under PATH_KEYS as paths; an unresolvable one drops its key. */
function fromPlaces(value: unknown, w: Walk): unknown {
  if (Array.isArray(value)) return value.map((v) => fromPlaces(v, w))
  if (!isObject(value)) return value
  const out: Obj = {}
  for (const [k, v] of Object.entries(value)) {
    if (PATH_KEYS.includes(k) && isPlaceRefShape(v)) {
      const path = fromRef(v, w.map, w.opts)
      if (path === undefined) w.unmapped.add(v.place)
      else put(out, k, path)
    } else put(out, k, fromPlaces(v, w))
  }
  return out
}

function isDeskShape(x: unknown): x is Obj & { id: string } {
  if (!isObject(x)) return false
  if (typeof x.id !== 'string' || x.id === '' || typeof x.name !== 'string') return false
  const frames = x.frames
  return isObject(frames) && isObject(frames.grid) && isObject(frames.views)
}

/** Slot ids of the terminal panes of a desk (panes whose params carry a string `slotId`). */
function terminalSlots(desk: unknown): string[] {
  const out: string[] = []
  if (!isObject(desk) || !isObject(desk.frames) || !isObject(desk.frames.views)) return out
  for (const view of Object.values(desk.frames.views)) {
    if (!isObject(view) || !isObject(view.panels)) continue
    for (const panel of Object.values(view.panels)) {
      if (isObject(panel) && isObject(panel.params) && typeof panel.params.slotId === 'string') out.push(panel.params.slotId)
    }
  }
  return out
}

export function exportLayout(layout: LayoutJson, map: PlaceMap, opts?: PlaceOpts): { entities: SyncEntities; map: PlaceMap; skipped: string[] } {
  if (!isObject(layout) || layout.v !== 4) return { entities: {}, map, skipped: [LAYOUT] }
  const w: Walk = { map, opts, unmapped: new Set() }
  const skipped: string[] = []
  const desks: Record<string, unknown> = {}
  const ids: string[] = []
  const list = Array.isArray(layout.desks) ? layout.desks : []
  list.forEach((d, i) => {
    const id = isObject(d) && typeof d.id === 'string' ? d.id : undefined
    if (id === undefined || !ID_RE.test(id) || !isDeskShape(d) || Object.hasOwn(desks, id)) {
      skipped.push(`${DESKS}/${id ?? `[${i}]`}`)
      return
    }
    const { asleep: _asleep, ...rest } = d
    put(desks, id, toPlaces(rest, w))
    ids.push(id)
  })
  const meta: Record<string, unknown> = { order: { ids } }
  if (Array.isArray(layout.emblems)) meta.emblems = { emblems: structuredClone(layout.emblems) }
  if (isObject(layout.workspace)) meta.workspace = toPlaces(layout.workspace, w)
  return { entities: { [DESKS]: desks, [LAYOUT]: meta }, map: w.map, skipped }
}

export function importLayout(
  entities: SyncEntities,
  current: LayoutJson,
  map: PlaceMap,
  opts?: PlaceOpts,
): { layout: LayoutJson; arrived: string[]; removed: string[]; unmappedPlaces: string[]; skipped: string[] } {
  const out = structuredClone(current) as Obj
  const arrived: string[] = []
  const removed: string[] = []
  const skipped: string[] = []
  const w: Walk = { map, opts, unmapped: new Set() }
  const deskEntities = entities?.[DESKS]
  if (!isObject(deskEntities)) return { layout: out, arrived, removed, unmappedPlaces: [], skipped }

  const local = new Map<string, Obj>()
  if (Array.isArray(out.desks)) for (const d of out.desks) if (isObject(d) && typeof d.id === 'string') local.set(d.id, d)

  // Final desks by id. A malformed entity is ignored; the desk this machine already has under that id stays as it is.
  const incoming = new Map<string, Obj>()
  for (const [key, e] of Object.entries(deskEntities)) {
    if (isDeskShape(e) && e.id === key) {
      const desk = fromPlaces(e, w) as Obj
      delete desk.asleep
      incoming.set(key, desk)
    } else {
      skipped.push(`${DESKS}/${key}`)
      const mine = local.get(key)
      if (mine) incoming.set(key, mine)
    }
  }

  const order = (entities[LAYOUT] as Obj | undefined)?.order
  const orderIds = isObject(order) && Array.isArray(order.ids) ? order.ids.filter((x): x is string => typeof x === 'string') : []
  const sequence: string[] = []
  for (const id of orderIds) if (incoming.has(id) && !sequence.includes(id)) sequence.push(id)
  sequence.push(...[...incoming.keys()].filter((id) => !sequence.includes(id)).sort())

  const asleepPanes = (): string[] => (Array.isArray(out.asleepPanes) ? (out.asleepPanes as string[]) : (out.asleepPanes = []))
  const slept = (): string[] => (Array.isArray(out.deskSleptPanes) ? (out.deskSleptPanes as string[]) : (out.deskSleptPanes = []))
  const addTo = (list: string[], id: string): void => { if (!list.includes(id)) list.push(id) }

  const desks: Obj[] = []
  for (const id of sequence) {
    const desk = incoming.get(id)!
    const mine = local.get(id)
    if (mine) {
      if (desk !== mine && Object.hasOwn(mine, 'asleep')) put(desk, 'asleep', mine.asleep)
    } else {
      arrived.push(id)
      put(desk, 'asleep', true)
      for (const slot of terminalSlots(desk)) { addTo(asleepPanes(), slot); addTo(slept(), slot) }
    }
    desks.push(desk)
  }

  for (const [id, mine] of local) {
    if (incoming.has(id)) continue
    removed.push(id)
    const gone = new Set(terminalSlots(mine))
    if (Array.isArray(out.asleepPanes)) out.asleepPanes = (out.asleepPanes as string[]).filter((s) => !gone.has(s))
    if (Array.isArray(out.deskSleptPanes)) out.deskSleptPanes = (out.deskSleptPanes as string[]).filter((s) => !gone.has(s))
  }
  out.desks = desks
  if (typeof out.activeDesk === 'string' && removed.includes(out.activeDesk) && desks.length > 0) out.activeDesk = desks[0]!.id

  const meta = entities[LAYOUT]
  if (isObject(meta)) {
    const emblems = meta.emblems
    if (isObject(emblems) && Array.isArray(emblems.emblems)) out.emblems = structuredClone(emblems.emblems) // verbatim: emblems hold no machine paths
    if (isObject(meta.workspace)) out.workspace = fromPlaces(meta.workspace, w)
  }
  return { layout: out, arrived, removed, unmappedPlaces: [...w.unmapped].sort(), skipped }
}
