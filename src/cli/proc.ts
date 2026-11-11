// `tether proc`: background processes kept by tether (they outlive the panel that started them, and tetherd).
// Acts go through tetherd; `logs` and `history` read the files on disk, so they work with tetherd down.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { userInfo } from 'node:os'
import { procEventsPath, procLogPath, procLogsDir } from '../core/paths.ts'
import { DaemonError, type DaemonClient } from '../daemon/client.ts'
import { checkText, ownerText, type PortRow } from '../daemon/ports.ts'
import { authorText, historyLine, readProcEvents, statusText, useText, WAIT_DEFAULT_MS, WAIT_MAX_MS, type ProcBy, type ProcEvent, type ProcRecipe, type ProcState } from '../daemon/procs.ts'
import { formatInterval, parseInterval, RondaError } from '../daemon/ronda.ts'
import { parseArgs, UsageError } from './args.ts'
import { localTime, relativeTime, table, truncate } from './format.ts'

export interface ProcIo {
  out: (text: string) => void
  err: (text: string) => void
  env: NodeJS.ProcessEnv
  home: string
  /** The caller's folder (default --cwd). */
  cwd: string
  connect: () => Promise<DaemonClient | undefined>
}

export const PROC_USAGE = `uso: tether proc <comando>

  ls [--json]                         os processos: estado, pid, desde quando, quem iniciou
  info <nome> [--json]                a ficha inteira, o estado e os últimos eventos
  start <nome> [--port N]... [--desc "…"] [--env K=V]... [--cwd p] [--info k=v]...
        [--grace 5s] [--force] [--as rótulo] -- <comando…>
                                      registra e inicia; sem comando, inicia a receita guardada
                                      (--cwd padrão: a pasta atual). Porta declarada já ocupada:
                                      recusa dizendo quem ocupa; --force inicia mesmo assim
  wait <nome> [--timeout 60s]         espera as portas declaradas ouvirem (sem portas: rodando);
                                      se o processo sair antes, mostra o fim do log
  stop <nome> [--reason "…"]          para (Ctrl+C, espera, depois a árvore)
  restart <nome> [--reason "…"]       para e inicia de novo com a receita guardada
  rm <nome>                           esquece um processo parado (ficha, histórico e logs)
        stop, restart e rm de processo em uso por outros: recusa (saída 3) com o quadro;
        --wait [tempo] espera a liberação (padrão 60s, até 5m); --force "motivo" faz mesmo assim
  use <nome> [tempo] "para quê"       declara que você depende do processo (padrão 15m, até 60m);
                                      declarar de novo renova
  release <nome>                      libera o seu uso
  ports [--check N] [--json]          quem ouve em cada porta (do tether ou de fora) e as declaradas
  logs <nome> [--tail N] [--since HH:MM|ISO] [--run k]
                                      a saída da execução (padrão: a mais recente, 200 linhas)
  history <nome> [--json]             os eventos: quem fez o quê, quando e por quê
  host [stop [--force]]               o anfitrião dos processos; stop recusa com processos vivos

O processo continua rodando se o painel que o iniciou fechar, e se o tetherd
reiniciar. O tether nunca reinicia nada sozinho. Todos aceitam --as <rótulo>.
`

const GUARDED = new Set(['stop', 'restart', 'rm'])
const WAIT_LOG_LINES = 20

function by(io: ProcIo, as: string | undefined): ProcBy {
  const b: ProcBy = {}
  const slotId = io.env.TETHER_SLOT_ID?.trim()
  if (slotId) b.slotId = slotId
  if (as?.trim()) b.as = as.trim()
  try { b.user = userInfo().username } catch { /* no user name */ }
  return b
}

function requireName(positional: string[], usage: string): string {
  const name = positional[1]
  if (!name) throw new UsageError(`informe o nome do processo. ${usage}`)
  if (positional.length > 2) throw new UsageError(`argumentos a mais: ${positional.slice(2).join(' ')}. ${usage}`)
  return name
}

