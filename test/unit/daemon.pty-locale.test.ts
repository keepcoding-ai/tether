// The UTF-8 locale guarantee for pty children: a tether launched from Finder has no LANG/LC_*, and children in the C
// locale garble non-ASCII text (pbcopy reads UTF-8 as Mac Roman). Explicit LC_ALL/LC_CTYPE always win.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { withUtf8Locale } from '../../src/daemon/pty.ts'

describe('withUtf8Locale', () => {
  test('no locale at all gets en_US.UTF-8', () => {
    assert.deepEqual(withUtf8Locale({ PATH: '/bin' }, 'darwin'), { PATH: '/bin', LANG: 'en_US.UTF-8' })
  })
  test('a LANG without UTF-8 keeps its language part', () => {
    assert.equal(withUtf8Locale({ LANG: 'pt_BR' }, 'darwin').LANG, 'pt_BR.UTF-8')
    assert.equal(withUtf8Locale({ LANG: 'pt_BR.ISO8859-1' }, 'linux').LANG, 'pt_BR.UTF-8')
    assert.equal(withUtf8Locale({ LANG: 'C' }, 'darwin').LANG, 'en_US.UTF-8')
  })
  test('a UTF-8 LANG is kept, any spelling', () => {
    const env = { LANG: 'de_DE.utf8' }
    assert.equal(withUtf8Locale(env, 'linux'), env)
    assert.equal(withUtf8Locale({ LANG: 'pt_BR.UTF-8' }, 'darwin').LANG, 'pt_BR.UTF-8')
  })
  test('explicit LC_ALL or LC_CTYPE is never overridden', () => {
    const all = { LC_ALL: 'C' }
    const ctype = { LC_CTYPE: 'C', LANG: 'C' }
    assert.equal(withUtf8Locale(all, 'darwin'), all)
    assert.equal(withUtf8Locale(ctype, 'darwin'), ctype)
  })
  test('Windows is left alone', () => {
    const env = { PATH: 'C:\\' }
    assert.equal(withUtf8Locale(env, 'win32'), env)
  })
  test('the input is never mutated', () => {
    const env = { PATH: '/bin' }
    withUtf8Locale(env, 'darwin')
    assert.deepEqual(env, { PATH: '/bin' })
  })
})
