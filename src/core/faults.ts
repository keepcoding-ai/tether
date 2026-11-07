// The fault registry: what broke in any tether process, kept on disk for the person (and an agent they bring in) to
// read later. Always on: no feature flag governs capture (the `faults` feature only governs what the agent is
// offered). Everything lives under `<userDir>/faults/` (`~/.tether/faults` in production, never synced, never in an
// external report: stacks carry paths and project names, so they are stored as they came and the folder stays local).
//   faults.jsonl        one line per occurrence: { id, ts, proc, version, commit, kind, message, stack, sig, context }
//   faults-state.json   per `sig`: status, tags, notes, fix, count, first/last, shortId, returned (what the agent/person edits)
//   faults.lock         short-lived lock file holding its owner's pid: several processes (main, daemon, CLI) write here
//   faults.1.jsonl      the previous generation of faults.jsonl (rotated at 5 MB)
// A fault is a SIGNATURE, not an occurrence: `sig` is the hash of the normalized stack, so the same defect gives the
// same sig in two builds (see `faultSig`). Dedup is by sig, never by dropping lines: every occurrence is kept and the
// state carries the count; only a storm (the same sig more than STORM_LIMIT times inside STORM_WINDOW_MS) stops
// writing lines and just bumps the count. Reads are tolerant like src/core/profile.ts: a corrupt jsonl line is
// skipped and counted, a corrupt state file is copied aside and reset. `record` never throws: a fault reporter that
// can crash its host would be worse than the fault.
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, copyFileSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tetherHome, userDir } from './paths.ts'

export type FaultProc = 'main' | 'renderer' | 'daemon' | 'worker' | `ext:${string}`
export type FaultKind = 'uncaught' | 'rejection' | 'gone' | 'load'
export type FaultStatus = 'open' | 'investigating' | 'done' | 'ignored'

export interface FaultOccurrence {
  id: string
  /** ISO time. */
  ts: string
  proc: FaultProc
  version: string
  commit?: string
  kind: FaultKind
  message: string
  stack: string
  sig: string
  /** Small free object: slot id, window id, pane type, exit code/reason for `gone`... */
  context: Record<string, unknown>
}

/** What a process hands to `record`; the registry fills id, ts, version, commit and sig. */
export interface FaultInput {
  proc: FaultProc
  kind: FaultKind
  message: string
  stack?: string
  context?: Record<string, unknown>
}

export interface FaultNote { ts: string; author: string; text: string }

export interface FaultState {
  status: FaultStatus
  tags: string[]
  notes: FaultNote[]
  /** Set by `done`: the commit that fixed it (absent = resolved without one) and who said so. */
  fix?: { commit?: string; ts: string; by?: string }
  /** Set by `investigate`: who is on it (the agent's pane name, or the person). */
  investigating?: { by: string; ts: string }
  count: number
  first: string
  last: string
  /** The id shown to people: assigned when the sig is first recorded and never recomputed (the first claimant of a 4-hex prefix keeps it). */
  shortId: string
  returned?: { ts: string; version: string }
  /** Storm guard window of older versions: the guard now lives in memory, per process. */
  storm?: { start: number; n: number }
}

export interface StateFile {
  v: 1
  faults: Record<string, FaultState>
  /** Reports refused before they were recorded (rate limit), per sender (`<proc>:<id>`). */
  dropped?: Record<string, number>
}

/** The same sig more than this many times inside the window: further occurrences only bump the count (no jsonl line). */
export const STORM_LIMIT = 20
export const STORM_WINDOW_MS = 60_000
/** Frames of the stack that enter the signature. */
export const SIG_FRAMES = 5
/** Lengths a short id grows through when the shorter prefix is taken. */
export const SHORT_ID_LENGTHS = [4, 6, 8] as const

export function faultsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(userDir(env), 'faults')
}
export const occurrencesPath = (dir: string): string => join(dir, 'faults.jsonl')
export const statePath = (dir: string): string => join(dir, 'faults-state.json')

// ---- build info ---------------------------------------------------------------------------------------------------

// Defined by app/build.mjs (esbuild `define`) in the app bundles; absent when running from source (daemon, CLI, tests).
declare const __TETHER_COMMIT__: string | undefined
declare const __TETHER_VERSION__: string | undefined

/** Version from package.json and the build's commit when it has one. `fromDir` is where to start looking for package.json when the build did not bake the version in. */
export function buildInfo(fromDir: string = process.cwd()): { version: string; commit?: string } {
  const commit = typeof __TETHER_COMMIT__ === 'string' && __TETHER_COMMIT__ ? __TETHER_COMMIT__ : undefined
  let version = typeof __TETHER_VERSION__ === 'string' ? __TETHER_VERSION__ : undefined
  if (!version) {
    let dir = resolve(fromDir)
    for (let i = 0; i < 8 && !version; i++) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string }
        if (pkg.name === 'tether' && pkg.version) version = pkg.version
      } catch { /* no package.json here */ }
      const up = dirname(dir)
      if (up === dir) break
      dir = up
    }
  }
  return { version: version ?? 'unknown', ...(commit ? { commit } : {}) }
}

