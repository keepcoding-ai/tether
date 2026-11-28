// The rules of talking from afar (RR4 step 4.2b), with no DOM and no wire: what an answer of the portal means for an act
// (done, held by the pace, "may have happened", locked, refused for good), the outbox of the speeches (each with its actId
// until its answer, resent with the same id, marked "não enviada" when it fails for good), the drafts per channel, the
// ceilings checked before anything leaves (the portal's own, src/remote/talk.ts) and the lane of "seen" per channel.
// src/talk.ts holds the state and talks to the session; src/talk-view.ts draws it.
import { RES_STATUS } from '../../../src/remote/index.ts'
import { NAME_MAX, POLL_REASON_MAX, REACTION_TEXT_MAX, SAY_TEXT_MAX, SAY_TO_MAX } from '../../../src/remote/talk.ts'

export { POLL_REASON_MAX, SAY_TEXT_MAX }

// ---------------------------------------------------------------- an answer of the portal

/** What the device does after an answer to one act. */
export type ReplyStep =
  /** It happened: the body is the answer. */
  | { do: 'done'; body: Record<string, unknown> }
  /** The portal's pace (`slow-down`: too many speeches this minute; `busy`: too many writes in flight): nothing happened. */
  | { do: 'hold'; code: 'slow-down' | 'busy' }
  /** The house did not answer in time: it may have happened. The same actId again brings the real outcome. */
  | { do: 'resend'; afterMs: number }
  /** The session ended before the answer (or never gave one): the same actId again once a session is up. */
  | { do: 'wait-session' }
  /** The session asks for presence (0x04): unlock, then the same actId again. */
  | { do: 'locked' }
  /** Refused for good, with the code the screen words. */
  | { do: 'fail'; code: string }

/** The wait before asking again about an act the house did not answer in time. */
export const TIMEOUT_RESEND_MS = 2_000

const codeOf = (body: Record<string, unknown>, fallback: string): string =>
  typeof body.error === 'string' && /^[a-z][a-z-]{0,39}$/.test(body.error) ? body.error : fallback

/** The step an answer asks for. `status` -1: the session gave no answer (it ended, or the device's own wait ran out). */
export function stepOf(r: { status: number; body: Record<string, unknown> }): ReplyStep {
  switch (r.status) {
    case -1: return { do: 'wait-session' }
    case RES_STATUS.ok: return { do: 'done', body: r.body }
    case RES_STATUS.locked: return { do: 'locked' }
    case RES_STATUS.limit: return { do: 'hold', code: r.body.error === 'busy' ? 'busy' : 'slow-down' }
    case RES_STATUS.presenceRequired: return { do: 'fail', code: 'no-credential' }
    case RES_STATUS.noScope: return { do: 'fail', code: 'no-scope' }
    case RES_STATUS.unknownOp: return { do: 'fail', code: 'unknown-op' }
    case RES_STATUS.notFound: return { do: 'fail', code: codeOf(r.body, 'unknown-channel') }
    case RES_STATUS.badRequest: return { do: 'fail', code: codeOf(r.body, 'bad-request') }
    case RES_STATUS.failed: {
      const code = codeOf(r.body, 'failed')
      return code === 'timeout' ? { do: 'resend', afterMs: TIMEOUT_RESEND_MS } : { do: 'fail', code }
    }
    default: return { do: 'fail', code: 'failed' }
  }
}

// ---------------------------------------------------------------- the outbox of the speeches

/** A speech on its way. `id` is its actId (hex), the same on every resend; `at` is when it was first sent. */
export interface OutItem {
  id: string
  channel: string
  text: string
  to: string[]
  at: number
  state: 'sending' | 'sent' | 'failed'
  /** Where it landed (`sent`). */
  seq?: number
  /** Why it did not go (`failed`): the portal's code, or `unknown` when it is too late to ask the house about it. */
  why?: string
}

/**
 * How long a speech is resent by itself with the same actId. The portal keeps an act's outcome for 15 minutes: past this,
 * asking again could speak twice, so the person decides ("não sei se chegou" with "Tentar de novo").
 */
export const RESEND_WINDOW_MS = 10 * 60_000
/** How long the screen waits for the first answer before it lets the box go (the speech stays as "enviando"). */
export const FIRST_REPLY_MS = 1_500
/** The speeches the device keeps waiting (the oldest that already went leave first). */
export const OUTBOX_MAX = 50

const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const ID_RE = /^[0-9a-f]{32}$/
const CHANNEL_RE = /^[\w.:-]{1,64}$/

