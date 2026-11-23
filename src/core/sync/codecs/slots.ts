// Codec of the agents' identity (<home>/slots/<slotId>.json): a pure projection of each SlotMeta into one entity per
// slot (export) and back (import). Only who the agent is travels; the conversation never does. profileArgs/profileEnv
// (env may hold secrets), run state and agent-door fields stay on the machine. Only slots in use on a desk travel.
// Type-only import: the codec must not pull core modules at load time.
import type { SlotMeta } from '../../event.ts'
import { ensureRef, fromRef, HOME_PLACE, isPlaceName, type PlaceMap, type PlaceOpts, type PlaceRef } from '../places.ts'

export interface SyncedSlot {
  slotId: string
  name?: string
  agent: string
  cwd: PlaceRef
  args: string[]
  createdAt: string
  profileId?: string
}

/** collection → id → value */
export type SyncEntities = Record<string, Record<string, unknown>>

const ID_RE = /^[a-z0-9][a-z0-9._@:-]*$/ // same rule as the entity store's names
const COLLECTION = 'slots'

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((a) => typeof a === 'string')
}

/** Absolute by the shape of the text, for the platform the path was written on. */
function isAbsoluteFor(path: string, opts?: PlaceOpts): boolean {
  const win = (opts?.platform ?? process.platform) === 'win32'
  return win ? /^([a-zA-Z]:[\\/]|\\\\)/.test(path) : path.startsWith('/')
}

/** An argument that looks like an absolute path, whatever the platform: `X:\` / `X:/`, or posix with 2+ segments. */
function looksLikePath(arg: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(arg) || /^\/[^/\s]+\/[^/]/.test(arg)
}

export function exportSlots(
  metas: SlotMeta[],
  keep: ReadonlySet<string>,
  map: PlaceMap,
  opts?: PlaceOpts,
): { entities: SyncEntities; map: PlaceMap; skipped: string[]; leaks: string[] } {
  const out: Record<string, unknown> = {}
  const skipped: string[] = []
  const leaks: string[] = []
  let current = map
  for (const m of metas) {
    if (!keep.has(m.slotId)) continue
    if (!ID_RE.test(m.slotId) || m.slotId in out) { skipped.push(m.slotId); continue }
    if (typeof m.cwd !== 'string' || !isAbsoluteFor(m.cwd, opts)) { skipped.push(m.slotId); continue }
    const r = ensureRef(m.cwd, current, opts)
    current = r.map
    const s: SyncedSlot = { slotId: m.slotId, agent: m.agent, cwd: r.ref, args: [...m.args], createdAt: m.createdAt }
    if (m.name !== undefined) s.name = m.name
    if (m.profileId !== undefined) s.profileId = m.profileId
    m.args.forEach((a, i) => { if (looksLikePath(a)) leaks.push(`${COLLECTION}/${m.slotId}/args[${i}]`) })
    out[m.slotId] = s
  }
  return { entities: { [COLLECTION]: out }, map: current, skipped, leaks }
}

function asSynced(key: string, x: unknown): SyncedSlot | undefined {
  if (!ID_RE.test(key) || !isObject(x) || x.slotId !== key) return undefined
  if (typeof x.agent !== 'string' || x.agent === '' || !isStringArray(x.args) || typeof x.createdAt !== 'string') return undefined
  if (!(isObject(x.cwd) && (isPlaceName(x.cwd.place) || x.cwd.place === HOME_PLACE) && typeof x.cwd.rel === 'string')) return undefined
  if (x.name !== undefined && typeof x.name !== 'string') return undefined
  if (x.profileId !== undefined && typeof x.profileId !== 'string') return undefined
  return x as unknown as SyncedSlot
}

export function importSlots(
  entities: SyncEntities,
  current: SlotMeta[],
  map: PlaceMap,
  opts?: PlaceOpts,
): {
  create: SlotMeta[]
  rename: { slotId: string; name: string | undefined }[]
  pending: { slotId: string; place: string }[]
  skipped: string[]
} {
  const raw = entities[COLLECTION] ?? {}
  const local = new Map(current.map((m) => [m.slotId, m]))
  const create: SlotMeta[] = []
  const rename: { slotId: string; name: string | undefined }[] = []
  const pending: { slotId: string; place: string }[] = []
  const skipped: string[] = []

  for (const key of Object.keys(raw).sort()) {
    const s = asSynced(key, raw[key])
    if (!s) { skipped.push(key); continue }
    const mine = local.get(key)
    if (mine) {
      if (mine.name !== s.name) rename.push({ slotId: key, name: s.name })
      continue
    }
    const dir = fromRef(s.cwd, map, opts)
    if (dir === undefined) { pending.push({ slotId: key, place: s.cwd.place }); continue }
    const meta: SlotMeta = { v: 1, slotId: key, agent: s.agent as SlotMeta['agent'], cwd: dir, args: [...s.args], createdAt: s.createdAt }
    if (s.name !== undefined) meta.name = s.name
    if (s.profileId !== undefined) meta.profileId = s.profileId
    create.push(meta)
  }
  return { create, rename, pending, skipped }
}