// ---- source maps (minimal VLQ decoder: no dependency) -------------------------------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_INDEX = new Map([...B64].map((c, i) => [c, i] as const))

/** One generated line = flat quadruples [genCol, source, origLine, origCol]; source -1 when the segment has none. */
export function decodeMappings(mappings: string): Int32Array[] {
  const lines: Int32Array[] = []
  let cur: number[] = []
  let srcIdx = 0, srcLine = 0, srcCol = 0, genCol = 0
  let i = 0
  const readVlq = (): number => {
    let result = 0, shift = 0
    for (;;) {
      const d = B64_INDEX.get(mappings[i++] ?? '')
      if (d === undefined) throw new Error('mapa inválido')
      result += (d & 31) * 2 ** shift
      shift += 5
      if (!(d & 32)) break
    }
    return result % 2 === 1 ? -(result - 1) / 2 : result / 2
  }
  while (i < mappings.length) {
    const c = mappings[i]!
    if (c === ';') { lines.push(Int32Array.from(cur)); cur = []; genCol = 0; i++; continue }
    if (c === ',') { i++; continue }
    genCol += readVlq()
    const next = mappings[i]
    if (next === undefined || next === ',' || next === ';') { cur.push(genCol, -1, 0, 0); continue }
    srcIdx += readVlq(); srcLine += readVlq(); srcCol += readVlq()
    const after = mappings[i]
    if (after !== undefined && after !== ',' && after !== ';') readVlq() // name index: not needed
    cur.push(genCol, srcIdx, srcLine, srcCol)
  }
  lines.push(Int32Array.from(cur))
  return lines
}

interface ParsedMap { sources: string[]; lines: Int32Array[] }

/** Where a generated position came from: the original source path relative to the project root, or undefined. */
export type FrameMapper = (file: string, line: number, column: number) => string | undefined

function projectRootOf(dir: string): string {
  let d = dir
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(d, 'package.json'))) return d
    const up = dirname(d)
    if (up === d) break
    d = up
  }
  return dir
}

function slashes(p: string): string { return p.replace(/\\/g, '/') }

/** Keeps from the last node_modules on (so a package path is the same wherever the repo lives). */
function stablePath(p: string): string {
  const s = slashes(p)
  const k = s.lastIndexOf('/node_modules/')
  return k >= 0 ? s.slice(k + 1) : s
}

/** Mapper that reads `<bundle>.map` next to each bundle file it is asked about (cached; a missing or bad map means "no mapping"). */
export function createBundleMapper(): FrameMapper {
  const cache = new Map<string, ParsedMap | null>()
  const load = (file: string): ParsedMap | null => {
    const hit = cache.get(file)
    if (hit !== undefined) return hit
    let parsed: ParsedMap | null = null
    try {
      const mapPath = `${file}.map`
      const raw = JSON.parse(readFileSync(mapPath, 'utf8')) as { sources?: string[]; sourceRoot?: string; mappings?: string }
      if (typeof raw.mappings === 'string' && Array.isArray(raw.sources)) {
        const root = projectRootOf(dirname(mapPath))
        const sources = raw.sources.map(s => {
          const abs = resolve(dirname(mapPath), raw.sourceRoot ?? '', s)
          const rel = relative(root, abs)
          return stablePath(isAbsolute(rel) ? abs : rel)
        })
        parsed = { sources, lines: decodeMappings(raw.mappings) }
      }
    } catch { /* no map, or unreadable */ }
    cache.set(file, parsed)
    return parsed
  }
  return (file, line, column) => {
    const m = load(file)
    const segs = m?.lines[line - 1]
    if (!m || !segs) return undefined
    const col = column - 1 // stack columns are 1-based, maps 0-based
    let found = -1
    for (let k = 0; k + 3 < segs.length; k += 4) {
      if (segs[k]! <= col) found = k
      else break
    }
    if (found < 0) return undefined
    const src = segs[found + 1]!
    return src >= 0 ? m.sources[src] : undefined
  }
}

let defaultMapper: FrameMapper | undefined

// ---- signature ----------------------------------------------------------------------------------------------------

