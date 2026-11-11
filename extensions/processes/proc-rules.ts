// The Processes pad's rules, pure (no DOM): the groups in the order of what asks for action, the summary, the texts of a
// row, the actions and the "⋯" items each state offers, the badge (only what asks for action counts), the board of the
// in-use dialog, the ports view and the timeline. The phrases tether already says in the CLI come from
// src/daemon/proc-texts.ts (status, author, events, uses, a port's owner): one source for the CLI and the app.
import type { DialogSpec } from '../../app/shared/dialog.ts'
import type { PortRow } from '../../src/daemon/ports.ts'
import type { ProcAuthor, ProcCard, ProcEvent, ProcState, ProcStatus, UseView } from '../../src/daemon/procs.ts'
import { authorText, clockTime, eventText, ownerText, statusText, useText } from '../../src/daemon/proc-texts.ts'
import { relativeTime } from '../../src/cli/format.ts'

export type GroupId = 'attention' | 'running' | 'stopped'

export const GROUP_TITLES: Record<GroupId, string> = { attention: 'Pedem atenção', running: 'Rodando', stopped: 'Parados' }
const GROUP_ORDER: readonly GroupId[] = ['attention', 'running', 'stopped']

export const EMPTY_TEXT = 'Nenhum processo. Quando um agente iniciar um pelo tether, ele aparece aqui.'
export const FORGET_CONFIRM = 'Esquecer apaga o histórico e os logs.'
export const NO_OUTPUT = (name: string): string => `sem saída em memória; use \`tether proc logs ${name}\``
export const FORGOTTEN = 'processo esquecido'
export const HOLD_DURATION = '15m'
export const HOLD_PURPOSE = 'segurado pela pessoa'
/** The longest a "wait for the use to end" holds (tetherd's ceiling). */
export const WAIT_MS = 5 * 60_000
export const FORCE_REASON = 'decisão da pessoa, pelo app'

export function groupOf(status: ProcStatus): GroupId {
  if (status === 'running' || status === 'stopping') return 'running'
  if (status === 'stopped') return 'stopped'
  return 'attention'
}

export const isLive = (p: Pick<ProcState, 'status'>): boolean => p.status === 'running' || p.status === 'stopping'

/** The non-empty groups, in the order of what asks for action; each sorted by name. */
export function procGroups(list: readonly ProcState[]): { id: GroupId; title: string; procs: ProcState[] }[] {
  return GROUP_ORDER
    .map(id => ({ id, title: GROUP_TITLES[id], procs: list.filter(p => groupOf(p.status) === id).sort((a, b) => a.name.localeCompare(b.name)) }))
    .filter(g => g.procs.length > 0)
}

/** "310 MB", "1,2 GB". */
export function memoryText(mb: number): string {
  if (mb < 1024) return `${Math.round(mb)} MB`
  return `${(mb / 1024).toFixed(1).replace('.', ',')} GB`
}

/** "5 rodando · 1 pede atenção · 2 parados · ~1,2 GB": only the parts that are not zero. */
export function summaryText(list: readonly ProcState[]): string {
  const n = (g: GroupId): number => list.filter(p => groupOf(p.status) === g).length
  const running = n('running'), attention = n('attention'), stopped = n('stopped')
  const mb = list.reduce((sum, p) => sum + (isLive(p) ? p.memoryMB ?? 0 : 0), 0)
  return [
    running ? `${running} rodando` : '',
    attention ? `${attention} ${attention === 1 ? 'pede' : 'pedem'} atenção` : '',
    stopped ? `${stopped} ${stopped === 1 ? 'parado' : 'parados'}` : '',
    mb > 0 ? `~${memoryText(mb)}` : '',
  ].filter(Boolean).join(' · ')
}

