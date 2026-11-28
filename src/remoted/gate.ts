// The portal's gate for one REQ (fio-spec 7.2, 7.3): it decides by the 16-bit `op` and the one table of operations
// (src/remote/scopes.ts), BEFORE the JSON body is parsed. Order: a line for the op (else 0x02), the scope of the device (0x03),
// the presence class (0x04 locked / 0x05 presence required), then `actId` for a line that changes state (0x01). The events
// go by the same table (`gateEvent`). Pure.
//
// The reach of the pipe (rule 3): ./reach.ts classifies every message type a client may send tetherd, and lists the
// extension pairs a device may reach; re-exported here for the portal.
import { opByCode, PRESENCE, RES_STATUS, type EvtLine, type OpLine, type Presence, type Req, type ResStatus } from '../remote/index.ts'

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

// The reach of the pipe lives in ./reach.ts, the one source tetherd also enforces (src/daemon/server.ts).
export {
  EXT_READS, EXT_WRITES, extReadOf, PIPE_REACH, REMOTE_EXT_PAIRS, remoteMayRequest, remoteMaySend,
  type ExtPair, type ExtReadLinesOf, type ExtReadOp, type ExtReadPair, type ExtRequestLinesOf, type ExtWriteOp, type PipeReach, type PipeType,
} from './reach.ts'
