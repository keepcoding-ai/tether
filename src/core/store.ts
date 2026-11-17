// Slot state on disk: metadata, append-only events, run info, and the binding derived from the events.
// No locks and nothing in memory: one slot = its own files, events are appended one line at a time.
import { randomBytes } from 'node:crypto'
import { open, type FileHandle } from 'node:fs/promises'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import type { Binding, RunInfo, SlotMeta, TetherEvent } from './event.ts'
import { isAgentName } from '../agents/registry.ts'
import { slotAttentionPath, slotEventsPath, slotMetaPath, slotRondaPath, slotRunPath, slotsDir } from './paths.ts'

export const SLOT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i

/** 8 lowercase hex chars; retried while a slot with that id already exists in `home`. */
export function newSlotId(home: string): string {
  for (let i = 0; i < 100; i++) {
    const id = randomBytes(4).toString('hex')
    if (!existsSync(slotMetaPath(home, id)) && !existsSync(slotEventsPath(home, id))) return id
  }
  throw new Error('could not find a free slot id')
}

function assertSlotId(slotId: string): void {
  if (!SLOT_ID_RE.test(slotId)) throw new Error(`invalid slot id: ${JSON.stringify(slotId)}`)
}

function ensureSlotsDir(home: string): void {
  mkdirSync(slotsDir(home), { recursive: true })
}

// ---- slots ---------------------------------------------------------------

export function createSlot(home: string, meta: SlotMeta): void {
  assertSlotId(meta.slotId)
  ensureSlotsDir(home)
  const path = slotMetaPath(home, meta.slotId)
  if (existsSync(path)) throw new Error(`slot already exists: ${meta.slotId}`)
  writeFileSync(path, JSON.stringify(meta, null, 2) + '\n', { flag: 'wx' })
}

export function readSlot(home: string, slotId: string): SlotMeta | undefined {
  assertSlotId(slotId)
  const parsed = readJsonFile(slotMetaPath(home, slotId))
  return isSlotMeta(parsed) && parsed.slotId === slotId ? parsed : undefined
}

/** What one pass over the slots directory found: the readable slots (oldest first) and every file name in it. */
export interface SlotsScan {
  metas: SlotMeta[]
  names: string[]
}

/** One `readdir` of the slots directory plus the readable `.json` metas; the names tell a caller which side files exist without more disk calls. */
export function scanSlots(home: string): SlotsScan {
  const dir = slotsDir(home)
  if (!existsSync(dir)) return { metas: [], names: [] }
  const names = readdirSync(dir)
  const metas: SlotMeta[] = []
  for (const name of names) {
    if (!name.endsWith('.json') || name.endsWith('.run.json')) continue
    const id = name.slice(0, -'.json'.length)
    if (!SLOT_ID_RE.test(id)) continue
    const meta = readSlot(home, id)
    if (meta) metas.push(meta)
  }
  metas.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.slotId.localeCompare(b.slotId))
  return { metas, names }
}

/** All readable slots, sorted by creation time (oldest first). Unreadable `.json` files are skipped. */
export function listSlots(home: string): SlotMeta[] {
  return scanSlots(home).metas
}

/** Forgets the slot: removes tether's files. Never touches the agent's session files. */
export function removeSlot(home: string, slotId: string): void {
  assertSlotId(slotId)
  for (const p of [slotMetaPath(home, slotId), slotEventsPath(home, slotId), slotRunPath(home, slotId), slotAttentionPath(home, slotId), slotRondaPath(home, slotId)]) {
    rmSync(p, { force: true })
  }
}

// ---- events --------------------------------------------------------------

/** One O_APPEND write of one line. Small lines (< PIPE_BUF-ish) land whole, so concurrent writers never interleave. */
export function appendEvent(home: string, event: TetherEvent): void {
  assertSlotId(event.slotId)
  ensureSlotsDir(home)
  appendFileSync(slotEventsPath(home, event.slotId), JSON.stringify(event) + '\n')
}

