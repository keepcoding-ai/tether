// `@name` becomes `to` (extensions/channels/renderer/mentions.ts, slice U1b): pure.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addresseesOf, mentionedNames, resolveMention, segmentsOf } from '../../extensions/channels/renderer/mentions.ts'

const NAMES = ['claude · conferente', 'soul · bancada', 'codex · conferência']

test('segments of a display name', () => {
  assert.deepEqual(segmentsOf('Soul · Bancada'), ['soul', 'bancada'])
})

test('@soul resolves to the member whose name has that segment, case-blind', () => {
  assert.deepEqual(mentionedNames('@soul pode subir?', NAMES), ['soul · bancada'])
  assert.deepEqual(mentionedNames('@SOUL pode subir?', NAMES), ['soul · bancada'])
  assert.deepEqual(mentionedNames('oi @bancada', NAMES), ['soul · bancada'])
})

test('a mention with no member, or with more than one, stays text', () => {
  assert.deepEqual(mentionedNames('@ninguem oi', NAMES), [])
  assert.deepEqual(mentionedNames('@conferente e @codex', NAMES), ['claude · conferente', 'codex · conferência'])
  assert.equal(resolveMention('conf', NAMES), undefined, 'a part of a segment is not a segment')
  assert.deepEqual(mentionedNames('@x', ['a · x', 'b · x']), [], 'ambiguous')
})

test('an e-mail or a word glued to @ is not a mention', () => {
  assert.deepEqual(mentionedNames('escreva para fulano@soul.com', NAMES), [])
  assert.deepEqual(mentionedNames('@@soul', NAMES), [])
})

test('several mentions, each once, in order of appearance; the picked one comes first', () => {
  assert.deepEqual(mentionedNames('@bancada e @claude, de novo @bancada', NAMES), ['soul · bancada', 'claude · conferente'])
  assert.deepEqual(addresseesOf('codex · conferência', '@soul oi', NAMES), ['codex · conferência', 'soul · bancada'])
  assert.deepEqual(addresseesOf('soul · bancada', '@soul oi', NAMES), ['soul · bancada'])
  assert.deepEqual(addresseesOf('', 'sem ninguém', NAMES), [])
  assert.deepEqual(addresseesOf(undefined, 'oi', NAMES), [])
})
