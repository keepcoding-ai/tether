// The primaries of a card's bar: "Focar guia" and "Fechar guia" as always; an extension's highlight takes the first place and
// pushes "Fechar guia" out (it stays in the menu); with no highlight the bar is today's.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mainActions, type MenuItem } from '../../extensions/panel-pad-manager/bar-rules.ts'

const item = (label: string, pin?: MenuItem['pin']): MenuItem => ({ icon: 'x', label, run() {}, ...(pin ? { pin } : {}) })
const labels = (m: MenuItem[]): string[] => mainActions(m).map(e => e.label)
const focus = item('Focar guia', 'primary'), close = item('Fechar guia', 'primary')

describe('the bar of a card', () => {
  test('no highlight: Focar guia, Fechar guia, as today', () => {
    assert.deepEqual(labels([focus, close, item('Tomar', 'icon'), item('Mover…', 'icon')]), ['Focar guia', 'Fechar guia'])
  })
  test('a highlight goes first and takes the place of Fechar guia', () => {
    assert.deepEqual(labels([focus, close, item('Devolver a Atrium', 'highlight')]), ['Devolver a Atrium', 'Focar guia'])
  })
  test('another primary comes before Fechar guia and after Focar guia', () => {
    assert.deepEqual(labels([focus, close, item('Retomar', 'primary')]), ['Focar guia', 'Retomar'])
  })
  test('a highlight and another primary: the highlight and Focar guia stay', () => {
    assert.deepEqual(labels([focus, close, item('Retomar', 'primary'), item('Devolver', 'highlight')]), ['Devolver', 'Focar guia'])
  })
  test('icons never count, and a guide with no Focar guia has none', () => {
    assert.deepEqual(labels([item('Tomar', 'icon')]), [])
    assert.deepEqual(labels([close]), ['Fechar guia'])
  })
})
