// The "Sessões" menu as data, pure (no DOM, no node:*): rows with turn state and "sem guia", the icon's counter, the
// summary, the bulk-close batch and the short Portuguese texts. Absorbs the old closed-slots model (groupClosed,
// forgetEndedSituation). A "guia" is a tab (pane) showing the session.
import type { SlotState } from '../../src/daemon/protocol.ts'
import type { PauseBatch } from '../../src/daemon/pause.ts'
import type { DialogSpec } from '../shared/dialog.ts'
import { buttonTitle as pauseButtonTitle, counter as pauseCounter, hasBatch, orderedEntries, pauseAction } from './pause-rules.ts'

export { pauseAction }

/** What the model needs of a slot. `idleSince` (ISO: idle since) and `endedAt` (ISO: process ended) are absent on older daemons. */
export type SessionSlot = Pick<SlotState, 'slotId' | 'cwd' | 'status'> &
  Partial<Pick<SlotState, 'name' | 'title' | 'attention' | 'turn' | 'kind' | 'binding'>> & { idleSince?: string; endedAt?: string; busySince?: string; memoryMB?: number }

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
    message: 'Elas somem do Tether. Nenhuma está rodando; as conversas continuam no histórico do agente e podem ser retomadas por lá.',
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

const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']

/** "420 MB" (rounded) below 1 GB, "1,2 GB" from there. Invalid or non-positive reads as empty. */
export function formatMemory(mb: number | undefined): string {
  if (mb === undefined || !Number.isFinite(mb) || mb <= 0) return ''
  const rounded = Math.round(mb)
  if (rounded < 1024) return `${rounded} MB`
  return `${(mb / 1024).toFixed(1).replace('.', ',')} GB`
}

/** "encerrada há 2 h", "encerrada ontem", and from a week on the date: "encerrada em 3 nov". */
export function endedText(ms: number, endedAt: number): string {
  if (ms >= 7 * 24 * 60 * 60_000) {
    const d = new Date(endedAt)
    return `encerrada em ${d.getDate()} ${MONTHS[d.getMonth()]}`
  }
  return `encerrada ${formatAgo(ms)}`
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
  /** Working set of the session's process tree, formatted ("420 MB"); empty when unknown or ended. */
  memory: string
  /** Eligible for "Encerrar os N ociosos sem guia" (idle, no tab, and not held). */
  cleanup: boolean
  /** What makes the session worth keeping ("dono de 2 mesas"), when something does: an extension's word. */
  held?: string
  /** Idle enough for the bulk close but held: left out of it. */
  spared: boolean
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
    case 'busy': {
      const busy = sinceMs(s.busySince, now)
      return busy === undefined ? 'trabalhando agora' : `trabalhando ${formatAgo(busy)}`
    }
    case 'idle': {
      const idle = sinceMs(s.idleSince, now)
      return idle === undefined ? 'ocioso' : `ocioso ${formatAgo(idle)}`
    }
    case 'ended': {
      const ended = sinceMs(s.endedAt, now)
      return ended === undefined ? 'encerrada' : endedText(ended, Date.parse(s.endedAt!))
    }
  }
}

const RANK: Record<TurnState, number> = { attention: 0, busy: 1, idle: 2, ended: 3 }

