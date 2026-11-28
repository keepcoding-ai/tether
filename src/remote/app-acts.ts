// The gestures only the app knows how to do, asked from afar (RR5 5.1, fio-spec 17): hibernate and wake a desk or a pane,
// suspend a pane, create, rename, recolour and close a desk, move a pane, reopen and forget a closed session, give and take
// a desk or a pane from an agent ("Tirar a mesa de <nome>"), "Assumir o comando" and give it back. Each op of the table
// reaches tetherd as the ONE extension request `regency/act` (src/remoted/reach.ts EXT_WRITES), with the act's name and its
// fields; tetherd hands it to the app over the Regency's bridge (extensions/regency/daemon.ts) and the app does it with its
// own rules, no dialog and nothing brought forward (extensions/regency/renderer/remote-acts.ts).
//
// The closed list lives here, one source for the three: the portal builds the act from the strict body (`appActArgs`),
// tetherd takes from the `remote` client only an act this list allows, field by field, in the form the portal builds
// (`parseAppAct`), and the app parses the event by the same function. No free text but a desk's name (folded as a declared
// name, capped), and targets only by their real ids (a desk's, a pane's, a slot's), never a position nor a title. Pure: no
// node:*, no DOM.
import { RES_STATUS, sanitizeDeclaredName, type ResStatus } from './content.ts'
import type { OpName } from './scopes.ts'

/** The extension request tetherd answers (ext `regency`), the event it emits to the app and the app's answer. */
export const APP_ACT_REQUEST = 'act'
export const APP_ACT_EVENT = 'act'
export const APP_ACT_DONE = 'act.done'

/** How long the device waits (the portal's deadline): past it `timeout`, and the real outcome is a `late:` line of the audit. */
export const APP_ACT_PORTAL_MS = 10_000
/** How long tetherd waits for the app's answer before `no-answer` (longer than the portal's, so a slow act still settles). */
export const APP_ACT_BRIDGE_MS = 20_000
/** Acts waiting for the app at tetherd, every device together: over it, `busy`. */
export const APP_ACTS_PENDING_MAX = 16

/** A desk's name as the person types it in the pill (the app trims it and keeps it). */
export const DESK_NAME_MAX = 64
/** The colours of a desk (app/shared/palette.ts HUE_NAMES; test/unit/ext.regency-acts.test.ts keeps the two equal). */
export const DESK_COLORS = ['red', 'orange', 'yellow', 'lime', 'green', 'teal', 'cyan', 'sky', 'blue', 'purple', 'magenta', 'pink'] as const
export type DeskColor = (typeof DESK_COLORS)[number]

/** The ops of this module: the management lines the app does. */
export type AppActOp = Extract<OpName, `desks.${string}` | `panes.${string}` | `closed.${string}` | `owners.${string}`>
export const isAppActOp = (name: string): name is AppActOp => /^(desks|panes|closed|owners)\./.test(name)

/** One act as it crosses the pipe and reaches the app: its op's name and the ids, a desk's name or colour, nothing else. */
export type AppAct =
  | { act: 'desks.hibernate' | 'desks.wake'; deskId: string }
  | { act: 'desks.create'; name: string; color?: DeskColor }
  | { act: 'desks.rename'; deskId: string; name: string }
  | { act: 'desks.color'; deskId: string; color: DeskColor }
  | { act: 'desks.close'; deskId: string; panes: 'move' | 'stop' }
  | { act: 'panes.hibernate' | 'panes.wake' | 'panes.suspend'; deskId: string; paneId: string }
  | { act: 'panes.move'; deskId: string; paneId: string; to: string }
  | { act: 'panes.close'; deskId: string; paneId: string; process: 'keep' | 'stop' }
  | { act: 'closed.reopen'; slotId: string; deskId: string }
  | { act: 'closed.forget'; slotId: string }
  | { act: 'owners.give'; deskId: string; paneId?: string; to: string }
  | { act: 'owners.revoke' | 'owners.take' | 'owners.return'; deskId: string; paneId?: string }

/** What a field may hold: an id, a desk's name, a colour, or one of a closed list of values. */
type Field = 'id' | 'name' | 'color' | readonly string[]
interface ActRule { readonly need: Readonly<Record<string, Field>>; readonly may?: Readonly<Record<string, Field>> }

/**
 * The closed list, field by field: total over the ops (a line of the table in these families without its rule does not
 * compile). `need` are required, `may` optional; any other field is refused.
 */
