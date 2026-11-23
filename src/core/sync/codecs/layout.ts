// Codec of the arrangement (layout.json, v4): a pure projection of the working file into one entity per desk plus a
// few small layout entities (export) and back (import). The arrangement is treated as tolerant JSON: what the codec
// does not understand travels (desks) or stays (machine fields) byte for byte.
//   - Machine paths never travel: under the keys in PATH_KEYS an absolute path becomes a PlaceRef, and comes back as a
//     path through this machine's place map.
//   - A desk travels under a `uid`, not its local `desk-N` id (two machines both mint `desk-2`). The engine keeps the
//     local id → uid map (DeskIds) in a file; the codec receives it and hands it back.
//   - A pad whose state still holds an absolute path after the PATH_KEYS pass stays on the machine.
//   - What stays on the machine: activeDesk, drawer, sidebars, systemDesks, asleepPanes, deskSleptPanes, each desk's
//     `asleep` and any unknown top-level key.
import { randomUUID } from 'node:crypto'
import { ensureRef, fromRef, type PlaceMap, type PlaceOpts, type PlaceRef } from '../places.ts'

/** collection → id → value */
export type SyncEntities = Record<string, Record<string, unknown>>
/** A v4 layout.json, loosely typed. */
export type LayoutJson = Record<string, unknown>
/** This machine's desks: local desk id → uid (the identity that travels). */
export type DeskIds = Record<string, string>
export interface LayoutCodecOpts extends PlaceOpts { newUid?: () => string }

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

const defaultUid = (): string => `d${randomUUID().replaceAll('-', '').slice(0, 12)}`

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

