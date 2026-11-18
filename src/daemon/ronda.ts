// The ronda: tether's own clock that nudges an idle agent, one per slot. The agent assembles it (interval, an extra
// nudge, a stop criterion) through `tether ronda`; tetherd keeps it in <home>/slots/<id>.ronda.json (so it survives the
// agent's restart and the daemon's) and, when it is due and the agent is idle, sends the nudge through the ronda's channel
// (ronda-channel.ts): a message the agent's CLI takes as a turn of its own, never keys typed into the terminal, so the user's
// draft is never touched. Pure model and persistence here; the timer lives in server.ts.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { slotRondaPath } from '../core/paths.ts'

export interface Ronda {
  v: 1
  intervalMs: number
  /** Extra text appended to the default nudge (assembled by the agent). */
  nudge?: string
  /** Stop criterion: with one, `off` asks the agent whether it was met before switching off (unless forced). */
  criterion?: string
  createdAt: string
  /** ISO: when the next nudge is due. */
  nextAt: string
  /** ISO: the last nudge typed. */
  lastAt?: string
}

export const RONDA_DEFAULT_INTERVAL = '20m'
export const RONDA_DEFAULT_NUDGE = '[ronda] Ronda de rotina. Olhe para o seu trabalho e para os seus subagentes, e siga. Se o trabalho já acabou, diga isso e desligue esta ronda.'
/** Seconds are for tests only: the daemon accepts them when TETHER_RONDA_TEST_SECONDS=1 (never in the skill). */
export const ENV_RONDA_TEST_SECONDS = 'TETHER_RONDA_TEST_SECONDS'
const MIN_MS = 60_000
const MAX_MS = 24 * 60 * 60_000
const TEXT_MAX = 500

export class RondaError extends Error {}

/** `20m`, `20min`, `1h`, `1h30m`; `45s` only with allowSeconds. Throws RondaError with a Portuguese message. */
export function parseInterval(raw: string, allowSeconds = false): number {
  const s = raw.trim().toLowerCase().replace(/\s+/g, '')
  const m = /^(?:(\d+)(?:h|hr|hrs))?(?:(\d+)(?:m|min|mins))?(?:(\d+)(?:s|seg))?$/.exec(s)
  if (!s || !m || (!m[1] && !m[2] && !m[3])) throw new RondaError(`intervalo inválido: "${raw}" (use minutos ou horas, ex.: 10m, 1h)`)
  if (m[3] && !allowSeconds) throw new RondaError(`intervalo inválido: "${raw}" (use minutos ou horas, ex.: 10m, 1h)`)
  const ms = (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60_000 + Number(m[3] ?? 0) * 1000
  if (ms > MAX_MS) throw new RondaError('intervalo longo demais (máximo 24h)')
  if (ms < (allowSeconds ? 1000 : MIN_MS)) throw new RondaError('intervalo curto demais (mínimo 1m)')
  return ms
}

export function formatInterval(ms: number): string {
  if (ms % 60_000 !== 0) return `${Math.round(ms / 1000)}s`
  const min = ms / 60_000
  const h = Math.floor(min / 60)
  const rest = min % 60
  return h ? (rest ? `${h}h${rest}m` : `${h}h`) : `${min}m`
}

/** One line, no control characters (a newline would submit early), cut to a sane length. */
export function flatText(text: string | undefined): string {
  const flat = (text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return flat.length > TEXT_MAX ? flat.slice(0, TEXT_MAX).trimEnd() + '…' : flat
}

/** The nudge: the default plus the assembled extra. */
export function buildNudgeText(r: Pick<Ronda, 'nudge'>): string {
  const extra = flatText(r.nudge)
  return extra ? `${RONDA_DEFAULT_NUDGE} ${extra}` : RONDA_DEFAULT_NUDGE
}

/** What goes through the channel: the nudge, then the stop criterion when there is one. */
export function buildChannelText(r: Pick<Ronda, 'nudge' | 'criterion'>): string {
  const criterion = flatText(r.criterion)
  return criterion ? `${buildNudgeText(r)} Critério de parada: ${criterion}` : buildNudgeText(r)
}

/** The stimulus `off` answers when the ronda has a criterion and the call was not forced. */
export function criterionStimulus(criterion: string): string {
  return `Esta ronda tem um critério de parada: ${criterion}. Você cumpriu? Se não cumpriu, não deveria cumprir antes de parar? Para parar mesmo assim, use --off --force.`
}

export interface RondaChange {
  /** Interval text as typed (`10m`); undefined keeps the current one (20m for a new ronda). */
  interval?: string
  /** undefined keeps; '' clears. */
  nudge?: string
  criterion?: string
}

export type RondaOutcome = 'created' | 'updated' | 'unchanged'

/** Applies a `set` to the current ronda (or none). Throws RondaError on a bad interval. */
export function applyChange(cur: Ronda | undefined, change: RondaChange, now: number, allowSeconds = false): { ronda: Ronda; outcome: RondaOutcome } {
  const intervalMs = change.interval !== undefined ? parseInterval(change.interval, allowSeconds) : cur?.intervalMs ?? parseInterval(RONDA_DEFAULT_INTERVAL)
  const iso = new Date(now).toISOString()
  const next: Ronda = cur ? { ...cur } : { v: 1, intervalMs, createdAt: iso, nextAt: new Date(now + intervalMs).toISOString() }
  let changed = !cur
  if (cur && intervalMs !== cur.intervalMs) {
    next.intervalMs = intervalMs
    next.nextAt = new Date(now + intervalMs).toISOString()
    changed = true
  }
  for (const key of ['nudge', 'criterion'] as const) {
    const v = change[key]
    if (v === undefined) continue
    const flat = flatText(v)
    if ((cur?.[key] ?? '') === flat) continue
    if (flat) next[key] = flat
    else delete next[key]
    changed = true
  }
  return { ronda: next, outcome: !cur ? 'created' : changed ? 'updated' : 'unchanged' }
}

export function isRonda(x: unknown): x is Ronda {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false
  const r = x as Record<string, unknown>
  return r.v === 1 && typeof r.intervalMs === 'number' && r.intervalMs > 0 && typeof r.nextAt === 'string' && !Number.isNaN(Date.parse(r.nextAt))
    && typeof r.createdAt === 'string' && (r.nudge === undefined || typeof r.nudge === 'string') && (r.criterion === undefined || typeof r.criterion === 'string')
}

/** A ronda file's text parsed; undefined when it is not one. The read itself goes through the executor (server.ts). */
export function parseRonda(text: string): Ronda | undefined {
  try {
    const x: unknown = JSON.parse(text)
    return isRonda(x) ? x : undefined
  } catch { return undefined }
}

/** Atomic (temp + rename). */
export function writeRonda(home: string, slotId: string, r: Ronda): void {
  const path = slotRondaPath(home, slotId)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(r, null, 2) + '\n')
  renameSync(tmp, path)
}

export function clearRonda(home: string, slotId: string): void {
  rmSync(slotRondaPath(home, slotId), { force: true })
}