export const APP_ACT_FIELDS = {
  'desks.hibernate': { need: { deskId: 'id' } },
  'desks.wake': { need: { deskId: 'id' } },
  'desks.create': { need: { name: 'name' }, may: { color: 'color' } },
  'desks.rename': { need: { deskId: 'id', name: 'name' } },
  'desks.color': { need: { deskId: 'id', color: 'color' } },
  'desks.close': { need: { deskId: 'id', panes: ['move', 'stop'] } },
  'panes.hibernate': { need: { deskId: 'id', paneId: 'id' } },
  'panes.wake': { need: { deskId: 'id', paneId: 'id' } },
  'panes.suspend': { need: { deskId: 'id', paneId: 'id' } },
  'panes.move': { need: { deskId: 'id', paneId: 'id', to: 'id' } },
  'panes.close': { need: { deskId: 'id', paneId: 'id', process: ['keep', 'stop'] } },
  'closed.reopen': { need: { slotId: 'id', deskId: 'id' } },
  'closed.forget': { need: { slotId: 'id' } },
  'owners.give': { need: { deskId: 'id', to: 'id' }, may: { paneId: 'id' } },
  'owners.revoke': { need: { deskId: 'id' }, may: { paneId: 'id' } },
  'owners.take': { need: { deskId: 'id' }, may: { paneId: 'id' } },
  'owners.return': { need: { deskId: 'id' }, may: { paneId: 'id' } },
} as const satisfies { readonly [K in AppActOp]: ActRule }

/** Defaults the portal fills (the safe answer of the app's own dialog), so the act tetherd and the app get is whole. */
const DEFAULTS: Partial<Record<AppActOp, Record<string, string>>> = {
  'desks.close': { panes: 'move' },
  'panes.close': { process: 'keep' },
}

/** An id as the app and tetherd make them: a desk's (`desk-1`), a pane's or a slot's. */
const ID_RE = /^[\w.:-]{1,64}$/
const isId = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v)
const isColor = (v: unknown): v is DeskColor => typeof v === 'string' && (DESK_COLORS as readonly string[]).includes(v)
/** A desk's name in its kept form: one line, folded, within the ceiling and not empty. */
const isCleanName = (v: unknown): v is string => typeof v === 'string' && v !== '' && v.length <= DESK_NAME_MAX && sanitizeDeclaredName(v) === v

const fieldOk = (f: Field, v: unknown): boolean =>
  f === 'id' ? isId(v) : f === 'name' ? isCleanName(v) : f === 'color' ? isColor(v) : typeof v === 'string' && f.includes(v)

const ruleOf = (op: string): ActRule | undefined => (Object.hasOwn(APP_ACT_FIELDS, op) ? APP_ACT_FIELDS[op as AppActOp] : undefined)

/**
 * The act as tetherd and the app take it: an object whose `act` is a line of the list and whose every other field is one
 * its rule lists, in the form the portal builds (a name already folded), the required ones all there. Undefined otherwise.
 */
export function parseAppAct(v: unknown): AppAct | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const o = v as Record<string, unknown>
  const rule = typeof o.act === 'string' ? ruleOf(o.act) : undefined
  if (!rule) return undefined
  for (const [k, f] of Object.entries(rule.need)) if (!Object.hasOwn(o, k) || !fieldOk(f, o[k])) return undefined
  for (const [k, val] of Object.entries(o)) {
    if (k === 'act' || Object.hasOwn(rule.need, k)) continue
    const f = rule.may?.[k]
    if (f === undefined || !fieldOk(f, val)) return undefined
  }
  return { ...o } as AppAct
}

export type AppActRefusal = 'bad-request' | 'too-long'

/** The act's target, as the audit and the one-at-a-time rule name it: the pane, the slot, else the desk ('' for a new desk). */
export function appActTarget(a: AppAct): string {
  if ('paneId' in a && a.paneId !== undefined) return a.paneId
  if ('slotId' in a) return a.slotId
  if ('deskId' in a) return a.deskId
  return ''
}

/**
 * The portal's half: the act of `op` from the device's body (its keys already checked by the table), every field checked
 * and the name folded, or why the body is refused (0x01). The `args` are what goes to tetherd as `regency/act`.
 */
