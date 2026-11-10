// Claude Code plan usage, from the official Anthropic plan-usage endpoint only (the same one the app's /usage reads).
// Ported from the old llm-budget tool without its LLM Monitor part: no pace, no projection, no local service.
//
// SECURITY: the token exists only inside readClaudeToken() and the single fetch call. It is never printed, logged,
// cached, put in an error message or passed as a process argument. Errors carry fixed text, the HTTP status and a
// short network error code, never an exception message.
import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { CredentialError, readClaudeToken } from './claude-credential.ts'

export const OFFICIAL_URL = 'https://api.anthropic.com/api/oauth/usage'
const TIMEOUT_MS = 10_000
const CACHE_TTL_MS = 300_000 // the endpoint answers HTTP 429 when asked more often than about every 5 minutes
const NA = 'indisponível'
const NOT_COMPUTED_SHOWN = 8

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => v != null && typeof v === 'object' && !Array.isArray(v)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
/** External text -> printable and short: never trust vendor strings in the terminal. */
const clean = (v: unknown, max = 60): string | null => (typeof v === 'string' && v ? v.replace(/[^\p{L}\p{N}_ .·()-]/gu, '?').slice(0, max) : null)
const pct = (v: number | null): string => (v == null ? NA : `${Number(v.toFixed(1))}%`)
const p2 = (n: number): string => String(n).padStart(2, '0')
const norm = (s: unknown): string => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
const tokens = (s: unknown): string[] => String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)

// ---------- result types ----------
export interface UsageLimit {
  key: string
  label: string
  kind: string | null
  percent: number | null
  resetsAt: string | null
  resetsIn: string | null
  severity: string | null
  isActive: boolean | null
  share: { allowancePctOfWeek: number | null; usedPctOfWeek: number | null } | null
}
export interface ExtraUsage { enabled: boolean | null; monthlyLimit: number | null; usedCredits: number | null; utilization: number | null; currency: string | null }
export interface UsageModel {
  /** Normalized limits as stored in the cache (resetsIn is computed at read time). */
  limits: Array<Omit<UsageLimit, 'resetsIn'> & { scopeName: string | null }>
  notComputed: string[]
  newFields: string[]
  extraUsage: ExtraUsage | null
  keys: string[]
}
export interface UsageReport {
  state: 'ok'
  readAt: string
  source: 'live' | 'cache'
  ageSec: number
  note?: string
  limits: UsageLimit[]
  extraUsage: ExtraUsage | null
  notComputed: string[]
  newFields: string[]
}
export type StopState = 'no-credential' | 'network' | 'format-changed'
export interface UsageFailure { state: StopState; message: string; detail?: string }

class StopError extends Error {
  readonly state: StopState
  readonly detail: string
  readonly status: number | null
  readonly retryAfterSec: number | null
  constructor(state: StopState, detail: string, extra: { status?: number; retryAfterSec?: number | null } = {}) {
    super(state)
    this.state = state
    this.detail = detail
    this.status = extra.status ?? null
    this.retryAfterSec = extra.retryAfterSec ?? null
  }
}