/** The outbox as it was written (hostile-proof: whatever is not an item of the right shape is dropped). */
export function parseOutbox(raw: string | null): OutItem[] {
  if (!raw) return []
  let v: unknown
  try { v = JSON.parse(raw) } catch { return [] }
  if (!isRec(v) || v.v !== 1 || !Array.isArray(v.items)) return []
  const out: OutItem[] = []
  for (const x of v.items.slice(-OUTBOX_MAX)) {
    if (!isRec(x) || typeof x.id !== 'string' || !ID_RE.test(x.id) || typeof x.channel !== 'string' || !CHANNEL_RE.test(x.channel)) continue
    if (typeof x.text !== 'string' || x.text.length > SAY_TEXT_MAX || !Array.isArray(x.to) || typeof x.at !== 'number' || !Number.isFinite(x.at)) continue
    if (x.state !== 'sending' && x.state !== 'sent' && x.state !== 'failed') continue
    const to = x.to.filter((n): n is string => typeof n === 'string' && n.length <= NAME_MAX).slice(0, SAY_TO_MAX)
    out.push({
      id: x.id, channel: x.channel, text: x.text, to, at: x.at, state: x.state,
      ...(typeof x.seq === 'number' && Number.isSafeInteger(x.seq) && x.seq >= 1 ? { seq: x.seq } : {}),
      ...(typeof x.why === 'string' && x.why.length <= 40 ? { why: x.why } : {}),
    })
  }
  return out
}

export const serializeOutbox = (items: readonly OutItem[]): string => JSON.stringify({ v: 1, items: items.slice(-OUTBOX_MAX) })

/** Puts a new speech at the end; over the ceiling the oldest that is not waiting goes first, else the oldest. */
export function pushItem(items: readonly OutItem[], item: OutItem): OutItem[] {
  const next = [...items, item]
  while (next.length > OUTBOX_MAX) {
    const i = next.findIndex(x => x.state !== 'sending')
    next.splice(i >= 0 ? i : 0, 1)
  }
  return next
}

/** One item changed (by id); the others as they are. */
export const patchItem = (items: readonly OutItem[], id: string, patch: Partial<OutItem>): OutItem[] =>
  items.map(x => (x.id === id ? { ...x, ...patch } : x))

/** What still waits to be (re)sent by itself, in the order it was said: the ones within the resend window. */
export const toResend = (items: readonly OutItem[], now: number): OutItem[] =>
  items.filter(x => x.state === 'sending' && now - x.at < RESEND_WINDOW_MS)

/** A speech that waited past the window: the house may or may not have it, and only the person knows whether to try again. */
export const expire = (items: readonly OutItem[], now: number): OutItem[] =>
  items.map(x => (x.state === 'sending' && now - x.at >= RESEND_WINDOW_MS ? { ...x, state: 'failed', why: 'unknown' } : x))

/** A page of the channel came up to `last`: the speeches that landed at or before it are in the conversation now. */
export const confirmUpTo = (items: readonly OutItem[], channel: string, last: number): OutItem[] =>
  items.filter(x => !(x.channel === channel && x.state === 'sent' && x.seq !== undefined && x.seq <= last))

/** What the person reads under a speech that did not go. */
export function whyText(why: string | undefined): string {
  switch (why) {
    case 'unknown': return 'Não sei se chegou: a máquina não respondeu a tempo.'
    case 'slow-down': return 'Muitas falas seguidas: espere um pouco.'
    case 'busy': return 'A máquina está ocupada agora.'
    case 'closed': return 'O canal está encerrado.'
    case 'unknown-channel': return 'Este canal não existe mais.'
    case 'too-long': return `A fala passa de ${SAY_TEXT_MAX} caracteres.`
    case 'no-credential': return 'Este aparelho não tem biometria cadastrada: ele só vê.'
    case 'no-scope': return 'Este aparelho não tem permissão para falar nos canais.'
    default: return 'A máquina recusou a fala.'
  }
}

/** The short notice of the portal's pace (the box keeps the text). */
export const HOLD_TEXT: Record<'slow-down' | 'busy', string> = {
  'slow-down': 'Muitas falas seguidas. Espere um pouco e envie de novo: o texto ficou na caixa.',
  busy: 'A máquina está ocupada agora. Envie de novo em instantes: o texto ficou na caixa.',
}

// ---------------------------------------------------------------- the drafts, one per channel

/** The channels a device keeps a draft for, and the most characters kept of one (past the speech's own ceiling: never cut what was typed). */
export const DRAFTS_MAX = 32
export const DRAFT_MAX = 5 * SAY_TEXT_MAX

export function parseDrafts(raw: string | null): Record<string, string> {
  if (!raw) return {}
  let v: unknown
  try { v = JSON.parse(raw) } catch { return {} }
  if (!isRec(v) || v.v !== 1 || !isRec(v.drafts)) return {}
  const out: Record<string, string> = {}
  for (const [k, t] of Object.entries(v.drafts).slice(-DRAFTS_MAX)) if (CHANNEL_RE.test(k) && typeof t === 'string' && t !== '' && t.length <= DRAFT_MAX) out[k] = t
  return out
}

