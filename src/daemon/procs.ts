// Background processes (tether proc): the model, apart from the wire. Card (the recipe), history (append-only
// events, tetherd its only writer), state derived from history + run.json + what the host lists, the secret mask
// and the Portuguese texts. tether never restarts anything by itself and never kills by name: see proc-manager.ts.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { procCardPath, procEventsPath, procRunPath, procsDir } from '../core/paths.ts'
import { writeJsonAtomic, type RunFile } from '../procd/protocol.ts'
import { localTime } from '../cli/format.ts'

/** Lower case only: the name is a file name, and Windows would fold `Web` and `web` into one card. */
export const PROC_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
export const DEFAULT_STOP_GRACE_MS = 5_000
const SECRET_NAME = /KEY|TOKEN|SECRET|PASS|CREDENTIAL/i
export const SECRET_MASK = '•••'
/** How many events `proc-info` returns. */
export const INFO_EVENTS = 20

export type ProcErrorCode = 'unknown-proc' | 'proc-running' | 'proc-not-stopped' | 'proc-host' | 'bad-request'

export class ProcError extends Error {
  readonly code: ProcErrorCode
  constructor(code: ProcErrorCode, message: string) {
    super(message)
    this.name = 'ProcError'
    this.code = code
  }
}

/** Who did it, as they were at that moment (the portrait outlives the panel). */
export interface ProcAuthor {
  kind: 'agent' | 'shell' | 'app' | 'external'
  slotId?: string
  /** The panel's name at the time. */
  name?: string
  agent?: string
  sessionId?: string
  /** OS user. */
  user?: string
  /** --as */
  label?: string
}

/** What a CLI request says about its caller; tetherd turns it into a ProcAuthor. */
export interface ProcBy {
  slotId?: string
  as?: string
  user?: string
}

export interface ProcRecipe {
  command: string
  args: string[]
  cwd: string
  env?: Record<string, string>
  ports?: number[]
  description?: string
  info?: Record<string, string>
  stopGraceMs?: number
}

export interface ProcCard {
  v: 1
  name: string
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  ports: number[]
  stopGraceMs: number
  description?: string
  info: Record<string, string>
  registeredBy: ProcAuthor
  createdAt: string
}

/** The recipe part of a card: what `recipe-changed` compares and records. */
export type RecipeFields = Pick<ProcCard, 'command' | 'args' | 'cwd' | 'env' | 'ports' | 'stopGraceMs' | 'description' | 'info'>

export type ProcEventKind = 'registered' | 'recipe-changed' | 'started' | 'start-failed' | 'stop-requested' | 'restart-requested' | 'ended' | 'forgotten'
export type EndCause = 'requested' | 'own' | 'host'

export interface ProcEvent {
  v: 1
  ts: string
  kind: ProcEventKind
  by?: ProcAuthor
  run?: number
  reason?: string
  pid?: number
  /** ended: exit code (absent when the host went down with the process). */
  code?: number
  /** ended: the real time of the exit (run.json); `ts` is when tetherd recorded it. */
  at?: string
  cause?: EndCause
  message?: string
  before?: Partial<RecipeFields>
  after?: Partial<RecipeFields>
}

export type ProcStatus = 'running' | 'stopping' | 'stopped' | 'exited' | 'host-lost' | 'failed'

export interface ProcState {
  name: string
  /** env values whose names look like secrets are masked. */
  card: ProcCard
  status: ProcStatus
  run?: number
  pid?: number
  startedAt?: string
  startedBy?: ProcAuthor
  exit?: { code?: number; at: string; cause: EndCause }
  stoppedBy?: ProcAuthor
  reason?: string
  /** Ended by itself or with the host, and nobody looked yet. */
  attention?: boolean
  /** failed: why it did not start. */
  error?: string
}

// ---- validation ---------------------------------------------------------------------------------

export function checkName(name: unknown): string {
  if (typeof name !== 'string' || !PROC_NAME_RE.test(name)) {
    throw new ProcError('bad-request', `nome inválido: ${JSON.stringify(name)} (use letras minúsculas, dígitos, - e _, até 64; ex.: atrium-dev-web)`)
  }
  return name
}

const isStringMap = (x: unknown): x is Record<string, string> =>
  !!x && typeof x === 'object' && !Array.isArray(x) && Object.values(x).every((v) => typeof v === 'string')

