// Codec of the launch profiles (profiles.json): a pure projection of the working file into one entity per profile
// (export) and back (import). What stays on the machine never travels: env values (they may be secrets; only the
// names go), absolute folders (cwd becomes a PlaceRef) and shells whose command is an absolute path.
// Type-only import: profile.ts pulls the agent registry at load time, which a pure codec must not. The agent name is
// therefore checked by shape (a non-empty string); the engine that writes the file runs the registry-aware isProfile.
import type { Profile, ShellCommand } from '../../profile.ts'
import { ensureRef, fromRef, HOME_PLACE, isPlaceName, type PlaceMap, type PlaceOpts, type PlaceRef } from '../places.ts'

export interface SyncedProfile {
  id: string
  name: string
  agent: string
  args: string[]
  /** Sorted; only when the profile has env. */
  envNames?: string[]
  cwd?: PlaceRef
  /** Only when its command is not an absolute path. */
  shell?: ShellCommand
  /** The profile has a machine-bound shell that did not travel. */
  shellLocal?: true
  default?: boolean
  extensions?: Record<string, Record<string, unknown>>
}

/** collection → id → value */
export type SyncEntities = Record<string, Record<string, unknown>>

const ID_RE = /^[a-z0-9][a-z0-9._@:-]*$/ // same rule as the entity store's names
const COLLECTION = 'profiles'
const META = 'profiles.meta'

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((a) => typeof a === 'string')
}

/** Absolute by the shape of the text (win32 drive/UNC or posix root), whatever the current platform. */
function isAbsoluteText(command: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(command) || /^[\\/]/.test(command)
}

function isAbsoluteFor(path: string, opts?: PlaceOpts): boolean {
  const win = (opts?.platform ?? process.platform) === 'win32'
  return win ? /^([a-zA-Z]:[\\/]|\\\\)/.test(path) : path.startsWith('/')
}

function clone<T>(x: T): T {
  return structuredClone(x)
}

export function exportProfiles(
  profiles: Profile[],
  map: PlaceMap,
  opts?: PlaceOpts,
): { entities: SyncEntities; map: PlaceMap; skipped: string[] } {
  const out: Record<string, unknown> = {}
  const ids: string[] = []
  const skipped: string[] = []
  let current = map
  for (const p of profiles) {
    if (!ID_RE.test(p.id) || p.id in out) { skipped.push(p.id); continue }
    const s: SyncedProfile = { id: p.id, name: p.name, agent: p.agent, args: [...p.args] }
    if (p.env && Object.keys(p.env).length) s.envNames = Object.keys(p.env).sort()
    if (p.cwd !== undefined && isAbsoluteFor(p.cwd, opts)) {
      const r = ensureRef(p.cwd, current, opts)
      current = r.map
      s.cwd = r.ref
    }
    if (p.shell) {
      if (isAbsoluteText(p.shell.command)) s.shellLocal = true
      else s.shell = { command: p.shell.command, args: [...p.shell.args] }
    }
    if (p.default !== undefined) s.default = p.default
    if (p.extensions) s.extensions = clone(p.extensions)
    out[p.id] = s
    ids.push(p.id)
  }
  return { entities: { [COLLECTION]: out, [META]: { order: { ids } } }, map: current, skipped }
}

function asSynced(key: string, x: unknown): SyncedProfile | undefined {
  if (!ID_RE.test(key) || !isObject(x) || x.id !== key) return undefined
  if (typeof x.name !== 'string' || typeof x.agent !== 'string' || x.agent === '' || !isStringArray(x.args)) return undefined
  if (x.envNames !== undefined && !isStringArray(x.envNames)) return undefined
  if (x.cwd !== undefined && !(isObject(x.cwd) && (isPlaceName(x.cwd.place) || x.cwd.place === HOME_PLACE) && typeof x.cwd.rel === 'string')) return undefined
  if (x.shell !== undefined && !(isObject(x.shell) && typeof x.shell.command === 'string' && isStringArray(x.shell.args))) return undefined
  if (x.shellLocal !== undefined && x.shellLocal !== true) return undefined
  if (x.default !== undefined && typeof x.default !== 'boolean') return undefined
  if (x.extensions !== undefined && !(isObject(x.extensions) && Object.values(x.extensions).every(isObject))) return undefined
  return x as unknown as SyncedProfile
}

export function importProfiles(
  entities: SyncEntities,
  current: Profile[],
  map: PlaceMap,
  opts?: PlaceOpts,
): { profiles: Profile[]; missingEnv: Record<string, string[]>; unmappedPlaces: string[]; skipped: string[] } {
  const raw = entities[COLLECTION] ?? {}
  const valid = new Map<string, SyncedProfile>()
  const skipped: string[] = []
  for (const key of Object.keys(raw).sort()) {
    const s = asSynced(key, raw[key])
    if (s) valid.set(key, s)
    else skipped.push(key)
  }

  const order = (entities[META]?.order as { ids?: unknown } | undefined)?.ids
  const ordered: string[] = []
  const seen = new Set<string>()
  for (const id of Array.isArray(order) ? order : []) {
    if (typeof id === 'string' && valid.has(id) && !seen.has(id)) { seen.add(id); ordered.push(id) }
  }
  for (const id of [...valid.keys()].sort()) if (!seen.has(id)) ordered.push(id)

  const local = new Map(current.map((p) => [p.id, p]))
  const missingEnv: Record<string, string[]> = {}
  const unmapped = new Set<string>()
  const defaultTaken = new Set<string>()
  const profiles: Profile[] = []

  for (const id of ordered) {
    const s = valid.get(id)!
    const mine = local.get(id)
    const p: Profile = { id, name: s.name, agent: s.agent as Profile['agent'], args: [...s.args] }

    if (s.envNames?.length) {
      const env: Record<string, string> = {}
      const missing: string[] = []
      for (const name of s.envNames) {
        const v = mine?.env?.[name]
        if (typeof v === 'string') env[name] = v
        else missing.push(name)
      }
      if (Object.keys(env).length) p.env = env
      if (missing.length) missingEnv[id] = missing
    }

    if (s.cwd) {
      const dir = fromRef(s.cwd, map, opts)
      if (dir !== undefined) p.cwd = dir
      else unmapped.add(s.cwd.place)
    }

    if (s.shell) p.shell = { command: s.shell.command, args: [...s.shell.args] }
    else if (s.shellLocal && mine?.shell) p.shell = clone(mine.shell)

    if (s.default !== undefined) {
      if (s.default && defaultTaken.has(p.agent)) { /* a second default of the agent: the first one wins */ }
      else {
        p.default = s.default
        if (s.default) defaultTaken.add(p.agent)
      }
    }
    if (s.extensions) p.extensions = clone(s.extensions)

    profiles.push(p)
  }

  return { profiles, missingEnv, unmappedPlaces: [...unmapped].sort(), skipped }
}
