// Background processes (tether proc): the model, apart from the wire. Card (the recipe), history (append-only
// events, tetherd its only writer), state derived from history + run.json + what the host lists, the secret mask
// and the Portuguese texts. tether never restarts anything by itself and never kills by name: see proc-manager.ts.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { procAdoptPath, procCardPath, procEventsPath, procRunPath, procsDir, procUsesPath } from '../core/paths.ts'
import { writeJsonAtomic, type RunFile } from '../procd/protocol.ts'
import { actionText, useText } from './proc-texts.ts'

/** Lower case only: the name is a file name, and Windows would fold `Web` and `web` into one card. */
export const PROC_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
export const DEFAULT_STOP_GRACE_MS = 5_000
const SECRET_NAME = /KEY|TOKEN|SECRET|PASS|CREDENTIAL/i
export const SECRET_MASK = '•••'
/** How many events `proc-info` returns. */
export const INFO_EVENTS = 20

export type ProcErrorCode = 'bad-adopt' | 'unknown-proc' | 'proc-running' | 'proc-not-stopped' | 'proc-host' | 'proc-in-use' | 'port-busy' | 'bad-request'

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

export type ProcEventKind =
  | 'registered' | 'recipe-changed' | 'started' | 'adopted' | 'start-failed' | 'stop-requested' | 'restart-requested' | 'ended' | 'forgotten'
  | 'use-declared' | 'use-released' | 'use-expired' | 'refused-in-use' | 'forced'
/** `external`: an adopted process vanished (or is no longer the recorded one): its exit code is unknown. */
export type EndCause = 'requested' | 'own' | 'host' | 'external'
/** Why a use ended before its time: its author released it, or the author's panel left (exited or was forgotten). */
export type UseEndCause = 'released' | 'panel-gone'
/** The acts a declared use protects against. */
export type GuardedAction = 'stop' | 'restart' | 'forget'

/** A declared use: someone depends on the process until `until`, for `purpose`. */
export interface ProcUse {
  /** `slot:<slotId>` (a panel), `ext:<label|user>` (outside tether), `app` (the person). */
  key: string
  by: ProcAuthor
  until: string
  purpose: string
  declaredAt: string
}