function pairs(values: string[] | undefined, what: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const v of values ?? []) {
    const eq = v.indexOf('=')
    if (eq <= 0) throw new UsageError(`${what} deve ser NOME=valor: ${v}`)
    out[v.slice(0, eq)] = v.slice(eq + 1)
  }
  return out
}

function since(s: ProcState): string | undefined {
  return s.status === 'running' || s.status === 'stopping' ? s.startedAt : s.exit?.at
}

/** "3000 ✓" (listening) or "3000 …" (not yet). */
export function portsText(s: ProcState): string {
  return (s.ports ?? []).map((p) => `${p.port} ${p.listening ? '✓' : '…'}`).join(' ')
}

/** "em uso por kai (claude) até 14:20:00: e2e do checkout". */
export function usesText(s: ProcState): string {
  return s.uses?.length ? `em uso por ${s.uses.map(useText).join('; ')}` : ''
}

export function describeState(s: ProcState): string {
  const head = `${s.name}: ${statusText(s)}`
  if (s.status === 'running' || s.status === 'stopping') return `${head} (pid ${s.pid ?? '?'}, execução ${s.run})\n`
  if (s.status === 'failed') return `${head}: ${s.error ?? '?'}\n`
  return `${head}\n`
}

export function describeInfo(s: ProcState, events: ProcEvent[]): string {
  const c = s.card
  const lines = [
    `${c.name}: ${statusText(s)}${s.attention ? ' (pede atenção)' : ''}`,
    s.pid ? `  pid:         ${s.pid} (execução ${s.run}${s.startedAt ? `, desde ${localTime(s.startedAt)}` : ''})` : '',
    s.startedBy ? `  iniciado por ${authorText(s.startedBy)}` : '',
    s.exit ? `  fim:         ${localTime(s.exit.at)}${typeof s.exit.code === 'number' ? `, código ${s.exit.code}` : ''}` : '',
    s.stoppedBy ? `  parado por:  ${authorText(s.stoppedBy)}${s.reason ? `, motivo: ${s.reason}` : ''}` : '',
    s.error ? `  erro:        ${s.error}` : '',
    s.memoryMB !== undefined ? `  memória:     ${s.memoryMB} MB` : '',
    ...(s.uses ?? []).map((u) => `  em uso por ${useText(u)}`),
    `  comando:     ${[c.command, ...c.args].join(' ')}`,
    `  pasta:       ${c.cwd}`,
    c.description ? `  descrição:   ${c.description}` : '',
    c.ports.length ? `  portas:      ${s.ports ? portsText(s) : c.ports.join(', ')}` : '',
    Object.keys(c.env).length ? `  env:         ${Object.entries(c.env).map(([k, v]) => `${k}=${v}`).join(' ')}` : '',
    Object.keys(c.info).length ? `  info:        ${Object.entries(c.info).map(([k, v]) => `${k}=${v}`).join(' ')}` : '',
    `  parada:      Ctrl+C, espera ${c.stopGraceMs / 1000} s, depois a árvore`,
    `  registrado por ${authorText(c.registeredBy)} em ${localTime(c.createdAt)}`,
  ].filter(Boolean)
  if (events.length) lines.push('', 'Últimos eventos:', ...events.map((e) => `  ${historyLine(e)}`))
  return lines.join('\n') + '\n'
}

/** `HH:MM` (today, local) or an ISO time → ms epoch. */
function parseSince(raw: string, now = new Date()): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim())
  if (m) return new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(m[1]), Number(m[2])).getTime()
  const t = Date.parse(raw)
  if (Number.isNaN(t)) throw new UsageError(`--since inválido: ${raw} (use HH:MM ou uma data ISO)`)
  return t
}

