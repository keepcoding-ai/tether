// The person talking from afar (step 4.2a): the strict bodies of the five writes of a channel (channels.say, react, vote,
// poll, seen), checked field by field BEFORE anything reaches the pipe, and the arguments of tetherd's request rebuilt from
// what was checked (never the body copied). Hostile text is treated as the projector treats it on the way back
// (projection.ts): a speech keeps its line breaks and loses every other control, the bidi marks and the zero-width
// characters; a one-line field (a name, a question, an option, a reason) is folded as a declared name. The ceilings are the
// channel rules' own (extensions/channels/rules.ts), so what passes here is never refused there for its size; the speech's
// is the most a page shows of a line whole (LINE_BODY_MAX). Also the error codes a refusal of tetherd becomes, by status.
// Pure: no node:*, no DOM; the PWA reads the same ceilings.
import { RES_STATUS, sanitizeDeclaredName, type ResStatus } from './content.ts'
import { LINE_BODY_MAX, multiline, type ErrorCode } from './projection.ts'

/** Characters of a speech: a page shows a line whole up to this, so the phone never writes what it cannot read back. */
export const SAY_TEXT_MAX = LINE_BODY_MAX
/** Names a speech is addressed to (`to`), and the characters of each. */
export const SAY_TO_MAX = 16
export const NAME_MAX = 64
/** Characters of a reaction as written (a name of the five or one emoji; rules.ts parseReaction reads 40). */
export const REACTION_TEXT_MAX = 40
/** A poll (rules.ts POLL_*): the question, 2 to 6 options of up to 60, the reason of a vote, the deadline. */
export const POLL_QUESTION_MAX = 300
export const POLL_OPTIONS_MIN = 2
export const POLL_OPTIONS_MAX = 6
export const POLL_OPTION_MAX = 60
export const POLL_REASON_MAX = 140
export const POLL_TIMEOUT_MIN_MS = 60_000
export const POLL_TIMEOUT_MAX_MS = 24 * 3_600_000
/** Who a poll calls (`to`): agent ids or `user` (herself). A channel shows at most 64 members on a page. */
export const POLL_TO_MAX = 64

/** The ops of this module. */
export type TalkOp = 'channels.say' | 'channels.react' | 'channels.vote' | 'channels.poll' | 'channels.seen'

/** Why a body is refused before the pipe: its shape (`bad-request`) or a field over its ceiling (`too-long`). */
export type TalkRefusal = 'bad-request' | 'too-long'

/** The arguments for tetherd and the channel the act touches (the audit's target). */
export interface TalkArgs { channel: string; args: Record<string, unknown> }

const CHANNEL_RE = /^[\w.:-]{1,64}$/
const AGENT_RE = /^[\w.:-]{1,64}$/

class Refused {
  readonly why: TalkRefusal
  constructor(why: TalkRefusal) { this.why = why }
}
const refuse = (why: TalkRefusal = 'bad-request'): never => { throw new Refused(why) }

const channelOf = (v: unknown): string => (typeof v === 'string' && CHANNEL_RE.test(v) ? v : refuse())
const seqOf = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 ? v : refuse())
/** A text of many lines: at most `max` characters as written, then cleaned; empty once cleaned is refused. */
const body = (v: unknown, max: number): string => {
  if (typeof v !== 'string') return refuse()
  if (v.length > max) return refuse('too-long')
  const t = multiline(v)
  return t.trim() === '' ? refuse() : t
}
/** A text of one line: at most `max` characters as written, then folded as a declared name; empty once folded is refused. */
const oneLine = (v: unknown, max: number): string => {
  if (typeof v !== 'string') return refuse()
  if (v.length > max) return refuse('too-long')
  const t = sanitizeDeclaredName(v)
  return t === '' ? refuse() : t
}
const list = (v: unknown, max: number): unknown[] => (Array.isArray(v) && v.length <= max ? v : refuse())

/**
 * The checked arguments of one write, or the refusal. Absent optional fields stay absent; an empty `to` or `options` is
 * the same as none. Every key of the body was already checked against the op's line (house.ts, strict keys).
 */