/** The message with the parts that vary between runs removed: absolute paths, uuids/long hex, numbers. */
export function normalizeMessage(message: string): string {
  return message
    .slice(0, 500)
    .replace(/(?<=^|[\s'"(\[=])(?:[A-Za-z]:[\\/]|\\\\|\/)[^\s'"`)\]]*/g, '<path>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
}

const FRAME_RE = /^\s*at (?:(.*?) \()?(.*?):(\d+):(\d+)\)?\s*$/

/** "file:function" for the first SIG_FRAMES parseable frames: no line/column, the source file when a map exists, else the bundle's base name. */
export function normalizeFrames(stack: string, mapper?: FrameMapper | null): string[] {
  const out: string[] = []
  for (const text of stack.split('\n')) {
    const m = FRAME_RE.exec(text)
    if (!m) continue
    let fn = (m[1] ?? '').replace(/^async /, '').replace(/^new /, '').replace(/ \[as [^\]]*\]$/, '').trim()
    if (!fn || fn === '<anonymous>') fn = '<anon>'
    let file = m[2]!.replace(/[?#].*$/, '')
    if (file.startsWith('file://')) { try { file = fileURLToPath(file) } catch { /* keep as is */ } }
    let shown: string
    if (file.startsWith('node:')) shown = file
    else {
      const mapped = mapper ? mapper(file, Number(m[3]), Number(m[4])) : undefined
      const s = slashes(file)
      shown = mapped ?? (s.includes('/node_modules/') ? stablePath(s) : basename(s))
    }
    out.push(`${shown}:${fn}`)
    if (out.length >= SIG_FRAMES) break
  }
  return out
}

/**
 * sha256 of the normalized message plus the first frames. `mapper` undefined = read `.map` files next to the bundles;
 * `null` = never map. The same defect built twice (other line numbers, other bundle folder) gives the same sig.
 */
export function faultSig(message: string, stack: string | undefined, mapper?: FrameMapper | null): string {
  const m = mapper === undefined ? (defaultMapper ??= createBundleMapper()) : mapper
  const text = `${normalizeMessage(message)}\n${normalizeFrames(stack ?? '', m).join('\n')}`
  return createHash('sha256').update(text).digest('hex')
}

// ---- ids ----------------------------------------------------------------------------------------------------------

/** The id a NEW sig takes: its shortest prefix (4, 6, 8 hex, then whole) that is not already some other sig's short id. */
export function assignShortId(sig: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  for (const n of SHORT_ID_LENGTHS) if (!used.has(sig.slice(0, n))) return sig.slice(0, n)
  return sig
}

export type IdResolution = { sig: string } | { candidates: string[] }

/** A stored short id wins; otherwise a unique prefix of a full sig; otherwise the candidates (none: empty list). */
export function resolveId(faults: Record<string, Pick<FaultState, 'shortId'>>, ref: string): IdResolution {
  const r = ref.trim().toLowerCase()
  if (!r) return { candidates: [] }
  const byId = Object.keys(faults).filter(s => faults[s]!.shortId === r)
  if (byId.length === 1) return { sig: byId[0]! }
  const exact = Object.keys(faults).find(s => s === r)
  if (exact) return { sig: exact }
  const pref = Object.keys(faults).filter(s => s.startsWith(r))
  return pref.length === 1 ? { sig: pref[0]! } : { candidates: pref }
}

// ---- redaction and caps -------------------------------------------------------------------------------------------
// Everything that reaches the registry passes through `redact` and the caps below inside `record`, so the main process,
// the daemon, the CLI and whatever a renderer reports are all covered by one point. The registry stays on the person's
// disk, but an agent they bring in reads it, and messages/stacks/contexts routinely carry whatever the failing code held.

export const REDACTED = '[redigido]'
export const MAX_MESSAGE = 2_000
export const MAX_STACK = 20_000
export const MAX_CONTEXT_STRING = 1_000
export const MAX_CONTEXT_KEYS = 32
export const MAX_CONTEXT_KEY_LENGTH = 64
/** Exact secret values shorter than this are not redacted (too many false hits). */
export const MIN_SECRET_LENGTH = 8

/**
 * [source, flags, replacement] of every pattern. app/main/launcher.cjs carries a copy of this list (it may import
 * nothing but node core); test/unit/core.faults-redact.test.ts fails when the two differ, so change both together.
 */
export const REDACTION_PATTERNS: ReadonlyArray<readonly [source: string, flags: string, replacement: string]> = [
  ['sk-ant-[A-Za-z0-9_-]+', 'g', REDACTED],
  ['sk-[A-Za-z0-9_-]{20,}', 'g', REDACTED],
  ['gh[pousr]_[A-Za-z0-9]{20,}', 'g', REDACTED],
  ['xox[abp]-[A-Za-z0-9-]+', 'g', REDACTED],
  ['AKIA[A-Z0-9]{16}', 'g', REDACTED],
  ['eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+', 'g', REDACTED],
  ['Bearer \\S+', 'gi', REDACTED],
  ['(token|key|secret|passw?o?r?d?)(["\']?\\s*[:=]\\s*)\\S+', 'gi', `$1$2${REDACTED}`],
]
const COMPILED = REDACTION_PATTERNS.map(([source, flags, replacement]) => [new RegExp(source, flags), replacement] as const)

/** The text with the known secret shapes replaced by `[redigido]`, and every exact value of `secrets` (length >= 8, longest first). */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text
  for (const s of secrets) if (s.length >= MIN_SECRET_LENGTH && out.includes(s)) out = out.split(s).join(REDACTED)
  for (const [re, replacement] of COMPILED) out = out.replace(re, replacement)
  return out
}

const SECRET_ENV_NAME = /KEY|TOKEN|SECRET|PASS/i
const SECRETS_TTL_MS = 60_000
const secretSources = new Set<() => readonly string[]>()
let secretsCache: { at: number; home: string; values: string[] } | undefined

/** Registers a producer of exact secret values (the daemon and main hand over the launch profiles' env values). Returns the unregister function. */
export function addSecretSource(fn: () => readonly string[]): () => void {
  secretSources.add(fn)
  secretsCache = undefined
  return () => { secretSources.delete(fn); secretsCache = undefined }
}

export function resetSecretsCache(): void { secretsCache = undefined }

function readTrimmed(path: string): string | undefined {
  try { return readFileSync(path, 'utf8').trim() } catch { return undefined }
}

/**
 * The exact values to redact: the bridge's api.key and pairing token, the values of the env vars named like a secret and
 * whatever the registered sources hand over. Built once and rebuilt at most once a minute (files are read then only).
 */
export function secretValues(env: NodeJS.ProcessEnv = process.env, extra: readonly string[] = []): string[] {
  const home = tetherHome(env)
  const t = Date.now()
  if (!secretsCache || secretsCache.home !== home || t - secretsCache.at > SECRETS_TTL_MS) {
    const found = new Set<string>()
    const bridge = join(home, 'bridge')
    const key = readTrimmed(join(bridge, 'api.key'))
    if (key) found.add(key)
    const cfg = readTrimmed(join(bridge, 'config.json'))
    if (cfg) {
      try {
        const token = (JSON.parse(cfg) as { pairingToken?: unknown }).pairingToken
        if (typeof token === 'string') found.add(token.trim())
      } catch { /* an unreadable config has no token for us */ }
    }
    for (const [name, value] of Object.entries(env)) if (value && SECRET_ENV_NAME.test(name)) found.add(value.trim())
    for (const fn of secretSources) { try { for (const v of fn()) if (typeof v === 'string') found.add(v.trim()) } catch { /* a source that fails adds nothing */ } }
    secretsCache = { at: t, home, values: [...found].filter(v => v.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length) }
  }
  if (!extra.length) return secretsCache.values
  return [...new Set([...extra.map(v => v.trim()), ...secretsCache.values])].filter(v => v.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length)
}

const capText = (s: string, max: number): string => (s.length > max ? s.slice(0, max) : s)
/** Cuts before redacting (cheap on huge input) and again after (redaction may only shorten, so the cut loses nothing it should keep). */
const clean = (s: unknown, max: number, secrets: readonly string[]): string => capText(redact(capText(typeof s === 'string' ? s : String(s ?? ''), max * 2), secrets), max)

const CONTEXT_KEY = /^[\w.-]{1,64}$/

function cleanValue(v: unknown, secrets: readonly string[], depth: number): unknown {
  if (typeof v === 'string') return clean(v, MAX_CONTEXT_STRING, secrets)
  if (typeof v === 'boolean' || v === null) return v
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (depth >= 3) return undefined
  if (Array.isArray(v)) return v.slice(0, MAX_CONTEXT_KEYS).map(x => cleanValue(x, secrets, depth + 1) ?? null)
  if (v && typeof v === 'object') return cleanContext(v as Record<string, unknown>, secrets, depth + 1)
  return undefined
}

/** At most 32 keys of `[\w.-]{1,64}`; strings redacted and cut to 1000 chars; anything that is not JSON-plain is dropped. */
export function cleanContext(ctx: Record<string, unknown> | undefined, secrets: readonly string[] = [], depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!ctx || typeof ctx !== 'object') return out
  let n = 0
  for (const k of Object.keys(ctx)) {
    if (!CONTEXT_KEY.test(k)) continue
    const v = cleanValue(ctx[k], secrets, depth)
    if (v === undefined) continue
    out[k] = v
    if (++n >= MAX_CONTEXT_KEYS) break
  }
  return out
}

// ---- reading ------------------------------------------------------------------------------------------------------

export const rotatedPath = (dir: string): string => join(dir, 'faults.1.jsonl')

/** The occurrences, oldest first: the rotated generation (faults.1.jsonl) and then the current file. */
export function readOccurrences(dir: string): { items: FaultOccurrence[]; skipped: number } {
  let text = ''
  for (const file of [rotatedPath(dir), occurrencesPath(dir)]) {
    try { text += readFileSync(file, 'utf8') } catch { /* absent */ }
    if (text && !text.endsWith('\n')) text += '\n'
  }
  const items: FaultOccurrence[] = []
  let skipped = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const o = JSON.parse(line) as FaultOccurrence
      if (o && typeof o === 'object' && typeof o.sig === 'string' && typeof o.message === 'string') items.push(o)
      else skipped++
    } catch { skipped++ }
  }
  return { items, skipped }
}

