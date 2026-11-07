// Slot state on disk: metadata, append-only events, run info, and the binding derived from the events.
// No locks and nothing in memory: one slot = its own files, events are appended one line at a time.
import { randomBytes } from 'node:crypto'
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
import { slotAttentionPath, slotEventsPath, slotMetaPath, slotRunPath, slotsDir } from './paths.ts'

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

/** All readable slots, sorted by creation time (oldest first). Unreadable `.json` files are skipped. */
export function listSlots(home: string): SlotMeta[] {
  const dir = slotsDir(home)
  if (!existsSync(dir)) return []
  const out: SlotMeta[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json') || name.endsWith('.run.json')) continue
    const id = name.slice(0, -'.json'.length)
    if (!SLOT_ID_RE.test(id)) continue
    const meta = readSlot(home, id)
    if (meta) out.push(meta)
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.slotId.localeCompare(b.slotId))
}

/** Forgets the slot: removes tether's files. Never touches the agent's session files. */
export function removeSlot(home: string, slotId: string): void {
  assertSlotId(slotId)
  for (const p of [slotMetaPath(home, slotId), slotEventsPath(home, slotId), slotRunPath(home, slotId), slotAttentionPath(home, slotId)]) {
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
  assertSlotId(slotId)
  let text: string
  try {
    text = readFileSync(slotEventsPath(home, slotId), 'utf8')
  } catch {
    return []
  }
  return parseEvents(text)
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
  if (x.profileFeatures !== undefined && !(isObject(x.profileFeatures) && Object.values(x.profileFeatures).every((v) => typeof v === 'boolean'))) return false
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
