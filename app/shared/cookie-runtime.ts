// The everyday launcher's Electron runtime with the `EnableCookieEncryption` fuse on (Tether Browser E15, design §12b
// rule 19). The everyday tether runs from node_modules' electron.exe, whose fuses are the factory ones (cookie encryption
// off), and that binary must never be changed in place: it is shared with every test and `npm install` undoes it. So
// `npm run app:install` keeps a COPY of the runtime, fuse flipped, under `<TETHER_HOME>/runtime/electron-<version>-cookiefuse/`
// with a manifest (`tether-runtime.json`) recording the source binary's and the copy's sha256. The Start Menu shortcut still
// starts node_modules' electron.exe, with COOKIE_RUNTIME_FLAG: main checks the copy (same Electron version as the one
// running, the copy's hash equal to the manifest's) and hands the launch over to it; a missing, outdated or altered copy is
// logged and the launch goes on in node_modules' runtime, where the browser keeps its partition in memory.
// No Electron import: install.mjs and the unit tests use it too.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** The argument the shortcut adds: "prefer the cookie-fuse runtime when it is valid". Never passed on to the copy. */
export const COOKIE_RUNTIME_FLAG = '--cookie-fuse-runtime'
export const RUNTIME_MANIFEST = 'tether-runtime.json'
export const RUNTIME_FUSE = 'EnableCookieEncryption'

export interface RuntimeManifest {
  v: 1
  electronVersion: string
  fuse: typeof RUNTIME_FUSE
  /** sha256 of node_modules' electron executable the copy was made from. */
  sourceSha256: string
  /** sha256 of the copy's executable after the fuse was flipped. */
  exeSha256: string
}

export type RuntimeVerdict =
  | { ok: true }
  | { ok: false, reason: 'ausente' | 'manifesto inválido' | 'versão diferente' | 'executável alterado' }

/** Where the copy for an Electron version lives. */
export function cookieRuntimeDir(home: string, electronVersion: string): string {
  return join(home, 'runtime', `electron-${electronVersion}-cookiefuse`)
}

/** The executable inside a runtime folder (Windows only for now: the macOS copy would need re-signing after the flip). */
export function runtimeExe(dir: string): string {
  return join(dir, 'electron.exe')
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** A manifest as read from disk, or undefined when it is not one of ours. */
export function parseManifest(text: string | undefined): RuntimeManifest | undefined {
  if (text === undefined) return undefined
  let m: unknown
  try { m = JSON.parse(text) } catch { return undefined }
  const r = m as Partial<RuntimeManifest>
  const hex = (s: unknown): boolean => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s)
  if (!r || r.v !== 1 || r.fuse !== RUNTIME_FUSE || typeof r.electronVersion !== 'string' || !hex(r.sourceSha256) || !hex(r.exeSha256)) return undefined
  return r as RuntimeManifest
}

/**
 * Whether the copy may run this launch: it exists, its manifest is ours, it is the Electron version of the runtime that is
 * running now (an `npm install` that moved Electron makes the copy outdated) and its executable hashes to what the install
 * wrote. `exeSha256` is computed only when the cheaper checks pass (a ~200 MB file).
 */
export function runtimeVerdict(input: { manifestText: string | undefined, runningVersion: string, exeSha256: () => string | undefined }): RuntimeVerdict {
  if (input.manifestText === undefined) return { ok: false, reason: 'ausente' }
  const m = parseManifest(input.manifestText)
  if (!m) return { ok: false, reason: 'manifesto inválido' }
  if (m.electronVersion !== input.runningVersion) return { ok: false, reason: 'versão diferente' }
  const sha = input.exeSha256()
  if (sha === undefined) return { ok: false, reason: 'ausente' }
  if (sha !== m.exeSha256) return { ok: false, reason: 'executável alterado' }
  return { ok: true }
}

/** Whether an existing copy can be kept by the install: same source binary, same version, executable untouched. */
export function runtimeReusable(m: RuntimeManifest | undefined, input: { electronVersion: string, sourceSha256: string, exeSha256: string | undefined }): boolean {
  return !!m && m.electronVersion === input.electronVersion && m.sourceSha256 === input.sourceSha256 && input.exeSha256 === m.exeSha256
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
