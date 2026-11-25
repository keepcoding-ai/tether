// What the channel's pane shows of a poll (slice E3): pure functions, no DOM, no daemon. The poll's line holds the question, the options
// and who is called; its state (the votes now, or the result) comes apart, from the history or from the `poll` event. The card is
// built here (`cardOf`), the pane only paints it.
import { MISSING_TEXT, OK_OPTIONS, POLL_REASON_MAX, USER, type Line, type PollMissingWhy, type PollResult } from '../rules.ts'
import type { DialogSpec } from '../../../app/shared/dialog.ts'
import type { PollOpenView, PollState } from '../daemon/requests.ts'
import { timeOf } from './view-model.ts'

export { POLL_REASON_MAX }
export type { PollOpenView, PollState }

/** What the pane needs of a `poll` event (the daemon's PollEvent). */
export interface PollHeard { line: Line; poll?: PollOpenView }

/** A voter on an option, as the card names it. */
export interface CardVoter { id: string; name: string; reason?: string; mine: boolean }

export interface CardOption {
  n: number
  text: string
  count: number
  /** The bar's width, 0 to 100 (of the votes cast). */
  pct: number
  voters: CardVoter[]
  mine: boolean
  /** The single winner of a closed poll. */
  winner: boolean
}

export interface CardMissing { id: string; name: string; you: boolean; why?: string }

export interface PollCard {
  seq: number
  state: 'open' | 'closed'
  /** A closed poll the index no longer kept the result of: the card only says it closed. */
  unknown: boolean
  question: string
  author: string
  mineAuthor: boolean
  kind: 'ok' | 'choice'
  kindLabel: string
  options: CardOption[]
  /** Votes cast and people called (who left and did not vote does not count). */
  voted: number
  called: number
  /** The progress bar, 0 to 100. */
  progress: number
  tie: boolean
  /** Open: who still has no vote. Closed: "sem resposta", each with its reason. */
  missing: CardMissing[]
  /** Open: "fecha em 6 min"; closed: "todos votaram às 10:37". */
  clock: string
  soon: boolean
  /** Open: the closing time (ms since the epoch), for the countdown. */
  closesAt: number
  /** The person is called and has not voted yet (the card says it waits for her). */
  waitsYou: boolean
  canVote: boolean
  canClose: boolean
  /** The option the person chose (1-based) and the reason she gave. */
  mineOption?: number
  mineReason?: string
  /** "3 de 4 votaram" with the tie noted. */
  progressText: string
}

export interface CardContext {
  now: number
  /** The channel is closed: the card is read only. */
  readOnly: boolean
  /** The ids of the members now; absent until the members are known (nobody is taken for gone). */
  members?: ReadonlySet<string>
  /** A pending vote of the person, shown at once while the daemon has not answered. */
  pending?: number
}

/** "fecha em 6 min", "fecha em 0:48" in the last minute, "fecha em 1 h 5 min". `soon`: under a minute. */
export function countdown(closesAt: number, now: number): { text: string; soon: boolean } {
  const ms = closesAt - now
  if (ms <= 0) return { text: 'fechando…', soon: true }
  if (ms < 60_000) {
    const s = Math.ceil(ms / 1000)
    return { text: `fecha em 0:${String(s).padStart(2, '0')}`, soon: true }
  }
  const min = Math.ceil(ms / 60_000)
  if (min < 60) return { text: `fecha em ${min} min`, soon: false }
  const h = Math.floor(min / 60)
  const rest = min % 60
  return { text: `fecha em ${h} h${rest > 0 ? ` ${rest} min` : ''}`, soon: false }
}

/** Why it closed, in the card's words. */
export function closedClock(r: Pick<PollResult, 'by' | 'closer' | 'away'>, closedAt: string | undefined): string {
  const at = closedAt !== undefined && timeOf(closedAt) !== '' ? ` às ${timeOf(closedAt)}` : ''
  switch (r.by) {
    case 'all-voted': return `todos votaram${at}`
    case 'timeout': return r.away ? 'o prazo venceu com o tether fora' : `o prazo venceu${at}`
    case 'author': return `encerrada por ${r.closer?.id === USER ? 'você' : r.closer?.name ?? 'o autor'}`
    case 'channel-closed': return 'o canal foi encerrado'
  }
}

