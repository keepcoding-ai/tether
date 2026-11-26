// The capsule's fixed pills (Gaveta, system desks) drop to icons only when the common desks would not all fit
// (app/renderer/desk-switch-rules.ts fitCapsule).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fitCapsule, fitDesks, type CapsuleFitInput } from '../../app/renderer/desk-switch-rules.ts'

const order = ['a', 'b', 'c', 'd', 'e']
const widths = { a: 100, b: 100, c: 100, d: 100, e: 100 }
// Labels cost 150 px in all; icon-only costs 60 px less of that.
const base: CapsuleFitInput = { order, active: 'a', visible: [], widths, avail: 500, availCompact: 560, plusWidth: 40, gap: 0, lastUsed: {} }

test('everything fits with the names: the pills keep them', () => {
  const r = fitCapsule(base)
  assert.deepEqual(r.visible, order)
  assert.equal(r.compactPills, false)
})

test('it does not fit: the pills shrink to icons and the freed room brings desks back', () => {
  const narrow = { ...base, avail: 300, availCompact: 360 }
  const before = fitDesks(narrow)
  const r = fitCapsule(narrow)
  assert.equal(r.compactPills, true)
  assert.ok(r.visible.length > before.length, `${r.visible.length} > ${before.length}`)
  assert.ok(r.visible.includes('a'), 'the active desk stays')
})

test('icons make everything fit: no "+N" at all', () => {
  const r = fitCapsule({ ...base, avail: 450, availCompact: 520 })
  assert.deepEqual(r.visible, order)
  assert.equal(r.compactPills, true)
})

test('never fewer desks visible than with the names', () => {
  for (let avail = 0; avail <= 700; avail += 10) {
    const i = { ...base, avail, availCompact: avail + 60 }
    assert.ok(fitCapsule(i).visible.length >= fitDesks(i).length, `avail ${avail}`)
  }
})

test('an active fixed pill keeps its name: the caller measures it into availCompact, which is then smaller', () => {
  // Same rule, less gained: with only 10 px back, no extra desk fits but the visible set is not worse.
  const i = { ...base, avail: 300, availCompact: 310 }
  assert.equal(fitCapsule(i).visible.length, fitDesks(i).length)
})

test('availCompact below avail is ignored (no loss)', () => {
  const i = { ...base, avail: 300, availCompact: 200 }
  assert.deepEqual(fitCapsule(i).visible, fitDesks(i))
})
