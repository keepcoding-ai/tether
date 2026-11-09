// The closed-slots menu model (app/renderer/closed-slots.ts), pure: grouping, header, tooltip, badge, the batch dialog.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { SlotState, SlotStatus } from '../../src/daemon/protocol.ts'
import { badgeParts, buttonTitle, headerText } from '../../app/renderer/closed-slots.ts'
import { groupClosed } from '../../app/renderer/sessions-rules.ts'

const slot = (slotId: string, status: SlotStatus): SlotState => ({ slotId, kind: 'shell', cwd: '/work/x', status })
const none = (): boolean => false

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
