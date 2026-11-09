// The "Sessões" menu as data, pure (no DOM, no node:*): rows with turn state and "sem guia", the icon's counter, the
// summary, the bulk-close batch and the short Portuguese texts. Absorbs the old closed-slots model (groupClosed,
// forgetEndedSituation). A "guia" is a tab (pane) showing the session.
import type { SlotState } from '../../src/daemon/protocol.ts'
import type { PauseBatch } from '../../src/daemon/pause.ts'
import type { DialogSpec } from '../shared/dialog.ts'
import { buttonTitle as pauseButtonTitle, counter as pauseCounter, hasBatch, pauseAction } from './pause-rules.ts'

export { pauseAction }

/** What the model needs of a slot. `idleSince` (ISO: idle since) and `endedAt` (ISO: process ended) are absent on older daemons. */
export type SessionSlot = Pick<SlotState, 'slotId' | 'cwd' | 'status'> &
  Partial<Pick<SlotState, 'name' | 'title' | 'attention' | 'turn'>> & { idleSince?: string; endedAt?: string }

export type TurnState = 'attention' | 'busy' | 'idle' | 'ended'

/** Idle for at least this long (and nothing else going on) makes a session a candidate for the bulk close. */
export const IDLE_CLEANUP_MS = 10 * 60 * 1000

/** A process is alive (or about to be). Same rule as situations.ts, kept here so the model stays free of the icon imports. */
const isLive = (s: { status: SlotState['status'] }): boolean => s.status === 'running' || s.status === 'starting' || s.status === 'queued'

// ---------- grouping (moved from closed-slots.ts) ----------

export interface ClosedGroups {
  running: SlotState[]
  ended: SlotState[]
}

/** Splits the slots that have no pane into the two groups, each keeping the daemon's order. */
export function groupClosed(slots: Iterable<SlotState>, hasPane: (slotId: string) => boolean): ClosedGroups {
  const running: SlotState[] = []
  const ended: SlotState[] = []
  for (const s of slots) {
    if (hasPane(s.slotId)) continue
    ;(isLive(s) ? running : ended).push(s)
  }
  return { running, ended }
}

/** "Esquecer todas as encerradas": one question for the whole batch. Nothing live is in it, so nothing is stopped. */
export function forgetEndedSituation(count: number): DialogSpec {
  const many = count === 1 ? '1 sessão encerrada' : `${count} sessões encerradas`
  return {
    situation: 'forget-ended',
    tone: 'warn',
    icon: 'trash',
    title: `Esquecer ${many}?`,
    message: 'Elas somem do tether. Nenhuma está rodando; as conversas continuam no histórico do agente e podem ser retomadas por lá.',
    choices: [{ id: 'forget', icon: 'trash', label: count === 1 ? 'Esquecer a sessão' : `Esquecer as ${count} sessões`, consequence: 'Remove da lista de Encerradas. Não dá para desfazer.', tone: 'destructive' }],
    cancelLabel: 'Cancelar',
  }
}

/** "Encerrar os N ociosos sem guia": the single confirmation, listing the names. Stopping keeps the conversations. */
export function bulkCloseSituation(names: readonly string[]): DialogSpec {
  const n = names.length
  const shown = names.slice(0, 12)
  const lines = n > shown.length ? [...shown, `e mais ${n - shown.length}`] : shown
  return {
    situation: 'bulk-close',
    tone: 'info',
    icon: 'tray',
    title: n === 1 ? 'Encerrar a sessão ociosa sem guia?' : `Encerrar as ${n} sessões ociosas sem guia?`,
    message: 'Nenhuma está trabalhando nem pede atenção.',
    context: { icon: 'tray', name: n === 1 ? '1 sessão' : `${n} sessões`, lines },
    choices: [{ id: 'close', icon: 'power', label: n === 1 ? 'Encerrar a sessão' : `Encerrar as ${n} sessões`, consequence: 'O processo termina. As conversas ficam guardadas em Encerradas e podem ser reabertas.', tone: 'neutral' }],
    cancelLabel: 'Cancelar',
  }
}

