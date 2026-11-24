// What ties an agent to open channels (extensions/channels/renderer/holds.ts): pure counts, no DOM.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { channelsOf, heldText } from '../../extensions/channels/renderer/holds.ts'

const members = new Map<string, readonly string[]>([['c1', ['a', 'b']], ['c2', ['b']], ['c3', []]])

test('holds: counts the open channels the agent is in', () => {
  assert.equal(channelsOf(members, 'a'), 1)
  assert.equal(channelsOf(members, 'b'), 2)
  assert.equal(channelsOf(members, 'z'), 0)
  assert.equal(channelsOf(new Map(), 'a'), 0)
})

test('holds: the hold text is singular or plural, and nothing for a non-member', () => {
  assert.equal(heldText(members, 'a'), 'membro de 1 canal')
  assert.equal(heldText(members, 'b'), 'membro de 2 canais')
  assert.equal(heldText(members, 'z'), undefined)
})