// ---------- time ----------
function when(iso: string | null): string {
  const t = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(t)) return NA
  const d = new Date(t)
  return `${p2(d.getDate())}/${p2(d.getMonth() + 1)} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}
function until(iso: string | null, now: number): string | null {
  const t = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(t)) return null
  const ms = t - now
  if (ms <= 0) return 'já renovou'
  const h = ms / 3_600_000
  if (h < 1) return `em ${Math.max(1, Math.round(ms / 60_000))}min`
  if (h < 48) return `em ${Math.round(h)}h`
  return `em ${Number((h / 24).toFixed(1))}d`
}
const ageText = (sec: number): string => {
  const min = Math.round(sec / 60)
  return sec < 60 ? 'menos de 1 min' : min >= 180 ? `${Math.round(min / 60)} h` : `${min} min`
}

// ---------- normalization (generic: no model or vendor names in the logic) ----------
const STRUCTURAL = new Set(['limits', 'weekly_scoped_shares', 'extra_usage'])
const PHRASES: Record<string, string> = { five_hour: 'Janela de 5 h', seven_day: 'Semana' }
const WORDS: Record<string, string | null> = { weekly: 'Semana', week: 'Semana', all: 'todos os modelos', scoped: null }

function nameOf(v: unknown): string | null {
  if (typeof v === 'string') return clean(v)
  if (Array.isArray(v)) return v.map(nameOf).filter(Boolean).join(', ') || null
  if (isObj(v)) return clean(v.display_name) ?? clean(v.name) ?? null
  return null
}
/** "weekly_all" -> ["Semana", "todos os modelos"]; "five_hour" -> ["Janela de 5 h"]. Unknown tokens stay as they are. */
function humanTokens(s: unknown): string[] {
  const t = tokens(s)
  const out: string[] = []
  for (let i = 0; i < t.length; i++) {
    const pair = `${t[i]}_${t[i + 1]}`
    if (i + 1 < t.length && pair in PHRASES) { out.push(PHRASES[pair]!); i++ }
    else if (t[i]! in WORDS) { const w = WORDS[t[i]!]; if (w) out.push(w) }
    else out.push(t[i]!)
  }
  return out
}
function humanLabel(kind: string | null, group: string | null, scope: string | null, surface: string | null): string {
  const parts: string[] = []
  for (const p of [...humanTokens(group), ...humanTokens(kind)]) if (!parts.includes(p)) parts.push(p)
  const time = new Set(['Semana', PHRASES.five_hour])
  parts.sort((x, y) => Number(time.has(y)) - Number(time.has(x))) // window words first (stable)
  if (scope) parts.push(scope)
  const base = parts.join(' · ') || 'limite'
  return `${base}${surface ? ` (${surface})` : ''}`
}

type NormLimit = UsageModel['limits'][number]

/** Index of the limits[] entry that already represents a top-level window, or -1. */
function representedBy(key: string, w: { percent: number | null; resetsAt: string | null }, limits: NormLimit[], claimed: Set<number>): number {
  const kt = tokens(key)
  let i = limits.findIndex((l, n) => !claimed.has(n) && l.kind && norm(l.kind) === norm(key))
  if (i >= 0) return i
  const same = (l: NormLimit, n: number): boolean => !claimed.has(n) && l.percent === w.percent && l.resetsAt === w.resetsAt
  const words = (l: NormLimit): string[] => tokens(l.scopeName).filter((t) => /[a-z]/.test(t)) // drop pure version numbers
  const scoped = (l: NormLimit): boolean => words(l).length > 0
  const inKey = (l: NormLimit): boolean => words(l).some((t) => kt.includes(t))
  i = limits.findIndex((l, n) => same(l, n) && scoped(l) && inKey(l))
  if (i >= 0) return i
  return limits.some((l) => scoped(l) && inKey(l)) ? -1 : limits.findIndex((l, n) => same(l, n) && !scoped(l))
}

export function normalize(j: Json): UsageModel {
  const limits: NormLimit[] = []
  const shares = Array.isArray(j.weekly_scoped_shares) ? (j.weekly_scoped_shares as unknown[]) : []
  if (Array.isArray(j.limits)) {
    j.limits.forEach((l: unknown, i: number) => {
      if (!isObj(l)) return
      const scope = isObj(l.scope) ? l.scope : {}
      const share = shares.find((s) => isObj(s) && s.limit_index === i) as Json | undefined
      limits.push({
        key: clean(l.kind) ?? `limits[${i}]`,
        label: humanLabel(clean(l.kind), clean(l.group), nameOf(scope.model), nameOf(scope.surface)),
        kind: clean(l.kind),
        scopeName: nameOf(scope.model),
        percent: num(l.percent),
        resetsAt: typeof l.resets_at === 'string' ? l.resets_at : null,
        severity: clean(l.severity, 30),
        isActive: typeof l.is_active === 'boolean' ? l.is_active : null,
        share: share ? { allowancePctOfWeek: num(share.allowance_percent_of_weekly), usedPctOfWeek: num(share.used_percent_of_weekly) } : null,
      })
    })
  }

  const notComputed: string[] = []
  const newFields: string[] = []
  const claimed = new Set<number>()
  const fromLimits = limits.length // only entries from limits[] can absorb a top-level window
  for (const key of Object.keys(j)) {
    if (STRUCTURAL.has(key)) continue
    const v = j[key]
    const k = clean(key, 40) ?? '?'
    if (v === null) notComputed.push(k)
    else if (isObj(v) && 'utilization' in v) {
      const w = { percent: num(v.utilization), resetsAt: typeof v.resets_at === 'string' ? v.resets_at : null }
      if (w.percent == null) notComputed.push(k)
      else {
        const at = representedBy(key, w, limits.slice(0, fromLimits), claimed)
        if (at >= 0) claimed.add(at)
        else limits.push({ key: k, label: humanLabel(k, null, null, null), kind: null, scopeName: null, ...w, severity: null, isActive: null, share: null })
      }
    } else newFields.push(k)
  }

  let extraUsage: ExtraUsage | null = null
  if (isObj(j.extra_usage)) {
    const e = j.extra_usage
    extraUsage = {
      enabled: typeof e.is_enabled === 'boolean' ? e.is_enabled : null,
      monthlyLimit: num(e.monthly_limit),
      usedCredits: num(e.used_credits),
      utilization: num(e.utilization),
      currency: clean(e.currency, 10),
    }
  }
  return { limits, notComputed, newFields, extraUsage, keys: Object.keys(j).slice(0, 40).map((k) => clean(k, 40) ?? '?') }
}

// ---------- cache (the normalized result only: never the token, never raw headers) ----------
/** Per-user cache directory (never the shared temp dir): XDG on Linux, LOCALAPPDATA on Windows, Library/Caches on macOS. */
export function defaultCacheFile(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  const base =
    platform === 'win32' ? env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    : platform === 'darwin' ? join(home, 'Library', 'Caches')
    : env.XDG_CACHE_HOME || join(home, '.cache')
  return join(base, 'tether', 'usage', 'claude-official.json')
}
/** Refuses a symlink and, outside Windows, a file owned by someone else. */
function trustedCacheFile(file: string): boolean {
  const st = lstatSync(file)
  if (st.isSymbolicLink() || !st.isFile()) return false
  if (process.platform !== 'win32' && typeof process.getuid === 'function' && st.uid !== process.getuid()) return false
  return true
}
function readCache(file: string): { at: string; data: UsageModel } | null {
  try {
    if (!trustedCacheFile(file)) return null
    const c = JSON.parse(readFileSync(file, 'utf8')) as Json
    if (isObj(c) && typeof c.at === 'string' && Number.isFinite(Date.parse(c.at)) && isObj(c.data) && Array.isArray(c.data.limits) && c.data.limits.length) {
      return { at: c.at, data: c.data as unknown as UsageModel }
    }
  } catch { /* malformed or absent = no cache */ }
  return null
}
function writeCache(file: string, data: UsageModel, at: string): void {
  const tmp = `${file}.${randomUUID()}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(tmp, JSON.stringify({ at, data }), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    renameSync(tmp, file)
  } catch {
    try { unlinkSync(tmp) } catch { /* a cache failure never fails the tool */ }
  }
}

