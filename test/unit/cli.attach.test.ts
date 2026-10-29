import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createOutputFilter, DETACH_KEY } from '../../src/cli/attach.ts'

test('output filter drops the win32-input-mode request and keeps everything else', () => {
  const f = createOutputFilter()
  assert.equal(f('a\x1b[?9001hb\x1b[?9001lc'), 'abc')
  assert.equal(f('\x1b[2J\x1b[H$ '), '\x1b[2J\x1b[H$ ')
  assert.equal(f('\x1b[?25h'), '\x1b[?25h')
})

test('output filter handles a request split across chunks', () => {
  const f = createOutputFilter()
  assert.equal(f('x\x1b[?90'), 'x')
  assert.equal(f('01hy'), 'y')
  assert.equal(f('\x1b'), '')
  assert.equal(f('[31mred'), '\x1b[31mred')
})

test('detach key is Ctrl+]', () => {
  assert.equal(DETACH_KEY, '\x1d')
})