export interface StateRead { state: StateFile; problem?: string; backup?: string }

function stamp(): string { return new Date().toISOString().replace(/[:.]/g, '-') }

const FILE_MODE = 0o600
const DIR_MODE = 0o700

/** The faults folder, private to the user where the platform has modes. */
export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE })
}

function stateOf(parsed: StateFile): StateFile {
  const d = parsed.dropped
  return { v: 1, faults: parsed.faults, ...(d && typeof d === 'object' && !Array.isArray(d) ? { dropped: d } : {}) }
}

/** The state; a corrupt file is copied to `faults-state.json.corrompido-<time>` and replaced by an empty one. */
export function readState(dir: string): StateRead {
  const path = statePath(dir)
  let text: string
  try { text = readFileSync(path, 'utf8') } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { state: { v: 1, faults: {} } }
    return { state: { v: 1, faults: {} }, problem: `não consegui ler ${path} (${(e as Error).message})` }
  }
  try {
    const parsed = JSON.parse(text) as StateFile
    if (parsed && typeof parsed === 'object' && parsed.faults && typeof parsed.faults === 'object' && !Array.isArray(parsed.faults)) return { state: stateOf(parsed) }
    throw new Error('formato inesperado')
  } catch (e) {
    const backup = `${path}.corrompido-${stamp()}`
    try { copyFileSync(path, backup) } catch (err) {
      return { state: { v: 1, faults: {} }, problem: `${path} está inválido (${(e as Error).message}) e não consegui guardar uma cópia (${(err as Error).message}); nada foi regravado` }
    }
    const state: StateFile = { v: 1, faults: {} }
    writeState(dir, state)
    return { state, backup, problem: `${path} estava inválido (${(e as Error).message}); cópia guardada em ${backup}; estado recriado vazio` }
  }
}

