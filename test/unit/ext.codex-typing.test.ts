// The Codex typing: non-ASCII as win32 key events on Windows, raw elsewhere; the Enter waits are kept.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import '../../extensions/index.daemon.ts' // loads the extensions in their own order (codex/daemon.ts alone hits an import cycle)
import { codexAgent } from '../../extensions/codex/daemon.ts'
import { codexTyping, winKeyEvents } from '../../extensions/codex/typing.ts'
import { typingOf } from '../../src/daemon/door/typing.ts'

describe('codex typing', () => {
  test('winKeyEvents leaves ASCII raw and turns each non-ASCII unit into a key press', () => {
    assert.equal(winKeyEvents('ab'), 'ab')
    assert.equal(winKeyEvents('a·b'), 'a\x1b[0;0;183;1;0;1_b')
    assert.equal(winKeyEvents('—'), '\x1b[0;0;8212;1;0;1_')
  })

  test('on win32 the header dot goes as a key event, with the 300 ms Enter', () => {
    const chunks = codexTyping('win32').submit('a · b')
    assert.deepEqual(chunks, [{ data: 'a \x1b[0;0;183;1;0;1_ b' }, { data: '\r', waitMs: 300 }])
  })

  test('off Windows the text stays raw', () => {
    const chunks = codexTyping('linux').submit('a · é')
    assert.deepEqual(chunks, [{ data: 'a · é' }, { data: '\r', waitMs: 300 }])
  })

  test('several lines are a bracketed paste, lines joined with CR, 400 ms Enter', () => {
    const chunks = codexTyping('win32').submit('x·\ny')
    assert.deepEqual(chunks, [{ data: '\x1b[200~x\x1b[0;0;183;1;0;1_\ry\x1b[201~' }, { data: '\r', waitMs: 400 }])
  })

  test('the codex agent contribution carries it, and typingOf (used by the resume) returns it', () => {
    assert.ok(codexAgent.typing)
    assert.equal(typingOf(codexAgent), codexAgent.typing)
    const chunks = codexAgent.typing.submit('hello')
    assert.equal(chunks[1]!.waitMs, 300)
  })
})
