// Main's side of the status icon (F7 C4, design §5 "Dados"): GET /status on the bridge daemon every 15 s for the badge,
// every 2 s while the popover is open, plus the actions the popover offers (pause/resume, release every client). The
// bearer is the home's api.key, read at every call (the key may rotate) and never logged, never put in the snapshot.
// Electron-free and injectable (fetch, timers, the files), so the unit test drives it with a fake daemon.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { releaseClient } from './agents.ts'
import { folderCount } from '../../src/trace/timeline.ts'
import type { DaemonCheck } from '../../src/daemon/ext-api.ts'
import { debugOf, EMPTY_SNAPSHOT, pendingOf, reduceStatus, type DaemonReach, type StatusSnapshot } from './status.ts'

export const POLL_IDLE_MS = 15_000
export const POLL_OPEN_MS = 2_000
const TIMEOUT_MS = 2_500

export type ActionOutcome = { ok: true } | { ok: false; message: string }

export interface StatusPollerDeps {
  port: number
  /** <TETHER_HOME>/bridge: api.key lives here. */
  bridgeHome: string
  /** The versions and the C5 marker, read at every poll (cheap; the files are small). */
  version(): StatusSnapshot['version']
  /** The browser "Opções da extensão" opens in, if any. */
  options?(): StatusSnapshot['options']
  onChange(snapshot: StatusSnapshot): void
  log(msg: string): void
  /** Injected in the unit test. */
  fetch?: typeof fetch
  now?(): number
  idleMs?: number
  openMs?: number
  setTimer?(fn: () => void, ms: number): unknown
  clearTimer?(t: unknown): void
}

export interface StatusPoller {
  start(): void
  stop(): void
  /** The popover opened (fast cadence, one poll at once) or closed. */
  watch(open: boolean): void
  /** The last snapshot taken. */
  current(): StatusSnapshot
  /** A poll now; resolves with the snapshot. */
  refresh(): Promise<StatusSnapshot>
  pause(on: boolean): Promise<ActionOutcome>
  releaseAll(): Promise<ActionOutcome>
}

/** api.key of the bridge home (never logged, never returned past the request). */
const readApiKey = (bridgeHome: string): string | undefined => {
  try { return readFileSync(join(bridgeHome, 'api.key'), 'utf8').trim() || undefined } catch { return undefined }
}

/** `tether doctor`: the calls in flight at the bridge daemon now (GET /status `pending`), with their ids and ages. */
export async function bridgeInFlightCheck(deps: { port: number; bridgeHome: string; fetch?: typeof fetch }): Promise<DaemonCheck> {
  const name = 'chamadas em voo no bridge'
  const key = readApiKey(deps.bridgeHome)
  if (!key) return { level: 'OK', name, detail: 'instalação sem api.key: nada a perguntar' }
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    const r = await (deps.fetch ?? fetch)(`http://127.0.0.1:${deps.port}/status`, { signal: ctl.signal, headers: { authorization: `Bearer ${key}`, connection: 'close' } })
    if (!r.ok) return { level: 'AVISO', name, detail: `o daemon respondeu ${r.status} ao /status` }
    const pending = pendingOf(await r.json())
    if (!pending.length) return { level: 'OK', name, detail: 'nenhuma' }
    const secs = (ms: number): string => `${Math.round(ms / 1000)} s`
    const list = pending.slice(0, 5).map(p => `${p.callId} ${p.tool} há ${secs(p.ageMs)} (${p.browser})`).join('; ')
    return { level: 'OK', name, detail: `${pending.length}: ${list}${pending.length > 5 ? '; …' : ''}`, hint: `veja tether trace ${pending[0]!.callId}` }
  } catch {
    return { level: 'OK', name, detail: 'daemon sem resposta: nada em voo nele' }
  } finally { clearTimeout(t) }
}

/** `tether doctor`: the debug mode as the bridge daemon reports it (GET /status `browsers[].debug`), set in the extension's options page. */
export async function bridgeDebugStatusCheck(deps: { port: number; bridgeHome: string; displayName: string; dumpDir?: string; fetch?: typeof fetch }): Promise<DaemonCheck> {
  const name = `depuração do ${deps.displayName}`
  const dumps = deps.dumpDir ? folderCount(deps.dumpDir) : 0
  const dumpNote = dumps ? `; ${dumps} despejo${dumps === 1 ? '' : 's'} de falha em ${deps.dumpDir}` : ''
  const off: DaemonCheck = { level: 'OK', name, detail: `desligada${dumpNote}` }
  const key = readApiKey(deps.bridgeHome)
  if (!key) return off
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    const r = await (deps.fetch ?? fetch)(`http://127.0.0.1:${deps.port}/status`, { signal: ctl.signal, headers: { authorization: `Bearer ${key}`, connection: 'close' } })
    if (!r.ok) return off
    const on = debugOf(await r.json())
    if (!on.length) return off
    const deadline = (ms: number | null): string => ms === null ? 'sem prazo' : `${Math.round(ms / 1000)} s`
    const list = on.map(d => `${d.browser}, prazo de cada chamada: ${deadline(d.callTimeoutMs)}`).join('; ')
    return { level: 'AVISO', name, detail: `ligada em ${list}${dumpNote}`, hint: 'desligue nas opções da extensão no navegador quando terminar de investigar' }
  } catch {
    return off
  } finally { clearTimeout(t) }
}

