// Ports: one view of who listens where. Two probes (a TCP connect to localhost, which finds IPv4-only and
// IPv6-only listeners alike; the OS listener table through netstat / lsof) and pure parts: the parsers, the owner of
// a pid (the managed process whose tree holds it, else "outside tether" with its executable) and the rows of the view.
// Docker and system services fall in "outside tether" naturally: tether knows no domain.
import { execFile } from 'node:child_process'
import { connect } from 'node:net'
import type { ProcRow } from './memory.ts'
import type { ProcStatus } from './procs.ts'
import { ownerText } from './proc-texts.ts'

export interface Listener {
  port: number
  pid: number
  address: string
}

export interface PortRow {
  port: number
  listening: boolean
  /** Who listens (listening rows). */
  owner?: { proc?: string; pid: number; exe?: string }
  /** The listener is not in the tree of any managed process. */
  outside?: true
  /** Managed processes that declare this port. */
  declaredBy?: { name: string; status: ProcStatus }[]
}

const TIMEOUT_MS = 10_000

/** Does something accept connections on localhost:port? (~1 ms when nothing listens.) */
export function probePort(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host: 'localhost', port })
    const done = (v: boolean): void => { clearTimeout(timer); s.destroy(); resolve(v) }
    const timer = setTimeout(() => done(false), timeoutMs)
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}

/** The port after the last ':' of an address (`0.0.0.0:3000`, `[::]:3000`, `*:3000`). */
function portOf(address: string): number | undefined {
  const i = address.lastIndexOf(':')
  const n = Number(address.slice(i + 1))
  return i >= 0 && Number.isInteger(n) && n > 0 && n < 65536 ? n : undefined
}

function dedupe(list: Listener[]): Listener[] {
  const seen = new Set<string>()
  return list.filter((l) => { const k = `${l.port}/${l.pid}`; if (seen.has(k)) return false; seen.add(k); return true })
}

/**
 * `netstat -ano -p TCP|TCPv6` on Windows. A listening line has 5 columns and a foreign address ending in `:0`; the
 * state word and the header are localized (and come in the OEM codepage), so neither is read.
 */
export function parseNetstat(text: string): Listener[] {
  const out: Listener[] = []
  for (const line of text.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length !== 5 || !/^TCP/i.test(cols[0]!) || !cols[2]!.endsWith(':0')) continue
    const port = portOf(cols[1]!)
    const pid = Number(cols[4])
    if (port === undefined || !Number.isInteger(pid)) continue
    out.push({ port, pid, address: cols[1]! })
  }
  return dedupe(out)
}

/** `lsof -nP -iTCP -sTCP:LISTEN` (POSIX): `COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME (LISTEN)`. */
export function parseLsof(text: string): Listener[] {
  const out: Listener[] = []
  for (const line of text.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 9 || cols.at(-1) !== '(LISTEN)') continue
    const address = cols.at(-2)!
    const port = portOf(address)
    const pid = Number(cols[1])
    if (port === undefined || !Number.isInteger(pid)) continue
    out.push({ port, pid, address })
  }
  return dedupe(out)
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'latin1' }, (err, stdout) => {
      // lsof exits 1 when nothing listens: its (empty) output is still the answer.
      if (err && !stdout) return reject(err)
      resolve(stdout)
    })
  })
}

/** Every TCP listener of the machine, one per port and pid. */
export async function listListeners(): Promise<Listener[]> {
  if (process.platform === 'win32') {
    const [v4, v6] = await Promise.all([run('netstat', ['-ano', '-p', 'TCP']), run('netstat', ['-ano', '-p', 'TCPv6'])])
    return dedupe([...parseNetstat(v4), ...parseNetstat(v6)])
  }
  return parseLsof(await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']))
}

/** pid → name of the managed process whose tree (root pid plus every descendant, by ppid) holds it. */
export function treeOwners(rows: ProcRow[], roots: { pid: number; name: string }[]): Map<number, string> {
  const kids = new Map<number, number[]>()
  for (const r of rows) {
    if (r.ppid === r.pid) continue
    const list = kids.get(r.ppid)
    if (list) list.push(r.pid)
    else kids.set(r.ppid, [r.pid])
  }
  const out = new Map<number, string>()
  for (const root of roots) {
    const stack = [root.pid]
    while (stack.length) {
      const pid = stack.pop()!
      if (out.has(pid)) continue
      out.set(pid, root.name)
      for (const k of kids.get(pid) ?? []) stack.push(k)
    }
  }
  return out
}

export interface DeclaredPorts {
  name: string
  status: ProcStatus
  ports: number[]
}

/**
 * The single view: every listening port (of a managed process, declared or not, and from outside tether) plus the
 * ports declared by processes that do not listen on them. Sorted by port; one row per port.
 */
export function buildPortRows(listeners: Listener[], rows: ProcRow[], owners: Map<number, string>, declared: DeclaredPorts[]): PortRow[] {
  const exe = new Map(rows.map((r) => [r.pid, r.name]))
  const byPort = new Map<number, PortRow>()
  for (const l of listeners) {
    if (byPort.has(l.port)) continue
    const proc = owners.get(l.pid)
    const name = exe.get(l.pid)
    byPort.set(l.port, { port: l.port, listening: true, owner: { ...(proc ? { proc } : {}), pid: l.pid, ...(name ? { exe: name } : {}) }, ...(proc ? {} : { outside: true as const }) })
  }
  for (const d of declared) {
    for (const port of d.ports) {
      const row = byPort.get(port) ?? { port, listening: false }
      row.declaredBy = [...(row.declaredBy ?? []), { name: d.name, status: d.status }]
      byPort.set(port, row)
    }
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port)
}

/** "web (pid 123)" / "fora do tether: node.exe, pid 123". */
export { ownerText }

/** The answer of `proc ports --check N`: "livre", "ocupada por ‹quem›" or "declarada por ‹processo› (estado)". */
export function checkText(row: PortRow | undefined, port: number, statusText: (s: ProcStatus) => string): string {
  if (!row || (!row.listening && !row.declaredBy?.length)) return `porta ${port}: livre`
  if (row.listening) return `porta ${port}: ocupada por ${ownerText(row)}`
  return `porta ${port}: declarada por ${row.declaredBy!.map((d) => `${d.name} (${statusText(d.status)})`).join(', ')}`
}