/** Atomic: temp name first, then replace. Drops this process's cached view of the state (it was just replaced). */
export function writeState(dir: string, state: StateFile): void {
  ensureDir(dir)
  const path = statePath(dir)
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: FILE_MODE })
  renameSync(tmp, path)
  const c = caches.get(dir)
  if (c) c.snap = undefined
}

// ---- locking ------------------------------------------------------------------------------------------------------
// The lock file holds the pid of its owner. It is created atomically WITH its content (written to a private name, then
// hard-linked to `faults.lock`: link fails with EEXIST when the lock exists, and the content is never seen half-written).
// A lock whose owner is dead is stale: breaking it is serialized by `faults.lock.breaking` (created exclusively), and the
// breaker re-reads the lock under it, so a lock another writer has just taken over is never torn down. There is no
// "old enough, delete it" rule: a live owner keeps the lock for as long as it works, and the others wait or give up.

const LOCK_WAIT_MS = 5_000
const BREAKER_STALE_MS = 10_000

export class LockBusyError extends Error {
  constructor(dir: string) { super(`o registro de falhas em ${dir} está ocupado por outro processo`); this.name = 'LockBusyError' }
}

export interface LockOptions {
  /** How long to wait for a live owner (default 5 s); then `LockBusyError`. */
  waitMs?: number
  /** Test seams: the pid this writer claims and the liveness check. */
  pid?: number
  alive?: (pid: number) => boolean
}

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

function sleepMs(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

function claim(dir: string, lock: string, me: number): boolean {
  const mine = join(dir, `faults.lock.${me}.${randomUUID().slice(0, 8)}.tmp`)
  try {
    writeFileSync(mine, String(me), { mode: FILE_MODE })
    try { linkSync(mine, lock); return true } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false
      // a file system without hard links: exclusive create, then the pid (a reader that sees it empty waits for it)
      try { const fd = openSync(lock, 'wx', FILE_MODE); try { writeFileSync(fd, String(me)) } finally { closeSync(fd) } return true } catch (e2) {
        if ((e2 as NodeJS.ErrnoException).code === 'EEXIST') return false
        throw e2
      }
    }
  } finally { try { unlinkSync(mine) } catch { /* gone */ } }
}