export function createStatusPoller(deps: StatusPollerDeps): StatusPoller {
  const doFetch = deps.fetch ?? fetch
  const now = deps.now ?? (() => Date.now())
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((t: unknown): void => clearTimeout(t as ReturnType<typeof setTimeout>))
  let snapshot: StatusSnapshot = { ...EMPTY_SNAPSHOT, version: deps.version() }
  let everUp = false
  let pauseSupported = true
  let open = false
  let running = false
  let timer: unknown
  let inflight: Promise<StatusSnapshot> | undefined

  const readKey = (): string | undefined => readApiKey(deps.bridgeHome)

  const call = async (method: 'GET' | 'POST', path: string, key: string): Promise<Response> => {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), TIMEOUT_MS)
    try {
      return await doFetch(`http://127.0.0.1:${deps.port}${path}`, { method, signal: ctl.signal, headers: { authorization: `Bearer ${key}`, connection: 'close' } })
    } finally { clearTimeout(t) }
  }

  const take = async (): Promise<StatusSnapshot> => {
    const key = readKey()
    let daemon: DaemonReach = 'down'
    let reduced: ReturnType<typeof reduceStatus> = { paused: false, debug: false, browsers: [], agents: [] }
    if (!key) daemon = 'no-key'
    else {
      try {
        const r = await call('GET', '/status', key)
        if (r.status === 401 || r.status === 403) { daemon = 'refused'; await r.arrayBuffer().catch(() => undefined) }
        else if (!r.ok) { daemon = 'down'; await r.arrayBuffer().catch(() => undefined) }
        else { reduced = reduceStatus(await r.json().catch(() => undefined)); daemon = 'up' }
      } catch { daemon = 'down' }
    }
    if (daemon === 'up') everUp = true
    const next: StatusSnapshot = { at: now(), daemon, everUp, pauseSupported, ...reduced, version: deps.version(), ...(deps.options?.() ? { options: deps.options() } : {}) }
    const changed = JSON.stringify({ ...snapshot, at: 0 }) !== JSON.stringify({ ...next, at: 0 })
    snapshot = next
    if (changed) deps.onChange(snapshot)
    return snapshot
  }

  const schedule = (): void => {
    if (timer !== undefined) { clearTimer(timer); timer = undefined }
    if (!running) return
    timer = setTimer(() => { timer = undefined; void refresh().finally(schedule) }, open ? (deps.openMs ?? POLL_OPEN_MS) : (deps.idleMs ?? POLL_IDLE_MS))
  }

  const refresh = (): Promise<StatusSnapshot> => (inflight ??= take().finally(() => { inflight = undefined }))

  const act = async (what: string, path: string): Promise<ActionOutcome> => {
    const key = readKey()
    if (!key) return { ok: false, message: 'A instalação do bridge ainda não tem chave; abra o tether de novo.' }
    try {
      const r = await call('POST', path, key)
      await r.arrayBuffer().catch(() => undefined)
      if (r.ok) { deps.log(`${what}: ok`); return { ok: true } }
      deps.log(`${what}: o daemon respondeu ${r.status}`)
      if (r.status === 404) return { ok: false, message: 'Pausar está indisponível nesta versão do bridge; o próximo "npm run bridge:build" traz o recurso.' }
      if (r.status === 401 || r.status === 403) return { ok: false, message: 'O daemon recusou a chave do tether.' }
      return { ok: false, message: `O daemon respondeu ${r.status}.` }
    } catch {
      deps.log(`${what}: daemon sem resposta na porta ${deps.port}`)
      return { ok: false, message: 'O daemon do bridge não respondeu.' }
    }
  }

  return {
    start: () => { if (running) return; running = true; void refresh().finally(schedule) },
    stop: () => { running = false; if (timer !== undefined) { clearTimer(timer); timer = undefined } },
    watch: o => { if (open === o) return; open = o; if (open) void refresh().finally(schedule); else schedule() },
    current: () => snapshot,
    refresh,
    pause: async on => {
      const r = await act(on ? 'pausar' : 'retomar', on ? '/pause' : '/resume')
      if (!r.ok && /indisponível/.test(r.message)) { pauseSupported = false }
      await refresh().catch(() => undefined)
      return r
    },
    releaseAll: async () => {
      const ids = snapshot.agents.map(a => a.clientId)
      if (!ids.length) return { ok: true }
      const results = await Promise.all(ids.map(id => releaseClient({ port: deps.port, bridgeHome: deps.bridgeHome, log: deps.log, fetch: doFetch }, id)))
      await refresh().catch(() => undefined)
      const bad = results.filter(r => r !== 'released')
      if (!bad.length) return { ok: true }
      if (bad.includes('unreachable')) return { ok: false, message: 'O daemon do bridge não respondeu.' }
      if (bad.includes('no-key')) return { ok: false, message: 'A instalação do bridge ainda não tem chave.' }
      return { ok: false, message: `O daemon recusou soltar ${bad.length} de ${ids.length} agente(s).` }
    },
  }
}

/** The installed folder exists (for the version line). */
export const installedHere = (currentDir: string): boolean => existsSync(join(currentDir, 'manifest.json'))
