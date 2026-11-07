// The Portuguese words of the fault registry (src/core/faults-labels.ts): labels, status words typed on a command line,
// tag normalization and the "voltou" sentence (always with its detail).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { kindLabel, normalizeTag, parseStatus, returnedText, statusLabel, statusPlural } from '../../src/core/faults-labels.ts'

test('labels follow the design table', () => {
  assert.deepEqual((['open', 'investigating', 'done', 'ignored'] as const).map(statusLabel), ['aberta', 'investigando', 'resolvida', 'ignorada'])
  assert.deepEqual((['load', 'uncaught', 'rejection', 'gone'] as const).map(kindLabel), ['ao abrir', 'erro não tratado', 'erro não tratado', 'processo morreu'])
  assert.equal(statusPlural('open'), 'abertas')
  assert.equal(statusPlural('investigating'), 'investigando')
})

test('parseStatus takes both languages, any case', () => {
  assert.equal(parseStatus('Aberta'), 'open')
  assert.equal(parseStatus('open'), 'open')
  assert.equal(parseStatus('RESOLVIDA'), 'done')
  assert.equal(parseStatus('done'), 'done')
  assert.equal(parseStatus('investigando'), 'investigating')
  assert.equal(parseStatus('ignorada'), 'ignored')
  assert.equal(parseStatus('nope'), undefined)
})

test('normalizeTag: lowercase, no #, only a-z 0-9 and hyphen', () => {
  assert.equal(normalizeTag('#Build'), 'build')
  assert.equal(normalizeTag('Windows PTY'), 'windows-pty')
  assert.equal(normalizeTag('  ação_rápida! '), 'acao-rapida')
  assert.equal(normalizeTag('###'), '')
  assert.equal(normalizeTag('a'.repeat(60)).length, 32)
})

test('returnedText always carries the version and, when known, the fix', () => {
  assert.equal(returnedText({}), undefined)
  assert.equal(returnedText({ returned: { ts: 't', version: '0.9.4' }, fix: { commit: 'def4567890', ts: 't' } }), 'voltou na v0.9.4, depois do fix def4567')
  assert.equal(returnedText({ returned: { ts: 't', version: 'v0.9.4' }, fix: { ts: 't' } }), 'voltou na v0.9.4, depois de resolvida')
  assert.equal(returnedText({ returned: { ts: 't', version: '0.9.4' } }), 'voltou na v0.9.4')
});