/** The short notice of a refused vote or close. */
export function pollRefusalText(code: string | undefined): string {
  switch (code) {
    case 'poll-closed': return 'A enquete já fechou: seu voto não entrou.'
    case 'unknown-poll': return 'Esta enquete não está mais aberta.'
    case 'not-called': return 'Você não foi chamada para votar nesta enquete.'
    case 'bad-option': return 'Esta opção não existe na enquete.'
    case 'too-long': return `O motivo passa de ${POLL_REASON_MAX} caracteres.`
    case 'slow-down': return 'Você já trocou o voto vezes demais nesta enquete.'
    case 'closed': return 'O canal foi encerrado: nada mais entra.'
    case 'not-author': return 'Só o autor da enquete e você podem encerrá-la.'
    case 'unknown-channel': return 'Este canal não existe mais.'
    default: return 'O voto não entrou.'
  }
}

/** Whether the option is the "não ok" of an `ok` poll (the vote that asks its reason with emphasis). */
export const isNoOption = (kind: 'ok' | 'choice', n: number): boolean => kind === 'ok' && n === 2

/** Applies a `poll` event to the held states. Returns the poll's seq whose card changed, and how. */
export function applyPoll(states: Map<number, PollState>, ev: PollHeard): { seq: number; what: 'open' | 'vote' | 'close' } | undefined {
  const l = ev.line
  if (l.kind === 'poll') {
    if (ev.poll) states.set(l.seq, { seq: l.seq, open: ev.poll })
    return { seq: l.seq, what: 'open' }
  }
  if (l.kind === 'vote' && l.vote) {
    const held = states.get(l.vote.poll)
    // A vote heard after the result (or an older state than the page's) changes nothing.
    if (!ev.poll || held?.result) return undefined
    states.set(l.vote.poll, { seq: l.vote.poll, open: ev.poll })
    return { seq: l.vote.poll, what: 'vote' }
  }
  if (l.kind === 'notice' && l.event?.type === 'poll-close' && l.result) {
    states.set(l.result.poll, { seq: l.result.poll, result: l.result, closedAt: l.at })
    return { seq: l.result.poll, what: 'close' }
  }
  return undefined
}

const nameOf = (id: string, name: string): string => (id === USER ? 'Você' : name)

