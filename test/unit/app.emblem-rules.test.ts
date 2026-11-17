import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BUILTIN_EMBLEMS, buildIconIndex, fold, isModified, newEmblemId, readEmblems, searchIcons, shownEmblem } from '../../app/renderer/emblem-rules.ts'
import { EMBLEM_CATEGORIES, EMBLEM_ICONS } from '../../app/renderer/emblem-icons.ts'

const known = (n: string) => EMBLEM_ICONS.some(i => i.n === n)

test('readEmblems: absent → the built-ins; malformed entries dropped; missing built-ins appended; hidden only on built-ins', () => {
  assert.deepEqual(readEmblems(undefined, known).map(e => e.id), BUILTIN_EMBLEMS.map(e => e.id))
  const lib = readEmblems([
    { id: 'u-1', name: 'Meu', color: 'red', icon: 'heart', hidden: true },
    { id: 'u-1', name: 'dup', color: 'red', icon: 'heart' },
    { id: 'u-2', name: 'cor ruim', color: 'chartreuse', icon: 'heart' },
    { id: 'b-bug', name: 'Defeito', color: 'red', icon: 'bug', hidden: true },
    { id: 'u-3', name: 'ícone sumiu', color: 'blue', icon: 'no-such-icon' },
    null, 'x',
  ], known)
  assert.deepEqual(lib.slice(0, 3).map(e => e.id), ['u-1', 'b-bug', 'u-3'])
  assert.equal(lib[0]!.hidden, undefined, 'a person\'s emblem is never hidden')
  assert.equal(lib[1]!.hidden, true)
  assert.equal(lib[1]!.builtin, true)
  assert.equal(lib[2]!.icon, 'tag')
  assert.equal(lib.length, 3 + BUILTIN_EMBLEMS.length - 1)
})

test('every built-in icon and category icon is in the catalog', () => {
  for (const b of BUILTIN_EMBLEMS) assert.ok(known(b.icon), b.icon)
  for (const c of EMBLEM_CATEGORIES) assert.ok(known(c.icon), c.icon)
  assert.ok(EMBLEM_ICONS.every(i => EMBLEM_CATEGORIES.some(c => c.id === i.c)))
})

test('isModified / shownEmblem / newEmblemId', () => {
  const lib = readEmblems(undefined, known)
  assert.equal(isModified(lib[0]!), false)
  lib[0]!.color = 'red'
  assert.equal(isModified(lib[0]!), true)
  assert.equal(shownEmblem(lib, 'b-bug')?.name, 'Bug')
  lib.find(e => e.id === 'b-bug')!.hidden = true
  assert.equal(shownEmblem(lib, 'b-bug'), undefined)
  assert.equal(shownEmblem(lib, 'nope'), undefined)
  assert.equal(shownEmblem(lib, undefined), undefined)
  const id = newEmblemId([{ id: `u-${(5).toString(36)}`, name: '', color: 'red', icon: 'tag' }], 5)
  assert.equal(id, 'u-6')
})

test('searchIcons: accents and case folded, Portuguese and English, name prefix first, every word must hit', () => {
  const index = buildIconIndex(EMBLEM_ICONS)
  assert.equal(searchIcons(index, '  '), null)
  assert.equal(fold('Coração'), 'coracao')
  assert.ok(searchIcons(index, 'coracao')!.includes('heart'))
  assert.ok(searchIcons(index, 'CORAÇÃO')!.includes('heart'))
  assert.equal(searchIcons(index, 'rock')![0], 'rocket', 'the name prefix ranks first')
  assert.ok(searchIcons(index, 'deploy')!.includes('rocket-launch'))
  assert.ok(searchIcons(index, 'foguete')!.includes('rocket'))
  assert.deepEqual(searchIcons(index, 'zzzz'), [])
  assert.ok(searchIcons(index, 'aperto mao')!.includes('handshake'))
})