// ---------- time ----------

/** Short Portuguese span: "agora", "há 5 min", "há 2 h", "ontem", "há 3 dias". Negative or invalid reads as "agora". */
export function formatAgo(ms: number): string {
  const t = Number.isFinite(ms) && ms > 0 ? ms : 0
  const min = Math.floor(t / 60_000)
  if (min < 1) return 'agora'
  if (min < 60) return `há ${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `há ${h} h`
  const d = Math.floor(h / 24)
  return d < 2 ? 'ontem' : `há ${d} dias`
}

const sinceMs = (iso: string | undefined, now: number): number | undefined => {
  if (!iso) return undefined
  const t = Date.parse(iso)
  return Number.isNaN(t) ? undefined : Math.max(0, now - t)
}

// ---------- rows ----------

export interface SessionRow {
  slotId: string
  name: string
  state: TurnState
  /** Live and with no tab showing it (an ended session is never "sem guia"; it is just closed). */
  noTab: boolean
  /** Short line: "trabalhando agora", "pede atenção", "ocioso há 2 h", "encerrada ontem". */
  text: string
  /** Eligible for "Encerrar os N ociosos sem guia". */
  cleanup: boolean
  slot: SessionSlot
}

export function turnState(s: SessionSlot): TurnState {
  if (!isLive(s)) return 'ended'
  if (s.attention) return 'attention'
  return s.turn === 'busy' ? 'busy' : 'idle'
}

function displayName(s: SessionSlot): string {
  const named = s.name?.trim() || s.title?.trim()
  if (named) return named
  const parts = s.cwd.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? s.slotId
}

/** Live, no tab, not mid-turn, no attention, idle for at least 10 minutes. No `idleSince` means not eligible. */
export function isIdleForCleanup(s: SessionSlot, now: number, hasTab: (slotId: string) => boolean = () => false): boolean {
  if (!isLive(s) || hasTab(s.slotId) || s.turn === 'busy' || s.attention) return false
  const idle = sinceMs(s.idleSince, now)
  return idle !== undefined && idle >= IDLE_CLEANUP_MS
}

function rowText(s: SessionSlot, state: TurnState, now: number): string {
  switch (state) {
    case 'attention': return 'pede atenção'
    case 'busy': return 'trabalhando agora'
    case 'idle': {
      const idle = sinceMs(s.idleSince, now)
      return idle === undefined ? 'ocioso' : `ocioso ${formatAgo(idle)}`
    }
    case 'ended': {
      const ended = sinceMs(s.endedAt, now)
      return ended === undefined ? 'encerrada' : `encerrada ${formatAgo(ended)}`
    }
  }
}

const RANK: Record<TurnState, number> = { attention: 0, busy: 1, idle: 2, ended: 3 }

/** Rows in display order: attention, busy, idle (longest idle first), ended (most recent first); stable otherwise. */
export function sessionRows(slots: Iterable<SessionSlot>, hasTab: (slotId: string) => boolean, now: number): SessionRow[] {
  const rows = [...slots].map((slot, i) => {
    const state = turnState(slot)
    const row: SessionRow = {
      slotId: slot.slotId,
      name: displayName(slot),
      state,
      noTab: state !== 'ended' && !hasTab(slot.slotId),
      text: rowText(slot, state, now),
      cleanup: isIdleForCleanup(slot, now, hasTab),
      slot,
    }
    const at = Date.parse((state === 'ended' ? slot.endedAt : slot.idleSince) ?? '')
    return { row, i, at: Number.isNaN(at) ? undefined : at }
  })
  rows.sort((a, b) => {
    if (RANK[a.row.state] !== RANK[b.row.state]) return RANK[a.row.state] - RANK[b.row.state]
    if (a.at !== undefined && b.at !== undefined && a.at !== b.at) {
      // idle: oldest first (the cleanup candidates); ended: newest first
      return a.row.state === 'ended' ? b.at - a.at : a.at - b.at
    }
    if ((a.at === undefined) !== (b.at === undefined)) return a.at === undefined ? 1 : -1
    return a.i - b.i
  })
  return rows.map(r => r.row)
}

// ---------- bulk close ----------

export interface BulkCloseAction {
  label: string
  n: number
  names: string[]
  enabled: boolean
}

/** "Encerrar os N ociosos sem guia": the rows flagged `cleanup`, with their names for the single confirmation. */
export function bulkCloseAction(rows: readonly SessionRow[]): BulkCloseAction {
  const names = rows.filter(r => r.cleanup).map(r => r.name)
  const n = names.length
  if (n === 0) return { label: 'Nenhum ocioso sem guia para encerrar', n, names, enabled: false }
  return { label: n === 1 ? 'Encerrar o ocioso sem guia' : `Encerrar os ${n} ociosos sem guia`, n, names, enabled: true }
}

// ---------- icon counter ----------

export interface CounterSegment {
  /** attention = orange, running = green (sessions), progress = blue (pause going), done = green (pause ready). */
  tone: 'attention' | 'running' | 'progress' | 'done'
  text: string
}

/**
 * What the icon shows, at most two segments, only what asks for action. Orange K (sem guia pedindo atenção) always shows
 * and beats the green N (sem guia rodando); a pause on screen adds its own segment (blue x/y, green y/y). Calm = none.
 * Ended sessions and sessions with a tab are not counted.
 */
export function sessionsCounter(slots: Iterable<SessionSlot>, hasTab: (slotId: string) => boolean, batch: PauseBatch | null | undefined): CounterSegment[] {
  let attention = 0
  let running = 0
  for (const s of slots) {
    if (!isLive(s) || hasTab(s.slotId)) continue
    if (s.attention) attention++
    else if (s.turn === 'busy') running++
  }
  const out: CounterSegment[] = []
  if (attention > 0) out.push({ tone: 'attention', text: String(attention) })
  if (hasBatch(batch)) {
    const c = pauseCounter(batch)
    if (c.total > 0) out.push({ tone: c.stopped === c.total ? 'done' : 'progress', text: `${c.stopped}/${c.total}` })
  } else if (attention === 0 && running > 0) {
    out.push({ tone: 'running', text: String(running) })
  }
  return out
}

// ---------- summary ----------

export interface SessionsSummary {
  /** "3 em andamento · 1 pede atenção · 6 sem guia · 59 encerradas". */
  header: string
  tooltip: string
}

export function sessionsSummary(slots: Iterable<SessionSlot>, hasTab: (slotId: string) => boolean, batch: PauseBatch | null | undefined): SessionsSummary {
  let busy = 0
  let attention = 0
  let noTab = 0
  let ended = 0
  for (const s of slots) {
    if (!isLive(s)) {
      if (!hasTab(s.slotId)) ended++
      continue
    }
    if (s.attention) attention++
    else if (s.turn === 'busy') busy++
    if (!hasTab(s.slotId)) noTab++
  }
  const parts: string[] = []
  if (busy > 0) parts.push(`${busy} em andamento`)
  if (attention > 0) parts.push(attention === 1 ? '1 pede atenção' : `${attention} pedem atenção`)
  if (noTab > 0) parts.push(`${noTab} sem guia`)
  if (ended > 0) parts.push(`${ended} ${ended === 1 ? 'encerrada' : 'encerradas'}`)
  const header = parts.length > 0 ? parts.join(' · ') : 'Nenhuma sessão'
  const tooltip = hasBatch(batch) ? `Sessões: ${header}. ${pauseButtonTitle(batch)}` : `Sessões: ${header}`
  return { header, tooltip }
}

/** "Pedir pausa gentil primeiro" in the quit-all dialog: what it does, with the number of agents mid-turn. */
export function pauseFirstConsequence(busy: number): string {
  const who = busy === 1 ? 'Pede ao agente em andamento' : `Pede aos ${busy} agentes em andamento`
  return `${who} que pare no seu passo e abre o Acompanhar. Nada é encerrado agora.`
}
