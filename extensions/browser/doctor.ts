// `tether doctor` for the browser (tether-bridge-debug T2): what can be checked without opening a tab. All from files and
// one loopback request, no key used:
//   - the browser's process: <home>/browser/endpoint.json ({v, port, pid, instance}) present and its pid alive (the gate
//     lives in the tether app's process; the file goes when that process stops cleanly, a stale one names a dead pid);
//   - the gatekeeper: GET /tether/identity on 127.0.0.1:<port> answers with the file's instance (no key, by design);
//   - the trace: <home>/browser/mcp.log writable, the time of the last call it records, and the debug dumps' count;
//   - the calls in flight: derived from mcp.log, the `call_started` lines of the newest writer (pid) with no
//     `call_finished`. The vendored server keeps the true table in memory only (WebDiagnose); this is the file's view.
// Electron-free and injectable (the unit test drives it with temp files and a fake fetch). Never reads keys/.
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DaemonCheck } from '../../src/daemon/ext-api.ts'
import { folderCount, parseLine, tailLines, timeOf } from '../../src/trace/timeline.ts'
import { endpointFileOf } from './agents.ts'
import { browserTraceFileOf } from './trace-source.ts'

export interface BrowserDoctorDeps {
  home: string
  /** Whether a pid is alive (default: process.kill(pid, 0)). */
  alive?(pid: number): boolean
  fetch?: typeof fetch
  now?(): number
}

interface Endpoint { port: number; pid: number; instance: string }

/** endpoint.json as the gate writes it, or undefined (absent, unreadable, or not that shape). */
export function readEndpoint(home: string): Endpoint | undefined {
  try {
    const v = JSON.parse(readFileSync(endpointFileOf(home), 'utf8')) as Partial<Endpoint>
    return typeof v.port === 'number' && typeof v.pid === 'number' && typeof v.instance === 'string' ? { port: v.port, pid: v.pid, instance: v.instance } : undefined
  } catch { return undefined }
}

/** <home>/browser/debug: the vendored server's failure dumps in debug mode, one folder per call id (it keeps the latest 50). */
export const dumpDirOf = (home: string): string => join(dirname(browserTraceFileOf(home)), 'debug')

/** How many dump folders there are (0 without the folder). */
export const dumpCount = (home: string): number => folderCount(dumpDirOf(home))

