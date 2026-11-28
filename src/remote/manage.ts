// Management from afar (RR5 5.2, fio-spec 16): the strict bodies of the direct acts on tetherd (slots, ronda, processes),
// checked field by field BEFORE anything reaches the pipe, and the ONE pipe message of each op rebuilt from what was
// checked (never the body copied). The target is named by its real id (a slot's id, a process's name), which tetherd
// resolves and confers itself; nothing here trusts a position or the tree the app publishes. Hostile text (a name, a
// nudge, a criterion, a reason, a purpose) is folded to one line as a declared name and capped by tetherd's own ceilings,
// so what passes here is never cut there. Also the status each refusal of tetherd becomes. Pure: no node:*, no DOM; the
// PWA reads the same ceilings.
import { RES_STATUS, sanitizeDeclaredName, type ResStatus } from './content.ts'
import type { OP_TABLE, OpName } from './scopes.ts'
import { MANAGE_ERROR_CODES } from './projection.ts'

/** A slot's name (tetherd keeps any; the app shows 64). */
export const SLOT_NAME_MAX = 64
/** A ronda's interval as typed (`10m`, `1h30m`), its nudge and its criterion (src/daemon/ronda.ts TEXT_MAX). */
export const RONDA_INTERVAL_MAX = 16
export const RONDA_TEXT_MAX = 500
/** The reason of a stop or a restart, and of forcing over another's use (extensions/regency/system-rules.ts MAX_FORCE_REASON). */
export const PROC_REASON_MAX = 200
/** What a use is for (src/daemon/procs.ts PURPOSE_MAX), and how long it lasts as typed (`15m`, at most 60m at tetherd). */
export const PROC_PURPOSE_MAX = 200
export const PROC_DURATION_MAX = 16

/**
 * The ops of this module: the management lines that reach tetherd by a pipe message of their own. `procs.new` (RR5 5.5) is
 * apart (src/remote/procs-new.ts): it reads before it acts, and its body carries values that never go where a body is kept.
 */
export type ManageOp = Exclude<Extract<OpName, `agents.${string}` | `ronda.${string}` | `procs.${string}`>, 'procs.new'>
/** The pipe messages these ops send (without the request's `id`): a type of the line's `pipe`, and its checked fields. */
export type ManagePipe = (typeof OP_TABLE)[ManageOp]['pipe'][number]
export interface ActMessage { readonly t: ManagePipe; readonly [k: string]: unknown }

/** The message for tetherd and the act's target (the audit's: a slot's id or a process's name, never text). */
export interface ManageArgs { msg: ActMessage; target: string }
export type ManageRefusal = 'bad-request' | 'too-long'

/** A slot's id as tetherd makes them; a process's name as tetherd takes it (src/daemon/procs.ts PROC_NAME_RE). */
const SLOT_ID_RE = /^[\w.:-]{1,64}$/
const PROC_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
/** An interval or a duration as tetherd parses them: digits and the letters of h/m/min/s. */
const SPAN_RE = /^[0-9a-z ]{1,16}$/

class Refused {
  readonly why: ManageRefusal
  constructor(why: ManageRefusal) { this.why = why }
}
const refuse = (why: ManageRefusal = 'bad-request'): never => { throw new Refused(why) }

const slotIdOf = (v: unknown): string => (typeof v === 'string' && SLOT_ID_RE.test(v) ? v : refuse())
const procNameOf = (v: unknown): string => (typeof v === 'string' && PROC_NAME_RE.test(v) ? v : refuse())
/** One line as written: at most `max` characters, then folded; empty once folded is refused unless `empty` allows it. */
const oneLine = (v: unknown, max: number, empty = false): string => {
  if (typeof v !== 'string') return refuse()
  if (v.length > max) return refuse('too-long')
  const t = sanitizeDeclaredName(v)
  return t === '' && !empty ? refuse() : t
}
const span = (v: unknown, max: number): string => {
  if (typeof v !== 'string') return refuse()
  if (v.length > max) return refuse('too-long')
  const t = v.trim().toLowerCase()
  return SPAN_RE.test(t) ? t : refuse()
}

