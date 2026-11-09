// Polite pause batch: the pure model (entry state machine, report folding, request text) plus the
// <home>/pause.json persistence. The agent stops itself at a safe point; nothing here forces anything.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { pausePath } from '../core/paths.ts'

export type PauseEntryState =
  | 'queued'
  | 'listening'
  | 'delivered'
  | 'preparing'
  | 'stopped'
  | 'stopped-silent'
  | 'removed'
  | 'resumed'
  | 'resume-skipped'

export type PauseBatchState = 'pausing' | 'paused' | 'resuming' | 'closed'

export interface PauseHistoryItem {
  state: PauseEntryState
  at: string
}

export interface PauseEntry {
  slotId: string
  kind: string
  sessionId?: string
  state: PauseEntryState
  /** ISO time of the last state change. */
  since: string
  history: PauseHistoryItem[]
  /** What the agent said it is doing (ack). */
  phrase?: string
  /** Resume note (done, or the fallback text of a silent stop). */
  note?: string
}

export interface PauseBatch {
  v: 1
  id: string
  createdAt: string
  state: PauseBatchState
  entries: PauseEntry[]
}

export interface PauseReportLine {
  ts: string
  batchId?: string
  kind: 'delivered' | 'ack' | 'done' | 'stop'
  text?: string
}

/** After this long in delivered/preparing the label turns into "still finishing". */
export const STILL_FINISHING_MS = 5 * 60 * 1000

const ALLOWED: Record<PauseEntryState, readonly PauseEntryState[]> = {
  queued: ['listening', 'removed'],
  listening: ['delivered', 'preparing', 'stopped', 'stopped-silent', 'removed'],
  delivered: ['preparing', 'stopped', 'stopped-silent', 'removed'],
  preparing: ['stopped', 'stopped-silent', 'removed'],
  stopped: ['resumed', 'resume-skipped', 'removed'],
  // A late `done` upgrades a silent stop to a stop with a note.
  'stopped-silent': ['stopped', 'resumed', 'resume-skipped', 'removed'],
  removed: [],
  resumed: [],
  'resume-skipped': [],
}

export function canTransition(from: PauseEntryState, to: PauseEntryState): boolean {
  return ALLOWED[from].includes(to)
}

export class PauseTransitionError extends Error {
  constructor(from: PauseEntryState, to: PauseEntryState) {
    super(`invalid pause transition ${from} -> ${to}`)
  }
}

/** Returns a new entry in state `to` (history appended); throws PauseTransitionError when the move is not allowed. */
export function transition(
  entry: PauseEntry,
  to: PauseEntryState,
  now: string,
  patch: { phrase?: string; note?: string } = {},
): PauseEntry {
  if (!canTransition(entry.state, to)) throw new PauseTransitionError(entry.state, to)
  const next: PauseEntry = { ...entry, state: to, since: now, history: [...entry.history, { state: to, at: now }] }
  if (patch.phrase !== undefined) next.phrase = patch.phrase
  if (patch.note !== undefined) next.note = patch.note
  return next
}

export function newEntry(slotId: string, kind: string, now: string, sessionId?: string): PauseEntry {
  const entry: PauseEntry = { slotId, kind, state: 'queued', since: now, history: [{ state: 'queued', at: now }] }
  if (sessionId !== undefined) entry.sessionId = sessionId
  return entry
}

/** The text injected into the agent's context. `cliCommand` is the CLI invocation, e.g. `node "<repo>/bin/tether.mjs"`. */
export function buildRequestText(cliCommand: string): string {
  return [
    '[tether] Uma pausa temporária foi pedida pelo Guga. Você decide o ponto seguro para parar.',
    '',
    `1. Ao ler este pedido, rode: ${cliCommand} pause ack "<o que está fazendo e até onde vai>"`,
    '2. Termine o passo em andamento, sem começar tarefa nova.',
    `3. Rode: ${cliCommand} pause done "<nota de retomada: onde parou e qual é o próximo passo>" e encerre o turno.`,
    '',
    'Depois o Guga retoma você com essa nota. Se você já recebeu este pedido antes, ignore esta repetição.',
  ].join('\n')
}

