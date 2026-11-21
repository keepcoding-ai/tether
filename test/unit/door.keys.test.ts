// The agent door's named keys: the pure table that turns a key name into the bytes a terminal sends.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { isKeyName, KEY_BYTES, keyBytes } from '../../src/daemon/door/keys.ts'

describe('door keys', () => {
  test('the table has the bytes a terminal sends', () => {
    assert.equal(keyBytes('enter'), '\r')
    assert.equal(keyBytes('esc'), '\x1b')
    assert.equal(keyBytes('tab'), '\t')
    assert.equal(keyBytes('shift+tab'), '\x1b[Z')
    assert.equal(keyBytes('backspace'), '\x7f')
    assert.deepEqual(['up', 'down', 'right', 'left'].map(keyBytes), ['\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D'])
    assert.deepEqual(['ctrl+c', 'ctrl+d', 'ctrl+u', 'ctrl+e'].map(keyBytes), ['\x03', '\x04', '\x15', '\x05'])
    assert.equal(keyBytes('paste-start'), '\x1b[200~')
    assert.equal(keyBytes('paste-end'), '\x1b[201~')
  })

  test('every key is distinct and non-empty; names outside the table are refused', () => {
    const all = Object.values(KEY_BYTES)
    assert.equal(all.length, 15)
    assert.equal(new Set(all).size, all.length)
    assert.ok(all.every((b) => b.length > 0))
    assert.equal(isKeyName('enter'), true)
    assert.equal(isKeyName('toString'), false)
    assert.equal(isKeyName(42), false)
    assert.throws(() => keyBytes('f13'), /tecla desconhecida/)
    assert.throws(() => keyBytes('constructor'), /tecla desconhecida/)
  })
})
