// The list picker's rules (agent door, slice R4): the rows a query leaves, the selection keys, and the one- and two-step flows
// (Esc in the second step goes back, in the first closes). The box itself is proved in test/e2e/app.door-picker.test.ts.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { DoorHost } from '../../app/renderer/door/host.ts'
import { moveSelection, rankPicks, reselect, runList, runSteps, PICK_PAGE, type Ask, type AskContext, type PickAnswer } from '../../app/renderer/door/picker-rules.ts'
import type { PickItem, PickSpec } from '../../app/renderer/ext-api.ts'

const it = (value: string, label = value, detail?: string): PickItem<string> => ({ value, label, ...(detail ? { detail } : {}) })
const labels = (rows: { item: PickItem<string> }[]): string[] => rows.map(r => r.item.label)

describe('rankPicks', () => {
  const items = [it('a', 'Canal geral'), it('b', 'Agente dois', 'canal privado'), it('c', 'Mesa de casa')]

  test('an empty query keeps the list order and puts the featured item on top, once', () => {
    const featured = it('m', 'Canal da mesa')
    assert.deepEqual(labels(rankPicks(featured, items, '')), ['Canal da mesa', 'Canal geral', 'Agente dois', 'Mesa de casa'])
    const rows = rankPicks(featured, [...items, featured], '')
    assert.equal(rows.filter(r => r.item.value === 'm').length, 1)
    assert.equal(rows[0]!.featured, true)
    assert.ok(rows.slice(1).every(r => !r.featured))
  })

  test('the filter is fuzzy, ignores case and accents, and a label match ranks above a detail-only match', () => {
    assert.deepEqual(labels(rankPicks(undefined, items, 'CANAL')), ['Canal geral', 'Agente dois'])
    assert.deepEqual(labels(rankPicks(undefined, items, 'mêsa')), ['Mesa de casa'])
    assert.deepEqual(labels(rankPicks(undefined, items, 'zzz')), [])
  })

  test('the featured item is filtered like the others and stays on top while it matches', () => {
    const featured = it('m', 'Canal da mesa')
    assert.deepEqual(labels(rankPicks(featured, items, 'canal')).slice(0, 2), ['Canal da mesa', 'Canal geral'])
    assert.deepEqual(labels(rankPicks(featured, items, 'agente')), ['Agente dois'])
  })

  test('the label comes back split for the highlight', () => {
    const [row] = rankPicks(undefined, [it('a', 'Canal geral')], 'cg')
    assert.equal(row!.runs.map(r => r.text).join(''), 'Canal geral')
    assert.ok(row!.runs.some(r => r.hit))
  })
})

describe('selection', () => {
  test('the arrows wrap, the pages stop at the ends, other keys stay', () => {
    assert.equal(moveSelection(0, 3, 'ArrowUp'), 2)
    assert.equal(moveSelection(2, 3, 'ArrowDown'), 0)
    assert.equal(moveSelection(1, 40, 'PageDown'), 1 + PICK_PAGE)
    assert.equal(moveSelection(38, 40, 'PageDown'), 39)
    assert.equal(moveSelection(3, 40, 'PageUp'), 0)
    assert.equal(moveSelection(1, 3, 'x'), 1)
    assert.equal(moveSelection(5, 0, 'ArrowDown'), 0)
  })

  test('a new query keeps the same item selected when it is still there, else the first', () => {
    const rows = rankPicks(undefined, [it('a'), it('b'), it('c')], '')
    assert.equal(reselect(rows, it('c')), 2)
    assert.equal(reselect(rows, it('z')), 0)
    assert.equal(reselect(rows, undefined), 0)
  })
})

/** An ask that answers from a script, one answer per call, and records what it was asked. */
function scripted(...answers: (PickAnswer<never> | ((spec: PickSpec<unknown>, ctx: AskContext) => PickAnswer<never>))[]): { ask: Ask; asked: { title: string; ctx: AskContext }[] } {
  const asked: { title: string; ctx: AskContext }[] = []
  const ask: Ask = async (spec, ctx) => {
    asked.push({ title: spec.title, ctx })
    const next = answers.shift()
    assert.ok(next, 'asked more times than scripted')
    return (typeof next === 'function' ? next(spec as PickSpec<unknown>, ctx) : next) as never
  }
  return { ask, asked }
}
const picked = (value: string, query = ''): PickAnswer<never> => ({ kind: 'pick', item: it(value) as never, query })
const first: PickSpec<string> = { title: 'Primeiro', items: [] }
const second = (a: string): PickSpec<string> => ({ title: `Segundo de ${a}`, items: [] })

describe('runList', () => {
  test('resolves the picked value, or undefined when closed', async () => {
    assert.equal(await runList(scripted(picked('x')).ask, first), 'x')
    assert.equal(await runList(scripted({ kind: 'close' }).ask, first), undefined)
    assert.equal(await runList(scripted({ kind: 'back' }).ask, first), undefined)
  })
})

describe('runSteps', () => {
  test('the second step is built from the first choice', async () => {
    const { ask, asked } = scripted(picked('canal'), picked('agente'))
    assert.deepEqual(await runSteps(ask, first, second), { first: 'canal', second: 'agente' })
    assert.deepEqual(asked.map(a => a.title), ['Primeiro', 'Segundo de canal'])
    assert.deepEqual(asked.map(a => [a.ctx.step, a.ctx.steps]), [[1, 2], [2, 2]])
    assert.equal(asked[1]!.ctx.chosen, 'canal')
  })

  test('Esc in the second step goes back to the first with its query and choice kept, then a new choice goes on', async () => {
    const { ask, asked } = scripted(picked('canal', 'ca'), { kind: 'back' }, picked('mesa', 'me'), picked('outro'))
    assert.deepEqual(await runSteps(ask, first, second), { first: 'mesa', second: 'outro' })
    assert.deepEqual(asked.map(a => a.title), ['Primeiro', 'Segundo de canal', 'Primeiro', 'Segundo de mesa'])
    assert.equal(asked[2]!.ctx.query, 'ca')
    assert.equal(asked[2]!.ctx.previous?.value, 'canal')
    assert.equal(asked[0]!.ctx.query, undefined)
  })

  test('closing in the first step, or in the second, resolves undefined', async () => {
    assert.equal(await runSteps(scripted({ kind: 'close' }).ask, first, second), undefined)
    assert.equal(await runSteps(scripted(picked('canal'), { kind: 'close' }).ask, first, second), undefined)
  })

  test('the builder of the second step is not called before the first is chosen', async () => {
    let built = 0
    await runSteps(scripted({ kind: 'close' }).ask, first, a => { built++; return second(a) })
    assert.equal(built, 0)
  })
})

describe('DoorHost without a document', () => {
  test('a pick resolves as closed', async () => {
    const door = new DoorHost()
    assert.equal(await door.pickList({ title: 't', items: [it('a')] }), undefined)
    assert.equal(await door.pickSteps({ title: 't', items: [it('a')] }, () => ({ title: 'u', items: [] })), undefined)
  })
})