/** Rows in display order: attention, busy, idle (longest idle first), ended (most recent first); stable otherwise. */
export function sessionRows(slots: Iterable<SessionSlot>, hasTab: (slotId: string) => boolean, now: number, heldOf: (slotId: string) => string | undefined = () => undefined): SessionRow[] {
  const rows = [...slots].map((slot, i) => {
    const state = turnState(slot)
    const idle = isIdleForCleanup(slot, now, hasTab)
    const held = state === 'ended' ? undefined : heldOf(slot.slotId)
    const row: SessionRow = {
      slotId: slot.slotId,
      name: displayName(slot),
      state,
      noTab: state !== 'ended' && !hasTab(slot.slotId),
      text: rowText(slot, state, now),
      memory: state === 'ended' ? '' : formatMemory(slot.memoryMB),
      cleanup: idle && !held,
      ...(held ? { held } : {}),
      spared: idle && !!held,
      slot,
    }
    const at = Date.parse((state === 'ended' ? slot.endedAt : slot.idleSince) ?? '')
    return { row, i, at: Number.isNaN(at) ? undefined : at }
  })
  rows.sort((a, b) => {
    if (RANK[a.row.state] !== RANK[b.row.state]) return RANK[a.row.state] - RANK[b.row.state]
    // idle: oldest first (the cleanup candidates), by the minute the row shows; ended: newest first
    const bucket = (r: typeof a): number | undefined => (r.at === undefined ? undefined : r.row.state === 'idle' ? Math.floor(r.at / 60_000) : r.at)
    const ba = bucket(a)
    const bb = bucket(b)
    if (ba !== undefined && bb !== undefined && ba !== bb) return a.row.state === 'ended' ? bb - ba : ba - bb
    if ((a.at === undefined) !== (b.at === undefined)) return a.at === undefined ? 1 : -1
    // tie-break among idle sessions: the heaviest first, so cleaning up frees the most
    if (a.row.state === 'idle') {
      const d = (b.row.slot.memoryMB ?? 0) - (a.row.slot.memoryMB ?? 0)
      if (d !== 0) return d
    }
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
  /** How many idle ones the bulk close leaves alone because they own desks or panes, or belong to a channel. */
  spared: number
  /** "2 poupados: são donos ou membros de canal"; empty when none was spared. */
  hint: string
}

/** The hint under the bulk button when owners and channel members were left out. */
export function sparedHint(spared: number): string {
  if (spared <= 0) return ''
  return `${spared} ${spared === 1 ? 'poupado' : 'poupados'}: ${spared === 1 ? 'é dono ou membro de canal' : 'são donos ou membros de canal'}`
}

/** "Encerrar os N ociosos sem guia": the rows flagged `cleanup`, with their names for the single confirmation. */
export function bulkCloseAction(rows: readonly SessionRow[]): BulkCloseAction {
  const names = rows.filter(r => r.cleanup).map(r => r.name)
  const n = names.length
  const spared = rows.filter(r => r.spared).length
  const hint = sparedHint(spared)
  if (n === 0) return { label: 'Nenhum ocioso sem guia para encerrar', n, names, enabled: false, spared, hint }
  return { label: n === 1 ? 'Encerrar o ocioso sem guia' : `Encerrar os ${n} ociosos sem guia`, n, names, enabled: true, spared, hint }
}

/** "Encerrar mesmo assim?": the single confirmation of stopping, one by one, a session something depends on. */
export function stopHeldSituation(name: string, held: string): DialogSpec {
  return {
    situation: 'stop-held',
    tone: 'warn',
    icon: 'warning',
    title: `${name} é ${held}. Encerrar mesmo assim?`,
    message: 'Encerrar termina o processo; o que ele possui deixa de ter quem o comande.',
    context: { icon: 'robot', name, lines: [held] },
    choices: [{ id: 'close', icon: 'power', label: 'Encerrar mesmo assim', consequence: 'O processo termina. A conversa fica guardada em Encerradas e pode ser reaberta.', tone: 'destructive' }],
    cancelLabel: 'Cancelar',
  }
}

// ---------- icon counter ----------

export interface CounterSegment {
  /** attention = orange, running = green (sessions), idle = neutral (sessions), progress = blue (pause going), done = green (pause ready). */
  tone: 'attention' | 'running' | 'idle' | 'progress' | 'done'
  text: string
}

/**
 * What the icon shows, at most two segments. The first counts every live session without a tab (text = the total) and
 * takes the tone of the most urgent one: attention, else running (busy), else idle. A pause on screen adds its own
 * segment after it (blue x/y, green y/y) and does not hide the first. No live session without a tab and no pause = none.
 * Ended sessions and sessions with a tab are not counted.
 */
export function sessionsCounter(slots: Iterable<SessionSlot>, hasTab: (slotId: string) => boolean, batch: PauseBatch | null | undefined): CounterSegment[] {
  let total = 0
  let attention = false
  let busy = false
  for (const s of slots) {
    if (!isLive(s) || hasTab(s.slotId)) continue
    total++
    if (s.attention) attention = true
    else if (s.turn === 'busy') busy = true
  }
  const out: CounterSegment[] = []
  if (total > 0) out.push({ tone: attention ? 'attention' : busy ? 'running' : 'idle', text: String(total) })
  if (hasBatch(batch)) {
    const c = pauseCounter(batch)
    if (c.total > 0) out.push({ tone: c.stopped === c.total ? 'done' : 'progress', text: `${c.stopped}/${c.total}` })
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
  let noTabMB = 0
  for (const s of slots) {
    if (!isLive(s)) {
      if (!hasTab(s.slotId)) ended++
      continue
    }
    if (s.attention) attention++
    else if (s.turn === 'busy') busy++
    if (!hasTab(s.slotId)) { noTab++; noTabMB += s.memoryMB ?? 0 }
  }
  const parts: string[] = []
  if (busy > 0) parts.push(`${busy} em andamento`)
  if (attention > 0) parts.push(attention === 1 ? '1 pede atenção' : `${attention} pedem atenção`)
  if (noTab > 0) parts.push([`${noTab} sem guia`, formatMemory(noTabMB)].filter(Boolean).join(' · '))
  if (ended > 0) parts.push(`${ended} ${ended === 1 ? 'encerrada' : 'encerradas'}`)
  const header = parts.length > 0 ? parts.join(' · ') : 'Nenhuma sessão'
  const tooltip = hasBatch(batch) ? `Sessões: ${header}. ${pauseButtonTitle(batch)}` : `Sessões: ${header}`
  return { header, tooltip }
}

/** Total memory of the live sessions (with or without a tab), formatted; empty when nothing was measured. */
export function liveMemoryTotal(slots: Iterable<SessionSlot>): string {
  let mb = 0
  for (const s of slots) if (isLive(s)) mb += s.memoryMB ?? 0
  return formatMemory(mb)
}

/** "Pedir pausa gentil primeiro" in the quit-all dialog: what it does, with the number of agents mid-turn. */
export function pauseFirstConsequence(busy: number): string {
  const who = busy === 1 ? 'Pede ao agente em andamento' : `Pede aos ${busy} agentes em andamento`
  return `${who} que pare no seu passo e abre o Acompanhar. Nada é encerrado agora.`
}

// ---------- the "Sessões" popup (what is running, and what a pause or a resume would touch) ----------

/** Last two segments of a folder, "work/tether": enough to tell sessions apart in a narrow list. */
export function shortFolder(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean)
  return parts.length <= 2 ? parts.join('/') || cwd : parts.slice(-2).join('/')
}

export type PopupGroupId = 'attention' | 'busy' | 'idle' | 'pause' | 'outside'

export interface PopupGroup {
  id: PopupGroupId
  title: string
  /** Display order. The pause group lists the batch's entries (a session may be gone from the slots); the others, live sessions. */
  slotIds: string[]
}

const GROUP_OF: Record<Exclude<TurnState, 'ended'>, PopupGroupId> = { attention: 'attention', busy: 'busy', idle: 'idle' }
const GROUP_TITLE: Record<PopupGroupId, string> = {
  attention: 'Pedem atenção', busy: 'Em andamento', idle: 'Ociosas', pause: 'Na pausa', outside: 'Fora da pausa',
}

/**
 * The popup's groups from the rows (sessionRows order; ended ones are not shown here). Without a pause: attention, busy,
 * idle. With one: the batch's sessions first ("Na pausa", in the pause's order), then every other live session together
 * ("Fora da pausa"). Empty groups are left out.
 */
export function popupGroups(rows: readonly SessionRow[], batch: PauseBatch | null | undefined): PopupGroup[] {
  const live = rows.filter(r => r.state !== 'ended')
  const out: PopupGroup[] = []
  if (hasBatch(batch)) {
    const inBatch = orderedEntries(batch).map(e => e.slotId)
    const member = new Set(inBatch)
    if (inBatch.length > 0) out.push({ id: 'pause', title: GROUP_TITLE.pause, slotIds: inBatch })
    const rest = live.filter(r => !member.has(r.slotId)).map(r => r.slotId)
    if (rest.length > 0) out.push({ id: 'outside', title: GROUP_TITLE.outside, slotIds: rest })
    return out
  }
  for (const id of ['attention', 'busy', 'idle'] as const) {
    const slotIds = live.filter(r => r.state !== 'ended' && GROUP_OF[r.state] === id).map(r => r.slotId)
    if (slotIds.length > 0) out.push({ id, title: GROUP_TITLE[id], slotIds })
  }
  return out
}

/** The chosen session while it is still on the list, else the first row of the first group. */
export function resolvePopupSelection(groups: readonly PopupGroup[], slotId: string | undefined): string | undefined {
  if (slotId && groups.some(g => g.slotIds.includes(slotId))) return slotId
  return groups[0]?.slotIds[0]
}

export interface PausePreview {
  /** Mid-turn sessions: the ones that would get the request. */
  n: number
  enabled: boolean
  /** "Vão receber o pedido: 3 em andamento · 5 ociosas não são afetadas". */
  text: string
  /** "Pedir pausa aos 3 em andamento". */
  buttonLabel: string
}

/** Before asking for a pause: who gets the request and who does not. Counts live sessions, with or without a tab. */
export function pausePreview(slots: Iterable<SessionSlot>): PausePreview {
  const list = [...slots].filter(isLive)
  const act = pauseAction(list, null)
  const idle = list.filter(s => s.turn !== 'busy' && !s.attention).length
  const attention = list.filter(s => s.turn !== 'busy' && s.attention).length
  const others = idle + attention
  if (list.length === 0) return { n: 0, enabled: false, text: 'Nenhuma sessão rodando agora', buttonLabel: act.label }
  if (act.n === 0) return { n: 0, enabled: false, text: 'Ninguém em andamento agora: não há o que pausar', buttonLabel: act.label }
  const who: string[] = []
  if (idle > 0) who.push(idle === 1 ? '1 ociosa' : `${idle} ociosas`)
  if (attention > 0) who.push(`${attention} pedindo atenção`)
  const head = act.n === 1 ? 'Vai receber o pedido: 1 em andamento' : `Vão receber o pedido: ${act.n} em andamento`
  const tail = others > 0 ? ` · ${who.join(' e ')} ${others === 1 ? 'não é afetada' : 'não são afetadas'}` : ''
  return { n: act.n, enabled: true, text: head + tail, buttonLabel: act.label }
}

export interface ResumePreview {
  returning: number
  /** Of those, how many have a note to resume from. */
  withNote: number
  skipped: { slotId: string; reason: string }[]
  /** "Vão voltar: 3, cada uma com sua nota". */
  text: string
  /** "1 não volta: ocupada", empty when everyone returns. */
  skippedText: string
}

/** Why the daemon would skip a resume right now (mirrors Server.resumeOne), in the short form shown to people. */
function skipWhy(s: SessionSlot | undefined): string | undefined {
  if (!s) return 'não existe mais'
  if (!isLive(s)) return 'não está rodando'
  if (s.turn === 'busy') return 'ocupada'
  if (s.attention === 'waiting') return 'esperando você'
  return undefined
}

// ---------- the rows' actions: where a session goes, and the right-click menus ----------

/** The two groups of rows that have a tab-less session. */
export type RowGroup = 'free' | 'ended'

/** What a row's menu items do (main.ts maps each to a function). */
export type RowAction = 'peek' | 'open-here' | 'open-other' | 'stop' | 'reopen' | 'reopen-here' | 'reopen-other' | 'forget' | 'rename'

export interface RowMenuItem {
  action: RowAction
  label: string
  /** A submenu row (the desks, a separator, "Escolher o lugar…"). */
  submenu?: boolean
  danger?: boolean
  /** A separator line goes before it. */
  sepBefore?: boolean
}

/** The right-click menu of a row: "Sem guia" peeks, opens here or elsewhere, stops; "Encerradas" revives without a tab, here, elsewhere, or forgets. */
export function rowMenuPlan(group: RowGroup): RowMenuItem[] {
  if (group === 'free') {
    return [
      { action: 'peek', label: 'Espiar' },
      { action: 'open-here', label: 'Abrir nesta mesa' },
      { action: 'open-other', label: 'Abrir em outra mesa', submenu: true },
      { action: 'rename', label: 'Renomear…', sepBefore: true },
      { action: 'stop', label: 'Encerrar…', danger: true, sepBefore: true },
    ]
  }
  return [
    { action: 'reopen', label: 'Reabrir' },
    { action: 'reopen-here', label: 'Reabrir nesta mesa' },
    { action: 'reopen-other', label: 'Reabrir em outra mesa', submenu: true },
    { action: 'forget', label: 'Esquecer', danger: true, sepBefore: true },
  ]
}

/** The last row of every "in another desk" list, after a separator: the move screen decides the exact place. */
export const CHOOSE_PLACE_LABEL = 'Escolher o lugar…'
/** The list's heading ("Abrir em outra mesa") and the button that opens it. */
export const OPEN_ELSEWHERE_LABEL = 'Abrir em outra mesa'

export interface DeskChoice {
  id: string
  label: string
  /** The desk the person is on (marked in the list; picking it opens the session there, as "nesta mesa" does). */
  current: boolean
}

/** The desks as the list shows them, in the strip's order; a nameless one reads "Mesa N". */
export function deskChoices(desks: readonly { id: string; name: string }[], currentId: string): DeskChoice[] {
  return desks.map((d, i) => ({ id: d.id, label: d.name.trim() || `Mesa ${i + 1}`, current: d.id === currentId }))
}

/** Before "Retomar": who goes back (and with which note) and who would be skipped, from the sessions' state right now. */
export function resumePreview(batch: PauseBatch | null | undefined, slots: Iterable<SessionSlot>): ResumePreview {
  const bySlot = new Map<string, SessionSlot>()
  for (const s of slots) bySlot.set(s.slotId, s)
  let returning = 0
  let withNote = 0
  const skipped: ResumePreview['skipped'] = []
  for (const e of hasBatch(batch) ? orderedEntries(batch) : []) {
    if (e.state !== 'stopped' && e.state !== 'stopped-silent') continue
    const why = skipWhy(bySlot.get(e.slotId))
    if (why) { skipped.push({ slotId: e.slotId, reason: why }); continue }
    returning++
    if (e.state === 'stopped' && e.note) withNote++
  }
  let text: string
  if (returning === 0) text = 'Nenhuma sessão volta agora'
  else if (withNote === returning) text = returning === 1 ? 'Vai voltar: 1, com a sua nota' : `Vão voltar: ${returning}, cada uma com sua nota`
  else text = returning === 1 ? 'Vai voltar: 1, sem nota' : `Vão voltar: ${returning} · ${withNote} com nota`
  let skippedText = ''
  if (skipped.length > 0) {
    const counts = new Map<string, number>()
    for (const s of skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1)
    const list = [...counts].map(([r, n]) => (skipped.length === 1 ? r : `${n} ${r}`)).join(', ')
    skippedText = skipped.length === 1 ? `1 não volta: ${list}` : `${skipped.length} não voltam: ${list}`
  }
  return { returning, withNote, skipped, text, skippedText }
}
