// The one table of remote operations (fio-spec 7.2, plano §2 "Escopos"): every request type of the remote protocol, with the
// scope a device needs, its presence class (7.3), whether it changes state, whether it is a gesture (E-11), the strict keys
// of its body and the pipe messages it may emit. The portal's gate decides by this table alone, by the 16-bit `op`, before
// the body is parsed. An `op` without a line is refused (0x02).
//
// Totality is a compile error, not a convention: OP_CODES is the protocol (the codes the wire carries) and OP_TABLE must
// have a line for each of its names (`satisfies` a mapped type), so a code added without a line, or a line without a
// declared scope, does not compile; test/unit/remote.scopes.test.ts checks the same at run time. The events (house →
// device) have their own table under the same rule. Pure: no node:*, no DOM.

/** The scope families a device may hold (plano §2). All on at pairing, adjustable on the machine. */
export const SCOPE_FAMILIES = [
  'attention', 'channels', 'regency:read', 'manage:agents', 'manage:desks', 'manage:procs', 'manage:destructive',
  'peek:terminal:read', 'peek:terminal:write', 'peek:browser',
] as const
export type ScopeFamily = (typeof SCOPE_FAMILIES)[number]

/** The scope of a line. `session` is the family every session has: what remains when the session is locked. */
export type OpScope = 'session' | ScopeFamily

/** Presence classes (spec 7.3). `fresh-pair`: only in the session that concluded the pairing (7.4 point 1). */
export type PresenceClass = 'none' | 'unlocked' | 'window' | 'per-act' | 'fresh-pair'

/** The scopes each range of `op` may use (spec 7.2): 0x00 session, 0x01 attention, 0x02 channels, 0x03 regency, 0x04 management, 0x05 peek, 0x06 devices. */
export const RANGE_SCOPES: Readonly<Record<number, readonly OpScope[]>> = {
  0x00: ['session'],
  0x01: ['attention'],
  0x02: ['channels'],
  0x03: ['regency:read'],
  0x04: ['manage:agents', 'manage:desks', 'manage:procs', 'manage:destructive'],
  0x05: ['peek:terminal:read', 'peek:terminal:write', 'peek:browser'],
  // The devices reuse manage:destructive (spec 7.2): the wire fixes the code and the presence class, not this scope.
  0x06: ['manage:destructive'],
}

/** The request types of the remote protocol: name → 16-bit `op`. A name here needs a line in OP_TABLE to compile. */
export const OP_CODES = {
  'session.info': 0x0001,
  'admit.renew': 0x0002,
  'uv.challenge': 0x0003,
  'uv.assert': 0x0004,
  'uv.register': 0x0005,
  'device.revoke-self': 0x0006,
  'session.lock': 0x0007,
  'house.key-rotate.ack': 0x0008,
  'attention.list': 0x0100,
  'attention.watch': 0x0101,
  'device.list': 0x0600,
  'device.revoke': 0x0601,
} as const
export type OpName = keyof typeof OP_CODES

export interface OpRule {
  /** Required: a line without a declared scope does not compile. */
  readonly scope: OpScope
  readonly presence: PresenceClass
  /** A line that changes state must come with an `actId` (rule 7). */
  readonly mutates: boolean
  /** Only a line triggered by the person's input resets the idle clock (rule 8, E-11). Decided here, not by the PWA. */
  readonly gesture: boolean
  /** Declared exception to E-8 (Q19): allowed to a device without a presence credential although it changes state. */
  readonly allowedWithoutCredential?: boolean
  /** The strict keys of the body: any other key is refused (0x01). Absent while the op has no handler (answered `not-implemented`). */
  readonly body?: readonly string[]
  /** The request types of the pipe this op may send to tetherd (rule 2). The portal never forwards a pipe object whole. */
  readonly pipe: readonly string[]
}

/** The table. Read it with `opByCode`; OPS is the same table as rows. */
export const OP_TABLE = {
  'session.info': { scope: 'session', presence: 'none', mutates: false, gesture: false, body: [], pipe: [] },
  'admit.renew': { scope: 'session', presence: 'none', mutates: true, gesture: false, body: ['pubA'], pipe: [] },
  'uv.challenge': { scope: 'session', presence: 'none', mutates: false, gesture: false, pipe: [] },
  'uv.assert': { scope: 'session', presence: 'none', mutates: true, gesture: true, pipe: [] },
  'uv.register': { scope: 'session', presence: 'fresh-pair', mutates: true, gesture: true, pipe: [] },
  'device.revoke-self': { scope: 'session', presence: 'none', mutates: true, gesture: true, body: [], pipe: [] },
  'session.lock': { scope: 'session', presence: 'none', mutates: true, gesture: true, pipe: [] },
  'house.key-rotate.ack': { scope: 'session', presence: 'unlocked', mutates: true, gesture: false, allowedWithoutCredential: true, pipe: [] },
  'attention.list': { scope: 'attention', presence: 'unlocked', mutates: false, gesture: false, body: [], pipe: [] },
  'attention.watch': { scope: 'attention', presence: 'unlocked', mutates: false, gesture: false, body: [], pipe: [] },
  'device.list': { scope: 'manage:destructive', presence: 'unlocked', mutates: false, gesture: false, pipe: [] },
  'device.revoke': { scope: 'manage:destructive', presence: 'per-act', mutates: true, gesture: true, pipe: [] },
} as const satisfies { readonly [K in OpName]: OpRule }

/** One row of the table: its code, its name and its rule. */
export type OpLine = OpRule & { readonly code: number; readonly name: OpName }

const OP_NAMES = Object.keys(OP_CODES) as OpName[]

/** The table as rows, in code order. */
export const OPS: readonly OpLine[] = OP_NAMES.map((name): OpLine => ({ code: OP_CODES[name], name, ...OP_TABLE[name] }))

const BY_CODE = new Map<number, OpLine>(OPS.map(l => [l.code, l]))
const BY_NAME = new Map<string, OpLine>(OPS.map(l => [l.name, l]))

/** The line of an `op`, or undefined: an `op` without a line is answered with status 0x02 (rule 3). */
export const opByCode = (code: number): OpLine | undefined => BY_CODE.get(code)
export const opByName = (name: string): OpLine | undefined => BY_NAME.get(name)

/** An event (house → device, rule 6): like an operation, it has a line with the scope and the presence a device needs to get it. */
export interface EvtLine {
  readonly code: number
  readonly name: string
  readonly scope: OpScope
  /** The presence the session must have for the event to go: a locked session keeps only the session family (7.3). */
  readonly presence: 'none' | 'unlocked'
}

/** Events fixed in this version. The portal emits one only to a session whose device has its scope and presence. */
export const EVT = {
  attentionChanged: { code: 0x0100, name: 'attention.changed', scope: 'attention', presence: 'unlocked' },
} as const satisfies Record<string, EvtLine>
export type EvtName = (typeof EVT)[keyof typeof EVT]['name']

const EVT_BY_CODE = new Map<number, EvtLine>(Object.values(EVT).map(l => [l.code, l]))

/** The line of an event code, or undefined for an event this version does not know. */
export const evtByCode = (code: number): EvtLine | undefined => EVT_BY_CODE.get(code)

/** Only these scopes are kept from the registry's list (an unknown string grants nothing and never reaches a device). */
export function knownScopes(scopes: readonly unknown[]): ScopeFamily[] {
  return SCOPE_FAMILIES.filter(s => scopes.includes(s))
}
