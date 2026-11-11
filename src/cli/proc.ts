// `tether proc`: background processes kept by tether (they outlive the panel that started them, and tetherd).
// Acts go through tetherd; `logs` and `history` read the files on disk, so they work with tetherd down.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { userInfo } from 'node:os'
import { procEventsPath, procLogPath, procLogsDir } from '../core/paths.ts'
import { DaemonError, type DaemonClient } from '../daemon/client.ts'
import { authorText, historyLine, readProcEvents, statusText, type ProcBy, type ProcEvent, type ProcRecipe, type ProcState } from '../daemon/procs.ts'
import { parseInterval, RondaError } from '../daemon/ronda.ts'
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
        [--grace 5s] [--as rótulo] -- <comando…>
                                      registra e inicia; sem comando, inicia a receita guardada
                                      (--cwd padrão: a pasta atual)
  stop <nome> [--reason "…"]          para (Ctrl+C, espera, depois a árvore)
  restart <nome> [--reason "…"]       para e inicia de novo com a receita guardada
  logs <nome> [--tail N] [--since HH:MM|ISO] [--run k]
                                      a saída da execução (padrão: a mais recente, 200 linhas)
  history <nome> [--json]             os eventos: quem fez o quê, quando e por quê
  rm <nome>                           esquece um processo parado (ficha, histórico e logs)
  host [stop [--force]]               o anfitrião dos processos; stop recusa com processos vivos

O processo continua rodando se o painel que o iniciou fechar, e se o tetherd
reiniciar. O tether nunca reinicia nada sozinho. Todos aceitam --as <rótulo>.
`

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
    `  comando:     ${[c.command, ...c.args].join(' ')}`,
    `  pasta:       ${c.cwd}`,
    c.description ? `  descrição:   ${c.description}` : '',
    c.ports.length ? `  portas:      ${c.ports.join(', ')}` : '',
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

export async function cmdProc(argv: string[], io: ProcIo): Promise<number> {
  const a = parseArgs(argv, { valued: ['desc', 'cwd', 'grace', 'as', 'reason', 'tail', 'since', 'run'], flags: ['json', 'force'], multi: ['port', 'env', 'info'] })
  const sub = a.positional[0]
  if (!sub || sub === 'help') { io.out(PROC_USAGE); return sub ? 0 : 2 }
  if (sub === 'logs') return cmdLogs(a, io)
  if (sub === 'history') return cmdHistory(a, io)
  if (!['ls', 'info', 'start', 'stop', 'restart', 'rm', 'host'].includes(sub)) throw new UsageError(`subcomando desconhecido: proc ${sub}\n\n${PROC_USAGE}`)
  const recipeOpts = a.options.desc !== undefined || a.options.cwd !== undefined || a.options.grace !== undefined || a.multi.port || a.multi.env || a.multi.info
  if (sub !== 'start' && (recipeOpts || a.rest.length)) throw new UsageError(`--port/--desc/--env/--cwd/--info/--grace e o comando só valem em proc start`)

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
  } else if (sub !== 'ls' && sub !== 'host') name = requireName(a.positional, PROC_USAGE)
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
        io.out(table(['NOME', 'ESTADO', 'PID', 'DESDE', 'INICIADO POR', 'DESCRIÇÃO'], procs.map((s) => [
          s.name, statusText(s) + (s.attention ? ' !' : ''), s.pid ? String(s.pid) : '-', relativeTime(since(s)), s.startedBy ? truncate(authorText(s.startedBy), 30) : '-', truncate(s.card.description ?? '', 40),
        ])))
        return 0
      }
      case 'info': {
        const reply = await client.request({ t: 'proc-info', name })
        io.out(a.flags.has('json') ? JSON.stringify({ proc: reply.proc, events: reply.events }, null, 2) + '\n' : describeInfo(reply.proc!, reply.events ?? []))
        return 0
      }
      case 'start': {
        const s = (await client.request({ t: 'proc-start', name, ...(recipe ? { recipe } : {}), by: who })).proc!
        if (a.flags.has('json')) io.out(JSON.stringify(s, null, 2) + '\n')
        else if (s.status === 'failed') io.err(`tether: ${describeState(s)}`)
        else io.out(describeState(s))
        return s.status === 'failed' ? 1 : 0
      }
      case 'stop':
      case 'restart': {
        const reason = a.options.reason
        const s = (await client.request({ t: sub === 'stop' ? 'proc-stop' : 'proc-restart', name, ...(reason ? { reason } : {}), by: who })).proc!
        io.out(a.flags.has('json') ? JSON.stringify(s, null, 2) + '\n' : describeState(s))
        return s.status === 'failed' ? 1 : 0
      }
      case 'rm':
        await client.request({ t: 'proc-forget', name, by: who })
        io.out(`${name} esquecido (ficha, histórico e logs apagados)\n`)
        return 0
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
    if (e instanceof DaemonError) { io.err(`tether: ${e.message}\n`); return 1 }
    throw e
  } finally {
    client.close()
  }
}
