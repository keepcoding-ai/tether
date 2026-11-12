// `tether ronda`: the agent's side of the ronda (tether's nudge clock for its own pane). The agent assembles it; tetherd
// keeps the clock and sends the nudge through the ronda's channel when the agent is idle. Talks to the daemon only.
//   ronda [intervalo] [--nudge "…"] [--criterion "…"]   switch on / reassemble (20m when new)
//   ronda --status [--json]                             the pane's ronda
//   ronda --off [--force]                               switch off (with a criterion: the stimulus, unless --force)
import { DaemonError, type DaemonClient } from '../daemon/client.ts'
import type { Ronda } from '../daemon/protocol.ts'
import { buildChannelText, formatInterval, RONDA_DEFAULT_INTERVAL } from '../daemon/ronda.ts'
import { parseArgs, UsageError } from './args.ts'

export interface RondaIo {
  out: (text: string) => void
  err: (text: string) => void
  env: NodeJS.ProcessEnv
  connect: () => Promise<DaemonClient | undefined>
}

export const RONDA_USAGE = 'uso: tether ronda [intervalo] [--nudge "<texto>"] [--criterion "<critério>"] | --status [--json] | --off [--force]  [--slot <id>]'

function clock(iso: string): string {
  const d = new Date(iso)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function describeRonda(r: (Ronda & { due?: boolean; channel?: 'listening' | 'none' }) | null | undefined): string {
  if (!r) return 'Ronda desligada neste painel.\n'
  const lines = [
    `Ronda ligada: a cada ${formatInterval(r.intervalMs)}.`,
    r.due ? 'Próximo cutucão: já na hora, esperando o agente ficar ocioso.' : `Próximo cutucão: ${clock(r.nextAt)}.`,
    `Cutucão extra: ${r.nudge ?? '(nenhum)'}`,
    `Critério de parada: ${r.criterion ?? '(nenhum)'}`,
  ]
  if (r.channel === 'listening') lines.push('Canal: ouvindo (o cutucão chega ao agente por dentro, sem tocar a caixa de texto).')
  else if (r.channel === 'none') lines.push('Canal: sem canal agora (o agente não está rodando ou ainda não conectou); a ronda espera o canal para cutucar.')
  if (r.lastAt) lines.push(`Último cutucão: ${clock(r.lastAt)}.`)
  return lines.join('\n') + '\n'
}

export async function cmdRonda(argv: string[], io: RondaIo): Promise<number> {
  const a = parseArgs(argv, { valued: ['nudge', 'criterion', 'slot'], flags: ['status', 'off', 'force', 'json'] })
  const slotId = (a.options.slot ?? io.env.TETHER_SLOT_ID ?? '').trim()
  if (!slotId) throw new UsageError('não sei qual é o painel: rode dentro de um painel do tether (TETHER_SLOT_ID) ou use --slot <id>')
  if (a.positional.length > 1) throw new UsageError(`só um intervalo; texto vai em --nudge ou --criterion. ${RONDA_USAGE}`)
  const off = a.flags.has('off')
  const status = a.flags.has('status')
  if (off && status) throw new UsageError('--off e --status não andam juntos')
  if ((off || status) && (a.positional.length || a.options.nudge !== undefined || a.options.criterion !== undefined)) throw new UsageError(`--off e --status não levam intervalo nem texto. ${RONDA_USAGE}`)
  if (a.flags.has('force') && !off) throw new UsageError('--force só vale com --off')

  const client = await io.connect()
  if (!client) { io.err('tether: o tetherd não está rodando; a ronda precisa dele (é ele que guarda o relógio).\n'); return 1 }
  try {
    if (status) {
      const reply = await client.request({ t: 'ronda-get', slotId })
      io.out(a.flags.has('json') ? JSON.stringify(reply.ronda ?? null, null, 2) + '\n' : describeRonda(reply.ronda))
      return 0
    }
    if (off) {
      try {
        const reply = await client.request({ t: 'ronda-off', slotId, ...(a.flags.has('force') ? { force: true } : {}) })
        io.out(reply.rondaOutcome === 'was-off' ? 'A ronda já estava desligada.\n' : 'Ronda desligada.\n')
        return 0
      } catch (e) {
        // The stimulus goes to stdout: it is meant for the agent to read and answer, not an error to swallow.
        if (e instanceof DaemonError && e.code === 'ronda-criterion') { io.out(e.message + '\n'); return 3 }
        throw e
      }
    }
    const interval = a.positional[0]
    let reply
    try {
      reply = await client.request({
      t: 'ronda-set', slotId,
      ...(interval !== undefined ? { interval } : {}),
      ...(a.options.nudge !== undefined ? { nudge: a.options.nudge } : {}),
      ...(a.options.criterion !== undefined ? { criterion: a.options.criterion } : {}),
      })
    } catch (e) {
      if (e instanceof DaemonError && e.code === 'ronda-unavailable') { io.out(`Ronda indisponível neste painel: ${e.message}
`); return 4 }
      throw e
    }
    const head = reply.rondaOutcome === 'created' ? `Ronda ligada${interval === undefined ? ` (padrão ${RONDA_DEFAULT_INTERVAL})` : ''}.`
      : reply.rondaOutcome === 'updated' ? 'Ronda atualizada.'
      : 'A ronda já está ligada assim; nada mudou.'
    io.out(`${head}\n${describeRonda(reply.ronda)}${reply.ronda ? `Texto que o tether vai enviar pelo canal: ${buildChannelText(reply.ronda)}\n` : ''}`)
    return 0
  } finally {
    client.close()
  }
}
