// `tether pause ack|done|status`: the agent's side of the polite pause (it appends to its own report file, no
// daemon needed) and a plain-language view of the current batch. Output in Portuguese.
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { slotPauseReportPath, tetherHome } from '../core/paths.ts'
import { derivedLabel, type PauseReportLine } from '../daemon/pause.ts'
import { readPauseFile } from '../daemon/pause-read.ts'
import { parseArgs, UsageError } from './args.ts'

export interface PauseIo {
  out: (text: string) => void
  err: (text: string) => void
  env: NodeJS.ProcessEnv
}

const ACK_REPLY = 'Anotado: você está preparando a parada.\n'
const DONE_REPLY = 'Anotado: parada registrada. O Guga retoma você com esta nota.\n'

export async function cmdPause(argv: string[], io: PauseIo): Promise<number> {
  const [sub, ...rest] = argv
  const home = tetherHome(io.env)
  switch (sub) {
    case 'ack':
    case 'done': {
      const a = parseArgs(rest, { valued: ['slot'] })
      const slotId = (a.options.slot ?? io.env.TETHER_SLOT_ID ?? '').trim()
      if (!slotId) throw new UsageError('não sei qual é o slot: rode dentro de um painel do tether (TETHER_SLOT_ID) ou use --slot <slot>')
      const text = a.positional.join(' ').trim()
      if (!text) {
        throw new UsageError(sub === 'ack'
          ? 'diga o que você está fazendo: tether pause ack "<frase>"'
          : 'escreva a nota de retomada: tether pause done "<nota>"')
      }
      const batch = readPauseFile(home)
      if (!batch || batch.state === 'closed') {
        io.err('tether: não há pausa em andamento.\n')
        return 1
      }
      const line: PauseReportLine = { ts: new Date().toISOString(), batchId: batch.id, kind: sub, text }
      const file = slotPauseReportPath(home, slotId)
      mkdirSync(dirname(file), { recursive: true })
      appendFileSync(file, JSON.stringify(line) + '\n')
      io.out(sub === 'ack' ? ACK_REPLY : DONE_REPLY)
      return 0
    }
    case 'status': {
      const a = parseArgs(rest, { flags: ['json'] })
      const batch = readPauseFile(home)
      if (a.flags.has('json')) {
        io.out(JSON.stringify(batch ?? null, null, 2) + '\n')
        return 0
      }
      if (!batch) {
        io.out('Nenhuma pausa em andamento.\n')
        return 0
      }
      const now = Date.now()
      const lines = [`Pausa ${batch.id} (${batch.state}), ${batch.entries.length} slot(s):`]
      for (const e of batch.entries) {
        let l = `  ${e.slotId}  ${derivedLabel(e, now)}`
        if (e.phrase) l += `\n      fazendo: ${e.phrase}`
        if (e.note) l += `\n      nota: ${e.note}`
        lines.push(l)
      }
      io.out(lines.join('\n') + '\n')
      return 0
    }
    default:
      throw new UsageError('uso: tether pause <ack "<frase>" | done "<nota>" | status [--json]> [--slot <slot>]')
  }
}