const defaultAlive =(pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

/** "agora", "há 8 s", "há 3 min", "há 2 h", "há 3 d". */
export function agoText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 3) return 'agora'
  if (s < 60) return `há ${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `há ${m} min`
  const h = Math.round(m / 60)
  return h < 48 ? `há ${h} h` : `há ${Math.round(h / 24)} d`
}

/** The calls of mcp.log's tail: the last one recorded, and those of the newest writer that never finished. */
export function callsOfTail(lines: readonly string[]): { last?: number; open: Array<{ call: string; tool?: string; at: number }> } {
  let last: number | undefined
  let pid: unknown
  const open = new Map<string, { call: string; tool?: string; at: number }>()
  for (const line of lines) {
    const raw = parseLine(line)
    if (!raw || (raw.ev !== 'call_started' && raw.ev !== 'call_finished') || typeof raw.call !== 'string') continue
    const at = timeOf(raw.t)
    if (!Number.isFinite(at)) continue
    last = Math.max(last ?? at, at)
    // A newer writer (the tetherd restarted): what the old one left open died with it.
    if (raw.pid !== pid) { pid = raw.pid; open.clear() }
    if (raw.ev === 'call_started') open.set(raw.call, { call: raw.call, ...(typeof raw.tool === 'string' ? { tool: raw.tool } : {}), at })
    else open.delete(raw.call)
  }
  return { ...(last !== undefined ? { last } : {}), open: [...open.values()].sort((a, b) => a.at - b.at) }
}

export function browserChecks(deps: BrowserDoctorDeps): Array<() => Promise<DaemonCheck>> {
  const alive = deps.alive ?? defaultAlive
  const now = (): number => (deps.now ?? Date.now)()
  const doFetch = deps.fetch ?? fetch
  const traceFile = browserTraceFileOf(deps.home)
  return [
    async () => {
      const name = 'processo do navegador do tether'
      const ep = readEndpoint(deps.home)
      if (!ep) return { level: 'AVISO', name, detail: `${endpointFileOf(deps.home)} ausente ou ilegível: o app do tether não está aberto, ou o porteiro não abriu`, hint: 'abra o tether; se ele já está aberto, veja tether-app.log' }
      let age = ''
      try { age = `, porteiro aberto ${agoText(now() - statSync(endpointFileOf(deps.home)).mtimeMs)}` } catch { /* raced away */ }
      if (!alive(ep.pid)) return { level: 'AVISO', name, detail: `endpoint.json aponta o pid ${ep.pid}, que não está rodando (arquivo de um app que caiu)`, hint: 'abra o tether de novo: o porteiro regrava o arquivo ao abrir' }
      return { level: 'OK', name, detail: `pid ${ep.pid} de pé${age}` }
    },
    async () => {
      const name = 'porteiro do navegador'
      const ep = readEndpoint(deps.home)
      if (!ep) return { level: 'OK', name, detail: 'sem endpoint.json, nada a perguntar (veja a linha do processo)' }
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), 1500)
      try {
        const r = await doFetch(`http://127.0.0.1:${ep.port}/tether/identity`, { signal: ctl.signal, headers: { connection: 'close' } })
        const body = r.ok ? await r.json() as { instance?: unknown } : undefined
        if (body?.instance === ep.instance) return { level: 'OK', name, detail: 'responde à identidade (só 127.0.0.1)' }
        return { level: 'AVISO', name, detail: r.ok ? 'quem responde na porta não é o porteiro deste endpoint.json' : `respondeu ${r.status} à identidade`, hint: 'reabra o tether' }
      } catch {
        return { level: 'AVISO', name, detail: 'não responde na porta do endpoint.json', hint: 'o app do tether pode estar travado ou fechado; veja tether-app.log' }
      } finally { clearTimeout(timer) }
    },
    async () => {
      const name = 'rastro do navegador (mcp.log)'
      const target = existsSync(traceFile) ? traceFile : dirname(traceFile)
      try { accessSync(target, constants.W_OK) } catch {
        return existsSync(target) ? { level: 'AVISO', name, detail: `${traceFile} sem permissão de escrita`, hint: 'o rastro das chamadas se perde; confira as permissões da pasta' }
          : { level: 'OK', name, detail: 'nenhuma chamada registrada ainda (a pasta nasce com o primeiro agente)' }
      }
      const { last } = callsOfTail(tailLines(traceFile))
      const dumps = dumpCount(deps.home)
      const dumpText = dumps ? `; ${dumps} despejo${dumps === 1 ? '' : 's'} de falha em ${dumpDirOf(deps.home)}` : ''
      return { level: 'OK', name, detail: `${traceFile} gravável; ${last === undefined ? 'nenhuma chamada registrada' : `última chamada ${agoText(now() - last)}`}${dumpText}` }
    },
    async () => {
      const name = 'chamadas em voo no navegador'
      const { open } = callsOfTail(tailLines(traceFile))
      if (!open.length) return { level: 'OK', name, detail: 'nenhuma (pelo mcp.log)' }
      const oldest = open[0]!
      const list = open.slice(0, 5).map(c => `${c.call} ${c.tool ?? '?'} ${agoText(now() - c.at)}`).join('; ')
      return { level: 'OK', name, detail: `${open.length} pelo mcp.log, sem fim registrado: ${list}${open.length > 5 ? '; …' : ''}`, hint: `a mais velha começou ${agoText(now() - oldest.at)}; veja tether trace ${oldest.call}` }
    },
  ]
}
