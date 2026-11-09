// The polite-pause menu model, pure (the DOM lives in main.ts). Colours: blue = in progress, green = stopped,
// grey = queued. Orange is reserved for attention and is never used here.
import type { PauseBatch, PauseEntry, PauseEntryState } from '../../src/daemon/pause.ts'
// Type-only import: src/daemon/pause.ts reaches node:fs, which the renderer bundle cannot resolve, so the label rule
// is mirrored below (the unit test pins it to derivedLabel).

export type PauseTone = 'progress' | 'stopped' | 'queued' | 'gone'

const IN_PROGRESS = new Set(['listening', 'delivered', 'preparing'])
const STOPPED = new Set(['stopped', 'stopped-silent'])

/** Entries that still take part in the pause (removed ones are out of the batch). */
export function activeEntries(batch: PauseBatch): PauseEntry[] {
  return batch.entries.filter(e => e.state !== 'removed')
}

export function stateTone(state: PauseEntryState): PauseTone {
  if (IN_PROGRESS.has(state)) return 'progress'
  if (STOPPED.has(state) || state === 'resumed' || state === 'resume-skipped') return 'stopped'
  if (state === 'queued') return 'queued'
  return 'gone'
}

export function entryTone(e: PauseEntry): PauseTone {
  return stateTone(e.state)
}

/** CSS variable of the tone. */
export function toneColor(t: PauseTone): string {
  return t === 'progress' ? 'var(--accent)' : t === 'stopped' ? 'var(--ok)' : 'var(--fg-dim)'
}

const RANK: Record<PauseTone, number> = { progress: 0, queued: 1, stopped: 2, gone: 3 }

/** Rows in display order: in progress, queued, stopped (stable inside each group); removed entries are left out. */
export function orderedEntries(batch: PauseBatch): PauseEntry[] {
  return activeEntries(batch)
    .map((e, i) => ({ e, i }))
    .sort((a, b) => RANK[entryTone(a.e)] - RANK[entryTone(b.e)] || a.i - b.i)
    .map(x => x.e)
}

/** Stopped over total, among the active entries. */
export function counter(batch: PauseBatch | null | undefined): { stopped: number; total: number } {
  if (!batch) return { stopped: 0, total: 0 }
  const act = activeEntries(batch)
  return { stopped: act.filter(e => entryTone(e) === 'stopped').length, total: act.length }
}

/** Whether a batch is on screen (the button opens the menu instead of starting a pause). */
export function hasBatch(batch: PauseBatch | null | undefined): batch is PauseBatch {
  return !!batch && batch.state !== 'closed'
}

/** Text beside the pause icon: empty with no batch, "2/5" with one. */
export function counterText(batch: PauseBatch | null | undefined): string {
  if (!hasBatch(batch)) return ''
  const c = counter(batch)
  return `${c.stopped}/${c.total}`
}

export function buttonTitle(batch: PauseBatch | null | undefined): string {
  if (!hasBatch(batch)) return 'Pausar com gentileza: pede a cada agente em andamento que pare no seu passo'
  const c = counter(batch)
  if (batch.state === 'resuming') return `Retomando os agentes (${c.total})`
  if (c.total > 0 && c.stopped === c.total) return `Pausa pronta: ${c.stopped} de ${c.total} pararam`
  return `Pausa em andamento: ${c.stopped} de ${c.total} pararam`
}

/** Resume is enabled when there is something to resume and every active agent has stopped. */
export function canResume(batch: PauseBatch | null | undefined): boolean {
  if (!hasBatch(batch) || batch.state === 'resuming') return false
  const act = activeEntries(batch).filter(e => e.state !== 'resumed' && e.state !== 'resume-skipped')
  return act.length > 0 && act.every(e => STOPPED.has(e.state))
}

/** The plain-language state label ("Ainda finalizando" after 5 minutes). */
const STILL_FINISHING_MS = 5 * 60 * 1000

export function entryLabel(e: PauseEntry, now: number): string {
  switch (e.state) {
    case 'queued': return 'Na fila'
    case 'listening': return 'Pedido enviado'
    case 'delivered':
    case 'preparing':
      if (now - Date.parse(e.since) >= STILL_FINISHING_MS) return 'Ainda finalizando'
      return e.state === 'delivered' ? 'Pedido recebido' : 'Preparando para parar'
    case 'stopped': return 'Parou'
    case 'stopped-silent': return 'Parou sem nota'
    case 'removed': return 'Fora do lote'
    case 'resumed': return 'Retomado'
    case 'resume-skipped': return 'Não retomado'
  }
}

/** The line beside the name: what the agent said while in progress, the note it left when stopped, else the label. */
export function entryText(e: PauseEntry, now: number): string {
  if (e.state === 'stopped' && e.note) return e.note
  if (e.phrase && entryTone(e) === 'progress') return e.phrase
  return entryLabel(e, now)
}

