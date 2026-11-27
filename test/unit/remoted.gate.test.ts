// The portal's gate (src/remoted/gate.ts; fio-spec 7.2, 7.3, E-8): the order op → scope → presence → actId, decided by
// the 16-bit op before any body is parsed. Pure: the cases the bench cannot reach yet (a device without a scope, a
// credential and a window, which arrive with RR2).
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { OPS, PRESENCE, RES_STATUS, type Req } from '../../src/remote/index.ts'
import { FRESH_PAIR_REGISTER_MS, gate, type GateContext } from '../../src/remoted/gate.ts'

const ALL = new Set(['attention', 'manage:destructive'])
const ctx = (o: Partial<GateContext> = {}): GateContext => ({ scopes: ALL, presence: PRESENCE.unlocked, elevUntilS: 0, freshPair: false, openedMs: 0, nowMs: 1_000, ...o })
const req = (op: number, o: Partial<Req> = {}): Req => ({ reqId: 1, op, body: new Uint8Array(0), ...o })
const act = new Uint8Array(16)
const status = (v: ReturnType<typeof gate>): number => (v.ok ? RES_STATUS.ok : v.status)

describe('the gate of the operations table', () => {
  test('an op without a line → 0x02; a line without the scope → 0x03 [39]', () => {
    assert.equal(status(gate(req(0x0999), ctx())), RES_STATUS.unknownOp)
    assert.equal(status(gate(req(0x0100), ctx({ scopes: new Set() }))), RES_STATUS.noScope)
    assert.equal(status(gate(req(0x0001), ctx({ scopes: new Set() }))), RES_STATUS.ok, 'the session family needs no scope')
  })

  test('locked: only the session family [E-10 shape]; no credential: reads pass, acts outside the session family → 0x05 [E-8, 40]', () => {
    assert.equal(status(gate(req(0x0100), ctx({ presence: PRESENCE.locked }))), RES_STATUS.locked)
    assert.equal(status(gate(req(0x0001), ctx({ presence: PRESENCE.locked }))), RES_STATUS.ok)
    assert.equal(status(gate(req(0x0100), ctx({ presence: PRESENCE.noCredential }))), RES_STATUS.ok)
    assert.equal(status(gate(req(0x0601, { actId: act }), ctx({ presence: PRESENCE.noCredential }))), RES_STATUS.presenceRequired)
    assert.equal(status(gate(req(0x0008, { actId: act }), ctx({ presence: PRESENCE.noCredential }))), RES_STATUS.ok, 'key-rotate.ack: the declared exception (Q19)')
    assert.equal(status(gate(req(0x0006, { actId: act }), ctx({ presence: PRESENCE.noCredential }))), RES_STATUS.ok, 'revoke-self only lowers power')
  })

  test('per act: a uvProof is needed (the house checks it), from an unlocked device with a credential; fresh-pair: only the pairing session, within 5 min [42]', () => {
    const uvProof = { uvCtr: 1, authenticatorData: new Uint8Array(37), clientDataJSON: new Uint8Array(2), signature: new Uint8Array(8) }
    assert.equal(status(gate(req(0x0601, { actId: act }), ctx())), RES_STATUS.presenceRequired)
    assert.equal(status(gate(req(0x0601, { actId: act, uvProof }), ctx())), RES_STATUS.ok)
    assert.equal(status(gate(req(0x0601, { actId: act, uvProof }), ctx({ presence: PRESENCE.locked }))), RES_STATUS.locked)
    assert.equal(status(gate(req(0x0601, { actId: act, uvProof }), ctx({ presence: PRESENCE.noCredential }))), RES_STATUS.presenceRequired)
    assert.equal(status(gate(req(0x0004, { actId: act, uvProof }), ctx({ presence: PRESENCE.locked }))), RES_STATUS.ok, 'uv.assert carries its proof')
    assert.equal(status(gate(req(0x0100, { uvProof }), ctx())), RES_STATUS.badRequest, 'a proof where none is checked')
    assert.equal(status(gate(req(0x0005, { actId: act }), ctx())), RES_STATUS.presenceRequired)
    assert.equal(status(gate(req(0x0005, { actId: act }), ctx({ freshPair: true }))), RES_STATUS.ok)
    assert.equal(status(gate(req(0x0005, { actId: act }), ctx({ freshPair: true, nowMs: FRESH_PAIR_REGISTER_MS + 1 }))), RES_STATUS.presenceRequired)
  })

  test('a line that changes state without actId → 0x01; every mutating line of the table is caught', () => {
    for (const line of OPS.filter((l) => l.mutates)) {
      const v = gate(req(line.code), ctx({ freshPair: true, presence: PRESENCE.unlocked }))
      assert.ok(!v.ok, line.name)
    }
    assert.equal(status(gate(req(0x0002), ctx())), RES_STATUS.badRequest)
    assert.equal(status(gate(req(0x0002, { actId: act }), ctx())), RES_STATUS.ok)
  })
})
