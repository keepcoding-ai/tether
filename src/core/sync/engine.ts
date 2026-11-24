// Sync engine: ties the working files (through injected ports), the four codecs, the persistent folder and the
// provider. It knows no Electron and no daemon; the wiring to the app is the caller's.
//   - exportAll writes this machine's projection into the folder, one file per entity (<collection>/<id>.json).
//   - importAll reads the folder, runs the imports against the working files and hands the ports only what changed.
//   - sync = export -> pull -> (import when the pull changed something) -> push, retrying a `behind` push.
// The engine keeps a `base` in <home>: the hash of each entity of this machine's projection as of the last sync. An
// entity is written only when the local projection moved away from the base (or its file is missing), and deleted only
// when it was in the base and left the projection. So what this machine never had (a slot whose place is pending here,
// an entity a newer version wrote) and what an import could not fully restore (an unmapped place) is never
// overwritten or deleted by this machine, and a sync with nothing new writes nothing.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SlotMeta } from '../event.ts'
import type { Profile } from '../profile.ts'
import { createEntityStore, serializeEntity } from '../storage/entity-store.ts'
import { exportLayout, importLayout, type DeskIds, type LayoutCodecOpts, type LayoutJson } from './codecs/layout.ts'
import { exportProfiles, importProfiles } from './codecs/profiles.ts'
import { exportSettings, importSettings } from './codecs/settings.ts'
import { exportSlots, importSlots } from './codecs/slots.ts'
import { readPlaceMap, writePlaceMap, type PlaceMap } from './places.ts'
import type { ConnectResult, ProviderStatus, PullConflict, SyncProvider } from './provider.ts'

/** collection → id → value */
export type SyncEntities = Record<string, Record<string, unknown>>

/** The working files as the app has them. */
export interface Working {
  profiles: Profile[]
  /** layout.json (v4). Any other shape: the arrangement is left alone (neither exported nor imported). */
  layout: LayoutJson
  /** Every SlotMeta of the machine; only the slots on a desk travel. */
  slots: SlotMeta[]
  settings: Record<string, unknown>
  /** The parsed keybindings.json; undefined when there is none. */
  keybindings: unknown
}

/** What an import changed. Only the keys that changed are present; an empty plan is never sent. */
export interface ApplyPlan {
  /** The whole new profiles list (the persistent rules the set and the order). */
  profiles?: Profile[]
  /** The whole new layout.json. */
  layout?: LayoutJson
  /** Slots to create (with their local cwd) and to rename (`name: undefined` clears the name). */
  slots?: { create: SlotMeta[]; rename: { slotId: string; name: string | undefined }[] }
  /** The whole new settings.json. */
  settings?: Record<string, unknown>
  /** The whole new keybindings.json (present only when it changed). */
  keybindings?: unknown
}

export interface SyncPorts {
  read(): Promise<Working>
  /** Writes what the plan carries. The engine never calls it with an empty plan. */
  apply(plan: ApplyPlan): Promise<void>
}

export interface SyncEngineOpts extends LayoutCodecOpts {
  /** Extra dotted settings paths that stay on the machine (added to the codec's defaults). */
  localSettings?: readonly string[]
}

export interface SyncEngineDeps {
  /** The persistent folder (the provider's working tree). */
  dir: string
  /** Where the machine-local maps and the engine state live. */
  home: string
  provider: SyncProvider
  ports: SyncPorts
  opts?: SyncEngineOpts
}

export interface Applied { profiles: boolean; layout: boolean; slots: boolean; settings: boolean; keybindings: boolean }

export interface ExportReport {
  /** Entity files written or rewritten (`<collection>/<id>`). */
  written: string[]
  /** Entity files removed. */
  removed: string[]
  /** What a codec refused to export (`profiles/<id>`, `desks/<id>`, `slots/<id>`, `layout`). */
  skipped: string[]
  /** Absolute machine paths still found in exported entities (JSON paths). */
  leaks: string[]
  /** Pads that stayed on the machine because they hold a path (`<deskId>/<padId>`). */
  localPads: string[]
}

export interface ImportReport {
  applied: Applied
  /** Slots not created here because their place has no folder on this machine. */
  pending: { slotId: string; place: string }[]
  /** Env names a profile needs that this machine does not have, by profile id. */
  missingEnv: Record<string, string[]>
  /** Places that arrived with no folder on this machine. */
  unmappedPlaces: string[]
  /** Entities of the folder that could not be read or were refused (`<collection>/<id>`). */
  skipped: string[]
  /** Local ids of the desks that arrived / left. */
  arrivedDesks: string[]
  removedDesks: string[]
}

export interface SyncReport extends ExportReport, ImportReport {
  /** Present on `connect()`. */
  connect?: ConnectResult
  /** Paths ('/' separators) the pulls changed in the folder. */
  pulled: string[]
  conflicts: PullConflict[]
  pushed: boolean
  /** The remote kept moving: the last push was still `behind` after the retries. */
  behind: boolean
}