/** Every well-formed v1 event in the slot's file, in file order. Blank, corrupt, partial or foreign lines are skipped. */
export function readEvents(home: string, slotId: string): TetherEvent[] {
  const r = readEventsFile(home, slotId)
  return parseEvents(r.complete + r.fragment)
}

/**
 * A stretch of a slot's events file: bytes [start, end). `complete` holds the whole lines (up to the last newline) and
 * `fragment` what follows it (a line still being written, or one the writer did not terminate). `end` is the file size
 * seen; the next incremental read resumes at `end - bytes(fragment)`, i.e. `resume`.
 */
export interface EventsRead {
  start: number
  end: number
  resume: number
  complete: string
  fragment: string
}

function splitRead(buf: Buffer, start: number): EventsRead {
  const nl = buf.lastIndexOf(0x0a)
  const cut = nl + 1
  return {
    start,
    end: start + buf.length,
    resume: start + cut,
    complete: buf.toString('utf8', 0, cut),
    fragment: buf.toString('utf8', cut),
  }
}

/** The events file in one read (missing file = empty), parsed from byte `from` on; a file shorter than `from` is taken whole. */
export function readEventsFile(home: string, slotId: string, from = 0): EventsRead {
  assertSlotId(slotId)
  try {
    const buf = readFileSync(slotEventsPath(home, slotId))
    const start = buf.length < from ? 0 : from
    return splitRead(start === 0 ? buf : buf.subarray(start), start)
  } catch {
    return splitRead(Buffer.alloc(0), 0)
  }
}

/**
 * The events file from byte `from` on, asynchronously. A file shorter than `from` was truncated or rewritten: it is read
 * whole (`start` 0 tells the caller to forget what it kept). `from` must sit on a line start (a previous `resume`).
 */
export async function readEventsFrom(home: string, slotId: string, from: number): Promise<EventsRead> {
  assertSlotId(slotId)
  let fh: FileHandle
  try {
    fh = await open(slotEventsPath(home, slotId), 'r')
  } catch {
    return splitRead(Buffer.alloc(0), 0)
  }
  try {
    const size = (await fh.stat()).size
    const start = size < from ? 0 : from
    const buf = Buffer.alloc(size - start)
    let got = 0
    while (got < buf.length) {
      const { bytesRead } = await fh.read(buf, got, buf.length - got, start + got)
      if (bytesRead === 0) break
      got += bytesRead
    }
    return splitRead(got === buf.length ? buf : buf.subarray(0, got), start)
  } finally {
    await fh.close()
  }
}

export function parseEvents(text: string): TetherEvent[] {
  const out: TetherEvent[] = []
  for (const line of text.split('\n')) {
    const e = parseEventLine(line)
    if (e) out.push(e)
  }
  return out
}

export function parseEventLine(line: string): TetherEvent | undefined {
  const s = line.trim()
  if (!s) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(s)
  } catch {
    return undefined
  }
  return isTetherEvent(parsed) ? parsed : undefined
}

function isTetherEvent(x: unknown): x is TetherEvent {
  if (!isObject(x) || x.v !== 1) return false
  if (typeof x.ts !== 'string' || typeof x.slotId !== 'string' || typeof x.sessionId !== 'string') return false
  // Any plausible agent name: an event of an agent whose extension is off must not make the slot forget its session.
  if (!isAgentName(x.agent)) return false
  if (x.kind !== 'start' && x.kind !== 'rename' && x.kind !== 'end') return false
  if (typeof x.source !== 'string') return false
  if (x.title !== undefined && typeof x.title !== 'string') return false
  if (x.cwd !== undefined && typeof x.cwd !== 'string') return false
  if (x.resume !== undefined && !isResumeRecipe(x.resume)) return false
  return true
}

function isResumeRecipe(x: unknown): boolean {
  return isObject(x) && typeof x.cwd === 'string' && Array.isArray(x.args) && x.args.every((a) => typeof a === 'string')
}

