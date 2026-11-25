// The rules of the form that opens a poll (slice E4): pure functions, no DOM, no daemon. The form checks the limits before it asks;
// the tether still judges (its refusals come back as the form's warning, in `refusalText`).
import {
  oneLine, parsePollTimeout, POLL_OPTION_MAX, POLL_OPTIONS_MAX, POLL_OPTIONS_MIN, POLL_QUESTION_MAX, POLL_TIMEOUT_DEFAULT_MS,
  POLL_TIMEOUT_MAX_MS, POLL_TIMEOUT_MIN_MS, USER,
} from '../rules.ts'
import { timeOf } from './view-model.ts'

export { POLL_OPTION_MAX, POLL_OPTIONS_MAX, POLL_OPTIONS_MIN, POLL_QUESTION_MAX }

/** The command typed in the speaking box that opens the form (the rest of the line, when there is one, is the question). */
export const POLL_COMMAND = '/enquete'

/** The deadline chips; "outro" is a field of minutes (or `2h`, `1h30m`). */
export const DEADLINES = [
  { id: '5', label: '5 min', ms: 5 * 60_000 },
  { id: '10', label: '10 min', ms: 10 * 60_000 },
  { id: '30', label: '30 min', ms: 30 * 60_000 },
  { id: '60', label: '1 h', ms: 60 * 60_000 },
] as const
export type DeadlineId = (typeof DEADLINES)[number]['id'] | 'other'
export const DEADLINE_DEFAULT: DeadlineId = '10'

/** What the person filled in. `called` are the ids of the agents ticked; `includeYou` calls the person herself. */
export interface PollDraft {
  question: string
  kind: 'ok' | 'choice'
  options: readonly string[]
  called: readonly string[]
  includeYou: boolean
  deadline: DeadlineId
  /** The text of the "outro" field. */
  other: string
}

export interface PollErrors { question?: string; options?: string; called?: string; deadline?: string }

/** What `poll` takes: the same arguments the request of the daemon reads. */
export interface PollArgs { question: string; options?: string[]; to?: string[]; timeoutMs: number }

export const emptyDraft = (called: readonly string[] = []): PollDraft => ({
  question: '', kind: 'ok', options: ['', ''], called, includeYou: false, deadline: DEADLINE_DEFAULT, other: '',
})

/** The deadline in ms, or undefined when the field is not a time within 1 min to 24 h. */
export function deadlineMs(d: Pick<PollDraft, 'deadline' | 'other'>): number | undefined {
  if (d.deadline !== 'other') return DEADLINES.find(x => x.id === d.deadline)?.ms ?? POLL_TIMEOUT_DEFAULT_MS
  const ms = parsePollTimeout(d.other)
  return ms !== undefined && ms >= POLL_TIMEOUT_MIN_MS && ms <= POLL_TIMEOUT_MAX_MS ? ms : undefined
}

/** The options of a choice poll as the daemon will see them: one line each, the blank ones dropped. */
export const filledOptions = (options: readonly string[]): string[] => options.map(o => oneLine(o)).filter(o => o !== '')

