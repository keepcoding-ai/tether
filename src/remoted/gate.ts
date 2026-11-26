// The portal's gate for one REQ (fio-spec 7.2, 7.3): it decides by the 16-bit `op` and the one registry of operations
// (src/remote/ops.ts), BEFORE the JSON body is parsed. Order: a line for the op (else 0x02), the scope of the device (0x03),
// the presence class (0x04 locked / 0x05 presence required), then `actId` for a line that changes state (0x01). Pure.
import { opByCode, PRESENCE, RES_STATUS, type OpLine, type Presence, type Req, type ResStatus } from '../remote/index.ts'

/** How long the session that concluded a pairing may register its presence credential (spec 7.4 point 1). */
export const FRESH_PAIR_REGISTER_MS = 5 * 60_000

export interface GateContext {
  /** The scopes the registry grants this device. The session family needs none. */
  scopes: ReadonlySet<string>
  /** The device's presence now (from the registry and the portal's memory, never from the PWA). */
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
  // E-8: a device without a presence credential only reads; any act outside the session family needs the person.
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
      // The proof travels in the request itself and is checked by the presence verifier, which arrives with step 2.4.
      // Until then a per-act line is refused whatever the request carries: a proof nobody checks proves nothing.
      return { ok: false, status: RES_STATUS.presenceRequired, line }
  }
  if (line.mutates && !req.actId) return { ok: false, status: RES_STATUS.badRequest, line }
  return { ok: true, line }
}
