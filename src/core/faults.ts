// The fault registry: what broke in any tether process, kept on disk for the person (and an agent they bring in) to
// read later. Always on: no feature flag governs capture (the `faults` feature only governs what the agent is
// offered). Everything lives under `<userDir>/faults/` (`~/.tether/faults` in production, never synced, never in an
// external report: stacks carry paths and project names, so they are stored as they came and the folder stays local).
//   faults.jsonl        one line per occurrence: { id, ts, proc, version, commit, kind, message, stack, sig, context }
//   faults-state.json   per `sig`: status, tags, notes, fix, count, first/last, shortId, returned (what the agent/person edits)
//   faults.lock         short-lived lock file: several processes (main, daemon, CLI) write here
// A fault is a SIGNATURE, not an occurrence: `sig` is the hash of the normalized stack, so the same defect gives the
// same sig in two builds (see `faultSig`). Dedup is by sig, never by dropping lines: every occurrence is kept and the
// state carries the count; only a storm (the same sig more than STORM_LIMIT times inside STORM_WINDOW_MS) stops
// writing lines and just bumps the count. Reads are tolerant like src/core/profile.ts: a corrupt jsonl line is
// skipped and counted, a corrupt state file is copied aside and reset. `record` never throws: a fault reporter that
// can crash its host would be worse than the fault.
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { userDir } from './paths.ts'

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
  fix?: { commit?: string; ts: string }
  count: number
  first: string
  last: string
  /** The id shown to people: assigned when the sig is first recorded and never recomputed (the first claimant of a 4-hex prefix keeps it). */
  shortId: string
  returned?: { ts: string; version: string }
  /** Storm guard window (epoch ms of its start, occurrences seen in it). */
  storm?: { start: number; n: number }
}

export interface StateFile { v: 1; faults: Record<string, FaultState> }

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

// ---- reading ------------------------------------------------------------------------------------------------------

export function readOccurrences(dir: string): { items: FaultOccurrence[]; skipped: number } {
  let text: string
  try { text = readFileSync(occurrencesPath(dir), 'utf8') } catch { return { items: [], skipped: 0 } }
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
    if (parsed && typeof parsed === 'object' && parsed.faults && typeof parsed.faults === 'object' && !Array.isArray(parsed.faults)) return { state: { v: 1, faults: parsed.faults } }
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

/** Atomic: temp name first, then replace. */
export function writeState(dir: string, state: StateFile): void {
  mkdirSync(dir, { recursive: true })
  const path = statePath(dir)
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n')
  renameSync(tmp, path)
}

// ---- locking ------------------------------------------------------------------------------------------------------

const LOCK_STALE_MS = 5_000
const LOCK_WAIT_MS = 2_000

/** Runs `fn` holding the registry lock. Never blocks for good: a lock older than LOCK_STALE_MS is broken, and after LOCK_WAIT_MS `fn` runs anyway (a late fault beats a lost one). */
export function withLock<T>(dir: string, fn: () => T): T {
  mkdirSync(dir, { recursive: true })
  const lock = join(dir, 'faults.lock')
  const deadline = Date.now() + LOCK_WAIT_MS
  let held = false
  for (;;) {
    try { closeSync(openSync(lock, 'wx')); held = true; break } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') break
      try { if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) { unlinkSync(lock); continue } } catch { continue }
      if (Date.now() > deadline) break
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15)
    }
  }
  try { return fn() } finally { if (held) { try { unlinkSync(lock) } catch { /* already gone */ } } }
}

/**
 * Folds into the state the sigs that have lines in the jsonl but no state entry (the launcher writes `load` lines without
 * touching the state: it has nothing but node core). Counts, first/last and a short id are rebuilt from the lines.
 */
export function reconcileState(dir: string): void {
  try {
    const { items } = readOccurrences(dir)
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
}

export interface RecordResult { sig: string; shortId: string; written: boolean; occurrence: FaultOccurrence; state: FaultState }

/** Appends the occurrence (unless it is storm noise) and updates the state. Returns undefined when the registry itself could not be written. */
export function record(input: FaultInput, opts: RecordOptions = {}): RecordResult | undefined {
  try {
    const dir = opts.dir ?? faultsDir()
    const now = (opts.now ?? Date.now)()
    const ts = new Date(now).toISOString()
    const info = opts.version ? { version: opts.version, commit: opts.commit } : buildInfo(opts.fromDir)
    const stack = input.stack ?? ''
    const sig = faultSig(input.message, stack, opts.mapper)
    const occurrence: FaultOccurrence = {
      id: randomUUID(), ts, proc: input.proc, version: info.version, ...(info.commit ? { commit: info.commit } : {}),
      kind: input.kind, message: input.message, stack, sig, context: input.context ?? {},
    }
    return withLock(dir, () => {
      const { state } = readState(dir)
      let entry = state.faults[sig]
      if (!entry) {
        entry = { status: 'open', tags: [], notes: [], count: 0, first: ts, last: ts, shortId: assignShortId(sig, Object.values(state.faults).map(f => f.shortId)) }
        state.faults[sig] = entry
      }
      entry.count++
      entry.last = ts
      if (entry.status === 'done') { entry.status = 'open'; entry.returned = { ts, version: info.version } }
      const storm = entry.storm
      let written = true
      if (!storm || now - storm.start >= STORM_WINDOW_MS) entry.storm = { start: now, n: 1 }
      else { storm.n++; if (storm.n > STORM_LIMIT) written = false }
      if (written) {
        mkdirSync(dir, { recursive: true })
        appendFileSync(occurrencesPath(dir), JSON.stringify(occurrence) + '\n')
      }
      writeState(dir, state)
      return { sig, shortId: entry.shortId, written, occurrence, state: entry }
    })
  } catch {
    return undefined
  }
}
