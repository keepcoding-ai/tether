// `tether trace`: one call of the agents' browser tools told as a single timeline, from every log that cites its call id
// (tether-bridge-debug T2). The bases write JSON lines with a call id that crosses every hop (the bridge's shell, daemon and
// extension; the browser's server); this file is the generic engine: each daemon extension that owns such logs contributes
// a TraceSource (TetherDaemon.traces), naming its files and turning one raw line into a TraceEntry. The engine only reads.
//   - Files are read line by line in a stream (a call search) or by their tail (the doctor), never loaded whole; the rotated
//     generations (`<file>.1` … `<file>.5`) are read too. A missing file is no error; a line that is not JSON is skipped.
//   - Order: by the entry's time, then by the order read (a tie keeps the file's order).
//   - `--last`: the latest calls that ended in error, one per call id (the outermost record wins: the shell over the daemon).
//   - `--replay`: the call as it was asked (server, tool, arguments), from the debug trace's `call_started`; without recorded
//     arguments, or with a `[redacted]` value, it says so and invents nothing.
import { closeSync, createReadStream, existsSync, fstatSync, openSync, readSync } from 'node:fs'
import { createInterface } from 'node:readline'

/** One log line, as the timeline shows it. `at` is epoch ms; `raw` is the line as written. */
export interface TraceEntry {
  at: number
  /** Who wrote it, in the person's words: "casca", "daemon", "extensão", "browser". */
  origin: string
  /** The MCP server of the tool: "tether-bridge" or "tether-browser". */
  server: string
  event: string
  callId?: string
  tool?: string
  /** The stage (a call's step) or the CDP method of the line. */
  step?: string
  durationMs?: number
  ok?: boolean
  code?: string
  /** The call's arguments, when the line recorded them (the debug trace's call_started). */
  args?: unknown
  /** The folder of the failure's dump (debug mode), when the line names one. */
  dump?: string
  raw: Record<string, unknown>
}

/** A log file of a source: its path and the origin its lines get (a parser may refine it per line). */
export interface TraceFile { path: string; origin: string }

/** What a daemon extension contributes to `tether trace`. */
export interface TraceSource {
  /** The MCP server name the agents see ("tether-bridge", "tether-browser"). */
  server: string
  files(): TraceFile[]
  /** One parsed JSON line → an entry; undefined for a line that is not a trace line. Must not throw. */
  parse(raw: Record<string, unknown>, file: TraceFile): TraceEntry | undefined
  /** Whether this line names `callId` (the field each format uses). */
  cites(raw: Record<string, unknown>, callId: string): boolean
}

/** How many rotated generations are looked for next to each file. */
export const GENERATIONS = 5

/** `<path>`, then `<path>.1` … `<path>.5`, the ones that exist, oldest generation first (the timeline sorts anyway). */
export function generationsOf(path: string): string[] {
  const out: string[] = []
  for (let g = GENERATIONS; g >= 1; g--) if (existsSync(`${path}.${g}`)) out.push(`${path}.${g}`)
  if (existsSync(path)) out.push(path)
  return out
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** One line → its JSON object, or undefined (not JSON, or not an object). */
export function parseLine(line: string): Record<string, unknown> | undefined {
  const t = line.trim()
  if (!t.startsWith('{')) return undefined
  try { const v: unknown = JSON.parse(t); return isObject(v) ? v : undefined } catch { return undefined }
}

/** Each line of a file, in a stream (the file is never held whole). A file that cannot be read yields nothing. */
export async function* linesOf(path: string): AsyncGenerator<string> {
  let stream
  try { stream = createReadStream(path, { encoding: 'utf8' }) } catch { return }
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of rl) yield line
  } catch { /* vanished or unreadable mid-way: what was read stands */ } finally { rl.close(); stream.destroy() }
}

/** The last `maxBytes` of a file as lines (the first, cut, line is dropped when the file is longer). */
export function tailLines(path: string, maxBytes = 256 * 1024): string[] {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    const start = Math.max(0, size - maxBytes)
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    const lines = buf.toString('utf8').split(/\r?\n/)
    if (start > 0) lines.shift()
    return lines.filter(l => l.length > 0)
  } catch { return [] } finally { if (fd !== undefined) closeSync(fd) }
}

