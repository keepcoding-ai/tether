// The tab dot's precedence and tooltips (app/renderer/turn-rules.ts).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { tabMark, tabMarkTip } from '../../app/renderer/turn-rules.ts'

test('tabMark: attention > busy > nothing', () => {
  assert.equal(tabMark({ attention: 'done', turn: 'busy' }), 'attention')
  assert.equal(tabMark({ attention: 'waiting', turn: 'busy' }), 'attention')
  assert.equal(tabMark({ turn: 'busy' }), 'busy')
  assert.equal(tabMark({}), '')
  assert.equal(tabMark(undefined), '')
})

test('tabMarkTip: Portuguese tooltips', () => {
  assert.equal(tabMarkTip({ attention: 'done' }), 'Pede sua atenção: terminou')
  assert.equal(tabMarkTip({ attention: 'waiting', turn: 'busy' }), 'Pede sua atenção: esperando você')
  assert.equal(tabMarkTip({ turn: 'busy' }), 'Em andamento')
  assert.equal(tabMarkTip({}), '')
})