/** Header summary of the menu. */
export function summaryText(batch: PauseBatch, now: number): string {
  const c = counter(batch)
  if (batch.state === 'resuming') return 'Retomando os agentes, um passo de cada vez'
  if (c.total === 0) return 'Ninguém na pausa'
  if (c.stopped === c.total) return c.total === 1 ? 'O agente parou. Pronto para retomar quando quiser.' : `Os ${c.total} agentes pararam. Prontos para retomar quando quiser.`
  const finishing = activeEntries(batch).filter(e => entryLabel(e, now) === 'Ainda finalizando').length
  const base = `${c.stopped} de ${c.total} pararam, os outros estão terminando o passo`
  return finishing > 0 ? `${base} (${finishing} ainda finalizando)` : base
}

/** Gentle message when pause-start finds no agent mid-turn. */
export const NOBODY_BUSY_MESSAGE = 'Nenhum agente está em andamento agora, então não há o que pausar.'

// ---------- management popup ("Acompanhar…") ----------

/** The popup's four tiers, by the width of the window it lives in: phone, narrow, desktop, wide (TV). */
export type PauseTier = 'phone' | 'narrow' | 'desktop' | 'wide'

export function tierOf(width: number): PauseTier {
  if (width < 768) return 'phone'
  if (width < 1280) return 'narrow'
  if (width < 2560) return 'desktop'
  return 'wide'
}

/** The plain label of a state, without the clock ("Ainda finalizando" is entryLabel's, for the current state only). */
export function stateLabel(state: PauseEntryState): string {
  switch (state) {
    case 'queued': return 'Na fila'
    case 'listening': return 'Pedido enviado'
    case 'delivered': return 'Pedido recebido'
    case 'preparing': return 'Preparando para parar'
    case 'stopped': return 'Parou'
    case 'stopped-silent': return 'Parou sem nota'
    case 'removed': return 'Fora do lote'
    case 'resumed': return 'Retomado'
    case 'resume-skipped': return 'Não retomado'
  }
}

/** "12 s", "3 min 05 s", "1 h 05 min", "2 d 03 h". Negative or invalid spans read as zero. */
export function formatElapsed(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0
  const two = (n: number): string => String(n).padStart(2, '0')
  if (total < 60) return `${total} s`
  const min = Math.floor(total / 60)
  if (total < 3600) return `${min} min ${two(total % 60)} s`
  const h = Math.floor(total / 3600)
  if (total < 86_400) return `${h} h ${two(min % 60)} min`
  return `${Math.floor(total / 86_400)} d ${two(h % 24)} h`
}

/** Local wall-clock time, "09:05:07"; empty for an invalid date. */
export function formatClock(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

export interface TimelineItem {
  state: PauseEntryState
  label: string
  tone: PauseTone
  /** ISO time the entry reached this state. */
  at: string
  clock: string
  /** How long it stayed here; for the last item, how long it has been here so far. */
  durationMs: number
  /** The last item: its span is still running. */
  current: boolean
  /** "há 4 min 12 s" for the current item, "durou 1 min 03 s" for the ones left behind. */
  spanText: string
}

/** The state history of an entry, oldest first, with the time spent in each state. An empty history is rebuilt from `state`/`since`. */
export function timeline(e: PauseEntry, now: number): TimelineItem[] {
  const raw = e.history.length > 0 ? e.history : [{ state: e.state, at: e.since }]
  return raw.map((h, i) => {
    const current = i === raw.length - 1
    const start = Date.parse(h.at)
    const end = current ? now : Date.parse(raw[i + 1]!.at)
    const durationMs = Math.max(0, end - start)
    const span = durationMs < 1000 && !current ? 'menos de 1 s' : formatElapsed(durationMs)
    return {
      state: h.state,
      label: current ? entryLabel(e, now) : stateLabel(h.state),
      tone: stateTone(h.state),
      at: h.at,
      clock: formatClock(h.at),
      durationMs,
      current,
      spanText: current ? `há ${span}` : `durou ${span}`,
    }
  })
}

/** The entry to show on the right: the chosen one while it is still in the pause, else the first row on screen. */
export function resolveSelection(batch: PauseBatch | null | undefined, slotId: string | undefined): string | undefined {
  if (!batch) return undefined
  const rows = orderedEntries(batch)
  if (slotId && rows.some(e => e.slotId === slotId)) return slotId
  return rows[0]?.slotId
}

/** Footer line: "3 de 5 já pararam". */
export function followSummary(batch: PauseBatch | null | undefined): string {
  if (!hasBatch(batch)) return 'Nenhuma pausa em andamento'
  const c = counter(batch)
  if (batch.state === 'resuming') return 'Retomando os agentes, um passo de cada vez'
  if (c.total === 0) return 'Ninguém na pausa'
  return c.total === 1 ? `${c.stopped} de 1 já parou` : `${c.stopped} de ${c.total} já pararam`
}

/** How long the pause has been going, "Pausa há 4 min 12 s". */
export function batchElapsedText(batch: PauseBatch, now: number): string {
  return `Pausa há ${formatElapsed(now - Date.parse(batch.createdAt))}`
}

/** Whether "Tirar da fila" makes sense for the entry. */
export function canRemoveEntry(batch: PauseBatch, e: PauseEntry): boolean {
  return batch.state !== 'resuming' && e.state !== 'resumed' && e.state !== 'resume-skipped'
}