function breakIfStale(dir: string, lock: string, alive: (pid: number) => boolean): void {
  let seen: string
  try { seen = readFileSync(lock, 'utf8').trim() } catch { return } // gone already: the next claim wins
  const pid = Number(seen)
  if (seen === '') { try { if (Date.now() - statSync(lock).mtimeMs < 2_000) return } catch { return } } // a claim still being written
  else if (Number.isInteger(pid) && pid > 0 && alive(pid)) return
  const breaking = join(dir, 'faults.lock.breaking')
  let fd: number
  try { fd = openSync(breaking, 'wx', FILE_MODE) } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') { try { if (Date.now() - statSync(breaking).mtimeMs > BREAKER_STALE_MS) unlinkSync(breaking) } catch { /* someone else did */ } }
    return
  }
  try {
    closeSync(fd)
    let again: string
    try { again = readFileSync(lock, 'utf8').trim() } catch { return }
    if (again !== seen) return // taken over meanwhile
    const aside = join(dir, `faults.lock.stale.${randomUUID().slice(0, 8)}`)
    renameSync(lock, aside)
    try { unlinkSync(aside) } catch { /* leftovers are harmless */ }
  } catch { /* the loop tries again */ } finally { try { unlinkSync(breaking) } catch { /* gone */ } }
}

/** Runs `fn` holding the registry lock; throws `LockBusyError` when a live owner does not let go within `waitMs`. */
export function withLock<T>(dir: string, fn: () => T, o: LockOptions = {}): T {
  ensureDir(dir)
  const lock = join(dir, 'faults.lock')
  const me = o.pid ?? process.pid
  const alive = o.alive ?? pidAlive
  const deadline = Date.now() + (o.waitMs ?? LOCK_WAIT_MS)
  while (!claim(dir, lock, me)) {
    breakIfStale(dir, lock, alive)
    if (Date.now() > deadline) throw new LockBusyError(dir)
    sleepMs(10)
  }
  try { return fn() } finally {
    try { if (readFileSync(lock, 'utf8').trim() === String(me)) unlinkSync(lock) } catch { /* already gone */ }
  }
}

/**
 * Folds into the state the sigs that have lines in the jsonl but no state entry (the launcher writes `load` lines without
 * touching the state: it has nothing but node core). Counts, first/last and a short id are rebuilt from the lines.
 * Lines younger than RECENT_LINE_MS are left to the process that wrote them (its state write is still debounced).
 */
const RECENT_LINE_MS = 2_000
export function reconcileState(dir: string): void {
  try {
    flush(dir)
    const horizon = new Date(Date.now() - RECENT_LINE_MS).toISOString()
    const items = readOccurrences(dir).items.filter(o => o.ts <= horizon && o.sig !== OVERFLOW_SIG)
    if (!items.length) return
    withLock(dir, () => {
      const { state } = readState(dir)
      let changed = false
      const fresh = new Set<string>()
      for (const o of items) {
        if (!state.faults[o.sig]) {
          fresh.add(o.sig)
          state.faults[o.sig] = { status: 'open', tags: [], notes: [], count: 0, first: o.ts, last: o.ts, shortId: assignShortId(o.sig, Object.values(state.faults).map(f => f.shortId)) }
        } else if (!fresh.has(o.sig)) continue
        const f = state.faults[o.sig]!
        f.count++
        if (o.ts > f.last) f.last = o.ts
        changed = true
      }
      if (changed) writeState(dir, state)
    })
  } catch { /* best effort */ }
}

// ---- recording ----------------------------------------------------------------------------------------------------
// `record` appends the occurrence's line to the jsonl at once (one cheap append) and only NOTES the change to the state:
// the rewrite of faults-state.json is debounced (STATE_DEBOUNCE_MS), flushed at process exit and by every reader through
// `flush`. The pending changes are deltas applied to a fresh read under the lock, so another process' edits are kept.

export const STATE_DEBOUNCE_MS = 100
/** New signatures accepted per hour; past it occurrences fold into the synthetic sig OVERFLOW_SIG. */
export const NEW_SIG_LIMIT_PER_HOUR = 100
export const OVERFLOW_SIG = 'overflow'
/** faults.jsonl is rotated to faults.1.jsonl (one generation) when it reaches this size. */
export const MAX_JSONL_BYTES = 5 * 1024 * 1024
const HOUR_MS = 3_600_000
const SNAPSHOT_TTL_MS = 250
const MAX_DROPPED_SENDERS = 64

interface Delta { n: number; first: string; last: string; version: string; shortId?: string }
interface DirCache {
  snap?: { at: number; mtimeMs: number; size: number; faults: Record<string, FaultState> }
  pending: Map<string, Delta>
  dropped: Record<string, number>
  /** When (wall clock) this process accepted each new sig in the last hour; seeded once from the state, then only appended to. */
  newSigTimes: number[]
  seeded?: boolean
  storm: Map<string, { start: number; n: number }>
  bytes?: number
  timer?: ReturnType<typeof setTimeout>
}
const caches = new Map<string, DirCache>()
let exitHooked = false

