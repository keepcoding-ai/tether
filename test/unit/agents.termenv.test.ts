import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { withColorSupport } from '../../src/agents/termenv.ts'

describe('withColorSupport', () => {
  test('defaults TERM and COLORTERM when the daemon was launched without them', () => {
    const env = withColorSupport({ PATH: 'x' })
    assert.equal(env.TERM, 'xterm-256color')
    assert.equal(env.COLORTERM, 'truecolor')
    assert.equal(env.PATH, 'x')
  })
  test('removes an inherited NO_COLOR (any case) and FORCE_COLOR=0', () => {
    const env = withColorSupport({ NO_COLOR: '1', No_Color: '1', FORCE_COLOR: '0' })
    assert.equal('NO_COLOR' in env || 'No_Color' in env, false)
    assert.equal('FORCE_COLOR' in env, false)
  })
  test('keeps explicit TERM, COLORTERM and FORCE_COLOR values, replaces TERM=dumb', () => {
    assert.deepEqual(withColorSupport({ TERM: 'xterm-direct', COLORTERM: '24bit', FORCE_COLOR: '2' }), { TERM: 'xterm-direct', COLORTERM: '24bit', FORCE_COLOR: '2' })
    assert.equal(withColorSupport({ TERM: 'dumb' }).TERM, 'xterm-256color')
  })
  test('profile env merged afterwards wins (claude adapter order)', () => {
    const env = withColorSupport({ NO_COLOR: '1' })
    Object.assign(env, { COLORTERM: 'false', NO_COLOR: '1' })
    assert.equal(env.COLORTERM, 'false')
    assert.equal(env.NO_COLOR, '1')
  })
})
