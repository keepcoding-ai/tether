// The portal's gate for one REQ (fio-spec 7.2, 7.3): it decides by the 16-bit `op` and the one table of operations
// (src/remote/scopes.ts), BEFORE the JSON body is parsed. Order: a line for the op (else 0x02), the scope of the device (0x03),
// the presence class (0x04 locked / 0x05 presence required), then `actId` for a line that changes state (0x01). The events
// go by the same table (`gateEvent`). Pure.
//
// The reach of the pipe (rule 3): every message type a client may send tetherd is classified here, and the type is a
// mapped type over the pipe's union, so a new message type of src/daemon/protocol.ts does not compile until it is
// classified. `op`: some line of the table may emit it; `ext-read`: only `ext-request`, and only as one of the pairs
// (extension, request) of EXT_READS, each the read of one line of the table; `portal`: only the portal's own client sends
// it, to keep its views, never on a device's behalf; `never`: no remote path reaches it.
import { opByCode, PRESENCE, RES_STATUS, type EvtLine, type OpLine, type OpName, type Presence, type Req, type ResStatus } from '../remote/index.ts'
import type { OP_TABLE } from '../remote/scopes.ts'
import type { ClientMessage } from '../daemon/protocol.ts'

/** How long the session that concluded a pairing may register its presence credential (spec 7.4 point 1). */
export const FRESH_PAIR_REGISTER_MS = 5 * 60_000

export interface GateContext {
  /** The scopes the registry grants this device. The session family needs none. */
  scopes: ReadonlySet<string>
  /** The session's presence now (the registry's credential and the portal's memory, src/remoted/uv.ts; never the PWA's word). */
  presence: Presence
  /** Unix seconds until which the elevation window is open; 0 for none. */
  elevUntilS: number
  /** The session concluded a pairing, and when it opened. */
  freshPair: boolean
  openedMs: number
  nowMs: number
}

export type GateVerdict = { ok: true; line: OpLine } | { ok: false; status: ResStatus; line?: OpLine }

export function gate(req: Req, c: GateContext): GateVerdict {
  const line = opByCode(req.op)
  if (!line) return { ok: false, status: RES_STATUS.unknownOp }
  if (line.scope !== 'session' && !c.scopes.has(line.scope)) return { ok: false, status: RES_STATUS.noScope, line }
  const noCredential = c.presence === PRESENCE.noCredential
  // E-8: a device without a presence credential only reads, and does not peek; any act outside the session family needs the person.
  if (noCredential && line.scope.startsWith('peek:')) return { ok: false, status: RES_STATUS.presenceRequired, line }
  if (noCredential && line.scope !== 'session' && line.mutates && !line.allowedWithoutCredential) {
    return { ok: false, status: RES_STATUS.presenceRequired, line }
  }
  switch (line.presence) {
    case 'none':
      break
    case 'fresh-pair':
      if (!c.freshPair || c.nowMs - c.openedMs > FRESH_PAIR_REGISTER_MS) return { ok: false, status: RES_STATUS.presenceRequired, line }
      break
    case 'unlocked':
      if (c.presence === PRESENCE.locked) return { ok: false, status: RES_STATUS.locked, line }
      if (noCredential && line.mutates && !line.allowedWithoutCredential) return { ok: false, status: RES_STATUS.presenceRequired, line }
      break
    case 'window':
      if (noCredential || c.elevUntilS * 1000 <= c.nowMs) return { ok: false, status: RES_STATUS.presenceRequired, line }
      break
    case 'per-act':
      // The proof travels in the request itself; the gate only demands it is there, from a device that holds a credential
      // and is unlocked. The house verifies it against the challenge it recomputes from this request, before the act runs.
      if (noCredential || !req.uvProof) return { ok: false, status: RES_STATUS.presenceRequired, line }
      if (c.presence === PRESENCE.locked) return { ok: false, status: RES_STATUS.locked, line }
      break
  }
  // A proof means something only where it is checked: on uv.assert and on a per-act line. Anywhere else it is refused.
  if (req.uvProof && line.presence !== 'per-act' && line.name !== 'uv.assert') return { ok: false, status: RES_STATUS.badRequest, line }
  if (line.mutates && !req.actId) return { ok: false, status: RES_STATUS.badRequest, line }
  return { ok: true, line }
}

/** Whether an event may go to a session now: the device holds its scope, and the session's presence allows it (7.3). */
export function gateEvent(line: EvtLine, c: Pick<GateContext, 'scopes' | 'presence'>): boolean {
  if (line.scope !== 'session' && !c.scopes.has(line.scope)) return false
  if (line.scope.startsWith('peek:') && c.presence === PRESENCE.noCredential) return false
  return line.presence === 'none' || c.presence !== PRESENCE.locked
}

