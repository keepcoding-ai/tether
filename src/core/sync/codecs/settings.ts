// Codec of the preferences (settings.json) and the shortcuts (keybindings.json): a pure projection of the two parsed
// working files into two entities (export) and back (import). What is the machine's own (window geometry, remembered
// extension state, anything listed in `localPaths`) never travels; on import the persistent wins on what travels and the
// machine keeps what is its own. Inputs are never mutated.

/** collection → id → value */
export type SyncEntities = Record<string, Record<string, unknown>>

/** Dotted paths that stay on the machine by default; a path covers the key and everything below it. */
export const DEFAULT_LOCAL_SETTINGS: readonly string[] = ['window', 'trayNoticeShown', 'extensionState']

const COLLECTION = 'settings'
const SETTINGS_ID = 'settings'
const KEYBINDINGS_ID = 'keybindings'

type Obj = Record<string, unknown>

function isObject(x: unknown): x is Obj {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function isEmptyObject(x: unknown): boolean {
  return isObject(x) && Object.keys(x).length === 0
}

function clone<T>(x: T): T {
  return structuredClone(x)
}

function allLocal(extra?: readonly string[]): string[] {
  return [...new Set([...DEFAULT_LOCAL_SETTINGS, ...(extra ?? [])])].filter((p) => p !== '')
}

/** Deep equality where key order does not count (array order does). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]))
  if (isObject(a)) {
    if (!isObject(b)) return false
    const ka = Object.keys(a)
    return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]))
  }
  return false
}

function getPath(root: Obj, path: string): { found: boolean; value?: unknown } {
  let node: unknown = root
  for (const seg of path.split('.')) {
    if (!isObject(node) || !Object.hasOwn(node, seg)) return { found: false }
    node = node[seg]
  }
  return { found: true, value: node }
}

function setPath(root: Obj, path: string, value: unknown): void {
  const segs = path.split('.')
  const last = segs.pop() as string
  let node = root
  for (const seg of segs) {
    if (!isObject(node[seg])) node[seg] = {}
    node = node[seg] as Obj
  }
  node[last] = value
}

/** Removes the path and the objects it leaves empty on the way up. */
function cutPath(root: Obj, path: string): void {
  const segs = path.split('.')
  const last = segs.pop() as string
  const chain: Obj[] = [root] // chain[i] is the object that holds segs[i]
  for (const seg of segs) {
    const next = (chain[chain.length - 1] as Obj)[seg]
    if (!isObject(next)) return
    chain.push(next)
  }
  const leaf = chain[chain.length - 1] as Obj
  if (!Object.hasOwn(leaf, last)) return
  delete leaf[last]
  for (let i = chain.length - 1; i > 0; i--) {
    if (!isEmptyObject(chain[i])) break
    delete (chain[i - 1] as Obj)[segs[i - 1] as string]
  }
}

/** An absolute machine path by the shape of the text: `X:\` / `X:/` / UNC, or posix with 2+ segments. `~` and URLs are not. */
function looksLikeMachinePath(s: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('\\\\') || /^\/[^/\s]+\/[^/]/.test(s)
}

function findLeaks(x: unknown, at: string, out: string[]): void {
  if (typeof x === 'string') {
    if (looksLikeMachinePath(x)) out.push(at)
  } else if (Array.isArray(x)) {
    x.forEach((v, i) => findLeaks(v, `${at}[${i}]`, out))
  } else if (isObject(x)) {
    for (const k of Object.keys(x)) findLeaks(x[k], `${at}.${k}`, out)
  }
}

export function exportSettings(
  settings: Record<string, unknown>,
  keybindings: unknown,
  localPaths?: readonly string[],
): { entities: SyncEntities; leaks: string[] } {
  const traveling = clone(settings)
  for (const p of allLocal(localPaths)) cutPath(traveling, p)
  const coll: Record<string, unknown> = { [SETTINGS_ID]: traveling }
  const entities: SyncEntities = { [COLLECTION]: coll }
  const leaks: string[] = []
  findLeaks(traveling, 'settings', leaks)
  if (keybindings !== undefined) {
    coll[KEYBINDINGS_ID] = { keybindings: clone(keybindings) }
    findLeaks(keybindings, 'keybindings', leaks)
  }
  return { entities, leaks }
}

export function importSettings(
  entities: SyncEntities,
  current: { settings: Record<string, unknown>; keybindings: unknown },
  localPaths?: readonly string[],
): {
  settings: Record<string, unknown>
  keybindings: unknown
  changed: { settings: boolean; keybindings: boolean }
} {
  const coll = isObject(entities[COLLECTION]) ? entities[COLLECTION] : {}

  let settings = current.settings
  const inSettings = coll[SETTINGS_ID]
  if (isObject(inSettings)) {
    const merged = clone(inSettings)
    for (const p of allLocal(localPaths)) {
      cutPath(merged, p)
      const mine = getPath(current.settings, p)
      if (mine.found) setPath(merged, p, clone(mine.value))
    }
    settings = merged
  }

  let keybindings = current.keybindings
  const inKeys = coll[KEYBINDINGS_ID]
  if (isObject(inKeys) && Object.hasOwn(inKeys, 'keybindings')) keybindings = clone(inKeys.keybindings)

  return {
    settings,
    keybindings,
    changed: {
      settings: !deepEqual(settings, current.settings),
      keybindings: !deepEqual(keybindings, current.keybindings),
    },
  }
}