/** Time of a line in epoch ms from an ISO string field, or NaN. */
export const timeOf = (v: unknown): number => (typeof v === 'string' ? Date.parse(v) : NaN)

/** Every entry of every source that cites `callId`, in time order. */
export async function callTimeline(sources: readonly TraceSource[], callId: string): Promise<TraceEntry[]> {
  const found: Array<{ e: TraceEntry; n: number }> = []
  let n = 0
  for (const s of sources) {
    for (const f of s.files()) {
      for (const path of generationsOf(f.path)) {
        for await (const line of linesOf(path)) {
          // A cheap test before parsing: a line that does not hold the id is never parsed.
          if (!line.includes(callId)) continue
          const raw = parseLine(line)
          if (!raw || !s.cites(raw, callId)) continue
          const e = s.parse(raw, f)
          if (e) found.push({ e, n: n++ })
        }
      }
    }
  }
  return found.sort((a, b) => (a.e.at - b.e.at) || (a.n - b.n)).map(x => x.e)
}

/** A call that ended in error, as `--last` lists it. */
export interface FailedCall { callId: string; server: string; tool?: string; code?: string; durationMs?: number; at: number; origin: string }

/** The outermost record of a call wins (the agent saw that one): the shell / browser server over the daemon. */
const RANK: Record<string, number> = { casca: 3, browser: 3, daemon: 2, 'extensão': 1 }

/** The latest `n` calls that ended in error (`call_finished` with ok false), newest first, one per call id. */
export async function lastFailures(sources: readonly TraceSource[], n: number): Promise<FailedCall[]> {
  const byId = new Map<string, FailedCall>()
  // Bounded: once the map holds far more than asked, the oldest go (the memory stays fixed however long the logs are).
  const trim = (): void => {
    if (byId.size <= n * 4 + 32) return
    const keep = [...byId.values()].sort((a, b) => b.at - a.at).slice(0, n * 2 + 16)
    byId.clear()
    for (const c of keep) byId.set(c.callId, c)
  }
  for (const s of sources) {
    for (const f of s.files()) {
      for (const path of generationsOf(f.path)) {
        for await (const line of linesOf(path)) {
          if (!line.includes('call_finished')) continue
          const raw = parseLine(line)
          const e = raw && s.parse(raw, f)
          if (!e || e.event !== 'call_finished' || e.ok !== false || !e.callId) continue
          const prev = byId.get(e.callId)
          if (prev && (RANK[prev.origin] ?? 0) >= (RANK[e.origin] ?? 0)) continue
          byId.set(e.callId, { callId: e.callId, server: e.server, tool: e.tool ?? prev?.tool, code: e.code ?? prev?.code, durationMs: e.durationMs ?? prev?.durationMs, at: e.at, origin: e.origin })
          trim()
        }
      }
    }
  }
  return [...byId.values()].sort((a, b) => b.at - a.at).slice(0, n)
}

/** What `--replay` prints: the call ready to be asked again, or why it cannot be. */
export type Replay =
  | { ok: true; server: string; tool: string; args: unknown; redacted: string[]; typedInTrace: boolean }
  | { ok: false; reason: 'not-found' | 'no-args'; server?: string; tool?: string }

export const REDACTED = '[redacted]'

/** The paths (`text`, `fields[2].value`) whose value is `[redacted]`. */
export function redactedPaths(v: unknown, at = ''): string[] {
  if (v === REDACTED) return [at || '(tudo)']
  if (Array.isArray(v)) return v.flatMap((x, i) => redactedPaths(x, `${at}[${i}]`))
  if (isObject(v)) return Object.entries(v).flatMap(([k, x]) => redactedPaths(x, at ? `${at}.${k}` : k))
  return []
}

/** The replay of a call from its timeline: the first `call_started` that recorded arguments (the debug trace's). */
export function replayOf(entries: readonly TraceEntry[]): Replay {
  const started = entries.filter(e => e.event === 'call_started')
  if (!started.length) return { ok: false, reason: 'not-found' }
  const withArgs = started.find(e => e.args !== undefined)
  const first = started[0]!
  if (!withArgs) return { ok: false, reason: 'no-args', server: first.server, ...(first.tool ? { tool: first.tool } : {}) }
  const tool = withArgs.tool ?? first.tool
  if (!tool) return { ok: false, reason: 'no-args', server: withArgs.server }
  // The bridge records the text of a `type` as [redacted] in call_started (its target is not checked yet) and the text of a
  // field that is not a password in its `typing` event: the timeline shows it there.
  const typedInTrace = entries.some(e => e.event === 'typing' && typeof e.raw.text === 'string' && e.raw.text !== REDACTED)
  return { ok: true, server: withArgs.server, tool, args: withArgs.args, redacted: redactedPaths(withArgs.args), typedInTrace }
}

