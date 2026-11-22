// The user interlock of the delivery (src/daemon/door/user-presence.ts): the draft and the silence. Pure.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { countsAsTyping, draftAfter, UserPresence, USER_QUIET_MS } from '../../src/daemon/door/user-presence.ts'

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

  test('the draft is a count: the chunk is read in order', () => {
    assert.equal(draftAfter(0, 'ab\r'), 0)
    assert.equal(draftAfter(0, '\rab'), 2)
    assert.equal(draftAfter(0, '\x7f'), 0)
    assert.equal(draftAfter(3, '\x08\x7f'), 1)
  })

  test('a letter and Backspace free the slot', () => {
    const p = new UserPresence()
    p.input('s', 'a', 1000)
    assert.equal(p.draft('s'), true)
    p.input('s', '\x7f', 2000)
    assert.equal(p.draft('s'), false)
    assert.equal(p.isFree('s', 2000 + USER_QUIET_MS), true)
  })

  test('two letters and one Backspace keep the draft', () => {
    const p = new UserPresence()
    p.input('s', 'ab', 1000)
    p.input('s', '\x7f', 2000)
    assert.equal(p.draft('s'), true)
    assert.equal(p.isFree('s', 2000 + USER_QUIET_MS * 10), false)
  })

  test('Backspace on an empty box never goes negative', () => {
    const p = new UserPresence()
    p.input('s', '\x7f\x7f', 1000)
    p.input('s', 'a', 2000)
    assert.equal(p.draft('s'), true)
    p.input('s', '\x7f', 3000)
    assert.equal(p.draft('s'), false)
  })

  test('a paste weighs its length; chunks add up across calls', () => {
    const p = new UserPresence()
    p.input('s', '\x1b[200~abcd\x1b[201~', 1000)
    p.input('s', '\x7f\x7f\x7f', 2000)
    assert.equal(p.draft('s'), true)
    p.input('s', '\x7f', 3000)
    assert.equal(p.draft('s'), false)
    p.input('s', 'a', 4000)
    p.input('s', 'b', 5000)
    p.input('s', '\x7f', 6000)
    assert.equal(p.draft('s'), true)
    p.input('s', '\x7f', 7000)
    assert.equal(p.draft('s'), false)
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

  test('who typed is kept apart: the person alone, or both', () => {
    const p = new UserPresence()
    p.input('s', 'cmd', 1000, 'agent')
    assert.equal(p.isFree('s', 1000, 'user'), true, 'an agent draft is not hers')
    assert.equal(p.isFree('s', 1000 + USER_QUIET_MS * 10), false, 'both: the agent draft holds the delivery')
    assert.equal(p.draft('s', 'agent'), true)
    assert.equal(p.draft('s', 'user'), false)
    p.input('s', '\r', 2000, 'agent')
    p.input('s', 'x', 3000)
    assert.equal(p.isFree('s', 3000, 'agent'), false, 'the agent is quiet only after USER_QUIET_MS')
    assert.equal(p.freeAt('s', 'agent'), 2000 + USER_QUIET_MS)
    assert.equal(p.freeAt('s', 'user'), Infinity)
    assert.equal(p.freeAt('s'), Infinity)
    p.turnBusy('s')
    assert.equal(p.freeAt('s'), 3000 + USER_QUIET_MS, 'the later of the two')
  })
})
