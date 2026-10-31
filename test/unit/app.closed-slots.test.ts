// The closed-slots menu model (app/renderer/closed-slots.ts), pure: grouping, header, tooltip, badge, the batch dialog.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { SlotState, SlotStatus } from '../../src/daemon/protocol.ts'
import { badgeParts, buttonTitle, forgetEndedSituation, groupClosed, headerText } from '../../app/renderer/closed-slots.ts'

const slot = (slotId: string, status: SlotStatus): SlotState => ({ slotId, kind: 'shell', cwd: '/work/x', status })
const none = (): boolean => false

describe('grouping', () => {
  test('a slot with a pane is not closed; a live one without a pane is running, the rest are ended', () => {
    const all = [slot('a', 'running'), slot('b', 'exited'), slot('c', 'starting'), slot('d', 'queued'), slot('e', 'error'), slot('f', 'unconfirmed'), slot('g', 'running')]
    const g = groupClosed(all, id => id === 'g')
    assert.deepEqual(g.running.map(s => s.slotId), ['a', 'c', 'd'])
    assert.deepEqual(g.ended.map(s => s.slotId), ['b', 'e', 'f'])
  })

  test('keeps the daemon order inside each group; empty input gives empty groups', () => {
    assert.deepEqual(groupClosed([], none), { running: [], ended: [] })
    assert.deepEqual(groupClosed([slot('z', 'exited'), slot('y', 'exited')], none).ended.map(s => s.slotId), ['z', 'y'])
  })

  test('a slot moves between groups as its status changes', () => {
    const s = slot('a', 'running')
    assert.equal(groupClosed([s], none).running.length, 1)
    assert.equal(groupClosed([{ ...s, status: 'exited' }], none).ended.length, 1)
  })
})

describe('counts', () => {
  const g = groupClosed([slot('a', 'running'), slot('b', 'running'), ...Array.from({ length: 12 }, (_, i) => slot(`e${i}`, 'exited'))], none)

  test('header: "2 rodando · 12 encerrados"', () => assert.equal(headerText(g), '2 rodando · 12 encerrados'))
  test('header leaves a zero part out and has an empty message', () => {
    assert.equal(headerText(groupClosed([slot('a', 'exited')], none)), '1 encerrado')
    assert.equal(headerText(groupClosed([slot('a', 'running')], none)), '1 rodando')
    assert.equal(headerText(groupClosed([], none)), 'Nenhum slot fechado')
  })
  test('tooltip says the counts', () => {
    assert.equal(buttonTitle(g), 'Slots fechados: 2 rodando sem painel · 12 encerrados')
    assert.equal(buttonTitle(groupClosed([], none)), 'Slots fechados: nenhum')
  })
  test('badge: two numbers, a zero is blank', () => {
    assert.deepEqual(badgeParts(g), { running: '2', ended: '12' })
    assert.deepEqual(badgeParts(groupClosed([slot('a', 'exited')], none)), { running: '', ended: '1' })
    assert.deepEqual(badgeParts(groupClosed([], none)), { running: '', ended: '' })
  })
})

describe('forget all ended', () => {
  test('one destructive choice and a cancel; the title carries the count', () => {
    const spec = forgetEndedSituation(12)
    assert.match(spec.title, /12 slots encerrados/)
    assert.deepEqual(spec.choices.map(c => [c.id, c.tone]), [['forget', 'destructive']])
    assert.ok(spec.cancelLabel)
    assert.match(forgetEndedSituation(1).title, /1 slot encerrado\?/)
  })
})
