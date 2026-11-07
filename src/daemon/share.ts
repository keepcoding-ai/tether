// The composed share folder of a launch: tetherd merges the content of every feature enabled for the slot (src/core/
// features.ts) into <home>/share/<signature>/, a folder in the layout of a Soul shared folder, and hands it to the agent's
// contribution (AgentContribution.share). The signature names the SET (sorted ids joined by '+'; a short hash when that
// gets long), so the same set always lands in the same folder, which is reconciled in place at every launch:
//   skills/<name>        a junction (a 'dir' symlink off Windows) to the feature's skill folder; a copy when linking fails
//   mcps/<slug>/         a REAL folder: soul-sdk lists its MCP connections by Dirent.isDirectory(), which is false for a
//                        junction; its files (mcp.json, mcp.meta.json) are copied when their content changed, its folders
//                        (the MCP's own skills/) are linked like a skill
// Anything else in the folder (the adapters' own views: claude-plugin/, soul/) is left to whoever made it. Entries no
// feature of the set provides any more are removed. The folders under <home>/share are removed at every tetherd start
// (cleanShares). The adapters read the folder through shareSkills / shareMcpServers, and syncCopy makes a real copy where
// a reader refuses links (soul-sdk refuses a skill whose link resolves outside its skills/ folder).
//
// Removal never follows a link: removeTree unlinks a junction or symlink itself and recurses only into real folders, so
// a feature's source (a folder of the repo, the bridge's generated folder) is never touched by a cleanup.
import { createHash } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const SHARE_DIR = 'share'
export const SKILLS_DIR = 'skills'
export const MCPS_DIR = 'mcps'
export const MCP_FILE = 'mcp.json'
export const MCP_META_FILE = 'mcp.meta.json'

export const shareRootOf = (home: string): string => join(home, SHARE_DIR)

/** The folder name of a feature set: `bridge`, `bridge+faults`; a hash when the joined ids pass 48 characters. */
export function signatureOf(ids: readonly string[]): string {
  const joined = [...new Set(ids)].sort().join('+')
  if (joined.length <= 48) return joined || 'none'
  return `set-${createHash('sha256').update(joined).digest('hex').slice(0, 12)}`
}

/** One enabled feature and the folder its content is in. */
export interface FeatureSource {
  id: string
  dir: string
}

export interface ComposeResult {
  dir: string
  /** Links and copies made now (0 and 0 when the folder was already as it should be). */
  linked: number
  copied: number
  /** What could not be offered (name clashes, unreadable folders), in Portuguese, for the log. */
  problems: string[]
}

export interface ComposeDeps {
  /** Makes `path` point at the folder `target` (the test injects a failure to prove the copy fallback). */
  link?(target: string, path: string): void
}

/** A junction on Windows (no privilege needed), a directory symlink elsewhere. */
export function linkDir(target: string, path: string): void {
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
}

const isLink = (path: string): boolean => { try { return lstatSync(path).isSymbolicLink() } catch { return false } }
const isDirFollowing = (path: string): boolean => { try { return statSync(path).isDirectory() } catch { return false } }
const samePath = (a: string, b: string): boolean => {
  const n = (p: string): string => resolve(p).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b)
}

/** Removes the link itself (a junction on Windows answers to unlink, or else to rmdir), never what it points at. */
export function unlinkLink(path: string): void {
  try { unlinkSync(path) } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
    rmdirSync(path)
  }
}

/**
 * Removes `path` without ever following a link: a link is unlinked, a real folder is emptied entry by entry (each one
 * through this same rule) and then removed, a file is unlinked. A missing path is fine.
 */
export function removeTree(path: string): void {
  let st
  try { st = lstatSync(path) } catch { return }
  if (st.isSymbolicLink()) { unlinkLink(path); return }
  if (st.isDirectory()) {
    for (const name of readdirSync(path)) removeTree(join(path, name))
    rmdirSync(path)
    return
  }
  unlinkSync(path)
}