export interface SyncEngine {
  exportAll(): Promise<ExportReport>
  importAll(): Promise<ImportReport>
  sync(): Promise<SyncReport>
  connect(): Promise<SyncReport>
  status(): Promise<ProviderStatus>
  disconnect(): Promise<void>
}

/** The collections the codecs own; nothing else in the folder is ever touched. */
export const OWNED_COLLECTIONS: readonly string[] = ['profiles', 'profiles.meta', 'desks', 'layout', 'slots', 'settings']
const LAYOUT_COLLECTIONS = ['desks', 'layout', 'slots'] // the slots that travel come from the desks
export const BEHIND_RETRIES = 3
export const DESK_IDS_FILE = 'desk-ids.json'
export const STATE_FILE = 'sync-state.json'

type Obj = Record<string, unknown>
const isObject = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x)

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
const same = (a: unknown, b: unknown): boolean => serializeEntity(a ?? null) === serializeEntity(b ?? null)
const uniqSorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort()

function writeJsonAtomic(file: string, value: unknown): void {
  const text = serializeEntity(value)
  try { if (readFileSync(file, 'utf8') === text) return } catch { /* absent */ }
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}

function readJson(file: string): unknown {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return undefined }
}

interface EngineState { base: Record<string, string>; needsImport: boolean }

function readState(home: string): EngineState {
  const doc = readJson(join(home, STATE_FILE))
  const base: Record<string, string> = {}
  if (isObject(doc) && isObject(doc.base)) for (const [k, v] of Object.entries(doc.base)) if (typeof v === 'string') base[k] = v
  return { base, needsImport: isObject(doc) && doc.needsImport === true }
}

function writeState(home: string, s: EngineState): void {
  mkdirSync(home, { recursive: true })
  writeJsonAtomic(join(home, STATE_FILE), { v: 1, base: s.base, ...(s.needsImport ? { needsImport: true } : {}) })
}

export function readDeskIds(home: string): DeskIds {
  const doc = readJson(join(home, DESK_IDS_FILE))
  const out: DeskIds = {}
  if (isObject(doc) && isObject(doc.ids)) for (const [k, v] of Object.entries(doc.ids)) if (typeof v === 'string') out[k] = v
  return out
}

function writeDeskIds(home: string, ids: DeskIds): void {
  mkdirSync(home, { recursive: true })
  writeJsonAtomic(join(home, DESK_IDS_FILE), { v: 1, ids })
}

/** Slot ids of the terminal panes of the exported desks (panes whose params carry a string `slotId`). */
export function slotsOnDesks(desks: Record<string, unknown> | undefined): Set<string> {
  const out = new Set<string>()
  for (const desk of Object.values(desks ?? {})) {
    if (!isObject(desk) || !isObject(desk.frames) || !isObject(desk.frames.views)) continue
    for (const view of Object.values(desk.frames.views)) {
      if (!isObject(view) || !isObject(view.panels)) continue
      for (const panel of Object.values(view.panels)) {
        if (isObject(panel) && isObject(panel.params) && typeof panel.params.slotId === 'string') out.add(panel.params.slotId)
      }
    }
  }
  return out
}

interface Projection {
  entities: SyncEntities
  /** Collections the projection speaks for; the others are left as they are. */
  covered: Set<string>
  places: PlaceMap
  ids: DeskIds
  skipped: string[]
  leaks: string[]
  localPads: string[]
}

/** This machine's working files as entities (the four exports), with the maps they grew. */
function project(work: Working, places: PlaceMap, ids: DeskIds, opts: SyncEngineOpts): Projection {
  const p = exportProfiles(work.profiles, places, opts)
  const l = exportLayout(work.layout, p.map, ids, opts)
  const layoutOk = !l.skipped.includes('layout')
  const entities: SyncEntities = { ...p.entities }
  const skipped = p.skipped.map((id) => `profiles/${id}`)
  const leaks: string[] = [...l.leaks]
  let map = l.map
  if (layoutOk) {
    Object.assign(entities, l.entities)
    const s = exportSlots(work.slots, slotsOnDesks(l.entities.desks), map, opts)
    map = s.map
    Object.assign(entities, s.entities)
    skipped.push(...s.skipped.map((id) => `slots/${id}`))
    leaks.push(...s.leaks)
  }
  skipped.push(...l.skipped)
  const st = exportSettings(work.settings, work.keybindings, opts.localSettings)
  Object.assign(entities, st.entities)
  leaks.push(...st.leaks)
  const covered = new Set(OWNED_COLLECTIONS.filter((c) => layoutOk || !LAYOUT_COLLECTIONS.includes(c)))
  return { entities, covered, places: map, ids: layoutOk ? l.ids : ids, skipped, leaks, localPads: l.localPads }
}

