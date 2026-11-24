// The pure rules of the "@" autocomplete (extensions/channels/renderer/mentions.ts): trigger, filter, token, insertion, spans.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyMention, applyPick, channelSpans, filterChannelOptions, filterMentionOptions, listTrigger, mentionedNames, mentionSpans, mentionToken, mentionTrigger, plain } from '../../extensions/channels/renderer/mentions.ts'

const NAMES = ['claude · conferente', 'soul · bancada', 'codex · conferência']

test('the trigger: @ at the start or after whitespace, with the term up to the caret', () => {
  assert.deepEqual(mentionTrigger('@', 1), { start: 0, term: '' })
  assert.deepEqual(mentionTrigger('oi @cla', 7), { start: 3, term: 'cla' })
  assert.deepEqual(mentionTrigger('oi\n@so', 6), { start: 3, term: 'so' })
  assert.deepEqual(mentionTrigger('oi @cla pronto', 7), { start: 3, term: 'cla' }, 'the caret in the middle reads up to itself')
})

test('no trigger: e-mail, caret past a space, no @', () => {
  assert.equal(mentionTrigger('a@b', 3), undefined)
  assert.equal(mentionTrigger('oi @cla ', 8), undefined)
  assert.equal(mentionTrigger('oi', 2), undefined)
  assert.equal(mentionTrigger('@@a', 3), undefined)
})

test('filter: todos first, anywhere in the name, case- and accent-blind', () => {
  assert.deepEqual(filterMentionOptions('', NAMES).map(o => o.name), ['todos', ...NAMES])
  assert.deepEqual(filterMentionOptions('CONFER', NAMES).map(o => o.name), NAMES.filter(n => n.includes('confer')))
  assert.deepEqual(filterMentionOptions('conferencia', NAMES).map(o => o.name), ['codex · conferência'])
  assert.deepEqual(filterMentionOptions('tod', NAMES).map(o => o.name), ['todos'])
  assert.deepEqual(filterMentionOptions('zzz', NAMES), [])
  assert.equal(plain('Conferência'), 'conferencia')
})

test('the token is a segment that resolves back to that member alone', () => {
  assert.equal(mentionToken('claude · conferente', NAMES), 'claude')
  assert.equal(mentionToken('soul · bancada', NAMES), 'soul')
  assert.equal(mentionToken('todos', NAMES), 'todos')
  const twins = ['claude · bancada', 'soul · bancada']
  assert.equal(mentionToken('soul · bancada', twins), 'soul')
})

test('insertion replaces @term with "@token " and puts the caret after the space', () => {
  const t = mentionTrigger('oi @cla pronto', 7)!
  assert.deepEqual(applyMention('oi @cla pronto', t, 7, 'claude'), { text: 'oi @claude  pronto', caret: 11 })
})

test('the "#" trigger: same rules as "@", and it says which mark opened', () => {
  assert.deepEqual(listTrigger('#', 1), { mark: '#', start: 0, term: '' })
  assert.deepEqual(listTrigger('veja #ob', 8), { mark: '#', start: 5, term: 'ob' })
  assert.deepEqual(listTrigger('oi @cla', 7), { mark: '@', start: 3, term: 'cla' })
  assert.equal(listTrigger('a#b', 3), undefined, 'a "#" inside a word does not trigger')
  assert.equal(listTrigger('veja #ob ', 9), undefined)
  assert.equal(mentionTrigger('veja #ob', 8), undefined, 'the "@" rules ignore "#"')
})

test('the "#" filter: anywhere in the name, case- and accent-blind, the current channel last', () => {
  const chans = [{ name: 'obra', current: true }, { name: 'conferência', current: false }, { name: 'obras-gerais', current: false }]
  assert.deepEqual(filterChannelOptions('', chans).map(c => c.name), ['conferência', 'obras-gerais', 'obra'])
  assert.deepEqual(filterChannelOptions('OBR', chans).map(c => c.name), ['obras-gerais', 'obra'])
  assert.deepEqual(filterChannelOptions('conferencia', chans).map(c => c.name), ['conferência'])
  assert.deepEqual(filterChannelOptions('zzz', chans), [])
})

test('the "#" insertion puts "#name " and leaves the "@" rules alone', () => {
  const t = listTrigger('veja #ob pronto', 8)!
  assert.deepEqual(applyPick('veja #ob pronto', t, 8, 'obra', '#'), { text: 'veja #obra  pronto', caret: 11 })
})

test('"#" spans: only whole names of known channels, case-blind', () => {
  const text = 'veja #Obra, #nada e a#obra e #obras'
  assert.deepEqual(channelSpans(text, ['obra']), [{ start: 5, end: 10, name: 'obra' }])
  assert.deepEqual(channelSpans('#obra-x', ['obra']), [], 'the name must be whole')
  assert.deepEqual(mentionedNames('veja #obra', ['obra']), [], 'a "#" never addresses anybody')
})

test('spans: only mentions of known members, with the @', () => {
  const text = 'oi @soul e @fulano, @todos'
  assert.deepEqual(mentionSpans(text, NAMES), [{ start: 3, end: 8, name: 'soul · bancada' }])
  assert.equal(text.slice(3, 8), '@soul')
})
