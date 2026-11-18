import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Scrollback } from '../../src/daemon/scrollback.ts'

test('empty ring', () => {
  const s = new Scrollback(10)
  assert.deepEqual([s.start, s.end], [0, 0])
  assert.deepEqual(s.since(0), { data: '', off: 0, reset: false })
})

test('since inside the ring and at end', () => {
  const s = new Scrollback(100)
  s.push('hello'); s.push('world')
  assert.deepEqual(s.since(5), { data: 'world', off: 10, reset: false })
  assert.deepEqual(s.since(0), { data: 'helloworld', off: 10, reset: false })
  assert.deepEqual(s.since(10), { data: '', off: 10, reset: false })
})

test('off beyond end resets', () => {
  const s = new Scrollback(100)
  s.push('abc')
  assert.deepEqual(s.since(4), { data: 'abc', off: 3, reset: true })
  assert.equal(s.since(-1).reset, true)
})

test('overflow moves start; stale offsets reset', () => {
  const s = new Scrollback(10)
  s.push('aaaaa'); s.push('bbbbb'); s.push('ccccc')
  assert.equal(s.end, 15)
  assert.equal(s.start, 5)
  assert.equal(s.length, 10)
  assert.deepEqual(s.since(2), { data: 'bbbbbccccc', off: 15, reset: true })
  assert.deepEqual(s.since(5), { data: 'bbbbbccccc', off: 15, reset: false })
  assert.deepEqual(s.since(10), { data: 'ccccc', off: 15, reset: false })
})

test('oversized push keeps tail and offsets', () => {
  const s = new Scrollback(4)
  s.push('ab'); s.push('0123456789')
  assert.equal(s.end, 12)
  assert.equal(s.start, 8)
  assert.equal(s.text(), '6789')
  assert.equal(s.since(9).data, '789')
})

test('clear keeps offsets monotonic', () => {
  const s = new Scrollback(10)
  s.push('abc'); s.clear()
  assert.deepEqual([s.start, s.end], [3, 3])
  assert.deepEqual(s.since(0), { data: '', off: 3, reset: true })
})
