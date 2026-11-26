// Lending a live pane out of its tab (app/renderer/pane-loan-rules.ts), pure: the plan a pane type gets, the loan's
// state machine (lend, give back, the pane closed while lent, lending twice), and why a lend is refused.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { lendRefusal, loanStep, paneLendPlan, type LoanEvent, type LoanState } from '../../app/renderer/pane-loan-rules.ts'
import { paneLentNotice } from '../../app/renderer/peek-rules.ts'

const fn = (): void => {}

describe('the plan of a pane type', () => {
  test('a type that declares nothing lends its whole content (the default: any type, of today or of the future)', () => {
    assert.equal(paneLendPlan({}), 'move')
    assert.equal(paneLendPlan({ peek: 'lend' }), 'move')
  })
  test('a type with both hooks lends its own part (the terminal: its body)', () => {
    assert.equal(paneLendPlan({ lend: fn, takeBack: fn }), 'custom')
    assert.equal(paneLendPlan({ peek: 'lend', lend: fn, takeBack: fn }), 'custom')
  })
  test('one hook alone is no lending of its own: the whole content moves', () => {
    assert.equal(paneLendPlan({ lend: fn }), 'move')
    assert.equal(paneLendPlan({ takeBack: fn }), 'move')
  })
  test("'fresh' and 'none' win over the hooks; no type is never lent", () => {
    assert.equal(paneLendPlan({ peek: 'fresh', lend: fn, takeBack: fn }), 'fresh')
    assert.equal(paneLendPlan({ peek: 'none' }), 'none')
    assert.equal(paneLendPlan(undefined), 'none')
  })
})

describe('the loan, step by step', () => {
  const run = (events: LoanEvent[], from: LoanState = 'home') => {
    let state = from
    return events.map(e => { const s = loanStep(state, e); state = s.state; return `${s.state}:${s.act}` })
  }
  test('lend, then give back: out and home again', () => {
    assert.deepEqual(run(['lend', 'give-back']), ['lent:move-out', 'home:move-back'])
  })
  test('lending twice: the second is refused, the first loan goes on and gives back once', () => {
    assert.deepEqual(run(['lend', 'lend', 'give-back', 'give-back']), ['lent:move-out', 'lent:refuse', 'home:move-back', 'home:none'])
  })
  test('the pane closed while lent: the borrower drops it, nothing comes back, the pane stays gone', () => {
    assert.deepEqual(run(['lend', 'dispose', 'give-back', 'lend', 'lost']), ['lent:move-out', 'gone:drop', 'gone:none', 'gone:refuse', 'gone:none'])
  })
  test('a pane closed at home just goes', () => {
    assert.deepEqual(run(['dispose']), ['gone:none'])
  })
  test("the type's own part lost while lent: dropped once, the pane is home and can be lent again", () => {
    assert.deepEqual(run(['lend', 'lost', 'lost', 'give-back', 'lend']), ['lent:move-out', 'home:drop', 'home:none', 'home:none', 'lent:move-out'])
  })
  test('lent again after coming home', () => {
    assert.deepEqual(run(['lend', 'give-back', 'lend', 'give-back']), ['lent:move-out', 'home:move-back', 'lent:move-out', 'home:move-back'])
  })
})

describe('why a lend is refused', () => {
  test('a pane at home with a lending plan goes ahead', () => {
    assert.equal(lendRefusal('home', 'move'), undefined)
    assert.equal(lendRefusal('home', 'custom'), undefined)
  })
  test('lent already', () => {
    assert.equal(lendRefusal('lent', 'move'), 'lent')
    assert.equal(lendRefusal('lent', 'custom'), 'lent')
  })
  test('no shell, or a pane gone: unknown, whatever the plan', () => {
    assert.equal(lendRefusal(undefined, 'move'), 'unknown')
    assert.equal(lendRefusal('gone', 'move'), 'unknown')
    assert.equal(lendRefusal(undefined, 'none'), 'unknown')
  })
  test("a type that is 'fresh' or 'none' is never lent", () => {
    assert.equal(lendRefusal('home', 'fresh'), 'fresh')
    assert.equal(lendRefusal('home', 'none'), 'none')
    assert.equal(lendRefusal('lent', 'none'), 'none')
  })
})

describe('the notice of a lent tab', () => {
  test('names the tab and says it comes back', () => {
    const n = paneLentNotice('notas.md')
    assert.equal(n.title, 'Esta guia está sendo espiada')
    assert.equal(n.text, 'notas.md está no cartão aberto na tela. Quando você fechar o cartão, a guia volta para cá.')
    assert.match(n.tip, /^Sendo espiada/)
  })
})
