// "+ Novo" from afar (RR5 5.3, fio-spec 18): what a device may create on a desk it chooses, and from what. The device never
// names a path: a working folder is one of the list tetherd already knows (the app's pinned projects, the projects its
// agents infer, the recent folders), referred to by an opaque id (`folderId`, a hash of the folder's comparison key) and
// resolved back to its path by tetherd against that list, read fresh at each act. An engine and a profile are named, the
// profile by its name within the engine; a desk by its id. A read (`create.options`) gives the device the choices: the
// engines, the profiles' names (never their env, args or folder), the queue desks and the folders with a label.
//
// An agent and a terminal tetherd creates alone (the slot, born in that desk, `regency/create`); a note and a browser tab only
// the app knows how to make (the bridge of acts, src/remote/app-acts.ts). The app's card offers no first prompt for an agent,
// so none goes from afar either. Pure: no node:*, no DOM; tetherd, the portal and the app read the same rules.
import { RES_STATUS, sanitizeDeclaredName, type ResStatus } from './content.ts'

/** The Regency's requests (ext `regency`): the choices, and the creation tetherd does alone. */
export const CREATE_OPTIONS_REQUEST = 'create.options'
export const CREATE_REQUEST = 'create'

/** Ceilings of the choices tetherd gives (the rest is `more`: a phone never draws an endless list). */
export const CREATE_FOLDERS_MAX = 64
export const CREATE_PROFILES_MAX = 64
export const CREATE_DESKS_MAX = 64
/** A label, a profile's name, a desk's name and a pane's name, as shown and as typed. */
export const CREATE_NAME_MAX = 64

/** An engine as the registry names them (`claude`, `codex`, `soul`, an extension's); `shell` is the terminal's. */
const ENGINE_RE = /^[a-z][a-z0-9-]{0,31}$/
const ID_RE = /^[\w.:-]{1,64}$/
/** A folder's id: 16 hex digits. */
export const FOLDER_ID_RE = /^[0-9a-f]{16}$/

/** The comparison key of a folder: one kind of separator, no trailing one, case folded where the file system ignores it. */
export function folderKey(path: string, caseInsensitive: boolean): string {
  const p = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return caseInsensitive ? p.toLowerCase() : p
}

/** FNV-1a 32 of `s` from the basis `h` (no BigInt: the PWA runs on old TV browsers). */
const fnv32 = (s: string, h: number): string => {
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * The opaque id of a folder (two FNV-1a 32 of its key, from two bases): the same on tetherd and in the app, never a path on
 * the wire. Not a secret: what makes it safe is that tetherd resolves only an id of its own list.
 */
export function folderId(path: string, caseInsensitive: boolean): string {
  const key = folderKey(path, caseInsensitive)
  return fnv32(key, 0x811c9dc5) + fnv32(key, 0x2f1d3b57)
}

/** A folder of the list: where it came from (a project, pinned or of an agent, or a recent one), its label, its path. */
export interface KnownFolder { id: string; label: string; kind: 'project' | 'recent'; path: string }

/** The folders tetherd knows, in order (projects first), once each by key, at most CREATE_FOLDERS_MAX. */
export function knownFolders(src: { pinned: readonly string[]; agents: readonly string[]; recent: readonly string[] }, caseInsensitive: boolean): KnownFolder[] {
  const out: KnownFolder[] = []
  const seen = new Set<string>()
  const add = (path: unknown, kind: KnownFolder['kind']): void => {
    if (typeof path !== 'string' || path === '' || out.length >= CREATE_FOLDERS_MAX) return
    const id = folderId(path, caseInsensitive)
    if (seen.has(id)) return
    seen.add(id)
    const base = folderKey(path, false).split('/').filter(Boolean).at(-1) ?? path
    out.push({ id, label: sanitizeDeclaredName(base).slice(0, CREATE_NAME_MAX) || '/', kind, path })
  }
  for (const p of src.pinned) add(p, 'project')
  for (const p of src.agents) add(p, 'project')
  for (const p of src.recent) add(p, 'recent')
  return out
}

/** What tetherd answers `create.options` (the portal keeps the paths to itself: the device gets them without). */
export interface CreateOptionsAnswer {
  engines: string[]
  profiles: { name: string; engine: string; default?: true }[]
  desks: { deskId: string; name: string; asleep?: true }[]
  folders: KnownFolder[]
}

/** The device's view of the choices: the same lists, the folders by id and label only. */
export interface CreateOptions {
  engines: string[]
  profiles: { name: string; engine: string; default?: true }[]
  desks: { deskId: string; name: string; asleep?: true }[]
  folders: { id: string; label: string; kind: 'project' | 'recent' }[]
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})
const list = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : [])
const nameOf = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined
  const t = sanitizeDeclaredName(v).slice(0, CREATE_NAME_MAX)
  return t === '' ? undefined : t
}

/** The choices by the allow list: any other field of tetherd's answer, and every path, stays out. */
export function createOptionsView(v: unknown): CreateOptions {
  const a = rec(v)
  return {
    engines: [...new Set(list(a.engines, 16).filter((e): e is string => typeof e === 'string' && ENGINE_RE.test(e)))],
    profiles: list(a.profiles, CREATE_PROFILES_MAX).flatMap((p0) => {
      const p = rec(p0)
      const name = nameOf(p.name)
      return name && typeof p.engine === 'string' && ENGINE_RE.test(p.engine) ? [{ name, engine: p.engine, ...(p.default === true ? { default: true as const } : {}) }] : []
    }),
    desks: list(a.desks, CREATE_DESKS_MAX).flatMap((d0) => {
      const d = rec(d0)
      const name = nameOf(d.name)
      return typeof d.deskId === 'string' && ID_RE.test(d.deskId) && name ? [{ deskId: d.deskId, name, ...(d.asleep === true ? { asleep: true as const } : {}) }] : []
    }),
    folders: list(a.folders, CREATE_FOLDERS_MAX).flatMap((f0) => {
      const f = rec(f0)
      const label = nameOf(f.label)
      return typeof f.id === 'string' && FOLDER_ID_RE.test(f.id) && label && (f.kind === 'project' || f.kind === 'recent') ? [{ id: f.id, label, kind: f.kind }] : []
    }),
  }
}