/** The icon's badge: how many ask for attention (ended by themselves or with the host, and nobody looked yet). */
export function procBadge(list: readonly ProcState[]): { count: number; attention: true; tooltip: string } | undefined {
  const count = list.filter(p => p.attention).length
  if (!count) return undefined
  return { count, attention: true, tooltip: count === 1 ? '1 processo pede atenção' : `${count} processos pedem atenção` }
}

const hhmm = (iso: string): string => clockTime(iso).slice(0, 5)

/** The right side of the row's first line: "rodando há 2 h", "encerrou sozinho 13:41 (1)", "parado 13:41". */
export function whenText(p: ProcState, now = Date.now()): string {
  if (p.status === 'running') {
    const rel = p.startedAt ? relativeTime(p.startedAt, now) : ''
    return rel && rel !== '-' ? `rodando ${rel}` : 'rodando'
  }
  if (p.status === 'stopping') return 'parando…'
  if (p.status === 'failed') return statusText(p)
  const base = statusText({ status: p.status })
  const at = p.exit?.at ? ` ${hhmm(p.exit.at)}` : ''
  const code = p.status === 'exited' && typeof p.exit?.code === 'number' ? ` (${p.exit.code})` : ''
  return `${base}${at}${code}`
}

/** The row's status mark: the dot of a live one, the warning of one that asks for attention, the hollow dot of a stopped one. */
export function markOf(p: ProcState): 'live' | 'warn' | 'idle' {
  const g = groupOf(p.status)
  return g === 'running' ? 'live' : g === 'attention' ? 'warn' : 'idle'
}

/** A declared port as the row shows it: a link `localhost:3000 ✓` while it listens, `:3000` otherwise. */
export interface PortView { port: number; listening: boolean; text: string; url?: string }

export function portViews(p: ProcState): PortView[] {
  const probed = p.ports ?? p.card.ports.map(port => ({ port, listening: false }))
  return probed.map(({ port, listening }) => listening
    ? { port, listening, text: `localhost:${port} ✓`, url: `http://localhost:${port}` }
    : { port, listening, text: `:${port}` })
}

/** An author as a chip: the panel's current name when the pane still exists (clicking focuses it), else the portrait's. */
export interface ChipView { text: string; slotId?: string; focusable: boolean; icon: 'agent' | 'shell' | 'person' | 'outside' }

export function chipOf(by: ProcAuthor | undefined, pane: { name: string } | undefined): ChipView {
  if (!by) return { text: '?', focusable: false, icon: 'outside' }
  if (by.kind === 'app') return { text: 'você', focusable: false, icon: 'person' }
  if (by.kind === 'external') return { text: by.label ?? by.user ?? 'externo', focusable: false, icon: 'outside' }
  const text = pane?.name ?? by.name ?? by.slotId ?? 'painel'
  return { text, ...(by.slotId ? { slotId: by.slotId } : {}), focusable: !!pane && !!by.slotId, icon: by.kind === 'shell' ? 'shell' : 'agent' }
}

/** "até 14:20" of a use. */
export const untilText = (u: UseView): string => `até ${hhmm(u.until)}`

export type RowAction = 'output' | 'start' | 'stop' | 'restart'
export const ACTION_LABELS: Record<RowAction, string> = { output: 'Ver saída', start: 'Iniciar', stop: 'Parar', restart: 'Reiniciar' }

/** The labelled buttons of a row: a live one can be watched, restarted, stopped; any other watched or started. */
export function rowActions(p: Pick<ProcState, 'status'>): RowAction[] {
  if (p.status === 'stopping') return ['output']
  return isLive(p) ? ['output', 'restart', 'stop'] : ['output', 'start']
}

export type MenuAction = 'copy-command' | 'history' | 'hold' | 'release' | 'forget'
export const MENU_LABELS: Record<MenuAction, string> = {
  'copy-command': 'Copiar comando', history: 'Histórico', hold: 'Segurar por 15 min', release: 'Soltar', forget: 'Esquecer',
}