function build(op: ManageOp, b: Record<string, unknown>): ManageArgs {
  const slot = (): string => slotIdOf(b.slotId)
  const proc = (): string => procNameOf(b.name)
  const reason = (required: boolean): { reason?: string } => {
    if (b.reason === undefined) return required ? refuse() : {}
    const r = oneLine(b.reason, PROC_REASON_MAX, !required)
    return r === '' ? {} : { reason: r }
  }
  switch (op) {
    // `why: 'end'`: the intent is `ended`, as the app's "Parar"; hibernating or suspending stays the app's (step 5.1).
    case 'agents.stop': { const slotId = slot(); return { msg: { t: 'stop', slotId, why: 'end' }, target: slotId } }
    case 'agents.start': {
      const slotId = slot()
      if (b.choice !== undefined && b.choice !== 'resume' && b.choice !== 'new') refuse()
      return { msg: { t: 'start', slotId, ...(b.choice !== undefined ? { choice: b.choice } : {}) }, target: slotId }
    }
    case 'agents.restart': { const slotId = slot(); return { msg: { t: 'restart', slotId }, target: slotId } }
    case 'agents.rename': { const slotId = slot(); return { msg: { t: 'rename-slot', slotId, name: oneLine(b.name, SLOT_NAME_MAX) }, target: slotId } }
    case 'agents.forget': { const slotId = slot(); return { msg: { t: 'forget', slotId }, target: slotId } }
    case 'ronda.get': { const slotId = slot(); return { msg: { t: 'ronda-get', slotId }, target: slotId } }
    case 'ronda.set': {
      const slotId = slot()
      // undefined keeps, '' clears (src/daemon/ronda.ts RondaChange).
      const fields: Record<string, string> = {}
      if (b.interval !== undefined) fields.interval = span(b.interval, RONDA_INTERVAL_MAX)
      if (b.nudge !== undefined) fields.nudge = oneLine(b.nudge, RONDA_TEXT_MAX, true)
      if (b.criterion !== undefined) fields.criterion = oneLine(b.criterion, RONDA_TEXT_MAX, true)
      return { msg: { t: 'ronda-set', slotId, ...fields }, target: slotId }
    }
    // Always forced, as the app does: the person switching it off from afar is the person, not the agent asked to stop.
    case 'ronda.off': { const slotId = slot(); return { msg: { t: 'ronda-off', slotId, force: true }, target: slotId } }
    case 'procs.list': return { msg: { t: 'proc-list' }, target: '' }
    case 'procs.info': { const name = proc(); return { msg: { t: 'proc-info', name }, target: name } }
    // The stored recipe only: no recipe, no `force` over a busy port (a new recipe is step 5.5).
    case 'procs.start': { const name = proc(); return { msg: { t: 'proc-start', name }, target: name } }
    case 'procs.stop': { const name = proc(); return { msg: { t: 'proc-stop', name, ...reason(false) }, target: name } }
    case 'procs.restart': { const name = proc(); return { msg: { t: 'proc-restart', name, ...reason(false) }, target: name } }
    // "Anyway": its own op, the reason required; it goes to the ones who use it (tetherd tells them).
    case 'procs.stop-force': { const name = proc(); return { msg: { t: 'proc-stop', name, force: reason(true).reason }, target: name } }
    case 'procs.restart-force': { const name = proc(); return { msg: { t: 'proc-restart', name, force: reason(true).reason }, target: name } }
    case 'procs.use': {
      const name = proc()
      const duration = b.duration === undefined ? {} : { duration: span(b.duration, PROC_DURATION_MAX) }
      return { msg: { t: 'proc-use', name, ...duration, purpose: oneLine(b.purpose, PROC_PURPOSE_MAX) }, target: name }
    }
    case 'procs.release': { const name = proc(); return { msg: { t: 'proc-release', name }, target: name } }
    case 'procs.forget': { const name = proc(); return { msg: { t: 'proc-forget', name }, target: name } }
    case 'procs.forget-force': { const name = proc(); return { msg: { t: 'proc-forget', name, force: reason(true).reason }, target: name } }
  }
}

/** The checked act of `op`, or why its body is refused (0x01). The keys of the body were already checked by the table. */
export function manageArgs(op: ManageOp, body: Record<string, unknown>): ManageArgs | ManageRefusal {
  try { return build(op, body) } catch (e) {
    if (e instanceof Refused) return e.why
    throw e
  }
}

/** Whether a line's name is one of this module's. */
export const isManageOp = (name: string): name is ManageOp => /^(agents|ronda|procs)\./.test(name) && name !== 'procs.new'

export type ManageCode = (typeof MANAGE_ERROR_CODES)[number]
/**
 * The status each refusal of tetherd becomes: an id that names nothing is 0x06; the rest is what tetherd would not do,
 * 0x09 with its code. `bad-request` is not here: the portal's check makes it a bug (`failed`, logged).
 */
export const ACT_REFUSALS: Readonly<Record<ManageCode | 'too-many' | 'proc-exists', ResStatus>> = {
  // "Novo processo" over a ceiling of what is created from afar (RR5 M-2, src/daemon/afar-caps.ts).
  'too-many': RES_STATUS.limit,
  // "Novo processo" for a name that has a process, refused by tetherd in the name's lock (RR5 B-3), as the portal's own check.
  'proc-exists': RES_STATUS.failed,
  'unknown-slot': RES_STATUS.notFound,
  'unknown-proc': RES_STATUS.notFound,
  'proc-in-use': RES_STATUS.failed,
  'proc-running': RES_STATUS.failed,
  'proc-not-stopped': RES_STATUS.failed,
  'port-busy': RES_STATUS.failed,
  'proc-host': RES_STATUS.failed,
  'unconfirmed': RES_STATUS.failed,
  'ronda-unavailable': RES_STATUS.failed,
  'session-missing': RES_STATUS.failed,
  'cwd-missing': RES_STATUS.failed,
  'already-open': RES_STATUS.failed,
  'spawn-failed': RES_STATUS.failed,
  'agent-unavailable': RES_STATUS.failed,
}
export const isActRefusal = (code: unknown): code is ManageCode | 'too-many' | 'proc-exists' => typeof code === 'string' && Object.hasOwn(ACT_REFUSALS, code)