function clock(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** The runs that have a log, newest last. */
export function logRuns(home: string, name: string): number[] {
  let files: string[]
  try { files = readdirSync(procLogsDir(home, name)) } catch { return [] }
  return files.map((f) => /^run-(\d+)\.log$/.exec(f)).filter((m): m is RegExpExecArray => m !== null).map((m) => Number(m[1])).sort((a, b) => a - b)
}

function cmdLogs(a: ReturnType<typeof parseArgs>, io: ProcIo): number {
  const name = requireName(a.positional, 'uso: tether proc logs <nome> [--tail N] [--since HH:MM|ISO] [--run k]')
  const runs = logRuns(io.home, name)
  if (!runs.length) { io.err(`tether: ${name} não tem log (veja: tether proc ls)\n`); return 1 }
  const run = a.options.run !== undefined ? Number(a.options.run) : runs[runs.length - 1]!
  if (!Number.isInteger(run) || !existsSync(procLogPath(io.home, name, run))) throw new UsageError(`execução sem log: ${a.options.run}; há: ${runs.join(', ')}`)
  const tail = a.options.tail !== undefined ? Number(a.options.tail) : 200
  if (!Number.isInteger(tail) || tail < 0) throw new UsageError(`--tail inválido: ${a.options.tail}`)
  const from = a.options.since !== undefined ? parseSince(a.options.since) : undefined
  let lines = readFileSync(procLogPath(io.home, name, run), 'utf8').split('\n').filter((l) => l !== '')
  if (from !== undefined) lines = lines.filter((l) => Date.parse(l.slice(0, l.indexOf(' '))) >= from)
  if (tail) lines = lines.slice(-tail)
  io.out(lines.map((l) => { const sp = l.indexOf(' '); return `${clock(l.slice(0, sp))} ${l.slice(sp + 1)}` }).join('\n') + (lines.length ? '\n' : ''))
  return 0
}

function cmdHistory(a: ReturnType<typeof parseArgs>, io: ProcIo): number {
  const name = requireName(a.positional, 'uso: tether proc history <nome> [--json]')
  if (!existsSync(procEventsPath(io.home, name))) { io.err(`tether: ${name} não tem histórico (veja: tether proc ls)\n`); return 1 }
  const events = readProcEvents(io.home, name)
  io.out(a.flags.has('json') ? JSON.stringify(events, null, 2) + '\n' : events.map(historyLine).join('\n') + '\n')
  return 0
}

/** `--wait` takes an optional time: bare (or followed by something that is not a time) it means the default. */
function defaultWait(argv: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--') { out.push(...argv.slice(i)); break }
    if (a !== '--wait') { out.push(a); continue }
    const next = argv[i + 1]
    let isTime = false
    if (next !== undefined && !next.startsWith('--')) { try { parseInterval(next, true); isTime = true } catch { /* not a time */ } }
    out.push(isTime ? `--wait=${next}` : `--wait=${formatInterval(WAIT_DEFAULT_MS)}`)
    if (isTime) i++
  }
  return out
}

function interval(raw: string, what: string, max?: number): number {
  let ms: number
  try { ms = parseInterval(raw, true) } catch (e) { if (e instanceof RondaError) throw new UsageError(`${what}: ${e.message}`); throw e }
  if (max !== undefined && ms > max) throw new UsageError(`${what}: o máximo é ${formatInterval(max)}`)
  return ms
}

export function describePorts(rows: PortRow[]): string {
  if (!rows.length) return 'nenhuma porta ouvindo nem declarada\n'
  return table(['PORTA', 'ESTADO', 'QUEM', 'DECLARADA POR'], rows.map((r) => [
    String(r.port),
    r.listening ? 'ouvindo' : 'livre',
    r.listening ? ownerText(r) : '-',
    (r.declaredBy ?? []).map((d) => `${d.name} (${statusText({ status: d.status })})`).join(', ') || '-',
  ]))
}