/** The person holds it (a use declared from the app). */
export const heldByPerson = (p: Pick<ProcState, 'uses'>): boolean => (p.uses ?? []).some(u => u.by.kind === 'app')

/** The "⋯" items: copy the command, the history, hold (or let go of) the person's use, forget (only stopped). */
export function menuActions(p: ProcState): MenuAction[] {
  return [
    'copy-command', 'history',
    ...(isLive(p) ? [heldByPerson(p) ? 'release' as const : 'hold' as const] : heldByPerson(p) ? ['release' as const] : []),
    ...(isLive(p) ? [] : ['forget' as const]),
  ]
}

/** The command line, each argument with a space or a quote quoted. */
export function commandLine(card: Pick<ProcCard, 'command' | 'args'>): string {
  return [card.command, ...card.args].map(a => /[\s"]/.test(a) || a === '' ? `"${a.replace(/"/g, '\\"')}"` : a).join(' ')
}

/** The uses of others (not the person's): they are what makes a stop or restart ask first. */
export const othersUses = (p: Pick<ProcState, 'uses'>): UseView[] => (p.uses ?? []).filter(u => u.by.kind !== 'app')

/**
 * The dialog of a stop or restart that others' uses refused: who uses it, until when, for what; waiting is the default,
 * going ahead now is destructive and never the default; Esc cancels.
 */
export function inUseDialog(name: string, action: 'stop' | 'restart', uses: readonly UseView[]): DialogSpec {
  const verb = action === 'stop' ? 'parar' : 'reiniciar'
  const now = action === 'stop' ? 'Parar agora' : 'Reiniciar agora'
  return {
    situation: 'processes-in-use',
    tone: 'warn',
    icon: 'warning',
    title: `${name} está em uso`,
    message: `Quem usa declarou que depende dele. Você pode esperar o uso acabar ou ${verb} agora mesmo assim.`,
    context: { icon: 'pulse', name, lines: uses.map(useText), status: { label: uses.length === 1 ? 'em uso' : `${uses.length} usos`, tone: 'warn' } },
    choices: [
      { id: 'wait', icon: 'hourglass', label: 'Esperar o uso acabar', consequence: `O tether espera até 5 min os usos acabarem e então vai ${verb}. Se não acabarem, nada é feito.`, tone: 'safe' },
      { id: 'force', icon: action === 'stop' ? 'stop-circle' : 'arrow-clockwise', label: now, consequence: `Vai ${verb} já, por cima do uso. Quem usa recebe um recado dizendo que foi uma decisão sua.`, tone: 'destructive' },
    ],
    defaultChoice: 'wait',
    cancelLabel: 'Cancelar',
  }
}

/** The row's line while tetherd holds a stop or restart until the uses end. */
export function waitingText(until: number): string {
  return `esperando o uso acabar (até ${hhmm(new Date(until).toISOString())}); se não acabar, nada é feito`
}

/** One row of the ports view. */
export interface PortRowView { port: number; listening: boolean; proc?: string; who: string; declared: string }

export function portRowView(r: PortRow): PortRowView {
  const declared = (r.declaredBy ?? []).map(d => `${d.name} (${statusText({ status: d.status })})`).join(', ')
  return {
    port: r.port,
    listening: r.listening,
    ...(r.listening && r.owner?.proc ? { proc: r.owner.proc } : {}),
    who: r.listening ? (r.owner?.proc ?? ownerText(r)) : 'livre',
    declared: declared ? `declarada por ${declared}` : '',
  }
}

/** One line of the timeline: time with seconds (to cross with the log), who, what, why. */
export interface TimelineItem { time: string; who: string; what: string; reason?: string }

export function timelineItem(e: ProcEvent): TimelineItem {
  return { time: clockTime(e.ts), who: e.by ? authorText(e.by) : 'tether', what: eventText(e), ...(e.reason ? { reason: e.reason } : {}) }
}

/** The separator written in the output when a new run starts. */
export const runSeparator = (run: number): string => `── execução ${run} ──`