/** The path of a folder id in tetherd's answer (the portal's own use, never sent to a device), or undefined. */
export function folderPathOf(answer: unknown, id: string): string | undefined {
  const f = list(rec(answer).folders, CREATE_FOLDERS_MAX).map(rec).find((x) => x.id === id)
  return f && typeof f.path === 'string' && f.path !== '' ? f.path : undefined
}

// ---- the creation tetherd does alone: an agent or a terminal ------------------------------------------------------

/** The ops of the creation tetherd does alone. */
export type CreateSlotOp = 'create.agent' | 'create.terminal'
export const isCreateSlotOp = (name: string): name is CreateSlotOp => name === 'create.agent' || name === 'create.terminal'

/** The act as it crosses the pipe (`regency/create`): what to create, from what, where. Nothing else. */
export interface CreateSlotAct {
  what: 'agent' | 'terminal'
  /** The engine of an agent; a terminal's is `shell`. */
  engine: string
  /** A profile by its name, within the engine; absent: the engine's default. */
  profile?: string
  deskId: string
  folder: string
  /** The pane's name; absent: tetherd's default. */
  name?: string
}

export type CreateRefusal = 'bad-request' | 'too-long'

/** The portal's half: the act from the strict body (its keys already checked by the table), or why it is refused (0x01). */
export function createSlotArgs(op: CreateSlotOp, b: Record<string, unknown>): { args: CreateSlotAct; target: string } | CreateRefusal {
  const what = op === 'create.agent' ? 'agent' : 'terminal'
  const engine = what === 'agent' ? b.engine : 'shell'
  if (typeof engine !== 'string' || !ENGINE_RE.test(engine) || (what === 'agent' && engine === 'shell')) return 'bad-request'
  if (typeof b.deskId !== 'string' || !ID_RE.test(b.deskId)) return 'bad-request'
  if (typeof b.folder !== 'string' || !FOLDER_ID_RE.test(b.folder)) return 'bad-request'
  const text = (v: unknown): string | CreateRefusal | undefined => {
    if (v === undefined || v === '') return undefined
    if (typeof v !== 'string') return 'bad-request'
    if (v.length > CREATE_NAME_MAX) return 'too-long'
    const t = sanitizeDeclaredName(v)
    return t === '' ? 'bad-request' : t
  }
  const profile = text(b.profile)
  const name = text(b.name)
  for (const t of [profile, name]) if (t === 'bad-request' || t === 'too-long') return t
  const args: CreateSlotAct = {
    what, engine, deskId: b.deskId, folder: b.folder,
    ...(profile !== undefined ? { profile: profile as string } : {}), ...(name !== undefined ? { name: name as string } : {}),
  }
  return { args, target: b.deskId }
}

/** tetherd's half: the act exactly as the portal builds it (every field checked again, nothing more), or undefined. */
export function parseCreateSlot(v: unknown): CreateSlotAct | undefined {
  const o = rec(v)
  const keys = Object.keys(o)
  if (keys.some((k) => !['what', 'engine', 'profile', 'deskId', 'folder', 'name'].includes(k))) return undefined
  if (o.what !== 'agent' && o.what !== 'terminal') return undefined
  const built = createSlotArgs(o.what === 'agent' ? 'create.agent' : 'create.terminal', o)
  if (typeof built === 'string') return undefined
  // A field not in its kept form (a name not folded, a terminal with another engine) is not the portal's.
  if (o.what === 'terminal' && o.engine !== 'shell') return undefined
  for (const k of ['profile', 'name'] as const) if (o[k] !== undefined && o[k] !== built.args[k]) return undefined
  return built.args
}

/** What a creation answers: the new slot's id (its pane's id), nothing else of it. */
export interface CreateSlotAnswer { slotId: string }
export function createSlotAnswer(v: unknown): CreateSlotAnswer {
  const s = rec(v).slotId
  return { slotId: typeof s === 'string' && ID_RE.test(s) ? s : '' }
}

/**
 * The refusals of a creation, and the status of each: a choice that names nothing now (a desk, a folder of the list, a
 * profile's name, an engine) is 0x06; the desk hibernating, a folder gone from the disk, a launch that failed are 0x09.
 */
export const CREATE_REFUSALS = {
  'unknown-desk': RES_STATUS.notFound,
  'unknown-folder': RES_STATUS.notFound,
  'unknown-profile': RES_STATUS.notFound,
  'unknown-engine': RES_STATUS.notFound,
  'desk-asleep': RES_STATUS.failed,
  'cwd-missing': RES_STATUS.failed,
  'spawn-failed': RES_STATUS.failed,
} as const satisfies Record<string, ResStatus>
export const CREATE_ERROR_CODES = Object.keys(CREATE_REFUSALS) as (keyof typeof CREATE_REFUSALS)[]
export type CreateCode = keyof typeof CREATE_REFUSALS
export const isCreateRefusal = (code: unknown): code is CreateCode => typeof code === 'string' && Object.hasOwn(CREATE_REFUSALS, code)