// ---------- official source ----------
export interface UsageDeps {
  token: () => Promise<string>
  fetch: typeof fetch
  now: () => number
  cacheFile: string
}
export function defaultUsageDeps(): UsageDeps {
  return { token: () => readClaudeToken(), fetch: globalThis.fetch, now: Date.now, cacheFile: defaultCacheFile() }
}

async function fetchOfficial(deps: UsageDeps): Promise<unknown> {
  let token: string
  try {
    token = await deps.token()
  } catch (e) {
    // CredentialError text is fixed; anything else gets a generic line.
    throw new StopError('no-credential', e instanceof CredentialError ? e.message : 'credenciais indisponíveis')
  }
  let res: Response
  try {
    res = await deps.fetch(OFFICIAL_URL, {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'manual', // never forward the bearer to another place
    })
  } catch (e) {
    const err = e as { name?: string; cause?: { code?: unknown } }
    // name/code only: never the message, which a runtime may build from the request
    throw new StopError('network', err?.name === 'TimeoutError' ? 'tempo esgotado' : clean(err?.cause?.code, 30) || 'falha de rede')
  }
  if (!res.ok) {
    const wait = Number(res.headers.get('retry-after'))
    const retryAfterSec = Number.isFinite(wait) && wait > 0 ? Math.ceil(wait) : null
    const hint = res.status === 429 ? `; a fonte oficial pede intervalo entre consultas${retryAfterSec ? ` (tente de novo em ${retryAfterSec}s)` : ''}` : ''
    throw new StopError('network', `HTTP ${res.status}${hint}`, { status: res.status, retryAfterSec })
  }
  try {
    return await res.json()
  } catch {
    throw new StopError('format-changed', 'resposta não é JSON')
  }
}

const STATES: Record<StopState, (d: string) => string> = {
  'no-credential': (d) => `Sem credencial utilizável: ${d || 'token ausente'}. Abra o Claude Code para renovar/entrar.`,
  network: (d) => `Não consegui ler o uso oficial do plano (${d || 'falha de rede'}).`,
  'format-changed': (d) => `O formato da resposta mudou; ${d}. Não vou adivinhar valores; ajuste a ferramenta.`,
}
export const EXIT_CODES: Record<StopState, number> = { 'no-credential': 3, network: 4, 'format-changed': 5 }