export const serializeDrafts = (d: Readonly<Record<string, string>>): string => JSON.stringify({ v: 1, drafts: d })

/** The drafts with the one of `channel` set (empty: gone). The newest goes last; over the ceiling the oldest go. */
export function withDraft(d: Readonly<Record<string, string>>, channel: string, text: string): Record<string, string> {
  const next: Record<string, string> = {}
  for (const [k, t] of Object.entries(d)) if (k !== channel) next[k] = t
  if (text.trim() !== '') next[channel] = text.slice(0, DRAFT_MAX)
  const keys = Object.keys(next)
  for (const k of keys.slice(0, Math.max(0, keys.length - DRAFTS_MAX))) delete next[k]
  return next
}

// ---------------------------------------------------------------- the ceilings, before anything leaves

export type SayCheck = { ok: true } | { ok: false; code: 'too-long' | 'bad-request'; message: string }

/** A speech the portal would take: some text, at most SAY_TEXT_MAX characters, at most SAY_TO_MAX names of NAME_MAX. */
export function checkSay(text: string, to: readonly string[]): SayCheck {
  if (text.trim() === '') return { ok: false, code: 'bad-request', message: 'Escreva alguma coisa para enviar.' }
  if (text.length > SAY_TEXT_MAX) return { ok: false, code: 'too-long', message: `A fala passa de ${SAY_TEXT_MAX} caracteres (${text.length}). Corte ${text.length - SAY_TEXT_MAX} para enviar.` }
  if (to.length > SAY_TO_MAX) return { ok: false, code: 'too-long', message: `No máximo ${SAY_TO_MAX} destinatários numa fala.` }
  if (to.some(n => n.length > NAME_MAX)) return { ok: false, code: 'too-long', message: 'Um destinatário tem o nome comprido demais.' }
  return { ok: true }
}

/** The counter shows from this many characters on (near the ceiling, never while typing a normal speech). */
export const COUNTER_FROM = SAY_TEXT_MAX - 400

/** The counter of the box: hidden far from the ceiling; "3 712 / 4 000" near it; `over` past it. */
export function counterOf(length: number): { show: boolean; text: string; over: boolean } {
  const fmt = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  return { show: length >= COUNTER_FROM, text: `${fmt(length)} / ${fmt(SAY_TEXT_MAX)}`, over: length > SAY_TEXT_MAX }
}

/** A reaction the portal would take (a name of the five or an emoji, as written). */
export const reactionOk = (r: string): boolean => r.trim() !== '' && r.length <= REACTION_TEXT_MAX

/** The reason of a vote, cut to what the portal takes (the card's field already stops at the same ceiling). */
export const reasonOf = (r: string | undefined): string | undefined => {
  const t = r?.trim() ?? ''
  return t === '' ? undefined : t.slice(0, POLL_REASON_MAX)
}

// ---------------------------------------------------------------- "seen", one lane per channel

/**
 * The lane of one channel's "seen": the highest seq told (`sent`), the one waiting to be told (`pending`), and whether a
 * request is in flight. One request at a time; what the screen sees meanwhile is told once after it, the highest only.
 */
export interface SeenLane { sent: number; pending?: number; inFlight: boolean }

export const SEEN_LANE: SeenLane = { sent: 0, inFlight: false }

/**
 * The view sees up to `seq`. `start`: the caller arms the short delay that coalesces a burst (nothing in flight). The app's
 * marks write their `seen` to the daemon the same way: once per change, after its own short delay.
 */
export function seenWant(l: SeenLane, seq: number): { lane: SeenLane; start: boolean } {
  if (!(seq > l.sent) || (l.pending !== undefined && l.pending >= seq)) return { lane: l, start: false }
  return { lane: { ...l, pending: seq }, start: !l.inFlight }
}

/** The delay ran out: the seq to tell now, if any (the lane goes in flight). */
export function seenTake(l: SeenLane): { lane: SeenLane; seq?: number } {
  if (l.inFlight || l.pending === undefined) return { lane: l }
  if (!(l.pending > l.sent)) return { lane: { sent: l.sent, inFlight: false } }
  return { lane: { sent: l.sent, inFlight: true }, seq: l.pending }
}

/**
 * The answer came. `ok`: the house holds `seq` as seen. A refusal forgets nothing but the request: the next time the view
 * sees the end it is asked again. `start`: something newer waits.
 */
export function seenDone(l: SeenLane, seq: number, ok: boolean): { lane: SeenLane; start: boolean } {
  const sent = ok ? Math.max(l.sent, seq) : l.sent
  const lane: SeenLane = { sent, inFlight: false, ...(l.pending !== undefined && l.pending > sent ? { pending: l.pending } : {}) }
  return { lane, start: lane.pending !== undefined }
}