/** The card of a poll line with its state. */
export function cardOf(line: Line, state: PollState | undefined, ctx: CardContext): PollCard | undefined {
  const spec = line.poll
  if (line.kind !== 'poll' || !spec) return undefined
  const open = state?.open
  const result = state?.result
  const isOpen = open !== undefined && result === undefined
  const kind: 'ok' | 'choice' = spec.type
  const counts = new Map<number, CardVoter[]>()
  let mineOption: number | undefined
  let mineReason: string | undefined
  if (isOpen) {
    for (const [id, v] of Object.entries(open.votes)) {
      const list = counts.get(v.option) ?? []
      list.push({ id, name: nameOf(id, v.name), ...(v.reason ? { reason: v.reason } : {}), mine: id === USER })
      counts.set(v.option, list)
      if (id === USER) { mineOption = v.option; mineReason = v.reason }
    }
  } else if (result) {
    for (const t of result.tally) {
      counts.set(t.option, t.voters.map((v) => ({ id: v.id, name: nameOf(v.id, v.name), ...(v.reason ? { reason: v.reason } : {}), mine: v.id === USER })))
      const me = t.voters.find((v) => v.id === USER)
      if (me) { mineOption = t.option; mineReason = me.reason }
    }
  }
  const pendingMine = ctx.pending ?? mineOption
  const voted = [...counts.values()].reduce((n, l) => n + l.length, 0)
  const max = Math.max(0, ...[...counts.values()].map((l) => l.length))
  const winners = !isOpen && max > 0 ? [...counts].filter(([, l]) => l.length === max).map(([n]) => n) : []
  const options: CardOption[] = spec.options.map((text, i) => {
    const n = i + 1
    const voters = counts.get(n) ?? []
    return { n, text, count: voters.length, pct: voted === 0 ? 0 : Math.round((voters.length / voted) * 100), voters, mine: pendingMine === n, winner: winners.length === 1 && winners[0] === n }
  })

  // Who is called and has no vote: the list of the called, minus who left the channel (open), or the result's own "missing".
  const stillHere = (id: string): boolean => id === USER || ctx.members === undefined || ctx.members.has(id)
  let missing: CardMissing[]
  let called: number
  if (isOpen) {
    const owing = spec.to.filter((t) => stillHere(t.id) && !Object.hasOwn(open.votes, t.id))
    missing = owing.map((t) => ({ id: t.id, name: nameOf(t.id, t.name), you: t.id === USER }))
    called = voted + owing.length
  } else if (result) {
    missing = result.missing.map((m) => ({ id: m.id, name: nameOf(m.id, m.name), you: m.id === USER, why: MISSING_TEXT[m.why as PollMissingWhy] }))
    called = voted + result.missing.filter((m) => m.why !== 'left').length
  } else { missing = []; called = 0 }

  const closesAt = Date.parse(spec.closesAt)
  const cd = isOpen ? countdown(closesAt, ctx.now) : { text: result ? closedClock(result, state?.closedAt) : 'encerrada', soon: false }
  const calledYou = spec.to.some((t) => t.id === USER)
  const canVote = isOpen && !ctx.readOnly && calledYou
  const tie = winners.length > 1
  return {
    seq: line.seq, state: isOpen ? 'open' : 'closed', unknown: !isOpen && result === undefined,
    question: spec.question, author: line.from.id === USER ? 'Você' : line.from.name, mineAuthor: line.from.id === USER || line.from.role === 'moderator',
    kind, kindLabel: kind === 'ok' && spec.options.join('|') === OK_OPTIONS.join('|') ? 'ok / não ok' : 'escolha',
    options, voted, called, progress: called === 0 ? 0 : Math.round((voted / called) * 100), tie, missing,
    clock: cd.text, soon: cd.soon, closesAt, waitsYou: canVote && mineOption === undefined,
    canVote, canClose: isOpen && !ctx.readOnly,
    ...(pendingMine !== undefined ? { mineOption: pendingMine } : {}), ...(mineReason !== undefined ? { mineReason } : {}),
    progressText: `${voted} de ${called} votaram${tie ? ' · empate' : ''}`,
  }
}

/** The card as one sentence for a screen reader: author, question, how many voted and the clock. */
export function cardAria(c: PollCard): string {
  const base = `Enquete de ${c.author}: ${c.question} ${c.progressText}.`
  return c.state === 'open' ? `${base} ${c.clock}.` : `${base} Fechada: ${c.clock}.`
}

/** What the person is asked before closing a poll early. */
export function closePollDialog(c: Pick<PollCard, 'question' | 'missing'>): DialogSpec {
  const names = c.missing.map((m) => m.name)
  return {
    situation: 'channels.poll-close', tone: 'danger', icon: 'prohibit',
    title: 'Encerrar a enquete agora?',
    message: names.length > 0
      ? `Faltam ${names.length === 1 ? '1 voto' : `${names.length} votos`} (${names.join(', ')}). Quem não votou aparece como "sem resposta". O autor recebe o resultado.`
      : 'Todos já votaram. O autor recebe o resultado.',
    choices: [{ id: 'close', icon: 'prohibit', label: 'Encerrar enquete', consequence: 'A enquete fecha com os votos de agora e não reabre.', tone: 'destructive' }],
    cancelLabel: 'Cancelar',
  }
}
