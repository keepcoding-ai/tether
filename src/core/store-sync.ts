// Slot state, synchronous half: every function here touches the disk. The CLI uses it as is; the daemon reaches it only
// through nothing: tetherd's graph never imports it (its reads are in store-async.ts, its writes in slot-store.ts); the CLI and the tests do.
// No locks and nothing in memory: one slot = its own files, events are appended one line at a time.
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
import type { RunInfo, SlotMeta, TetherEvent } from './event.ts'
import { slotAttentionPath, slotEventsPath, slotMetaPath, slotRondaPath, slotRunPath, slotsDir } from './paths.ts'
import {
  asRunInfo, assertSlotId, byAge, metaIds, parseEvents, parseJson, parseSlotMeta, randomSlotId,
  serializeEvent, serializeMeta, serializeRun, splitRead,
  type EventsRead, type SlotsScan,
} from './store-model.ts'

/** 8 lowercase hex chars; retried while a slot with that id already exists in `home`. */
export function newSlotId(home: string): string {
  for (let i = 0; i < 100; i++) {
    const id = randomSlotId()
    if (!existsSync(slotMetaPath(home, id)) && !existsSync(slotEventsPath(home, id))) return id
  }
  throw new Error('could not find a free slot id')
}

function ensureSlotsDir(home: string): void {
  mkdirSync(slotsDir(home), { recursive: true })
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

// ---- slots ---------------------------------------------------------------

export function createSlot(home: string, meta: SlotMeta): void {
  assertSlotId(meta.slotId)
  ensureSlotsDir(home)
  const path = slotMetaPath(home, meta.slotId)
  if (existsSync(path)) throw new Error(`slot already exists: ${meta.slotId}`)
  writeFileSync(path, serializeMeta(meta), { flag: 'wx' })
}

export function readSlot(home: string, slotId: string): SlotMeta | undefined {
  assertSlotId(slotId)
  const text = readText(slotMetaPath(home, slotId))
  return text === undefined ? undefined : parseSlotMeta(text, slotId)
}

/** One `readdir` of the slots directory plus the readable `.json` metas; the names tell a caller which side files exist without more disk calls. */
export function scanSlots(home: string): SlotsScan {
  const dir = slotsDir(home)
  if (!existsSync(dir)) return { metas: [], names: [] }
  const names = readdirSync(dir)
  const metas: SlotMeta[] = []
  for (const id of metaIds(names)) {
    const meta = readSlot(home, id)
    if (meta) metas.push(meta)
  }
  metas.sort(byAge)
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

/** Rewrites the slot's meta file (rename, profile snapshot). Atomic: temp + rename. */
export function writeSlotMeta(home: string, meta: SlotMeta): void {
  assertSlotId(meta.slotId)
  ensureSlotsDir(home)
  const path = slotMetaPath(home, meta.slotId)
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, serializeMeta(meta))
  renameSync(tmp, path)
}

// ---- events --------------------------------------------------------------

/** One O_APPEND write of one line. Small lines (< PIPE_BUF-ish) land whole, so concurrent writers never interleave. */
export function appendEvent(home: string, event: TetherEvent): void {
  assertSlotId(event.slotId)
  ensureSlotsDir(home)
  appendFileSync(slotEventsPath(home, event.slotId), serializeEvent(event))
}

/** Every well-formed v1 event in the slot's file, in file order. Blank, corrupt, partial or foreign lines are skipped. */
export function readEvents(home: string, slotId: string): TetherEvent[] {
  const r = readEventsFile(home, slotId)
  return parseEvents(r.complete + r.fragment)
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

// ---- run info ------------------------------------------------------------

export function writeRun(home: string, slotId: string, run: RunInfo): void {
  assertSlotId(slotId)
  ensureSlotsDir(home)
  writeFileSync(slotRunPath(home, slotId), serializeRun(run))
}

export function readRun(home: string, slotId: string): RunInfo | undefined {
  assertSlotId(slotId)
  return asRunInfo(parseJson(readText(slotRunPath(home, slotId)) ?? ''))
}

export function clearRun(home: string, slotId: string): void {
  assertSlotId(slotId)
  rmSync(slotRunPath(home, slotId), { force: true })
}

// The async readers moved to store-async.ts (the daemon's graph); kept under their old names for the callers of this file.
export { readEventsFrom, scanSlotsAsync } from './store-async.ts'
