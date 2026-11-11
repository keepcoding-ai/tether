// The Portuguese texts of background processes (tether proc): status, author, event and use phrases, the history line
// and a port's owner. Pure and free of node imports: the CLI, tetherd and the app's renderer (the Processes pad) all show
// these same phrases.
import { localTime } from '../cli/format.ts'
import type { PortRow } from './ports.ts'
import type { GuardedAction, ProcAuthor, ProcEvent, ProcState, UseView } from './procs.ts'


export function statusText(s: Pick<ProcState, 'status' | 'exit'> & { external?: boolean }): string {
  switch (s.status) {
    case 'running': return s.external ? 'externo (adotado)' : 'rodando'
    case 'stopping': return 'parando'
    case 'stopped': return 'parado'
    case 'exited': return typeof s.exit?.code === 'number' ? `encerrou sozinho (${s.exit.code})` : 'encerrou sozinho'
    case 'host-lost': return 'caiu com o anfitrião'
    case 'failed': return 'não subiu'
  }
}

export function authorText(by: ProcAuthor | undefined): string {
  if (!by) return '?'
  let who: string
  switch (by.kind) {
    case 'app': who = 'você (pelo app)'; break
    case 'agent': who = `${by.name ?? by.slotId ?? 'painel'} (${by.agent ?? 'agente'})`; break
    case 'shell': who = `${by.name ?? by.slotId ?? 'painel'} (shell)`; break
    default: who = by.user ?? 'externo'
  }
  if (by.label) who = by.kind === 'external' ? `${by.label} (${who})` : `${who}, como ${by.label}`
  return who
}

const ACTION_TEXT: Record<GuardedAction, string> = { stop: 'parar', restart: 'reiniciar', forget: 'esquecer' }
export function actionText(a: GuardedAction): string {
  return ACTION_TEXT[a] ?? a
}

/** "kai (claude) até 14:20:00: e2e do checkout". */
export function useText(u: UseView): string {
  return `${authorText(u.by)} até ${clockTime(u.until)}: ${u.purpose}`
}

export function eventText(e: ProcEvent): string {
  switch (e.kind) {
    case 'use-declared': return `declarou uso até ${clockTime(e.until ?? e.ts)}: ${e.purpose ?? ''}`
    case 'use-released': return e.cause === 'panel-gone' ? 'uso encerrado: o painel saiu' : 'liberou o uso'
    case 'use-expired': return `uso venceu às ${clockTime(e.until ?? e.ts)}`
    case 'refused-in-use': return `quis ${actionText(e.action ?? 'restart')}, recusado: em uso por ${(e.uses ?? []).map((u) => authorText(u.by)).join(', ')}`
    case 'forced': return `forçou ${actionText(e.action ?? 'restart')} sobre o uso de ${(e.over ?? []).map((u) => authorText(u.by)).join(', ')}`
    case 'registered': return 'registrou o processo'
    case 'recipe-changed': return `alterou a receita: ${Object.keys(e.after ?? {}).join(', ')}`
    case 'adopted': return `adotou o processo externo (pid ${e.pid})`
    case 'started': return `iniciou (execução ${e.run}, pid ${e.pid})`
    case 'start-failed': return `não subiu: ${e.message ?? '?'}`
    case 'stop-requested': return `pediu a parada (execução ${e.run})`
    case 'restart-requested': return `pediu o reinício (execução ${e.run})`
    case 'forgotten': return 'esqueceu o processo'
    case 'ended': {
      const at = e.at ? ` às ${clockTime(e.at)}` : ''
      const code = typeof e.code === 'number' ? `, código ${e.code}` : ''
      if (e.cause === 'requested') return `execução ${e.run} parou a pedido${at}${code}`
      if (e.cause === 'external') return `o processo externo adotado (pid ${e.pid}) não existe mais${at}; código de saída desconhecido`
      if (e.cause === 'host') return `execução ${e.run} caiu com o anfitrião${at}`
      return `execução ${e.run} encerrou sozinha${at}${code}`
    }
  }
}

/** One history line: local time with seconds (to cross with the log), who, what, why. `ended` is the system's: no author. */
export function historyLine(e: ProcEvent): string {
  const who = e.by ? authorText(e.by) : 'tether'
  return `${localTime(e.ts, true)}  ${who}  ${eventText(e)}${e.reason ? `  motivo: ${e.reason}` : ''}`
}

/** Local HH:MM:SS. */
export function clockTime(iso: string): string {
  return localTime(iso, true).slice(-8)
}

/** Who listens on a port: the managed process by name, or "fora do tether: ‹exe›, pid N". */
export function ownerText(row: PortRow): string {
  const o = row.owner
  if (!o) return '?'
  return o.proc ? `${o.proc} (pid ${o.pid})` : `fora do tether: ${o.exe ?? 'executável desconhecido'}, pid ${o.pid}`
}