/** The sub-folders of `dir` (a link to a folder counts), by name; [] when `dir` is not there. */
function subfolders(dir: string): string[] {
  let names: string[]
  try { names = readdirSync(dir) } catch { return [] }
  return names.filter(n => !n.startsWith('.') && isDirFollowing(join(dir, n))).sort()
}

/** Writes `text` at `path` only when it differs (temp + rename). Returns whether it wrote. */
export function writeIfChanged(path: string, text: string | Buffer): boolean {
  let current: Buffer | undefined
  try { current = readFileSync(path) } catch { /* missing */ }
  const next = typeof text === 'string' ? Buffer.from(text) : text
  if (current && current.equals(next)) return false
  if (isLink(path) || isDirFollowing(path)) removeTree(path)
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, next)
  try { renameSync(tmp, path) } finally { rmSync(tmp, { force: true }) }
  return true
}

/** Makes `path` point at the folder `target`: kept when it already does, else replaced; a failed link becomes a copy. */
export function syncLink(path: string, target: string, counts: { linked: number; copied: number }, deps: ComposeDeps = {}): void {
  if (isLink(path)) {
    let to: string | undefined
    try { to = readlinkSync(path) } catch { /* unreadable: replaced */ }
    if (to !== undefined && samePath(to, target) && existsSync(path)) return
  }
  removeTree(path)
  try { (deps.link ?? linkDir)(target, path); counts.linked++ } catch {
    // A copy is refreshed at every call: it cannot tell when its source changed.
    removeTree(path)
    cpSync(target, path, { recursive: true, dereference: true })
    counts.copied++
  }
}

/** Makes `dir` hold exactly the entries of `wanted` (name → the folder it must point at); names not wanted are removed. */
export function syncLinks(dir: string, wanted: ReadonlyMap<string, string>, counts: { linked: number; copied: number }, deps: ComposeDeps = {}): void {
  mkdirSync(dir, { recursive: true })
  for (const name of readdirSync(dir)) if (!wanted.has(name)) removeTree(join(dir, name))
  for (const [name, target] of wanted) syncLink(join(dir, name), target, counts, deps)
}

/**
 * Composes (or brings up to date) <home>/share/<signature of the sources' ids>/. Sources are taken in id order; the first
 * one to offer a skill name or an MCP slug keeps it (the clash goes to `problems`).
 */
export function composeShare(home: string, sources: readonly FeatureSource[], deps: ComposeDeps = {}): ComposeResult {
  const ordered = [...sources].sort((a, b) => a.id.localeCompare(b.id))
  const dir = join(shareRootOf(home), signatureOf(ordered.map(s => s.id)))
  const problems: string[] = []
  const counts = { linked: 0, copied: 0 }
  const skills = new Map<string, string>()
  const mcps = new Map<string, string>()
  const owner = new Map<string, string>()
  for (const s of ordered) {
    for (const name of subfolders(join(s.dir, SKILLS_DIR))) {
      if (skills.has(name)) { problems.push(`skill ${name} da feature ${s.id} ignorada: já vem da feature ${owner.get(`s:${name}`)}`); continue }
      skills.set(name, join(s.dir, SKILLS_DIR, name)); owner.set(`s:${name}`, s.id)
    }
    for (const slug of subfolders(join(s.dir, MCPS_DIR))) {
      if (mcps.has(slug)) { problems.push(`MCP ${slug} da feature ${s.id} ignorado: já vem da feature ${owner.get(`m:${slug}`)}`); continue }
      mcps.set(slug, join(s.dir, MCPS_DIR, slug)); owner.set(`m:${slug}`, s.id)
    }
  }
  mkdirSync(dir, { recursive: true })
  syncLinks(join(dir, SKILLS_DIR), skills, counts, deps)
  const mcpsDir = join(dir, MCPS_DIR)
  mkdirSync(mcpsDir, { recursive: true })
  for (const name of readdirSync(mcpsDir)) {
    const path = join(mcpsDir, name)
    // Each slug is a real folder of ours; a link (an older layout) or a stray file under a wanted name goes too.
    if (!mcps.has(name) || isLink(path) || !isDirFollowing(path)) removeTree(path)
  }
  for (const [slug, src] of mcps) {
    const out = join(mcpsDir, slug)
    mkdirSync(out, { recursive: true })
    const folders = new Map<string, string>()
    const files = new Set<string>()
    let names: string[] = []
    try { names = readdirSync(src) } catch { problems.push(`MCP ${slug}: pasta ilegível ${src}`) }
    for (const name of names) {
      const from = join(src, name)
      if (isDirFollowing(from)) { folders.set(name, from); continue }
      files.add(name)
      try { if (writeIfChanged(join(out, name), readFileSync(from))) counts.copied++ } catch (e) { problems.push(`MCP ${slug}: ${name} não copiado (${(e as Error).message})`) }
    }
    for (const name of readdirSync(out)) if (!folders.has(name) && !files.has(name)) removeTree(join(out, name))
    for (const [name, target] of folders) syncLink(join(out, name), target, counts, deps)
  }
  return { dir, ...counts, problems }
}