// ---- the person's text ------------------------------------------------------------------------------------------------

const pad2 = (n: number): string => String(n).padStart(2, '0')
/** "14:03:07.512" in local time. */
export function clockOf(at: number): string {
  const d = new Date(at)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`
}
const dayOf = (at: number): string => { const d = new Date(at); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` }
const msText = (ms: number | undefined): string => (ms === undefined ? '' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`)

/** The timeline as the person reads it: a header, then one aligned row per entry. */
export function renderTimeline(callId: string, entries: readonly TraceEntry[]): string {
  if (!entries.length) return `nenhuma linha cita a chamada ${callId} nos logs do tether-bridge e do tether-browser\n`
  const tool = entries.find(e => e.tool)?.tool
  const servers = [...new Set(entries.map(e => e.server))].join(', ')
  const end = [...entries].reverse().find(e => e.event === 'call_finished')
  const verdict = !end ? 'sem fim registrado' : end.ok === false ? `falhou${end.code ? ` (${end.code})` : ''}${end.durationMs !== undefined ? ` em ${msText(end.durationMs)}` : ''}` : `ok${end.durationMs !== undefined ? ` em ${msText(end.durationMs)}` : ''}`
  const rows = entries.map(e => [clockOf(e.at), e.origin, e.event, e.step ?? '', msText(e.durationMs), e.ok === false ? (e.code ?? 'erro') : ''])
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map(r => r[i]!.length)))
  const head = `chamada ${callId} · ${tool ?? 'tool ?'} · ${servers} · ${dayOf(entries[0]!.at)} · ${verdict}\n`
  const dumps = [...new Set(entries.flatMap(e => (e.dump ? [e.dump] : [])))]
  const foot = dumps.map(d => `despejo da falha: ${d}\n`).join('')
  return head + rows.map(r => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join('  ').trimEnd()).join('\n') + '\n' + foot
}

/** `--last`: one row per failed call, newest first. */
export function renderFailures(list: readonly FailedCall[]): string {
  if (!list.length) return 'nenhuma chamada com erro nos logs do tether-bridge e do tether-browser\n'
  const rows = list.map(c => [`${dayOf(c.at)} ${clockOf(c.at)}`, c.callId, c.server, c.tool ?? '?', c.code ?? 'erro', msText(c.durationMs)])
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map(r => r[i]!.length)))
  return rows.map(r => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join('  ').trimEnd()).join('\n') + '\n'
}

/** `--replay`: the recipe, or the plain reason it cannot be given. */
export function renderReplay(callId: string, r: Replay): string {
  if (!r.ok && r.reason === 'not-found') return `a chamada ${callId} não tem call_started nos logs: não há o que repetir\n`
  if (!r.ok) return `a chamada ${callId}${r.tool ? ` (${r.tool}, ${r.server})` : ''} não tem argumentos gravados: o modo de depuração estava desligado quando ela rodou. Ligue-o em Configurações e repita a chamada à mão para que a próxima fique gravada.\n`
  const lines = [`servidor MCP: ${r.server}`, `tool: ${r.tool}`, `argumentos: ${JSON.stringify(r.args, null, 2)}`]
  if (r.redacted.length) {
    lines.push(`atenção: ${r.redacted.join(', ')} ${r.redacted.length === 1 ? 'foi gravado' : 'foram gravados'} como [redacted] (campo de senha, ou texto ainda não conferido): preencha antes de repetir.`)
    lines.push(r.typedInTrace ? `o texto digitado aparece no evento typing da linha do tempo (tether trace ${callId}).` : 'o rastro não guarda esse valor.')
  }
  lines.push('Para repetir, o agente chama essa tool com esses argumentos; o tether não a executa.')
  return lines.join('\n') + '\n'
}
