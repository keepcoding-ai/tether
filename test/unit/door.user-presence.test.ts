// The user interlock of the delivery (src/daemon/door/user-presence.ts): the draft and the silence. Pure.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { countsAsTyping, draftEffect, UserPresence, USER_QUIET_MS } from '../../src/daemon/door/user-presence.ts'

describe('door user presence', () => {
  test('nobody typed: free', () => {
    const p = new UserPresence()
    assert.equal(p.isFree('s', 0), true)
    assert.equal(p.freeAt('s'), undefined)
  })

  test('a printable key makes a draft: never free by time alone', () => {
    const p = new UserPresence()
    p.input('s', 'ab', 1000)
    assert.equal(p.draft('s'), true)
    assert.equal(p.isFree('s', 1000 + USER_QUIET_MS * 10), false)
    assert.equal(p.freeAt('s'), Infinity)
  })

  test('Enter, Ctrl+C and Ctrl+U clear the draft; then 10 s of silence frees the slot', () => {
    for (const clear of ['\r', '\n', '\x03', '\x15']) {
      const p = new UserPresence()
      p.input('s', 'ab', 1000)
      p.input('s', clear, 2000)
      assert.equal(p.draft('s'), false, JSON.stringify(clear))
      assert.equal(p.isFree('s', 2000 + USER_QUIET_MS - 1), false)
      assert.equal(p.isFree('s', 2000 + USER_QUIET_MS), true)
    }
  })

  test('the last effect of a chunk wins', () => {
    assert.equal(draftEffect('ab\r'), false)
    assert.equal(draftEffect('\rab'), true)
    assert.equal(draftEffect('\x7f'), undefined)
  })

  test('a busy turn takes the draft', () => {
    const p = new UserPresence()
    p.input('s', 'ab', 1000)
    p.turnBusy('s')
    assert.equal(p.draft('s'), false)
    assert.equal(p.isFree('s', 1000 + USER_QUIET_MS), true)
  })

  test('terminal answers (a chunk that starts with ESC) are not typing; a bracketed paste is, and makes a draft', () => {
    const p = new UserPresence()
    p.input('s', '\x1b[?1;2c', 1000)
    p.input('s', '\x1b[I', 1000)
    assert.equal(p.freeAt('s'), undefined)
    assert.equal(countsAsTyping('\x1b[200~x\x1b[201~'), true)
    p.input('s', '\x1b[200~linha 1\nlinha 2\x1b[201~', 1000)
    assert.equal(p.draft('s'), true, 'line breaks inside a paste do not submit it')
    p.input('s', '\r', 2000)
    assert.equal(p.draft('s'), false)
  })

  test('slots are independent; forget clears one', () => {
    const p = new UserPresence(50)
    p.input('a', 'x', 0)
    assert.equal(p.isFree('b', 0), true)
    p.forget('a')
    assert.equal(p.isFree('a', 0), true)
  })
})
