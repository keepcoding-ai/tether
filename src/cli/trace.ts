// `tether trace`: one call of the agents' browser tools (tether-bridge, tether-browser) as a single timeline, from the logs
// the daemon extensions contribute (TetherDaemon.traces; the engine is src/trace/timeline.ts). Only reads files: no
// daemon, no tool is called. The call id is the one every error of those tools ends its first line with: `(call <id>…)`.
import { UsageError } from './args.ts'
import { callTimeline, lastFailures, renderFailures, renderReplay, renderTimeline, replayOf, type TraceSource } from '../trace/timeline.ts'

export const TRACE_HELP = `uso: tether trace <id> [--json | --replay]
       tether trace --last [n] [--json]

  Junta numa linha do tempo, por horário, tudo o que os logs do tether-bridge (mcp.log, daemon.log,
  trace.log) e do tether-browser (mcp.log) registraram de uma chamada. O <id> é o que o erro da tool
  mostra no fim da primeira linha: "(call <id>…)".

  --json     as linhas cruas dos logs, mescladas na mesma ordem (uma por linha)
  --replay   a chamada pronta para repetir: servidor MCP, tool e argumentos (só com o modo de
             depuração ligado quando ela rodou; o tether não executa a tool)
  --last [n] as últimas n chamadas com erro (padrão 10): horário, id, servidor, tool, código, duração

Saída: 0 ok · 1 nada encontrado · 2 uso inválido
`

export interface TraceIo { out(t: string): void; err(t: string): void; sources(): ReadonlyArray<TraceSource> }

const ID = /^[A-Za-z0-9._:-]{1,64}$/

export async function cmdTrace(args: string[], io: TraceIo): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { io.out(TRACE_HELP); return 0 }
  const flags = new Set<string>()
  const positional: string[] = []
  for (const a of args) {
    if (a === '--json' || a === '--replay' || a === '--last') flags.add(a.slice(2))
    else if (a.startsWith('--')) throw new UsageError(`opção desconhecida: ${a}`)
    else positional.push(a)
  }
  const sources = io.sources()
  if (flags.has('last')) {
    if (flags.has('replay')) throw new UsageError('--last não combina com --replay')
    if (positional.length > 1) throw new UsageError('--last aceita só o número de chamadas')
    const n = positional.length ? Number(positional[0]) : 10
    if (!Number.isInteger(n) || n < 1 || n > 1000) throw new UsageError('--last [n]: n é um inteiro de 1 a 1000')
    const list = await lastFailures(sources, n)
    io.out(flags.has('json') ? list.map(c => JSON.stringify(c)).join('\n') + (list.length ? '\n' : '') : renderFailures(list))
    return list.length ? 0 : 1
  }
  if (positional.length !== 1) throw new UsageError('tether trace <id> (ou --last [n])')
  const id = positional[0]!
  if (!ID.test(id)) throw new UsageError('o id de chamada tem de 1 a 64 letras, dígitos, ".", "_", ":" ou "-"')
  if (flags.has('json') && flags.has('replay')) throw new UsageError('--json não combina com --replay')
  const entries = await callTimeline(sources, id)
  if (flags.has('replay')) {
    const r = replayOf(entries)
    io.out(renderReplay(id, r))
    return r.ok ? 0 : 1
  }
  io.out(flags.has('json') ? entries.map(e => JSON.stringify(e.raw)).join('\n') + (entries.length ? '\n' : '') : renderTimeline(id, entries))
  return entries.length ? 0 : 1
}