function isSlotMeta(x: unknown): x is SlotMeta {
  if (
    !isObject(x) ||
    x.v !== 1 ||
    typeof x.slotId !== 'string' ||
    (x.agent !== 'shell' && !isAgentName(x.agent)) || // unregistered agents load too (agent-unavailable, never vanish)
    typeof x.cwd !== 'string' ||
    !Array.isArray(x.args) ||
    typeof x.createdAt !== 'string'
  ) return false
  // Profile fields are optional (slots from before profiles existed have none); a malformed one makes the meta unreadable.
  if (x.profileId !== undefined && typeof x.profileId !== 'string') return false
  if (x.profileArgs !== undefined && !(Array.isArray(x.profileArgs) && x.profileArgs.every((a) => typeof a === 'string'))) return false
  if (x.profileEnv !== undefined && !(isObject(x.profileEnv) && Object.values(x.profileEnv).every((v) => typeof v === 'string'))) return false
  if (x.endedAt !== undefined && typeof x.endedAt !== 'string') return false
  return true
}

/** Rewrites the slot's meta file (rename, profile snapshot). Atomic: temp + rename. */
export function writeSlotMeta(home: string, meta: SlotMeta): void {
  assertSlotId(meta.slotId)
  ensureSlotsDir(home)
  const path = slotMetaPath(home, meta.slotId)
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(meta, null, 2) + '\n')
  renameSync(tmp, path)
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

// ---- binding -------------------------------------------------------------

/**
 * Marker for bindings that did not come from an agent event (slot has no `start` yet, but something was
 * guessed from the agent's own files). No inference lives here: a later task builds those and sets
 * `confirmed: false`. `currentBinding` always returns confirmed bindings.
 */
export type InferredBinding = Binding & { confirmed: false }

/**
 * The slot's current session: the last `start` event decides sessionId/cwd/resume/since.
 * - title: the latest `rename` for that session at/after the start, else the start's own `title`.
 * - ended: the last event about that session is an `end` (a later `start` of the same id reopens it).
 * Returns undefined when the slot has no `start` event.
 */
export function currentBinding(events: TetherEvent[], meta: SlotMeta): Binding | undefined {
  let startIdx = -1
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.kind === 'start') {
      startIdx = i
      break
    }
  }
  if (startIdx < 0) return undefined
  const start = events[startIdx]!

  let title = start.title
  let ended = false
  for (let i = startIdx + 1; i < events.length; i++) {
    const e = events[i]!
    if (e.sessionId !== start.sessionId) continue
    if (e.kind === 'rename') {
      if (e.title !== undefined) title = e.title
      ended = false
    } else if (e.kind === 'end') {
      ended = true
    }
  }

  const binding: Binding = {
    slotId: meta.slotId,
    agent: start.agent,
    sessionId: start.sessionId,
    cwd: start.cwd ?? start.resume?.cwd ?? meta.cwd,
    since: start.ts,
    confirmed: true,
    ended,
  }
  if (start.resume) binding.resume = start.resume
  if (title !== undefined) binding.title = title
  return binding
}

// ---- run info ------------------------------------------------------------

export function writeRun(home: string, slotId: string, run: RunInfo): void {
  assertSlotId(slotId)
  ensureSlotsDir(home)
  writeFileSync(slotRunPath(home, slotId), JSON.stringify(run, null, 2) + '\n')
}

export function readRun(home: string, slotId: string): RunInfo | undefined {
  assertSlotId(slotId)
  const x = readJsonFile(slotRunPath(home, slotId))
  if (!isObject(x) || typeof x.pid !== 'number' || typeof x.startedAt !== 'string') return undefined
  if (x.agentPid !== undefined && typeof x.agentPid !== 'number') return undefined
  return x as unknown as RunInfo
}

export function clearRun(home: string, slotId: string): void {
  assertSlotId(slotId)
  rmSync(slotRunPath(home, slotId), { force: true })
}