// ---- report lines -------------------------------------------------------------------------------------------------

function parseLine(raw: unknown): PauseReportLine | undefined {
  let x: unknown = raw
  if (typeof raw === 'string') {
    try { x = JSON.parse(raw) } catch { return undefined }
  }
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return undefined
  const o = x as Record<string, unknown>
  if (typeof o.ts !== 'string' || Number.isNaN(Date.parse(o.ts))) return undefined
  if (o.kind !== 'delivered' && o.kind !== 'ack' && o.kind !== 'done' && o.kind !== 'stop') return undefined
  if (o.batchId !== undefined && typeof o.batchId !== 'string') return undefined
  if (o.text !== undefined && typeof o.text !== 'string') return undefined
  const line: PauseReportLine = { ts: o.ts, kind: o.kind }
  if (o.batchId !== undefined) line.batchId = o.batchId
  if (o.text !== undefined) line.text = o.text
  return line
}

/**
 * Folds one report line (raw jsonl string or parsed object) into the entry. Returns the entry unchanged when the
 * line is corrupt, belongs to another batch, predates the entry, or does not apply to its current state.
 */
export function applyReportLine(entry: PauseEntry, raw: unknown, batchId?: string): PauseEntry {
  const line = parseLine(raw)
  if (!line) return entry
  if (line.batchId !== undefined && batchId !== undefined && line.batchId !== batchId) return entry
  const born = Date.parse(entry.history[0]?.at ?? entry.since)
  if (Date.parse(line.ts) < born) return entry
  const state = entry.state
  const live = state === 'listening' || state === 'delivered' || state === 'preparing'
  const note = line.text === undefined ? {} : { note: line.text }
  switch (line.kind) {
    case 'delivered':
      return state === 'listening' ? transition(entry, 'delivered', line.ts) : entry
    case 'ack': {
      let e = entry
      if (state === 'listening') e = transition(e, 'delivered', line.ts)
      else if (state !== 'delivered') return entry
      return transition(e, 'preparing', line.ts, line.text === undefined ? {} : { phrase: line.text })
    }
    case 'done':
      return live || state === 'stopped-silent' ? transition(entry, 'stopped', line.ts, note) : entry
    case 'stop':
      return live ? transition(entry, 'stopped-silent', line.ts, note) : entry
  }
}

/** Plain-language status for the UI. Derived, never stored. `now` is epoch ms, an ISO string or a Date. */
export function derivedLabel(entry: PauseEntry, now: number | string | Date): string {
  const t = now instanceof Date ? now.getTime() : typeof now === 'string' ? Date.parse(now) : now
  switch (entry.state) {
    case 'queued': return 'Na fila'
    case 'listening': return 'Pedido enviado'
    case 'delivered':
    case 'preparing':
      if (t - Date.parse(entry.since) >= STILL_FINISHING_MS) return 'Ainda finalizando'
      return entry.state === 'delivered' ? 'Pedido recebido' : 'Preparando para parar'
    case 'stopped': return 'Parou'
    case 'stopped-silent': return 'Parou sem nota'
    case 'removed': return 'Fora do lote'
    case 'resumed': return 'Retomado'
    case 'resume-skipped': return 'Não retomado'
  }
}

// ---- persistence --------------------------------------------------------------------------------------------------

/** Reads <home>/pause.json; undefined when missing, unreadable or not a batch. */
export function readPauseFile(home: string): PauseBatch | undefined {
  try {
    const x: unknown = JSON.parse(readFileSync(pausePath(home), 'utf8'))
    if (typeof x !== 'object' || x === null) return undefined
    const b = x as PauseBatch
    if (b.v !== 1 || typeof b.id !== 'string' || typeof b.createdAt !== 'string' || typeof b.state !== 'string') return undefined
    if (!Array.isArray(b.entries)) return undefined
    return b
  } catch {
    return undefined
  }
}

/** Atomic: temp + rename. */
export function writePauseFile(home: string, batch: PauseBatch): void {
  const path = pausePath(home)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(batch, null, 2) + '\n')
  renameSync(tmp, path)
}