/** Reads the usage (cache when fresh, else the official source). Never throws; failures come back as data. */
export async function readClaudeUsage(deps: UsageDeps = defaultUsageDeps(), opts: { fresh?: boolean } = {}): Promise<UsageReport | UsageFailure> {
  const fail = (state: StopState, detail: string): UsageFailure => ({ state, message: STATES[state](detail), ...(detail ? { detail } : {}) })
  const cached = readCache(deps.cacheFile)
  const cacheAgeMs = cached ? deps.now() - Date.parse(cached.at) : Infinity
  let m: UsageModel
  let source: 'live' | 'cache'
  let readAt: string
  let note: string | undefined
  if (cached && !opts.fresh && cacheAgeMs < CACHE_TTL_MS) {
    m = cached.data; source = 'cache'; readAt = cached.at
  } else {
    try {
      const raw = await fetchOfficial(deps)
      if (!isObj(raw)) return fail('format-changed', 'a resposta não é um objeto')
      m = normalize(raw)
      if (!m.limits.length) return fail('format-changed', `nem "limits" nem janelas reconhecíveis; chaves encontradas: ${m.keys.length ? m.keys.join(', ') : '(nenhuma)'}`)
      writeCache(deps.cacheFile, m, new Date(deps.now()).toISOString())
      source = 'live'; readAt = new Date(deps.now()).toISOString()
    } catch (e) {
      if (!(e instanceof StopError)) return fail('network', 'falha inesperada') // never e.message
      if (e.state !== 'network' || !cached) return fail(e.state, e.detail)
      // the provider asked for an interval (or is down): the last reading is better than nothing
      m = cached.data; source = 'cache'; readAt = cached.at
      const ago = ageText(Math.round(cacheAgeMs / 1000))
      note = e.status === 429
        ? `Fonte oficial pediu intervalo entre consultas${e.retryAfterSec ? ` (tente de novo em ${e.retryAfterSec}s)` : ''}; mostrando a leitura de há ${ago}.`
        : `Fonte oficial indisponível agora (${e.detail || 'falha de rede'}); mostrando a leitura de há ${ago}.`
    }
  }
  const now = deps.now()
  return {
    state: 'ok',
    readAt,
    source,
    ageSec: Math.max(0, Math.round((now - Date.parse(readAt)) / 1000)),
    ...(note ? { note } : {}),
    limits: m.limits.map((l) => ({
      key: l.key, label: l.label, kind: l.kind, percent: l.percent, resetsAt: l.resetsAt, resetsIn: until(l.resetsAt, now),
      severity: l.severity, isActive: l.isActive, share: l.share,
    })),
    extraUsage: m.extraUsage,
    notComputed: m.notComputed,
    newFields: m.newFields,
  }
}

export function renderUsageText(m: UsageReport): string {
  const L: string[] = []
  const lido = m.source === 'cache' ? `lido às ${when(m.readAt)} (cache, há ${ageText(m.ageSec)})` : `lido ${when(m.readAt)}`
  L.push(`Uso de LLM — Claude Code, plano oficial, ${lido} (fonte: uso oficial do plano)`)
  if (m.note) L.push(m.note)
  for (const l of m.limits) {
    const bits = [`${l.label}: ${pct(l.percent)} usado`]
    if (l.resetsAt) bits.push(`renova ${when(l.resetsAt)}${l.resetsIn ? ` (${l.resetsIn})` : ''}`)
    if (l.severity) bits.push(`severidade ${l.severity}`)
    if (l.isActive === false) bits.push('inativo')
    if (l.share) bits.push(`teto: até ${pct(l.share.allowancePctOfWeek)} da semana; já usou ${pct(l.share.usedPctOfWeek)} da semana`)
    L.push(`  - ${bits.join(' | ')}`)
  }
  const e = m.extraUsage
  if (e) {
    const cur = e.currency ? ` ${e.currency}` : ''
    const bits = [`Créditos de uso extra: ${e.enabled == null ? NA : e.enabled ? 'ligado' : 'desligado'}`]
    if (e.monthlyLimit != null) bits.push(`teto ${e.monthlyLimit}${cur}`)
    if (e.usedCredits != null) bits.push(`usado ${e.usedCredits}${cur}${e.utilization != null ? ` (${pct(e.utilization)})` : ''}`)
    if (e.monthlyLimit == null && e.usedCredits == null && cur) bits.push(`moeda${cur}`)
    L.push(bits.join(' | '))
  }
  if (m.notComputed.length) {
    const more = m.notComputed.length > NOT_COMPUTED_SHOWN ? ` e mais ${m.notComputed.length - NOT_COMPUTED_SHOWN}` : ''
    L.push(`Observado: janelas não computadas pelo fornecedor agora: ${m.notComputed.slice(0, NOT_COMPUTED_SHOWN).join(', ')}${more} (regras e promoções mudam; não é erro).`)
  }
  if (m.newFields.length) L.push(`Campos novos observados: ${m.newFields.join(', ')}`)
  return L.join('\n')
}