export async function cmdProc(argv: string[], io: ProcIo): Promise<number> {
  // --force is a reason on stop/restart/rm ("motivo", it reaches whoever uses the process) and a switch elsewhere.
  const guarded = GUARDED.has(argv[0] ?? '')
  const a = parseArgs(guarded ? defaultWait(argv) : argv, {
    valued: ['desc', 'cwd', 'grace', 'as', 'reason', 'tail', 'since', 'run', 'check', 'timeout', ...(guarded ? ['force', 'wait'] : [])],
    flags: ['json', ...(guarded ? [] : ['force'])],
    multi: ['port', 'env', 'info'],
  })
  const sub = a.positional[0]
  if (!sub || sub === 'help') { io.out(PROC_USAGE); return sub ? 0 : 2 }
  if (sub === 'logs') return cmdLogs(a, io)
  if (sub === 'history') return cmdHistory(a, io)
  if (!['ls', 'info', 'start', 'stop', 'restart', 'rm', 'host', 'use', 'release', 'ports', 'wait'].includes(sub)) throw new UsageError(`subcomando desconhecido: proc ${sub}\n\n${PROC_USAGE}`)
  const recipeOpts = a.options.desc !== undefined || a.options.cwd !== undefined || a.options.grace !== undefined || a.multi.port || a.multi.env || a.multi.info
  if (sub !== 'start' && (recipeOpts || a.rest.length)) throw new UsageError(`--port/--desc/--env/--cwd/--info/--grace e o comando só valem em proc start`)
  if (a.options.check !== undefined && sub !== 'ports') throw new UsageError('--check só vale em proc ports')
  if (a.options.timeout !== undefined && sub !== 'wait') throw new UsageError('--timeout só vale em proc wait')
  if (a.flags.has('force') && sub !== 'start' && sub !== 'host') throw new UsageError('--force só vale em start, host stop, e com motivo em stop/restart/rm')
  if (guarded && a.options.force !== undefined && !a.options.force.trim()) throw new UsageError('--force pede um motivo: --force "motivo" (ele chega a quem usa)')
  if (guarded && a.options.force !== undefined && a.options.wait !== undefined) throw new UsageError('escolha --wait ou --force, não os dois')
  const waitMs = a.options.wait !== undefined ? interval(a.options.wait, '--wait', WAIT_MAX_MS) : undefined
  const guard = { ...(waitMs !== undefined ? { waitMs } : {}), ...(a.options.force !== undefined ? { force: a.options.force } : {}) }
  let check: number | undefined
  if (a.options.check !== undefined) {
    check = Number(a.options.check)
    if (!Number.isInteger(check) || check <= 0 || check > 65535) throw new UsageError(`--check inválido: ${a.options.check}`)
  }
  const timeoutMs = interval(a.options.timeout ?? '60s', '--timeout')
  let useArgs: { duration?: string; purpose: string } | undefined
  if (sub === 'use') {
    const [, n, x, y, ...more] = a.positional
    if (!n || !x || more.length) throw new UsageError('uso: tether proc use <nome> [tempo] "para quê"')
    if (y === undefined) {
      let looksLikeTime = false
      try { parseInterval(x, true); looksLikeTime = true } catch { /* the purpose */ }
      if (looksLikeTime) throw new UsageError(`diga para quê: tether proc use ${n} ${x} "para quê"`)
    }
    useArgs = y === undefined ? { purpose: x } : { duration: x, purpose: y }
  }

  // Built before connecting: a usage error never needs tetherd.
  let recipe: ProcRecipe | undefined
  let name = ''
  if (sub === 'start') {
    name = requireName(a.positional, 'uso: tether proc start <nome> [opções] -- <comando…>')
    if (!a.rest.length && recipeOpts) throw new UsageError('as opções da receita vêm com o comando: tether proc start <nome> [opções] -- <comando…>')
    if (a.rest.length) {
      let stopGraceMs: number | undefined
      if (a.options.grace !== undefined) {
        try { stopGraceMs = parseInterval(a.options.grace, true) } catch (e) { if (e instanceof RondaError) throw new UsageError(`--grace: ${e.message}`); throw e }
      }
      const ports = (a.multi.port ?? []).map((p) => {
        const n = Number(p)
        if (!Number.isInteger(n) || n <= 0 || n > 65535) throw new UsageError(`--port inválida: ${p}`)
        return n
      })
      recipe = {
        command: a.rest[0]!,
        args: a.rest.slice(1),
        cwd: resolve(io.cwd, a.options.cwd ?? '.'),
        env: pairs(a.multi.env, '--env'),
        info: pairs(a.multi.info, '--info'),
        ports,
        ...(a.options.desc !== undefined ? { description: a.options.desc } : {}),
        ...(stopGraceMs !== undefined ? { stopGraceMs } : {}),
      }
    }
  } else if (sub === 'use') name = a.positional[1]!
  else if (sub !== 'ls' && sub !== 'host' && sub !== 'ports') name = requireName(a.positional, PROC_USAGE)
  if (sub === 'host' && a.positional[1] !== undefined && a.positional[1] !== 'stop') throw new UsageError('uso: tether proc host [stop [--force]]')

  const client = await io.connect()
  if (!client) { io.err('tether: o tetherd não está rodando; os processos são geridos por ele (suba o app ou rode: tether daemon restart). logs e history funcionam sem ele.\n'); return 1 }
  const who = by(io, a.options.as)
  try {
    switch (sub) {
      case 'ls': {
        const procs = (await client.request({ t: 'proc-list' })).procs ?? []
        if (a.flags.has('json')) { io.out(JSON.stringify(procs, null, 2) + '\n'); return 0 }
        if (!procs.length) { io.out('nenhum processo (registre com: tether proc start <nome> -- <comando…>)\n'); return 0 }
        io.out(table(['NOME', 'ESTADO', 'PID', 'PORTAS', 'MEMÓRIA', 'DESDE', 'INICIADO POR', 'DESCRIÇÃO'], procs.map((s) => [
          s.name, statusText(s) + (s.attention ? ' !' : ''), s.pid ? String(s.pid) : '-', portsText(s) || '-', s.memoryMB !== undefined ? `${s.memoryMB} MB` : '-',
          relativeTime(since(s)), s.startedBy ? truncate(authorText(s.startedBy), 30) : '-', truncate(s.card.description ?? '', 40),
        ])))
        const used = procs.filter((s) => s.uses?.length).map((s) => `${s.name}: ${usesText(s)}`)
        if (used.length) io.out('\n' + used.join('\n') + '\n')
        return 0
      }
      case 'info': {
        const reply = await client.request({ t: 'proc-info', name })
        io.out(a.flags.has('json') ? JSON.stringify({ proc: reply.proc, events: reply.events }, null, 2) + '\n' : describeInfo(reply.proc!, reply.events ?? []))
        return 0
      }
      case 'start': {
        const s = (await client.request({ t: 'proc-start', name, ...(recipe ? { recipe } : {}), by: who, ...(a.flags.has('force') ? { force: true } : {}) })).proc!
        if (a.flags.has('json')) io.out(JSON.stringify(s, null, 2) + '\n')
        else if (s.status === 'failed') io.err(`tether: ${describeState(s)}`)
        else io.out(describeState(s))
        return s.status === 'failed' ? 1 : 0
      }
      case 'stop':
      case 'restart': {
        const reason = a.options.reason
        const s = (await client.request({ t: sub === 'stop' ? 'proc-stop' : 'proc-restart', name, ...(reason ? { reason } : {}), by: who, ...guard })).proc!
        io.out(a.flags.has('json') ? JSON.stringify(s, null, 2) + '\n' : describeState(s))
        return s.status === 'failed' ? 1 : 0
      }
      case 'rm':
        await client.request({ t: 'proc-forget', name, by: who, ...guard })
        io.out(`${name} esquecido (ficha, histórico e logs apagados)\n`)
        return 0
      case 'use': {
        const s = (await client.request({ t: 'proc-use', name, ...useArgs!, by: who })).proc!
        io.out(a.flags.has('json') ? JSON.stringify(s, null, 2) + '\n' : `uso declarado. ${s.name}: ${usesText(s)}\nLibere ao terminar: tether proc release ${s.name}\n`)
        return 0
      }
      case 'release': {
        const r = await client.request({ t: 'proc-release', name, by: who })
        io.out(r.released ? `uso de ${name} liberado\n` : `você não tinha uso declarado em ${name}\n`)
        return 0
      }
      case 'ports': {
        const rows = (await client.request({ t: 'proc-ports', ...(check !== undefined ? { check } : {}) })).ports ?? []
        if (a.flags.has('json')) { io.out(JSON.stringify(rows, null, 2) + '\n'); return 0 }
        if (check === undefined) { io.out(describePorts(rows)); return 0 }
        const row = rows.find((r) => r.port === check)
        io.out(checkText(row, check, (st) => statusText({ status: st })) + '\n')
        return row?.listening || row?.declaredBy?.length ? 1 : 0
      }
      case 'wait':
        return await waitReady(client, name, timeoutMs, io)
      case 'host': {
        if (a.positional[1] === 'stop') {
          await client.request({ t: 'proc-host-stop', ...(a.flags.has('force') ? { force: true } : {}), by: who })
          io.out('anfitrião encerrado\n')
          return 0
        }
        const host = (await client.request({ t: 'proc-host' })).host ?? null
        if (a.flags.has('json')) { io.out(JSON.stringify(host, null, 2) + '\n'); return 0 }
        io.out(host
          ? `anfitrião pid ${host.pid} (versão ${host.version}), desde ${localTime(host.startedAt)}, ${host.live} processo(s) vivo(s)\n`
          : 'anfitrião parado (sobe sozinho no próximo proc start)\n')
        return 0
      }
    }
    return 0
  } catch (e) {
    // The board of a refusal by uses goes to stdout with exit 3: it is for the agent to read and decide (wait, force, talk).
    if (e instanceof DaemonError && e.code === 'proc-in-use') { io.out(e.message + '\n'); return 3 }
    if (e instanceof DaemonError) { io.err(`tether: ${e.message}\n`); return 1 }
    throw e
  } finally {
    client.close()
  }
}

