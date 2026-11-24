// The list picker's rules (agent door, slice R4): the rows a query leaves, the selection keys, and the one- and two-step flows
// (Esc in the second step goes back, in the first closes). The box itself is proved in test/e2e/app.door-picker.test.ts.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { DoorHost } from '../../app/renderer/door/host.ts'
import { engineOf, registerAgentUi } from '../../app/renderer/agent-ui.ts'
import { confirmText, groupHeading, hasEngineColumn, manyChosen, manyCount, manyFooter, manyOptions, moveSelection, numberedRow, orderedItems, rankPicks, reselect, runList, runMany, runSteps, toggleMark, PICK_PAGE, type Ask, type AskContext, type PickAnswer } from '../../app/renderer/door/picker-rules.ts'
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

  test('the emblem name is searched too, after the label and the detail', () => {
    const wears = (value: string, label: string, name: string, detail?: string): PickItem<string> => ({ ...it(value, label, detail), emblem: { name, color: 'teal', icon: 'rocket-launch' } })
    const rows = [wears('a', 'atrium', 'Bug'), wears('b', 'atrium', 'Deploy'), it('c', 'xxx')]
    assert.deepEqual(rankPicks(undefined, rows, 'deploy').map(r => r.item.value), ['b'])
    assert.deepEqual(rankPicks(undefined, rows, 'DEPLOY').map(r => r.runs.map(x => x.text).join('')), ['atrium'])
    assert.deepEqual(rankPicks(undefined, rows, 'zzz'), [])
    // A label match outranks an emblem-only match; a row with no emblem is untouched.
    const mixed = [wears('e', 'outro', 'Revisar'), it('l', 'Revisão')]
    assert.deepEqual(rankPicks(undefined, mixed, 'revis').map(r => r.item.value), ['l', 'e'])
  })

  test('the engine name is searched too ("soul" finds the Soul agents), last, and an unknown kind answers to its own name', () => {
    const disposable = registerAgentUi({ name: 'soul', label: 'Soul', icon: 'soul-mark', keywords: [], argsPlaceholder: '' })
    try {
      const mk = (value: string, label: string, engine: string): PickItem<string> => ({ ...it(value, label), engine })
      const rows = [mk('a', 'kai', 'soul'), mk('b', 'kai', 'claude'), mk('c', 'Soulange', 'claude'), it('d', 'xxx')]
      assert.deepEqual(rankPicks(undefined, rows, 'soul').map(r => r.item.value), ['c', 'a'], 'a label match first, then the engine match')
      assert.deepEqual(rankPicks(undefined, rows, 'claude').map(r => r.item.value), ['b', 'c'], 'an engine with no AgentUi is named by its kind')
      assert.deepEqual(engineOf('soul'), { icon: 'soul-mark', label: 'Soul' })
      assert.deepEqual(engineOf('shell'), { icon: 'terminal-window', label: 'Shell' })
      assert.deepEqual(engineOf('codex'), { icon: 'terminal-window', label: 'codex' })
      assert.equal(hasEngineColumn(rows), true)
      assert.equal(hasEngineColumn([it('x'), it('y')]), false, 'a list that is not of agents has no column')
      assert.equal(hasEngineColumn([it('x')], mk('f', 'f', 'soul')), true, 'the featured row counts')
    } finally { disposable.dispose() }
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
    assert.equal(await door.pickMany({ title: 't', items: [it('a')] }), undefined)
  })
})