export type PipeType = ClientMessage['t']
export type PipeReach = 'op' | 'ext-read' | 'portal' | 'never'

/** Every message type of the pipe, classified. Total: a type of the pipe without a key here does not compile. */
export const PIPE_REACH = {
  // The portal's own client: its handshake and the list that feeds the attention view.
  'auth': 'portal', 'hello': 'portal', 'list': 'portal',
  'perf': 'never', 'debug-block': 'never',
  'create': 'never', 'start': 'never', 'attach': 'never', 'detach': 'never', 'read-screen': 'never', 'resize': 'never',
  'stop': 'never', 'set-want': 'never', 'forget': 'never', 'rename-slot': 'never', 'shutdown': 'never',
  'profiles-list': 'never', 'profile-save': 'never', 'profile-delete': 'never', 'set-profile': 'never', 'restart': 'never',
  'seen': 'never', 'unseen': 'never', 'desk-map': 'never',
  // Tunnels (rule 4): a remote op never carries another type inside its body. An extension request that is exposed gets its
  // own op, and `ext-request` reaches tetherd only as one pair of EXT_READS (below): every other one stays without a path.
  'ext-request': 'ext-read',
  'verb-list': 'never', 'verb': 'never', 'object-get': 'never', 'object-set': 'never',
  'pause-start': 'never', 'pause-get': 'never', 'pause-remove': 'never', 'pause-cancel': 'never', 'pause-resume': 'never',
  'ronda-set': 'never', 'ronda-get': 'never', 'ronda-off': 'never',
  'proc-list': 'never', 'proc-info': 'never', 'proc-start': 'never', 'proc-stop': 'never', 'proc-restart': 'never',
  'proc-adopt': 'never', 'proc-forget': 'never', 'proc-use': 'never', 'proc-release': 'never', 'proc-ports': 'never',
  'proc-seen': 'never', 'proc-attach': 'never', 'proc-detach': 'never', 'proc-host': 'never', 'proc-host-stop': 'never',
  'input': 'never', 'typed': 'never',
} as const satisfies { readonly [T in PipeType]: PipeReach }

/** Every pipe type a line of the table may emit is a type of the pipe (a misspelt or removed type does not compile). */
type EmittedByOps = (typeof OP_TABLE)[OpName]['pipe'][number]
const emittedArePipeTypes: [EmittedByOps] extends [PipeType] ? true : false = true
void emittedArePipeTypes

// ---- the class `ext-read`: a read of an extension, listed by name -------------------------------------------------

type Lines = { readonly [name: string]: { readonly mutates: boolean; readonly gesture: boolean; readonly pipe: readonly string[] } }
/** The lines of a table that emit `ext-request`. */
export type ExtRequestLinesOf<T extends Lines> = { [K in keyof T]: 'ext-request' extends T[K]['pipe'][number] ? K : never }[keyof T]
/** The lines of a table that may hold a pair: they emit `ext-request`, change no state and are no gesture. */
export type ExtReadLinesOf<T extends Lines> = {
  [K in keyof T]: T[K] extends { readonly mutates: false; readonly gesture: false } ? (K extends ExtRequestLinesOf<T> ? K : never) : never
}[keyof T]
export type ExtReadOp = ExtReadLinesOf<typeof OP_TABLE>
/** A line that emits `ext-request` and changes state (or is a gesture) does not compile: an extension's write has no remote path here. */
const extRequestOnlyReads: [ExtRequestLinesOf<typeof OP_TABLE>] extends [ExtReadOp] ? true : false = true
void extRequestOnlyReads

/** One read request of a daemon extension: the extension and the request's name, exactly as tetherd registers them. */
export interface ExtReadPair { readonly ext: string; readonly name: string }

/**
 * The closed list of the extension reads a device may reach, by the line of the table that reaches each one. Total both
 * ways by type: a line that emits `ext-request` without a pair, a pair without a line, and a pair on a line that changes
 * state do not compile. The device never names the extension nor the request: the portal takes them from here by the op
 * the gate already checked, and test/unit/remote.scopes.test.ts proves on the daemon halves that each pair only reads.
 */
export const EXT_READS = {
  'channels.marks': { ext: 'channels', name: 'marks' },
  'channels.page': { ext: 'channels', name: 'history' },
  'regency.tree': { ext: 'regency', name: 'tree.read' },
} as const satisfies { readonly [K in ExtReadOp]: ExtReadPair }

/** The pair of a line, or undefined for a name that has none (every request outside the list stays `never`). */
export const extReadOf = (op: string): ExtReadPair | undefined =>
  Object.hasOwn(EXT_READS, op) ? EXT_READS[op as ExtReadOp] : undefined