/** The base this projection stands for; collections it does not cover keep their old entries. */
function baseOf(proj: Projection, old: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {}
  for (const [k, v] of Object.entries(old)) if (!proj.covered.has(k.slice(0, k.lastIndexOf('/')))) base[k] = v
  for (const [collection, byId] of Object.entries(proj.entities)) {
    for (const [id, value] of Object.entries(byId)) base[`${collection}/${id}`] = sha(serializeEntity(value))
  }
  return base
}

const noneApplied = (): Applied => ({ profiles: false, layout: false, slots: false, settings: false, keybindings: false })

export function createSyncEngine(deps: SyncEngineDeps): SyncEngine {
  const { dir, home, provider, ports } = deps
  const opts: SyncEngineOpts = deps.opts ?? {}
  const store = createEntityStore(dir)
  const encode = (name: string): string => name.replaceAll(':', '%3A') // as the entity store names files
  const fileOf = (collection: string, id: string): string => join(dir, ...collection.split('/').map(encode), `${encode(id)}.json`)

  function persistMaps(proj: Projection): void {
    writePlaceMap(home, proj.places)
    writeDeskIds(home, proj.ids)
  }

  async function exportNow(): Promise<ExportReport> {
    const work = await ports.read()
    const state = readState(home)
    const proj = project(work, readPlaceMap(home), readDeskIds(home), opts)
    persistMaps(proj) // before the files: a uid minted for a desk must not be minted again
    const written: string[] = []
    const removed: string[] = []
    const fresh = new Set<string>()
    for (const [collection, byId] of Object.entries(proj.entities)) {
      for (const [id, value] of Object.entries(byId)) {
        const key = `${collection}/${id}`
        fresh.add(key)
        const text = serializeEntity(value)
        let onDisk: string | undefined
        try { onDisk = readFileSync(fileOf(collection, id), 'utf8') } catch { /* absent */ }
        if (onDisk === text) continue
        if (onDisk !== undefined && state.base[key] === sha(text)) continue // unchanged here since the last sync: the folder's version stands
        store.set(collection, id, value)
        written.push(key)
      }
    }
    for (const key of Object.keys(state.base)) {
      const collection = key.slice(0, key.lastIndexOf('/'))
      if (fresh.has(key) || !proj.covered.has(collection) || !OWNED_COLLECTIONS.includes(collection)) continue
      if (store.delete(collection, key.slice(collection.length + 1))) removed.push(key)
    }
    writeState(home, { ...state, base: baseOf(proj, state.base) })
    return { written: written.sort(), removed: removed.sort(), skipped: proj.skipped, leaks: proj.leaks, localPads: proj.localPads }
  }

  function readFolder(): { entities: SyncEntities; skipped: string[] } {
    const entities: SyncEntities = {}
    const skipped: string[] = []
    for (const collection of OWNED_COLLECTIONS) {
      const byId: Record<string, unknown> = {}
      for (const id of store.list(collection)) {
        let value: unknown
        try { value = store.get(collection, id) } catch { value = undefined } // a file name the store refuses
        if (value === undefined) skipped.push(`${collection}/${id}`)
        else byId[id] = value
      }
      entities[collection] = byId
    }
    return { entities, skipped }
  }

  async function importNow(): Promise<ImportReport> {
    const { entities, skipped: unreadable } = readFolder()
    const work = await ports.read()
    const places = readPlaceMap(home)
    const ids = readDeskIds(home)
    const pr = importProfiles(entities, work.profiles, places, opts)
    const layoutOk = isObject(work.layout) && work.layout.v === 4
    const lr = layoutOk ? importLayout(entities, work.layout, places, ids, opts) : undefined
    const sr = importSlots(entities, work.slots, places, opts)
    // A settings/keybindings entity whose local projection no longer matches the base was edited after the last
    // export: the folder copy is older, so it must not overwrite it. Keep the local value and leave the old base
    // entry in place, so the next export sees the difference and sends it.
    const baseBefore = readState(home).base
    const localProj = exportSettings(work.settings, work.keybindings, opts.localSettings).entities['settings'] ?? {}
    const keepLocal = ['settings', 'keybindings'].filter((id) => {
      const old = baseBefore[`settings/${id}`]
      return old !== undefined && id in localProj && old !== sha(serializeEntity(localProj[id]))
    })
    const folderSettings = { ...(entities['settings'] ?? {}) }
    for (const id of keepLocal) delete folderSettings[id]
    const se = importSettings({ ...entities, settings: folderSettings }, { settings: work.settings, keybindings: work.keybindings }, opts.localSettings)

    const plan: ApplyPlan = {}
    if (!same(pr.profiles, work.profiles)) plan.profiles = pr.profiles
    if (lr && !same(lr.layout, work.layout)) plan.layout = lr.layout
    if (sr.create.length > 0 || sr.rename.length > 0) plan.slots = { create: sr.create, rename: sr.rename }
    if (se.changed.settings) plan.settings = se.settings
    if (se.changed.keybindings) plan.keybindings = se.keybindings
    if (Object.keys(plan).length > 0) await ports.apply(plan)

    // The working files as they are now, by construction: the base becomes their projection.
    const renames = new Map(sr.rename.map((r) => [r.slotId, r.name]))
    const slots = work.slots.map((m) => {
      if (!renames.has(m.slotId)) return m
      const { name: _old, ...rest } = m
      const name = renames.get(m.slotId)
      return name === undefined ? rest : { ...rest, name }
    })
    const next: Working = {
      profiles: plan.profiles ?? work.profiles,
      layout: plan.layout ?? work.layout,
      slots: [...slots, ...sr.create],
      settings: plan.settings ?? work.settings,
      keybindings: se.changed.keybindings ? se.keybindings : work.keybindings,
    }
    const state = readState(home)
    const proj = project(next, places, lr ? lr.ids : ids, opts)
    persistMaps(proj)
    const newBase = baseOf(proj, state.base)
    for (const id of keepLocal) newBase[`settings/${id}`] = baseBefore[`settings/${id}`]!
    writeState(home, { base: newBase, needsImport: false })

    const skipped = [...unreadable, ...pr.skipped.map((id) => `profiles/${id}`), ...(lr?.skipped ?? []), ...sr.skipped.map((id) => `slots/${id}`)]
    if (!layoutOk) skipped.push('layout')
    return {
      applied: {
        profiles: plan.profiles !== undefined,
        layout: plan.layout !== undefined,
        slots: plan.slots !== undefined,
        settings: plan.settings !== undefined,
        keybindings: se.changed.keybindings,
      },
      pending: sr.pending,
      missingEnv: pr.missingEnv,
      unmappedPlaces: uniqSorted([...pr.unmappedPlaces, ...(lr?.unmappedPlaces ?? [])]),
      skipped: uniqSorted(skipped),
      arrivedDesks: lr?.arrived ?? [],
      removedDesks: lr?.removed ?? [],
    }
  }

  async function cycle(connecting: boolean): Promise<SyncReport> {
    const report: SyncReport = {
      pulled: [], conflicts: [], pushed: false, behind: false,
      written: [], removed: [], skipped: [], leaks: [], localPads: [],
      applied: noneApplied(), pending: [], missingEnv: {}, unmappedPlaces: [], arrivedDesks: [], removedDesks: [],
    }
    if (connecting) report.connect = await provider.connect()
    Object.assign(report, await exportNow()) // before any import: the local desks must be in the folder first

    const pullAndImport = async (): Promise<void> => {
      const r = await provider.pull()
      report.pulled = uniqSorted([...report.pulled, ...r.changed])
      report.conflicts.push(...r.conflicts)
      const state = readState(home)
      if (r.changed.length === 0 && r.conflicts.length === 0 && !state.needsImport) return
      if (!state.needsImport) writeState(home, { ...state, needsImport: true }) // survives a failed apply: the next sync imports again
      const im = await importNow()
      for (const k of Object.keys(im.applied) as (keyof Applied)[]) report.applied[k] ||= im.applied[k]
      report.pending = im.pending
      report.missingEnv = im.missingEnv
      report.unmappedPlaces = im.unmappedPlaces
      report.skipped = uniqSorted([...report.skipped, ...im.skipped])
      report.arrivedDesks.push(...im.arrivedDesks)
      report.removedDesks.push(...im.removedDesks)
    }

    await pullAndImport()
    let push = await provider.push()
    for (let tries = 0; !push.pushed && push.reason === 'behind' && tries < BEHIND_RETRIES; tries++) {
      await pullAndImport()
      push = await provider.push()
    }
    report.pushed = push.pushed
    report.behind = !push.pushed && push.reason === 'behind'
    return report
  }

  // One operation at a time. A sync asked while another waits to start joins it; one asked while a sync runs gets
  // a single follow-up shared by every caller that comes before it starts.
  let chain: Promise<unknown> = Promise.resolve()
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn)
    chain = run.catch(() => undefined)
    return run
  }
  let waitingSync: Promise<SyncReport> | undefined

  return {
    exportAll: () => serial(exportNow),
    importAll: () => serial(importNow),
    sync(): Promise<SyncReport> {
      if (waitingSync) return waitingSync
      const run = serial(() => {
        waitingSync = undefined
        return cycle(false)
      })
      waitingSync = run
      return run
    },
    connect: () => serial(() => cycle(true)),
    status: () => provider.status(),
    disconnect: () => serial(() => provider.disconnect()),
  }
}