function cacheOf(dir: string): DirCache {
  let c = caches.get(dir)
  if (!c) { c = { pending: new Map(), dropped: {}, newSigTimes: [], storm: new Map() }; caches.set(dir, c) }
  return c
}

function schedule(dir: string, c: DirCache): void {
  if (!exitHooked) {
    exitHooked = true
    const hook = (): void => { try { flush() } catch { /* exiting */ } }
    process.on('exit', hook)
    process.on('beforeExit', hook)
  }
  if (c.timer) return
  c.timer = setTimeout(() => { c.timer = undefined; try { flush(dir) } catch { /* retried by the next change */ } }, STATE_DEBOUNCE_MS)
  c.timer.unref?.()
}

function statOf(path: string): { mtimeMs: number; size: number } | undefined {
  try { const s = statSync(path); return { mtimeMs: s.mtimeMs, size: s.size } } catch { return undefined }
}

/** This process' view of the state file, re-read when the file changed (checked at most every SNAPSHOT_TTL_MS). */
function snapshotOf(dir: string, c: DirCache, t: number): Record<string, FaultState> {
  const s = c.snap
  if (s && t - s.at < SNAPSHOT_TTL_MS) return s.faults
  const st = statOf(statePath(dir))
  if (s && st && st.mtimeMs === s.mtimeMs && st.size === s.size) { s.at = t; return s.faults }
  const faults = st ? readState(dir).state.faults : {}
  const after = statOf(statePath(dir))
  c.snap = { at: t, mtimeMs: after?.mtimeMs ?? 0, size: after?.size ?? 0, faults }
  if (!c.seeded) {
    c.seeded = true
    const since = Date.now() - HOUR_MS
    c.newSigTimes = Object.values(faults).map(f => Date.parse(f.first)).filter(ms => ms > since).sort((a, b) => a - b)
  }
  return faults
}

/** Writes the debounced state changes now (of one folder, or of every folder this process wrote to). Never throws. */
export function flush(dir?: string): void {
  for (const [d, c] of dir ? [[dir, caches.get(dir)] as const] : [...caches]) {
    if (!c || (!c.pending.size && !Object.keys(c.dropped).length)) continue
    if (c.timer) { clearTimeout(c.timer); c.timer = undefined }
    try {
      withLock(d, () => {
        const { state, problem, backup } = readState(d)
        if (problem && !backup) throw new Error(problem) // unreadable and not copied aside: do not overwrite
        for (const [sig, delta] of c.pending) {
          let f = state.faults[sig]
          if (!f) {
            const taken = Object.values(state.faults).map(x => x.shortId)
            const shortId = delta.shortId && !taken.includes(delta.shortId) ? delta.shortId : assignShortId(sig, taken)
            f = { status: 'open', tags: [], notes: [], count: 0, first: delta.first, last: delta.first, shortId }
            state.faults[sig] = f
          }
          f.count += delta.n
          if (delta.last > f.last) f.last = delta.last
          if (f.status === 'done') { f.status = 'open'; f.returned = { ts: delta.last, version: delta.version }; delete f.investigating }
        }
        if (Object.keys(c.dropped).length) {
          const dropped = { ...(state.dropped ?? {}) }
          for (const [k, n] of Object.entries(c.dropped)) {
            if (!(k in dropped) && Object.keys(dropped).length >= MAX_DROPPED_SENDERS) { dropped.other = (dropped.other ?? 0) + n; continue }
            dropped[k] = (dropped[k] ?? 0) + n
          }
          state.dropped = dropped
        }
        writeState(d, state)
        c.pending.clear()
        c.dropped = {}
      }, { waitMs: 250 })
    } catch {
      if (c.pending.size || Object.keys(c.dropped).length) schedule(d, c) // lock busy or disk trouble: try again later
    }
  }
}

/** Counts a report refused before it reached `record` (rate limit, bad shape) against `sender`; shows as `dropped` in the state. */
export function noteDropped(sender: string, dir: string = faultsDir()): void {
  try {
    const c = cacheOf(dir)
    const key = sender.slice(0, 80)
    if (!(key in c.dropped) && Object.keys(c.dropped).length >= MAX_DROPPED_SENDERS) c.dropped.other = (c.dropped.other ?? 0) + 1
    else c.dropped[key] = (c.dropped[key] ?? 0) + 1
    schedule(dir, c)
  } catch { /* never throws */ }
}