/** A recipe from the wire, checked; the optional fields get their defaults (the recipe is complete). */
export function normalizeRecipe(input: unknown): RecipeFields {
  if (!input || typeof input !== 'object') throw new ProcError('bad-request', 'receita inválida')
  const r = input as Partial<ProcRecipe>
  if (typeof r.command !== 'string' || !r.command.trim()) throw new ProcError('bad-request', 'a receita precisa de um comando')
  if (!Array.isArray(r.args) || !r.args.every((a) => typeof a === 'string')) throw new ProcError('bad-request', 'args deve ser uma lista de textos')
  if (typeof r.cwd !== 'string' || !isAbsolute(r.cwd)) throw new ProcError('bad-request', 'a receita precisa de uma pasta absoluta (cwd)')
  if (r.env !== undefined && !isStringMap(r.env)) throw new ProcError('bad-request', 'env deve ser pares nome=valor')
  if (r.info !== undefined && !isStringMap(r.info)) throw new ProcError('bad-request', 'info deve ser pares chave=valor')
  if (r.ports !== undefined && (!Array.isArray(r.ports) || !r.ports.every((p) => Number.isInteger(p) && p > 0 && p < 65536))) {
    throw new ProcError('bad-request', 'portas devem ser números entre 1 e 65535')
  }
  if (r.stopGraceMs !== undefined && (!Number.isFinite(r.stopGraceMs) || r.stopGraceMs < 0)) throw new ProcError('bad-request', 'stopGraceMs inválido')
  const description = typeof r.description === 'string' ? r.description.replace(/\s+/g, ' ').trim() : ''
  return {
    command: r.command,
    args: [...r.args],
    cwd: r.cwd,
    env: { ...(r.env ?? {}) },
    ports: [...new Set(r.ports ?? [])],
    stopGraceMs: r.stopGraceMs ?? DEFAULT_STOP_GRACE_MS,
    ...(description ? { description } : {}),
    info: { ...(r.info ?? {}) },
  }
}

export function recipeOf(card: ProcCard): RecipeFields {
  const { command, args, cwd, env, ports, stopGraceMs, description, info } = card
  return { command, args, cwd, env, ports, stopGraceMs, ...(description !== undefined ? { description } : {}), info }
}

/** The fields that differ, before and after (env masked: the history must not keep secrets); undefined when equal. */
export function recipeDiff(before: RecipeFields, after: RecipeFields): { before: Partial<RecipeFields>; after: Partial<RecipeFields> } | undefined {
  const keys: (keyof RecipeFields)[] = ['command', 'args', 'cwd', 'env', 'ports', 'stopGraceMs', 'description', 'info']
  const b: Record<string, unknown> = {}
  const a: Record<string, unknown> = {}
  for (const k of keys) {
    if (JSON.stringify(before[k] ?? null) === JSON.stringify(after[k] ?? null)) continue
    b[k] = k === 'env' ? maskEnv(before.env) : before[k]
    a[k] = k === 'env' ? maskEnv(after.env) : after[k]
  }
  return Object.keys(a).length ? { before: b as Partial<RecipeFields>, after: a as Partial<RecipeFields> } : undefined
}

export function maskEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) out[k] = SECRET_NAME.test(k) ? SECRET_MASK : v
  return out
}

export function maskCard(card: ProcCard): ProcCard {
  return { ...card, env: maskEnv(card.env) }
}

// ---- derived state ------------------------------------------------------------------------------

/** What the history says about the latest run. */
export interface Replay {
  lastRun: number
  started?: ProcEvent
  ended?: ProcEvent
  /** The stop/restart request of the latest run that has no `ended` yet (or that the `ended` answered). */
  request?: ProcEvent
  /** A start-failed after the latest started. */
  failed?: ProcEvent
}

export function replay(events: ProcEvent[]): Replay {
  const r: Replay = { lastRun: 0 }
  for (const e of events) {
    if (e.kind === 'started' && typeof e.run === 'number') {
      r.lastRun = Math.max(r.lastRun, e.run)
      r.started = e
      r.ended = undefined
      r.request = undefined
      r.failed = undefined
    } else if (e.kind === 'ended' && e.run === r.started?.run) r.ended = e
    else if ((e.kind === 'stop-requested' || e.kind === 'restart-requested') && e.run === r.started?.run) r.request = e
    else if (e.kind === 'start-failed') {
      r.failed = e
      if (typeof e.run === 'number') r.lastRun = Math.max(r.lastRun, e.run)
    }
  }
  return r
}

export function hasEnded(events: ProcEvent[], run: number): boolean {
  return events.some((e) => e.kind === 'ended' && e.run === run)
}

/** The stop/restart request pending for `run` (no `ended` after it). */
export function pendingRequest(events: ProcEvent[], run: number): ProcEvent | undefined {
  const r = replay(events)
  return r.started?.run === run && !r.ended ? r.request : undefined
}

export function deriveState(card: ProcCard, events: ProcEvent[], live: { runFile?: RunFile; stopping?: boolean; seenRun?: number }): ProcState {
  const r = replay(events)
  const s: ProcState = { name: card.name, card: maskCard(card), status: 'stopped' }
  if (r.failed) {
    s.status = 'failed'
    s.error = r.failed.message ?? 'não subiu'
    return s
  }
  if (!r.started) return s
  const run = r.started.run!
  s.run = run
  if (r.started.by) s.startedBy = r.started.by
  if (!r.ended) {
    s.status = live.stopping ? 'stopping' : 'running'
    if (typeof r.started.pid === 'number') s.pid = r.started.pid
    if (live.runFile?.run === run) s.startedAt = live.runFile.startedAt
    return s
  }
  const end = r.ended
  s.exit = { ...(typeof end.code === 'number' ? { code: end.code } : {}), at: end.at ?? end.ts, cause: end.cause ?? 'own' }
  if (end.cause === 'requested') {
    s.status = 'stopped'
    if (r.request?.by) s.stoppedBy = r.request.by
    if (r.request?.reason) s.reason = r.request.reason
  } else {
    s.status = end.cause === 'host' ? 'host-lost' : 'exited'
    if (live.seenRun !== run) s.attention = true
  }
  return s
}