export function appActArgs(op: AppActOp, body: Record<string, unknown>): { args: AppAct; target: string } | AppActRefusal {
  const rule: ActRule = APP_ACT_FIELDS[op]
  const out: Record<string, unknown> = { act: op, ...(DEFAULTS[op] ?? {}) }
  const take = (k: string, f: Field, v: unknown): AppActRefusal | undefined => {
    if (f === 'name') {
      if (typeof v !== 'string') return 'bad-request'
      if (v.length > DESK_NAME_MAX) return 'too-long'
      const clean = sanitizeDeclaredName(v)
      if (clean === '') return 'bad-request'
      out[k] = clean
      return undefined
    }
    if (!fieldOk(f, v)) return 'bad-request'
    out[k] = v
    return undefined
  }
  for (const [k, f] of Object.entries(rule.need)) {
    if (body[k] === undefined) { if (out[k] !== undefined) continue; return 'bad-request' }
    const why = take(k, f, body[k])
    if (why) return why
  }
  for (const [k, f] of Object.entries(rule.may ?? {})) {
    if (body[k] === undefined) continue
    const why = take(k, f, body[k])
    if (why) return why
  }
  const args = parseAppAct(out)
  if (!args) return 'bad-request'
  return { args, target: appActTarget(args) }
}

/** What an act answers: done, or nothing to do (`already`); a new desk says its id. Nothing else of the app goes out. */
export interface AppActAnswer { state: 'done' | 'already'; deskId?: string }

/** The answer by the allow list, from what the app or tetherd said. */
export function appActAnswer(v: unknown): AppActAnswer {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  return { state: o.state === 'already' ? 'already' : 'done', ...(isId(o.deskId) ? { deskId: o.deskId } : {}) }
}

/**
 * The refusals of an act, by stable code, and the status each one is on the wire. `no-app` (no app open, or its lease ran
 * out: nothing is kept for later) is 0x08; an id that names nothing is 0x06; `busy` (another act on the same target waits,
 * or too many wait) 0x07; the rest is what the app would not do, 0x09: the person is typing in that pane (`with-user`),
 * the desk is the one she is looking at (`in-view`), the last awake desk, the same desk, a session that is not closed, a
 * target nobody was given, a pane that cannot (no process to hibernate, a shell to suspend), the agents' ownership off,
 * a pane's session never confirmed, and `no-answer` (the app was there and did not answer within tetherd's wait).
 */
export const APP_ACT_REFUSALS = {
  'no-app': RES_STATUS.noApp,
  'unknown-desk': RES_STATUS.notFound,
  'unknown-pane': RES_STATUS.notFound,
  'unknown-slot': RES_STATUS.notFound,
  'unknown-agent': RES_STATUS.notFound,
  'busy': RES_STATUS.limit,
  'with-user': RES_STATUS.failed,
  'in-view': RES_STATUS.failed,
  'last-desk': RES_STATUS.failed,
  'same-desk': RES_STATUS.failed,
  'not-closed': RES_STATUS.failed,
  'not-given': RES_STATUS.failed,
  'cannot': RES_STATUS.failed,
  'owners-off': RES_STATUS.failed,
  'unconfirmed': RES_STATUS.failed,
  'no-answer': RES_STATUS.failed,
  'refused': RES_STATUS.failed,
} as const satisfies Record<string, ResStatus>
export type AppActCode = keyof typeof APP_ACT_REFUSALS
export const isAppActRefusal = (code: unknown): code is AppActCode => typeof code === 'string' && Object.hasOwn(APP_ACT_REFUSALS, code)

/** The codes the app may answer with (tetherd's own, `no-app`, `busy`, `no-answer`, are not the app's to say). Any other: `refused`. */
export const APP_ANSWER_CODES: readonly AppActCode[] = [
  'unknown-desk', 'unknown-pane', 'unknown-slot', 'unknown-agent', 'with-user', 'in-view', 'last-desk', 'same-desk', 'not-closed',
  'not-given', 'cannot', 'owners-off', 'unconfirmed', 'refused',
]

/** The codes this module adds to what a body may carry (the others are in the lists of src/remote/projection.ts already). */
export const APP_ACT_ERROR_CODES = [
  'no-app', 'unknown-desk', 'unknown-pane', 'unknown-agent', 'with-user', 'in-view', 'last-desk', 'same-desk', 'not-closed',
  'not-given', 'cannot', 'owners-off', 'no-answer',
] as const

/** The event tetherd emits to the app: one ask, its act, and when it stops counting (an act that comes too late is not done). */
export interface AppActEvent { ask: string; act: AppAct; until: number }
/** The app's answer: done (`state`, a new desk's id) or refused by a code. */
export type AppActDoneArgs = { ask: string; ok: true; state?: 'done' | 'already'; deskId?: string } | { ask: string; ok: false; code: string }