const readJson = (p: string): unknown => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return undefined } }
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
/** A link's real folder (a link to a link is one more hop to break). */
const real = (p: string): string => { try { return realpathSync(p) } catch { return p } }

/** The servers of every `mcps/<slug>/mcp.json` of a composed folder, merged (first slug wins), without the disabled ones. */
export function shareMcpServers(shareDir: string): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const slug of subfolders(join(shareDir, MCPS_DIR))) {
    const meta = readJson(join(shareDir, MCPS_DIR, slug, MCP_META_FILE))
    if (isObject(meta) && meta.enabled === false) continue
    const spec = readJson(join(shareDir, MCPS_DIR, slug, MCP_FILE))
    const servers = isObject(spec) && isObject(spec.mcpServers) ? spec.mcpServers : {}
    for (const [name, server] of Object.entries(servers)) if (!(name in out) && isObject(server)) out[name] = server
  }
  return out
}

/** Every skill of a composed folder, name → its real folder: the loose ones first, then each MCP's own (first name wins). */
export function shareSkills(shareDir: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const name of subfolders(join(shareDir, SKILLS_DIR))) out.set(name, real(join(shareDir, SKILLS_DIR, name)))
  for (const slug of subfolders(join(shareDir, MCPS_DIR))) {
    const dir = join(shareDir, MCPS_DIR, slug, SKILLS_DIR)
    for (const name of subfolders(dir)) if (!out.has(name)) out.set(name, real(join(dir, name)))
  }
  return out
}

/**
 * Makes `dest` a real copy of the folder `src` (links in `src` are followed; nothing in `dest` is a link): files written
 * only when their content differs, entries `src` does not have removed. Returns the number of files written.
 */
export function syncCopy(src: string, dest: string): number {
  if (isLink(dest) || (existsSync(dest) && !lstatSync(dest).isDirectory())) removeTree(dest)
  mkdirSync(dest, { recursive: true })
  let written = 0
  const names = readdirSync(src)
  for (const name of readdirSync(dest)) if (!names.includes(name)) removeTree(join(dest, name))
  for (const name of names) {
    const from = join(src, name)
    const to = join(dest, name)
    if (isDirFollowing(from)) written += syncCopy(from, to)
    else if (writeIfChanged(to, readFileSync(from))) written++
  }
  return written
}

/** Removes every composed folder (tetherd start: nothing launched by this daemon uses one yet). Returns the names removed. */
export function cleanShares(home: string): string[] {
  const root = shareRootOf(home)
  let names: string[]
  try { names = readdirSync(root) } catch { return [] }
  for (const name of names) removeTree(join(root, name))
  return names
}