/** The same fold the daemon uses to tell two options apart (case and accents do not). */
const foldText = (s: string): string => oneLine(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/** Every limit, before asking. No errors: the poll may be asked (`args`). */
export function validateDraft(d: PollDraft): { errors: PollErrors; args?: PollArgs } {
  const errors: PollErrors = {}
  const question = oneLine(d.question)
  if (question === '') errors.question = 'Escreva a pergunta.'
  else if (question.length > POLL_QUESTION_MAX) errors.question = `A pergunta passa de ${POLL_QUESTION_MAX} caracteres (${question.length}).`
  const options = d.kind === 'choice' ? filledOptions(d.options) : []
  if (d.kind === 'choice') {
    if (options.length < POLL_OPTIONS_MIN) errors.options = `Escreva ao menos ${POLL_OPTIONS_MIN} opções.`
    else if (options.length > POLL_OPTIONS_MAX) errors.options = `No máximo ${POLL_OPTIONS_MAX} opções.`
    else if (options.some(o => o.length > POLL_OPTION_MAX)) errors.options = `Cada opção tem até ${POLL_OPTION_MAX} caracteres.`
    else if (new Set(options.map(foldText)).size !== options.length) errors.options = 'Há opções repetidas.'
  }
  if (d.called.length === 0 && !d.includeYou) errors.called = 'Chame ao menos um voto: marque um agente ou "incluir você".'
  const ms = deadlineMs(d)
  if (ms === undefined) errors.deadline = 'O prazo vai de 1 min a 24 h (ex.: 15, 90m, 2h).'
  if (Object.keys(errors).length > 0 || ms === undefined) return { errors }
  const to = [...d.called, ...(d.includeYou ? [USER] : [])]
  return { errors, args: { question, ...(d.kind === 'choice' ? { options } : {}), to, timeoutMs: ms } }
}

/** What the box's text asks: `/enquete` alone (or with a question after it) opens the form; any other text is a speech. */
export function pollCommand(text: string): { question: string } | undefined {
  const t = text.trim()
  if (t.toLowerCase() === POLL_COMMAND) return { question: '' }
  if (t.toLowerCase().startsWith(`${POLL_COMMAND} `)) return { question: t.slice(POLL_COMMAND.length).trim() }
  return undefined
}

/** A member the form lists (what `members` says). */
export interface PollMember { id: string; name: string; muted: boolean; path: string }

/** The members that do not hear now (their process does not run, or nobody delivers to them). */
export const deafOf = (members: readonly PollMember[], called: readonly string[]): PollMember[] =>
  members.filter(m => called.includes(m.id) && m.path !== 'inside' && m.path !== 'terminal')

/** "Fecha às 10:42 ou quando os 4 votarem". */
export function footText(now: number, ms: number | undefined, voters: number): string {
  if (ms === undefined) return 'Escolha um prazo de 1 min a 24 h.'
  const at = timeOf(new Date(now + ms).toISOString())
  return voters > 0 ? `Fecha às ${at} ou quando ${voters === 1 ? 'o voto chegar' : `os ${voters} votarem`}` : `Fecha às ${at}`
}

/** "bancada não ouve agora: recebe se voltar antes de 10:42." */
export function deafText(deaf: readonly PollMember[], now: number, ms: number | undefined): string {
  if (deaf.length === 0) return ''
  const names = deaf.map(m => m.name).join(', ')
  const until = ms !== undefined ? ` antes de ${timeOf(new Date(now + ms).toISOString())}` : ''
  return `${names} ${deaf.length === 1 ? 'não ouve' : 'não ouvem'} agora: ${deaf.length === 1 ? 'recebe' : 'recebem'} se voltar${until}.`
}

const REFUSALS: Record<string, string> = {
  'vote-first': 'Você ainda deve voto numa enquete aberta neste canal: vote nela antes de abrir outra.',
  limit: 'Já há enquetes abertas demais neste canal (no máximo 3, e uma por autor). Espere uma fechar ou encerre uma.',
  'slow-down': 'Você abriu enquetes demais na última hora (no máximo 5 por canal). Tente mais tarde.',
  'nobody-called': 'Ninguém foi chamado para votar: marque ao menos um agente do canal.',
  closed: 'O canal está encerrado.',
  'too-long': 'A pergunta, uma opção ou o motivo passa do limite de caracteres.',
  'bad-request': 'Confira a pergunta, as opções (2 a 6, sem repetir) e o prazo (1 min a 24 h).',
  'unknown-channel': 'Esse canal não existe mais.',
}

/** The tether's refusal in plain words (the form keeps what was typed). */
export const refusalText = (code: string): string => REFUSALS[code] ?? `O tether recusou a enquete (${code}).`