/** What a use looks like outside tetherd (ProcState, events). */
export type UseView = Pick<ProcUse, 'by' | 'until' | 'purpose'>

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
  /** ended: why the run ended; use-released: why the use ended. */
  cause?: EndCause | UseEndCause
  message?: string
  /** use-declared / use-expired. */
  until?: string
  purpose?: string
  /** refused-in-use / forced. */
  action?: GuardedAction
  /** refused-in-use: the uses that refused it. */
  uses?: UseView[]
  /** forced: the uses it went over. */
  over?: UseView[]
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
  /** The declared ports, probed now. */
  ports?: { port: number; listening: boolean }[]
  /** Working set of the process tree, from the last memory sample (live processes only). */
  memoryMB?: number
  /** Uses in force. */
  uses?: UseView[]
  /** Runs outside tether and was adopted (`pid` is the adopted one; no run, no log, no exit code). */
  external?: boolean
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
    if ((e.kind === 'started' || e.kind === 'adopted') && typeof e.run === 'number') {
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

export function deriveState(card: ProcCard, events: ProcEvent[], live: { runFile?: RunFile; stopping?: boolean; seenRun?: number; adoptedStartedAt?: string }): ProcState {
  const r = replay(events)
  const s: ProcState = { name: card.name, card: maskCard(card), status: 'stopped' }
  if (r.failed) {
    s.status = 'failed'
    s.error = r.failed.message ?? 'não subiu'
    return s
  }
  if (!r.started) return s
  const run = r.started.run!
  const adopted = r.started.kind === 'adopted'
  if (!adopted) s.run = run
  if (r.started.by) s.startedBy = r.started.by
  if (!r.ended) {
    s.status = live.stopping ? 'stopping' : 'running'
    if (typeof r.started.pid === 'number') s.pid = r.started.pid
    if (adopted) {
      s.external = true
      if (live.adoptedStartedAt) s.startedAt = live.adoptedStartedAt
    } else if (live.runFile?.run === run) s.startedAt = live.runFile.startedAt
    return s
  }
  const end = r.ended
  s.exit = { ...(typeof end.code === 'number' ? { code: end.code } : {}), at: end.at ?? end.ts, cause: (end.cause as EndCause | undefined) ?? 'own' }
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

// ---- texts (Portuguese): in proc-texts.ts, free of node imports so the app's renderer shows the same phrases ----------

export { actionText, authorText, clockTime, eventText, historyLine, statusText, useText } from './proc-texts.ts'

// ---- uses ---------------------------------------------------------------------------------------

export const USE_DEFAULT = '15m'
export const USE_MAX_MS = 60 * 60_000
export const PURPOSE_MAX = 200
/** --wait: default and ceiling. */
export const WAIT_DEFAULT_MS = 60_000
export const WAIT_MAX_MS = 5 * 60_000

/** Whose a use is: the panel, the outside label/user, or the person in the app. */
export function useKey(by: ProcAuthor): string {
  if (by.kind === 'app') return 'app'
  if ((by.kind === 'agent' || by.kind === 'shell') && by.slotId) return `slot:${by.slotId}`
  return `ext:${by.label ?? by.user ?? 'externo'}`
}

export function useView(u: ProcUse): UseView {
  return { by: u.by, until: u.until, purpose: u.purpose }
}

/** Uses in force at `now`. */
export function liveUses(uses: ProcUse[], now = Date.now()): ProcUse[] {
  return uses.filter((u) => Date.parse(u.until) > now)
}

/** Uses in force that are not `key`'s. */
export function othersUses(uses: ProcUse[], key: string, now = Date.now()): ProcUse[] {
  return liveUses(uses, now).filter((u) => u.key !== key)
}

/**
 * The board an act refused by uses answers with (stdout of the CLI, exit 3): who uses it, until when, what for,
 * and what can be done.
 */
export function inUseBoard(name: string, action: GuardedAction, uses: UseView[], waitedMs?: number): string {
  const verb = actionText(action)
  const cmd = action === 'forget' ? 'rm' : action
  const lines = [
    waitedMs !== undefined
      ? `${name} continua em uso depois de ${Math.round(waitedMs / 1000)} s de espera; nada foi feito.`
      : `${name} está em uso; não vou ${verb} agora.`,
    ...uses.map((u) => `  - ${useText(u)}`),
    'Opções:',
    `  - esperar a liberação: tether proc ${cmd} ${name} --wait [tempo] (padrão 60s, até 5m)`,
    `  - ${verb} mesmo assim: tether proc ${cmd} ${name} --force "motivo" (o motivo chega a quem usa)`,
    '  - ou combinar com quem usa e tentar depois.',
  ]
  return lines.join('\n')
}

export function readUses(home: string, name: string): ProcUse[] {
  try {
    const list = JSON.parse(readFileSync(procUsesPath(home, name), 'utf8')) as ProcUse[]
    return Array.isArray(list) ? list.filter((u) => u && typeof u.key === 'string' && typeof u.until === 'string' && u.by && typeof u.purpose === 'string') : []
  } catch {
    return []
  }
}

export function writeUses(home: string, name: string, uses: ProcUse[]): void {
  if (!uses.length) { rmSync(procUsesPath(home, name), { force: true }); return }
  writeJsonAtomic(procUsesPath(home, name), uses)
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

/** The identity of an adopted process, written when it was adopted: pid + creation time. */
export interface AdoptFile {
  v: 1
  pid: number
  startedAt: string
  adoptedAt: string
}

export function readAdopt(home: string, name: string): AdoptFile | undefined {
  try {
    const a = JSON.parse(readFileSync(procAdoptPath(home, name), 'utf8')) as AdoptFile
    return a && a.v === 1 && Number.isInteger(a.pid) && typeof a.startedAt === 'string' ? a : undefined
  } catch {
    return undefined
  }
}

export function writeAdopt(home: string, name: string, a: AdoptFile): void {
  writeJsonAtomic(procAdoptPath(home, name), a)
}

export function removeAdopt(home: string, name: string): void {
  rmSync(procAdoptPath(home, name), { force: true })
}

/** Card, history, run file, uses, adoption and logs. */
export function removeProcFiles(home: string, name: string): void {
  for (const p of [procCardPath(home, name), procEventsPath(home, name), procRunPath(home, name), procUsesPath(home, name), procAdoptPath(home, name)]) rmSync(p, { force: true })
  const dir = join(procsDir(home), name)
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
}
