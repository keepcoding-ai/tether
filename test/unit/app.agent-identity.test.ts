import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerAgentUi } from '../../app/renderer/agent-ui.ts'
import { identityLabel, identityOf, letterOf } from '../../app/renderer/agent-identity-rules.ts'
import { agentHue } from '../../app/shared/agent-color.ts'

registerAgentUi({ name: 'soul-identity', label: 'Soul', icon: 'soul-mark', keywords: [], argsPlaceholder: '' })

const emblem = { name: 'Revisor', color: 'teal' as const, icon: 'eye' }

test('an agent with an emblem: engine and emblem, no letter', () => {
  const id = identityOf({ kind: 'soul-identity', name: 'conferente', seed: 's1', emblem })
  assert.deepEqual(id.engine, { icon: 'soul-mark', label: 'Soul' })
  assert.deepEqual(id.mark, { type: 'emblem', emblem })
  assert.equal(identityLabel(id), 'Soul, emblema Revisor: conferente')
})

test('an agent with no emblem: engine and the letter in the emblem\'s place, hue from the slot id', () => {
  const id = identityOf({ kind: 'soul-identity', name: 'bancada', seed: 's2' })
  assert.deepEqual(id.mark, { type: 'letter', letter: 'B', hue: agentHue('s2') })
  assert.equal(identityLabel(id), 'Soul: bancada')
})

test('a shell follows the same rule with the terminal\'s icon', () => {
  const id = identityOf({ kind: 'shell', name: 'pwsh', seed: 'sh1' })
  assert.deepEqual(id.engine, { icon: 'terminal-window', label: 'Shell' })
  assert.equal(id.mark.type, 'letter')
  assert.equal(identityOf({ kind: 'shell', name: 'pwsh', seed: 'sh1', emblem }).mark.type, 'emblem')
})

test('an unknown engine keeps its own name and the terminal\'s icon; the letter takes a whole code point', () => {
  assert.deepEqual(identityOf({ kind: 'ghost', name: 'x', seed: 'g' }).engine, { icon: 'terminal-window', label: 'ghost' })
  assert.equal(letterOf('😀 festa'), '😀')
  assert.equal(letterOf('   '), '?')
})