// ---- texts (Portuguese) -------------------------------------------------------------------------

export function statusText(s: Pick<ProcState, 'status' | 'exit'>): string {
  switch (s.status) {
    case 'running': return 'rodando'
    case 'stopping': return 'parando'
    case 'stopped': return 'parado'
    case 'exited': return typeof s.exit?.code === 'number' ? `encerrou sozinho (${s.exit.code})` : 'encerrou sozinho'
    case 'host-lost': return 'caiu com o anfitrião'
    case 'failed': return 'não subiu'
  }
}

export function authorText(by: ProcAuthor | undefined): string {
  if (!by) return '?'
  let who: string
  switch (by.kind) {
    case 'app': who = 'você (pelo app)'; break
    case 'agent': who = `${by.name ?? by.slotId ?? 'painel'} (${by.agent ?? 'agente'})`; break
    case 'shell': who = `${by.name ?? by.slotId ?? 'painel'} (shell)`; break
    default: who = by.user ?? 'externo'
  }
  if (by.label) who = by.kind === 'external' ? `${by.label} (${who})` : `${who}, como ${by.label}`
  return who
}

export function eventText(e: ProcEvent): string {
  switch (e.kind) {
    case 'registered': return 'registrou o processo'
    case 'recipe-changed': return `alterou a receita: ${Object.keys(e.after ?? {}).join(', ')}`
    case 'started': return `iniciou (execução ${e.run}, pid ${e.pid})`
    case 'start-failed': return `não subiu: ${e.message ?? '?'}`
    case 'stop-requested': return `pediu a parada (execução ${e.run})`
    case 'restart-requested': return `pediu o reinício (execução ${e.run})`
    case 'forgotten': return 'esqueceu o processo'
    case 'ended': {
      const at = e.at ? ` às ${localTime(e.at)}` : ''
      const code = typeof e.code === 'number' ? `, código ${e.code}` : ''
      if (e.cause === 'requested') return `execução ${e.run} parou a pedido${at}${code}`
      if (e.cause === 'host') return `execução ${e.run} caiu com o anfitrião${at}`
      return `execução ${e.run} encerrou sozinha${at}${code}`
    }
  }
}

/** One history line: local time, who, what, why. `ended` is the system's: no author. */
export function historyLine(e: ProcEvent): string {
  const who = e.by ? authorText(e.by) : 'tether'
  return `${localTime(e.ts)}  ${who}  ${eventText(e)}${e.reason ? `  motivo: ${e.reason}` : ''}`
}

// ---- files --------------------------------------------------------------------------------------

export function readCard(home: string, name: string): ProcCard | undefined {
  try {
    const c = JSON.parse(readFileSync(procCardPath(home, name), 'utf8')) as ProcCard
    return c && c.v === 1 && c.name === name && typeof c.command === 'string' && Array.isArray(c.args) ? c : undefined
  } catch {
    return undefined
  }
}

export function writeCard(home: string, card: ProcCard): void {
  writeJsonAtomic(procCardPath(home, card.name), card)
}

export function listCards(home: string): ProcCard[] {
  let files: string[]
  try { files = readdirSync(procsDir(home)) } catch { return [] }
  const out: ProcCard[] = []
  for (const f of files) {
    const m = /^(.+)\.json$/.exec(f)
    if (!m || f.endsWith('.run.json') || !PROC_NAME_RE.test(m[1]!)) continue
    const card = readCard(home, m[1]!)
    if (card) out.push(card)
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Every event in order; a corrupt line is skipped. */
export function readProcEvents(home: string, name: string): ProcEvent[] {
  let text: string
  try { text = readFileSync(procEventsPath(home, name), 'utf8') } catch { return [] }
  const out: ProcEvent[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line) as ProcEvent
      if (e && typeof e.kind === 'string' && typeof e.ts === 'string') out.push(e)
    } catch { /* a torn or hand-edited line: skipped */ }
  }
  return out
}

export function appendProcEvent(home: string, name: string, e: ProcEvent): void {
  const path = procEventsPath(home, name)
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, JSON.stringify(e) + '\n')
}

/** Card, history, run file and logs. */
export function removeProcFiles(home: string, name: string): void {
  for (const p of [procCardPath(home, name), procEventsPath(home, name), procRunPath(home, name)]) rmSync(p, { force: true })
  const dir = join(procsDir(home), name)
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
}