/** Moves a full faults.jsonl aside (one generation kept), re-checking under the lock: several processes append here. */
function rotateIfFull(dir: string, c: DirCache): void {
  try {
    withLock(dir, () => {
      const size = statOf(occurrencesPath(dir))?.size ?? 0
      if (size + 1 >= MAX_JSONL_BYTES) { renameSync(occurrencesPath(dir), rotatedPath(dir)); c.bytes = 0 } else c.bytes = size
    }, { waitMs: 250 })
  } catch { c.bytes = 0 }
}

const infoCache = new Map<string, { version: string; commit?: string }>()
function infoOf(fromDir: string | undefined): { version: string; commit?: string } {
  const k = fromDir ?? ''
  let i = infoCache.get(k)
  if (!i) { i = buildInfo(fromDir); infoCache.set(k, i) }
  return i
}

export interface RecordOptions {
  /** The faults folder (default: faultsDir()). */
  dir?: string
  now?: () => number
  /** undefined: `.map` files next to the bundles; null: no mapping. */
  mapper?: FrameMapper | null
  version?: string
  commit?: string
  /** Where to look for package.json when `version` is not given. */
  fromDir?: string
  /** Exact values to redact besides the ones `secretValues` finds. */
  secrets?: readonly string[]
  /** The environment the secrets are read from (default process.env). */
  env?: NodeJS.ProcessEnv
}

export interface RecordResult { sig: string; shortId: string; written: boolean; occurrence: FaultOccurrence; state: FaultState }

/**
 * Redacts and caps the input, appends the occurrence (unless it is storm noise) and notes the state change (written by
 * `flush`, debounced). `state` in the result is the entry as it will be once flushed. Returns undefined when the registry
 * itself could not be written.
 */
export function record(input: FaultInput, opts: RecordOptions = {}): RecordResult | undefined {
  try {
    const dir = opts.dir ?? faultsDir()
    const now = (opts.now ?? Date.now)()
    const ts = new Date(now).toISOString()
    const info = opts.version ? { version: opts.version, commit: opts.commit } : infoOf(opts.fromDir)
    const secrets = secretValues(opts.env ?? process.env, opts.secrets ?? [])
    const message = clean(input.message, MAX_MESSAGE, secrets)
    const stack = clean(input.stack ?? '', MAX_STACK, secrets)
    const context = cleanContext(input.context, secrets)
    const c = cacheOf(dir)
    const faults = snapshotOf(dir, c, Date.now())
    let sig = faultSig(message, stack, opts.mapper)
    if (!faults[sig] && !c.pending.has(sig)) {
      const since = Date.now() - HOUR_MS
      while (c.newSigTimes.length && c.newSigTimes[0]! < since) c.newSigTimes.shift()
      if (c.newSigTimes.length >= NEW_SIG_LIMIT_PER_HOUR) sig = OVERFLOW_SIG
      else c.newSigTimes.push(Date.now())
    }
    const occurrence: FaultOccurrence = {
      id: randomUUID(), ts, proc: input.proc, version: info.version, ...(info.commit ? { commit: info.commit } : {}),
      kind: input.kind, message, stack, sig, context,
    }
    let storm = c.storm.get(sig)
    let written = true
    if (!storm || now - storm.start >= STORM_WINDOW_MS) c.storm.set(sig, storm = { start: now, n: 1 })
    else { storm.n++; if (storm.n > STORM_LIMIT) written = false }
    if (written) {
      ensureDir(dir)
      const line = JSON.stringify(occurrence) + '\n'
      c.bytes ??= statOf(occurrencesPath(dir))?.size ?? 0
      if (c.bytes + line.length >= MAX_JSONL_BYTES) rotateIfFull(dir, c) // before the append: the new line opens the new file
      appendFileSync(occurrencesPath(dir), line, { mode: FILE_MODE })
      c.bytes += Buffer.byteLength(line)
    }
    let delta = c.pending.get(sig)
    if (!delta) {
      delta = { n: 0, first: ts, last: ts, version: info.version }
      if (!faults[sig]) delta.shortId = sig === OVERFLOW_SIG ? 'over' : assignShortId(sig, [...Object.values(faults).map(f => f.shortId), ...[...c.pending.values()].map(d => d.shortId ?? '')])
      c.pending.set(sig, delta)
    }
    delta.n++
    delta.last = ts
    delta.version = info.version
    schedule(dir, c)
    const base = faults[sig]
    const view: FaultState = base
      ? { ...base, count: base.count + delta.n, last: ts }
      : { status: 'open', tags: [], notes: [], count: delta.n, first: delta.first, last: ts, shortId: delta.shortId! }
    if (view.status === 'done') { view.status = 'open'; view.returned = { ts, version: info.version } }
    return { sig, shortId: view.shortId, written, occurrence, state: view }
  } catch {
    return undefined
  }
}