describe('pick.many rules', () => {
  const list = [it('a', 'Alfa'), it('b', 'Beta'), it('c', 'Gama')]
  const none = new Set<unknown>()

  test('toggleMark marks and unmarks, without touching the set it was given', () => {
    const one = toggleMark(none, 'b')
    assert.deepEqual([...one], ['b'])
    assert.equal(none.size, 0)
    assert.deepEqual([...toggleMark(one, 'b')], [])
    assert.deepEqual([...toggleMark(one, 'a')].sort(), ['a', 'b'])
  })

  test('Enter with no mark answers with the row under the cursor alone; with no row, with nothing', () => {
    assert.deepEqual(manyChosen(list, none, list[1]).map(i => i.value), ['b'])
    assert.deepEqual(manyChosen(list, none, undefined), [])
  })

  test('Enter with marks answers with the marked ones in the list order, whatever the marking order and the cursor', () => {
    const marks = toggleMark(toggleMark(none, 'c'), 'a')
    assert.deepEqual(manyChosen(list, marks, list[1]).map(i => i.value), ['a', 'c'])
  })

  test('a mark survives a filter: it is read against the whole list, not against the rows left', () => {
    const marks = toggleMark(none, 'a')
    const left = rankPicks(undefined, list, 'gama')
    assert.deepEqual(left.map(r => r.item.value), ['c'])
    assert.deepEqual(manyChosen(orderedItems(undefined, list), marks, left[0]!.item).map(i => i.value), ['a'])
  })

  test('the featured item leads the order, once', () => {
    const featured = it('m', 'Mesa')
    assert.deepEqual(orderedItems(featured, [...list, featured]).map(i => i.value), ['m', 'a', 'b', 'c'])
    assert.deepEqual(orderedItems(undefined, list).map(i => i.value), ['a', 'b', 'c'])
  })

  test('the button counts the marks, or the one row Enter would take, and says the verb alone when nothing would go', () => {
    const o = manyOptions({ title: 't', items: [], confirmLabel: 'Juntar', confirmHint: 'junta' })
    assert.equal(confirmText(o, manyCount(none, true)), 'Juntar 1')
    assert.equal(confirmText(o, manyCount(toggleMark(toggleMark(none, 'a'), 'b'), true)), 'Juntar 2')
    assert.equal(confirmText(o, manyCount(none, false)), 'Juntar')
    assert.equal(manyFooter(o), 'Espaço marca vários · Enter junta · Esc fecha')
    assert.deepEqual(manyOptions({ title: 't', items: [] }), { confirmLabel: 'Confirmar', confirmHint: 'confirma' })
  })

  test('runMany: the confirmed values; closing, Esc and going back resolve undefined; the ask carries the words', async () => {
    const many = (...values: string[]): PickAnswer<never> => ({ kind: 'many', items: values.map(v => it(v)) as never, query: '' })
    const spec = { title: 'Juntar', items: [], confirmLabel: 'Juntar' }
    const { ask, asked } = scripted(many('a', 'c'))
    assert.deepEqual(await runMany(ask, spec), ['a', 'c'])
    assert.equal(asked[0]!.ctx.many?.confirmLabel, 'Juntar')
    assert.equal(await runMany(scripted({ kind: 'close' }).ask, spec), undefined)
    assert.equal(await runMany(scripted({ kind: 'back' }).ask, spec), undefined)
  })
})

describe('K1.6: groups and the number keys', () => {
  const g = (value: string, group?: string): PickItem<string> => ({ value, label: value, ...(group ? { group } : {}) })
  const items = [g('atrium', 'Recentes'), g('kai', 'Nesta mesa'), g('soul', 'Nesta mesa'), g('codex', 'Outras mesas'), g('kaio', 'Recentes')]

  test('rows of a group stay together, groups in the order they first appear; the heading opens each group once', () => {
    const rows = rankPicks(undefined, items, '')
    assert.deepEqual(labels(rows), ['atrium', 'kaio', 'kai', 'soul', 'codex'])
    assert.deepEqual(rows.map((_, i) => groupHeading(rows, i) ?? ''), ['Recentes', '', 'Nesta mesa', '', 'Outras mesas'])
  })

  test('a query ranks inside each group and keeps the group order', () => {
    const rows = rankPicks(undefined, items, 'kai')
    assert.deepEqual(labels(rows), ['kaio', 'kai'], 'Recentes before Nesta mesa, whatever the score')
    assert.deepEqual(rows.map((_, i) => groupHeading(rows, i) ?? ''), ['Recentes', 'Nesta mesa'])
  })

  test('no group anywhere: the order of today; the featured row has no heading', () => {
    const plain = [g('a'), g('b')]
    assert.deepEqual(labels(rankPicks(undefined, plain, '')), ['a', 'b'])
    const rows = rankPicks({ value: 'top', label: 'top', group: 'Recentes' }, items, '')
    assert.equal(groupHeading(rows, 0), undefined, 'the featured row has no heading')
    assert.equal(groupHeading(rows, 1), 'Recentes', 'the group under it opens with its heading')
  })

  test('1 to 9 choose a row while the filter is empty; otherwise the key types', () => {
    assert.equal(numberedRow('1', '', 5), 0)
    assert.equal(numberedRow('5', '', 5), 4)
    assert.equal(numberedRow('6', '', 5), undefined, 'no such row')
    assert.equal(numberedRow('0', '', 5), undefined)
    assert.equal(numberedRow('2', 'k', 5), undefined, 'with text in the filter the key types')
    assert.equal(numberedRow('a', '', 5), undefined)
    assert.equal(numberedRow('9', '', 20), 8)
  })
})
