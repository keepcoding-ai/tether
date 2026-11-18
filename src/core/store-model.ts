// Slot state, pure half: ids, shapes read from disk, parsing, serialization and the binding derived from the events.
// No node:fs on purpose: the coordinator (and the slot store that hands text to the executor) may import this file
// freely. The synchronous, fs-touching half lives in store-sync.ts.
import { randomBytes } from 'node:crypto'
import type { Binding, RunInfo, SlotMeta, TetherEvent } from './event.ts'
import { isAgentName } from '../agents/registry.ts'

export const SLOT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i

/** 8 lowercase hex chars; the caller retries while a slot with that id already exists. */
export function randomSlotId(): string {
  return randomBytes(4).toString('hex')
}

export function assertSlotId(slotId: string): void {
  if (!SLOT_ID_RE.test(slotId)) throw new Error(`invalid slot id: ${JSON.stringify(slotId)}`)
}

// ---- serialization -------------------------------------------------------

export function serializeMeta(meta: SlotMeta): string {
  return JSON.stringify(meta, null, 2) + '\n'
}

export function serializeRun(run: RunInfo): string {
  return JSON.stringify(run, null, 2) + '\n'
}

/** One line of the events file, newline included. */
export function serializeEvent(event: TetherEvent): string {
  return JSON.stringify(event) + '\n'
}

// ---- parsing -------------------------------------------------------------

export function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

/** JSON text to a value; anything unreadable is `undefined`. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export function isSlotMeta(x: unknown): x is SlotMeta {
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

/** The meta of slot `slotId` from its file's text, or undefined when unreadable, malformed or for another slot. */
export function parseSlotMeta(text: string, slotId: string): SlotMeta | undefined {
  const parsed = parseJson(text)
  return isSlotMeta(parsed) && parsed.slotId === slotId ? parsed : undefined
}

/** A parsed value as a run file, or undefined when it is not one. */
export function asRunInfo(x: unknown): RunInfo | undefined {
  if (!isObject(x) || typeof x.pid !== 'number' || typeof x.startedAt !== 'string') return undefined
  if (x.agentPid !== undefined && typeof x.agentPid !== 'number') return undefined
  return x as unknown as RunInfo
}

export function parseRunInfo(text: string): RunInfo | undefined {
  return asRunInfo(parseJson(text))
}

function isResumeRecipe(x: unknown): boolean {
  return isObject(x) && typeof x.cwd === 'string' && Array.isArray(x.args) && x.args.every((a) => typeof a === 'string')
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

export function parseEvents(text: string): TetherEvent[] {
  const out: TetherEvent[] = []
  for (const line of text.split('\n')) {
    const e = parseEventLine(line)
    if (e) out.push(e)
  }
  return out
}

// ---- events file stretches ----------------------------------------------

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

export function splitRead(buf: Buffer, start: number): EventsRead {
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

// ---- slots directory -----------------------------------------------------

/** What one pass over the slots directory found: the readable slots (oldest first) and every file name in it. */
export interface SlotsScan {
  metas: SlotMeta[]
  names: string[]
}

/** Names in the slots directory that are slot metas (`<id>.json`, not a run file): their ids. */
export function metaIds(names: string[]): string[] {
  const ids: string[] = []
  for (const name of names) {
    if (!name.endsWith('.json') || name.endsWith('.run.json')) continue
    const id = name.slice(0, -'.json'.length)
    if (SLOT_ID_RE.test(id)) ids.push(id)
  }
  return ids
}

export function byAge(a: SlotMeta, b: SlotMeta): number {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.slotId < b.slotId ? -1 : a.slotId > b.slotId ? 1 : 0
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

  // An agent's session keeps the folder it was opened in: a later start of the same session (compact, clear,
  // resume) reports the agent's CURRENT folder, which a `cd` may have moved. Only a shell follows its `cd`.
  let first = start
  if (start.agent !== 'shell') {
    for (let i = 0; i < startIdx; i++) {
      const e = events[i]!
      if (e.kind === 'start' && e.sessionId === start.sessionId) { first = e; break }
    }
  }
  const cwd = first.cwd ?? first.resume?.cwd ?? meta.cwd
  const binding: Binding = {
    slotId: meta.slotId,
    agent: start.agent,
    sessionId: start.sessionId,
    cwd,
    since: start.ts,
    confirmed: true,
    ended,
  }
  if (start.resume) binding.resume = { ...start.resume, cwd }
  if (title !== undefined) binding.title = title
  return binding
}
