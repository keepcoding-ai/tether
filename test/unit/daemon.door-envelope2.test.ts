// Envelope 2 (channels contract N2 and N3): `to` and `ref` on the delivery message, and `userTypedAt` on the slots service.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deliveryMeta } from '../../src/daemon/door/channel-meta.ts'
import { terminalHeader, terminalText } from '../../src/daemon/door/terminal-text.ts'
import { checkMessage } from '../../src/daemon/door/delivery.ts'
import { UserPresence } from '../../src/daemon/door/user-presence.ts'
import { SlotsService } from '../../src/daemon/door/slots.ts'
import { DisposableStore } from '../../app/shared/vscode-lifecycle.ts'
import type { DeliveryMessage } from '../../src/daemon/door/types.ts'

const base: DeliveryMessage = { kind: 'message', room: 'obra', from: { name: 'claude · conferente', id: 'a1', role: 'member' }, body: 'oi' }

test('a message without to and ref keeps today\'s meta and header, byte for byte', () => {
  assert.deepEqual(deliveryMeta(base, 'channels', 'm_1'), {
    kind: 'message', origin: 'channels', room: 'obra', from: 'claude · conferente', from_id: 'a1', role: 'member', id: 'm_1',
  })
  assert.equal(terminalHeader(base, 'channels', 'm_1'), '[tether · channels · #obra · de claude · conferente (member) · m_1]')
  assert.equal(terminalText(base, 'channels', 'm_1'), '[tether · channels · #obra · de claude · conferente (member) · m_1] oi')
})

test('meta carries to (comma-joined, sanitised) and ref; an empty to is absent', () => {
  const meta = deliveryMeta({ ...base, to: ['Atrium', 'soul\n· bancada'], ref: 'obra#42' }, 'channels', 'm_1')
  assert.equal(meta.to, 'Atrium,soul · bancada')
  assert.equal(meta.ref, 'obra#42')
  assert.equal(meta.id, 'm_1')
  assert.ok(!('to' in deliveryMeta({ ...base, to: [] }, 'channels', 'm_1')))
  assert.ok(!('to' in deliveryMeta({ ...base, to: ['  '] }, 'channels', 'm_1')))
})

test('terminal header shows → names and the ref in place of the delivery id', () => {
  const msg = { ...base, to: ['Atrium', 'soul'], ref: 'obra#42' }
  assert.equal(terminalHeader(msg, 'channels', 'm_1'), '[tether · channels · #obra · de claude · conferente (member) → Atrium, soul · obra#42]')
  assert.equal(terminalHeader({ ...base, ref: 'obra#7' }, 'channels', 'm_1'), '[tether · channels · #obra · de claude · conferente (member) · obra#7]')
  assert.equal(terminalHeader({ ...base, to: ['x]'] }, 'channels', 'm_1'), '[tether · channels · #obra · de claude · conferente (member) → x) · m_1]')
})

test('checkMessage keeps to and ref and refuses a to that is not a list of text', () => {
  const ok = checkMessage({ ...base, to: ['Atrium'], ref: 'obra#1' })
  assert.deepEqual(ok.to, ['Atrium'])
  assert.equal(ok.ref, 'obra#1')
  assert.ok(!('to' in checkMessage({ ...base, to: [] })))
  assert.deepEqual(checkMessage(base), base)
  for (const bad of ['Atrium', [1], ['a', null], { 0: 'a' }]) {
    assert.throws(() => checkMessage({ ...base, to: bad }), (e: unknown) => (e as { code?: string }).code === 'bad-request')
  }
  assert.throws(() => checkMessage({ ...base, ref: 5 }), (e: unknown) => (e as { code?: string }).code === 'bad-request')
})

test('UserPresence.typedAt: the person\'s key moves it, the agent\'s does not, a draft does not make it Infinity', () => {
  const p = new UserPresence()
  assert.equal(p.typedAt('s1'), undefined)
  p.input('s1', 'ab', 1000, 'agent')
  assert.equal(p.typedAt('s1'), undefined)
  assert.equal(p.typedAt('s1', 'agent'), 1000)
  p.input('s1', 'abc', 2000, 'user')
  assert.equal(p.draft('s1', 'user'), true)
  assert.equal(p.typedAt('s1'), 2000)
  p.input('s1', 'd', 3000, 'agent')
  assert.equal(p.typedAt('s1'), 2000)
  p.input('s1', 'e', 4000, 'user')
  assert.equal(p.typedAt('s1'), 4000)
  p.input('s1', '\x1b[I', 5000, 'user')
  assert.equal(p.typedAt('s1'), 4000)
})

test('userTypedAt reads the presence: the person\'s key only, undefined when never or without presence', () => {
  const at = new Map<string, number>([['s1', 1234]])
  const svc = new SlotsService(() => undefined, () => {}, () => undefined, () => ({ isFree: () => true, typedAt: (id) => at.get(id) }))
  const api = svc.apiFor('x', new DisposableStore())
  assert.equal(api.userTypedAt('s1'), 1234)
  assert.equal(api.userTypedAt('s2'), undefined)
  const bare = new SlotsService(() => undefined, () => {}).apiFor('x', new DisposableStore())
  assert.equal(bare.userTypedAt('s1'), undefined)
})
