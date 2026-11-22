// The everyday launcher's Electron runtime with the `EnableCookieEncryption` fuse on (Tether Browser E15, design §12b
// rule 19). The everyday tether runs from node_modules' electron.exe, whose fuses are the factory ones (cookie encryption
// off), and that binary must never be changed in place: it is shared with every test and `npm install` undoes it. So
// `npm run app:install` keeps a COPY of the runtime, fuse flipped, under `<TETHER_HOME>/runtime/electron-<version>-cookiefuse/`
// (`<TETHER_HOME>/runtime` made its owner's alone) with a manifest (`tether-runtime.json`) recording the source binary's
// sha256 and every file of the copy's (review N-M3). The Start Menu shortcut still starts node_modules' electron.exe, with
// COOKIE_RUNTIME_FLAG: main checks the copy (same Electron version as the one running, the runtime folder private, every
// file's hash equal to the manifest's) and hands the launch over to it; a missing, outdated or altered copy is
// logged and the launch goes on in node_modules' runtime, where the browser keeps its partition in memory.
// No Electron import: install.mjs and the unit tests use it too.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** The argument the shortcut adds: "prefer the cookie-fuse runtime when it is valid". Never passed on to the copy. */
export const COOKIE_RUNTIME_FLAG = '--cookie-fuse-runtime'
export const RUNTIME_MANIFEST = 'tether-runtime.json'
export const RUNTIME_FUSE = 'EnableCookieEncryption'
/** The copy's executable is renamed (and re-branded, app/exe-identity.mjs) so the Task Manager shows "tether", not "electron". */
export const RUNTIME_EXE = 'tether.exe'
/** The factory executable inside node_modules' electron dist. */
export const SOURCE_EXE = 'electron.exe'

export interface RuntimeManifest {
  v: 2
  electronVersion: string
  fuse: typeof RUNTIME_FUSE
  /** sha256 of node_modules' electron executable the copy was made from. */
  sourceSha256: string
  /** sha256 of the copy's executable after the fuse was flipped (also in `files`). */
  exeSha256: string
  /**
   * sha256 of every file of the copy but the manifest, by path relative to the folder with `/` (review N-M3: the DLLs, the
   * `.pak`, `icudtl.dat` and the V8 snapshots load into the process as much as the executable does).
   */
  files: Record<string, string>
}

export type RuntimeVerdict =
  | { ok: true }
  | { ok: false, reason: 'ausente' | 'manifesto inválido' | 'versão diferente' | 'pasta não privada' | 'executável alterado' | 'arquivos alterados' }

/** Where the copy for an Electron version lives. */
export function cookieRuntimeDir(home: string, electronVersion: string): string {
  return join(home, 'runtime', `electron-${electronVersion}-cookiefuse`)
}

/** The executable inside a runtime folder (Windows only for now: the macOS copy would need re-signing after the flip). */
export function runtimeExe(dir: string): string {
  return join(dir, RUNTIME_EXE)
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** sha256 of every file under `dir` (relative paths with `/`, sorted), the manifest at the top excluded. */
export function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (rel: string): void => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(r)
      else if (r !== RUNTIME_MANIFEST) out[r] = sha256File(join(dir, r))
    }
  }
  walk('')
  return out
}

/** Whether two file maps list the same files with the same hashes. */
export function sameFiles(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a)
  return ka.length === Object.keys(b).length && ka.every(k => Object.hasOwn(b, k) && a[k] === b[k])
}

/** A manifest as read from disk, or undefined when it is not one of ours. */
export function parseManifest(text: string | undefined): RuntimeManifest | undefined {
  if (text === undefined) return undefined
  let m: unknown
  try { m = JSON.parse(text) } catch { return undefined }
  const r = m as Partial<RuntimeManifest>
  const hex = (s: unknown): boolean => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s)
  if (!r || r.v !== 2 || r.fuse !== RUNTIME_FUSE || typeof r.electronVersion !== 'string' || !hex(r.sourceSha256) || !hex(r.exeSha256)) return undefined
  const files = r.files
  if (!files || typeof files !== 'object' || Array.isArray(files) || !Object.values(files).every(hex)) return undefined
  if (files[RUNTIME_EXE] !== r.exeSha256) return undefined
  return r as RuntimeManifest
}

/**
 * Whether the copy may run this launch: it exists, its manifest is ours, it is the Electron version of the runtime that is
 * running now (an `npm install` that moved Electron makes the copy outdated), `<home>/runtime` is reachable by its owner only
 * (otherwise another user of the machine could plant a DLL next to the executable), and every file of the copy hashes to what
 * the install wrote, none missing, none added. `privateDir` and `files` run only when the cheaper checks pass (~300 MB read).
 */
export function runtimeVerdict(input: { manifestText: string | undefined, runningVersion: string, privateDir: () => boolean, files: () => Record<string, string> | undefined }): RuntimeVerdict {
  if (input.manifestText === undefined) return { ok: false, reason: 'ausente' }
  const m = parseManifest(input.manifestText)
  if (!m) return { ok: false, reason: 'manifesto inválido' }
  if (m.electronVersion !== input.runningVersion) return { ok: false, reason: 'versão diferente' }
  if (!input.privateDir()) return { ok: false, reason: 'pasta não privada' }
  const files = input.files()
  if (files === undefined || files[RUNTIME_EXE] === undefined) return { ok: false, reason: 'ausente' }
  if (files[RUNTIME_EXE] !== m.exeSha256) return { ok: false, reason: 'executável alterado' }
  if (!sameFiles(files, m.files)) return { ok: false, reason: 'arquivos alterados' }
  return { ok: true }
}

/** Whether an existing copy can be kept by the install: same source binary, same version, every file as the manifest says. */
export function runtimeReusable(m: RuntimeManifest | undefined, input: { electronVersion: string, sourceSha256: string, files: Record<string, string> | undefined }): boolean {
  return !!m && m.electronVersion === input.electronVersion && m.sourceSha256 === input.sourceSha256 && !!input.files && sameFiles(input.files, m.files)
}

const samePath = (a: string, b: string): boolean => {
  const n = (p: string): string => resolve(p).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b)
}

/** Whether this launch asks for the hand-off (the flag is there) and is not already running from the copy. */
export function wantsHandoff(argv: readonly string[], execPath: string, copyExe: string): boolean {
  return argv.slice(1).includes(COOKIE_RUNTIME_FLAG) && !samePath(execPath, copyExe)
}

/** The copy's arguments: this process' own after the executable, without the flag (the copy never hands off again). */
export function handoffArgs(argv: readonly string[]): string[] {
  return argv.slice(1).filter(a => a !== COOKIE_RUNTIME_FLAG)
}