export function talkArgs(op: TalkOp, b: Record<string, unknown>): TalkArgs | TalkRefusal {
  try {
    const channel = channelOf(b.channel)
    switch (op) {
      case 'channels.say': {
        const text = body(b.text, SAY_TEXT_MAX)
        const to = b.to === undefined ? [] : [...new Set(list(b.to, SAY_TO_MAX).map((n) => oneLine(n, NAME_MAX)))]
        return { channel, args: { channel, text, ...(to.length ? { to } : {}) } }
      }
      case 'channels.react': {
        const seq = seqOf(b.seq)
        const reaction = body(b.reaction, REACTION_TEXT_MAX).trim()
        if (b.remove !== undefined && typeof b.remove !== 'boolean') refuse()
        return { channel, args: { channel, seq, reaction, ...(b.remove === true ? { remove: true } : {}) } }
      }
      case 'channels.vote': {
        const poll = seqOf(b.poll)
        const vote = b.vote
        if (typeof vote !== 'number' || !Number.isInteger(vote) || vote < 1 || vote > POLL_OPTIONS_MAX) refuse()
        const reason = b.reason === undefined || b.reason === '' ? undefined : oneLine(b.reason, POLL_REASON_MAX)
        return { channel, args: { channel, poll, vote, ...(reason !== undefined ? { reason } : {}) } }
      }
      case 'channels.poll': {
        const question = oneLine(b.question, POLL_QUESTION_MAX)
        const options = b.options === undefined ? [] : list(b.options, POLL_OPTIONS_MAX).map((o) => oneLine(o, POLL_OPTION_MAX))
        if (options.length === 1) refuse()
        const to = b.to === undefined ? [] : list(b.to, POLL_TO_MAX).map((w) => (w === 'user' || (typeof w === 'string' && AGENT_RE.test(w)) ? w : refuse()))
        const t = b.timeoutMs
        if (t !== undefined && (typeof t !== 'number' || !Number.isInteger(t) || t < POLL_TIMEOUT_MIN_MS || t > POLL_TIMEOUT_MAX_MS)) refuse()
        return {
          channel,
          args: { channel, question, ...(options.length ? { options } : {}), ...(to.length ? { to: [...new Set(to)] } : {}), ...(t !== undefined ? { timeoutMs: t } : {}) },
        }
      }
      case 'channels.seen':
        return { channel, args: { channel, seq: seqOf(b.seq) } }
    }
  } catch (e) {
    if (e instanceof Refused) return e.why
    throw e
  }
}

// ---- tetherd's refusals, as a device gets them ---------------------------------------------------------------------

/**
 * The codes the person can get from the channels' rules for these five requests (extensions/channels/rules.ts and
 * daemon/fanout.ts; `not-member` and `muted` never apply to the moderator), each with the status it goes under: the
 * channel, line or poll that is not there is 0x06, the channel's own pace (`slow-down`) is 0x07, a body the rules read as
 * malformed is 0x01, and a rule that says no is 0x09 with its code. Any other code is `failed`.
 */
export const TALK_REFUSALS = {
  'unknown-channel': RES_STATUS.notFound,
  'unknown-line': RES_STATUS.notFound,
  'unknown-poll': RES_STATUS.notFound,
  'slow-down': RES_STATUS.limit,
  'bad-request': RES_STATUS.badRequest,
  'bad-reaction': RES_STATUS.badRequest,
  'bad-option': RES_STATUS.badRequest,
  'too-long': RES_STATUS.badRequest,
  closed: RES_STATUS.failed,
  'too-old': RES_STATUS.failed,
  'not-a-message': RES_STATUS.failed,
  'poll-closed': RES_STATUS.failed,
  'not-called': RES_STATUS.failed,
  'vote-first': RES_STATUS.failed,
  limit: RES_STATUS.failed,
  'nobody-called': RES_STATUS.failed,
} as const satisfies Partial<Record<ErrorCode, ResStatus>>
export type TalkRefusalCode = keyof typeof TALK_REFUSALS

export const isTalkRefusal = (code: unknown): code is TalkRefusalCode => typeof code === 'string' && Object.hasOwn(TALK_REFUSALS, code)