/** Every absolute path left in `value`, as the JSON path of the string (or of the object holding the offending key). */
function findPaths(value: unknown, at: string, out: string[]): void {
  if (typeof value === 'string') { if (isAbsolutePath(value)) out.push(at); return }
  if (Array.isArray(value)) { value.forEach((v, i) => findPaths(v, `${at}/${i}`, out)); return }
  if (!isObject(value)) return
  for (const [k, v] of Object.entries(value)) {
    if (isAbsolutePath(k)) out.push(`${at}/${k}`)
    findPaths(v, `${at}/${k}`, out)
  }
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

export function exportLayout(
  layout: LayoutJson,
  map: PlaceMap,
  ids: DeskIds,
  opts?: LayoutCodecOpts,
): { entities: SyncEntities; map: PlaceMap; ids: DeskIds; skipped: string[]; localPads: string[]; leaks: string[] } {
  if (!isObject(layout) || layout.v !== 4) return { entities: {}, map, ids: { ...ids }, skipped: [LAYOUT], localPads: [], leaks: [] }
  const w: Walk = { map, opts, unmapped: new Set() }
  const newUid = opts?.newUid ?? defaultUid
  const skipped: string[] = []
  const localPads: string[] = []
  const desks: Obj = {}
  const order: string[] = []
  const outIds: DeskIds = {}
  const taken = new Set(Object.values(ids))
  const seenLocal = new Set<string>()
  const list = Array.isArray(layout.desks) ? layout.desks : []
  list.forEach((d, i) => {
    const localId = isObject(d) && typeof d.id === 'string' && d.id !== '' ? d.id : undefined
    if (localId !== undefined && Object.hasOwn(ids, localId)) outIds[localId] = ids[localId]! // the desk still exists here
    if (localId === undefined || !isDeskShape(d) || seenLocal.has(localId)) { skipped.push(`${DESKS}/${localId ?? `[${i}]`}`); return }
    seenLocal.add(localId)
    let uid = Object.hasOwn(ids, localId) ? ids[localId]! : undefined
    if (uid === undefined) {
      for (let tries = 0; tries < 16; tries++) {
        const candidate = newUid()
        if (!taken.has(candidate)) { uid = candidate; break }
      }
      if (uid !== undefined) { taken.add(uid); outIds[localId] = uid }
    }
    if (uid === undefined || !ID_RE.test(uid) || Object.hasOwn(desks, uid)) { skipped.push(`${DESKS}/${localId}`); return }

    const { asleep: _asleep, id: _id, pads, ...rest } = d
    const entity = toPlaces(rest, w) as Obj
    put(entity, 'id', uid)
    if (isObject(pads)) {
      const kept: Obj = {}
      for (const [padId, state] of Object.entries(pads)) {
        const probe: Walk = { map: w.map, opts, unmapped: w.unmapped }
        const converted = toPlaces(state, probe)
        const left: string[] = []
        findPaths(converted, '', left)
        if (left.length > 0) { localPads.push(`${localId}/${padId}`); continue }
        w.map = probe.map
        put(kept, padId, converted)
      }
      put(entity, 'pads', kept)
    } else if (pads !== undefined) put(entity, 'pads', pads)
    put(desks, uid, entity)
    order.push(uid)
  })
  const meta: Obj = { order: { ids: order } }
  if (Array.isArray(layout.emblems)) meta.emblems = { emblems: structuredClone(layout.emblems) }
  if (isObject(layout.workspace)) meta.workspace = toPlaces(layout.workspace, w)
  const entities: SyncEntities = { [DESKS]: desks, [LAYOUT]: meta }
  const leaks: string[] = []
  for (const [collection, byId] of Object.entries(entities)) {
    for (const [id, value] of Object.entries(byId)) findPaths(value, `${collection}/${id}`, leaks)
  }
  return { entities, map: w.map, ids: outIds, skipped, localPads: localPads.sort(), leaks }
}

export function importLayout(
  entities: SyncEntities,
  current: LayoutJson,
  map: PlaceMap,
  ids: DeskIds,
  opts?: LayoutCodecOpts,
): { layout: LayoutJson; ids: DeskIds; arrived: string[]; removed: string[]; unmappedPlaces: string[]; skipped: string[] } {
  const out = structuredClone(current) as Obj
  const arrived: string[] = []
  const removed: string[] = []
  const skipped: string[] = []
  const w: Walk = { map, opts, unmapped: new Set() }
  const deskEntities = entities?.[DESKS]
  if (!isObject(deskEntities)) return { layout: out, ids: { ...ids }, arrived, removed, unmappedPlaces: [], skipped }

  // This machine's desks by local id, and by the uid the map gives them.
  const local = new Map<string, Obj>()
  const byUid = new Map<string, Obj>()
  if (Array.isArray(out.desks)) {
    for (const d of out.desks) {
      if (!isObject(d) || typeof d.id !== 'string') continue
      local.set(d.id, d)
      const uid = Object.hasOwn(ids, d.id) ? ids[d.id] : undefined
      if (typeof uid === 'string' && !byUid.has(uid)) byUid.set(uid, d)
    }
  }

  // Incoming desks by uid. A malformed entity is ignored; the desk this machine keeps under that uid stays as it is.
  interface Incoming { desk: Obj; mine?: Obj; keep?: true }
  const incoming = new Map<string, Incoming>()
  for (const [uid, e] of Object.entries(deskEntities)) {
    const mine = byUid.get(uid)
    if (isDeskShape(e) && e.id === uid) {
      incoming.set(uid, { desk: fromPlaces(e, w) as Obj, ...(mine ? { mine } : {}) })
    } else {
      skipped.push(`${DESKS}/${uid}`)
      if (mine) incoming.set(uid, { desk: mine, mine, keep: true })
    }
  }

  const order = (entities[LAYOUT] as Obj | undefined)?.order
  const orderIds = isObject(order) && Array.isArray(order.ids) ? order.ids.filter((x): x is string => typeof x === 'string') : []
  const sequence: string[] = []
  for (const uid of orderIds) if (incoming.has(uid) && !sequence.includes(uid)) sequence.push(uid)
  sequence.push(...[...incoming.keys()].filter((uid) => !sequence.includes(uid)).sort())

  const asleepPanes = (): string[] => (Array.isArray(out.asleepPanes) ? (out.asleepPanes as string[]) : (out.asleepPanes = []))
  const slept = (): string[] => (Array.isArray(out.deskSleptPanes) ? (out.deskSleptPanes as string[]) : (out.deskSleptPanes = []))
  const addTo = (list: string[], id: string): void => { if (!list.includes(id)) list.push(id) }
  const used = new Set(local.keys())
  const nextLocalId = (): string => {
    for (let n = 1; ; n++) if (!used.has(`desk-${n}`)) { used.add(`desk-${n}`); return `desk-${n}` }
  }

  const desks: Obj[] = []
  const finalIds: DeskIds = {}
  for (const uid of sequence) {
    const { desk, mine, keep } = incoming.get(uid)!
    if (keep) {
      desks.push(desk)
      finalIds[desk.id as string] = uid
      continue
    }
    delete desk.asleep
    if (mine) {
      put(desk, 'id', mine.id)
      if (Object.hasOwn(mine, 'asleep')) put(desk, 'asleep', mine.asleep)
      if (isObject(mine.pads)) { // pads that did not travel stay; the ones that did replace the local ones
        const merged: Obj = {}
        for (const [k, v] of Object.entries(mine.pads)) put(merged, k, v)
        if (isObject(desk.pads)) for (const [k, v] of Object.entries(desk.pads)) put(merged, k, v)
        put(desk, 'pads', merged)
      }
    } else {
      const id = nextLocalId()
      put(desk, 'id', id)
      arrived.push(id)
      put(desk, 'asleep', true)
      for (const slot of terminalSlots(desk)) { addTo(asleepPanes(), slot); addTo(slept(), slot) }
    }
    finalIds[desk.id as string] = uid
    desks.push(desk)
  }

  for (const [id, mine] of local) {
    if (Object.hasOwn(finalIds, id)) continue
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
  return { layout: out, ids: finalIds, arrived, removed, unmappedPlaces: [...w.unmapped].sort(), skipped }
}