/** Polls until every declared port listens (no ports: running); exit 1 with the log's end when it ends first, or on timeout. */
async function waitReady(client: DaemonClient, name: string, timeoutMs: number, io: ProcIo): Promise<number> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const s = (await client.request({ t: 'proc-info', name })).proc!
    if (s.status !== 'running' && s.status !== 'stopping') {
      io.out(`${name}: ${statusText(s)}${s.error ? `: ${s.error}` : ''}; não vai ficar pronto.\n`)
      const run = s.run ?? logRuns(io.home, name).at(-1)
      if (run !== undefined && existsSync(procLogPath(io.home, name, run))) {
        const lines = readFileSync(procLogPath(io.home, name, run), 'utf8').split('\n').filter((l) => l !== '').slice(-WAIT_LOG_LINES)
        io.out(`Fim do log (execução ${run}):\n${lines.map((l) => { const sp = l.indexOf(' '); return `${clock(l.slice(0, sp))} ${l.slice(sp + 1)}` }).join('\n')}\n`)
      }
      return 1
    }
    const missing = (s.ports ?? []).filter((p) => !p.listening).map((p) => p.port)
    if (s.status === 'running' && !missing.length) {
      io.out(s.ports?.length ? `${name} pronto: ${portsText(s)}\n` : `${name} rodando (sem portas declaradas)\n`)
      return 0
    }
    if (Date.now() >= deadline) {
      io.out(`${name} não ficou pronto em ${formatInterval(timeoutMs)}: ${missing.length ? `porta(s) ${missing.join(', ')} ainda não ouvem` : 'ainda parando'}. Veja: tether proc logs ${name}\n`)
      return 1
    }
    await new Promise((r) => setTimeout(r, 300))
  }
}
