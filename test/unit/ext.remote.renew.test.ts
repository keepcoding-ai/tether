// The registry's half of M-1 (temper RR2): a renewal written to devices.json never grows it because of one device. Expired
// superseded tickets go, a renewal that would leave more than the ceiling alive is refused before anything changes, and
// the past keys keep only the newest ones.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { renewDevice, type DeviceEntry } from '../../extensions/remote/rules.ts'
import { LIMITS } from '../../src/remoted/limits.ts'

const NOW = 2_000_000_000
const hex = (n: number, bytes: number): string => n.toString(16).padStart(bytes * 2, '0')
const ticket = (n: number, exp = NOW + 30 * 86_400) => ({ ticketId: hex(n, 16), exp, keyId: hex(n, 8) })

function device(): DeviceEntry {
  return {
    deviceId: hex(1, 16), pubD: '04' + '11'.repeat(64), name: 'x', access: 'code', state: 'active', scopes: [], createdAt: '',
    maxVerUsed: 1, tickets: [ticket(0)], usedKeyIds: [hex(0, 8)], denied: [],
  }
}

describe('the registry bounds what renewals grow (M-1)', () => {
  test('superseded tickets stop at the ceiling: the renewal past it is refused and the entry stays as it was', () => {
    const d = device()
    for (let i = 1; i <= LIMITS.deniedPerDevice; i++) renewDevice(d, ticket(i), NOW, LIMITS.deniedPerDevice, LIMITS.usedKeyIdsPerDevice)
    assert.equal(d.denied.length, LIMITS.deniedPerDevice)
    const before = structuredClone(d)
    assert.throws(() => renewDevice(d, ticket(999), NOW, LIMITS.deniedPerDevice, LIMITS.usedKeyIdsPerDevice), /too many superseded/)
    assert.deepEqual(d, before)
  })

  test('expired superseded tickets leave at the next renewal; a reused key is refused; past keys keep the newest', () => {
    const d = device()
    d.denied = [{ ticketId: hex(7, 16), exp: NOW - 301 }, { ticketId: hex(8, 16), exp: NOW - 100 }]
    renewDevice(d, ticket(1), NOW, 3, 2)
    assert.deepEqual(d.denied.map((t) => t.ticketId), [hex(8, 16), hex(0, 16)], 'the expired one went; within the skew stays')
    assert.deepEqual(d.tickets, [ticket(1)])
    assert.throws(() => renewDevice(d, ticket(1), NOW, 3, 2), /already used/)
    renewDevice(d, ticket(2), NOW, 3, 2)
    assert.deepEqual(d.usedKeyIds, [hex(1, 8), hex(2, 8)])
  })
})
