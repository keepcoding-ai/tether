// The floor of every tab's menu (app/renderer/tab-menu-basics.ts): whatever a pane type draws, the menu has the link and a close.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { CLOSE_LABEL, LINK_LABEL, isCloseLabel, withTabMenuBasics } from '../../app/renderer/tab-menu-basics.ts'

type Item = { label: string }
type E = Item | 'sep'
const SEP = 'sep' as E
const basics: { link: Item; close: Item } = { link: { label: LINK_LABEL }, close: { label: CLOSE_LABEL } }
const labels = (es: E[]): string[] => es.map(e => (e === 'sep' ? '—' : e.label))

/** The menus the registered pane types draw today, reduced to labels (the core's empty/slot menus have their own). */
const TYPE_MENUS: Record<string, E[]> = {
  'sem menu (Extensões, prévia da pesquisa)': [],
  configurações: [{ label: 'Abrir settings.json' }, SEP, { label: 'Mover…' }, SEP, { label: 'Fechar painel…' }],
  atalhos: [{ label: 'Mover…' }],
  navegador: [{ label: 'Recarregar' }, SEP, { label: LINK_LABEL }, { label: 'Mover…' }, SEP, { label: 'Fechar guia' }],
  processo: [{ label: LINK_LABEL }, { label: 'Mover…' }],
  nota: [{ label: 'Revelar no explorador' }, { label: 'Fechar' }],
}

describe('withTabMenuBasics', () => {
  for (const [name, menu] of Object.entries(TYPE_MENUS)) {
    test(`${name}: the menu closes the pane and copies its link`, () => {
      const out = withTabMenuBasics(menu, SEP, basics)
      assert.ok(labels(out).some(isCloseLabel), labels(out).join(', '))
      assert.ok(labels(out).includes(LINK_LABEL))
      assert.equal(labels(out).filter(isCloseLabel).length, 1, 'never two closes')
      assert.equal(labels(out).filter(l => l === LINK_LABEL).length, 1, 'never two links')
    })
  }
  test('a type without a menu gets just the floor, no leading separator', () => {
    assert.deepEqual(labels(withTabMenuBasics([], SEP, basics)), [LINK_LABEL, CLOSE_LABEL])
  })
  test('what is missing goes after a separator, the type\'s entries untouched', () => {
    assert.deepEqual(labels(withTabMenuBasics([{ label: 'Mover…' }], SEP, basics)), ['Mover…', '—', LINK_LABEL, CLOSE_LABEL])
  })
  test('close labels', () => {
    for (const l of ['Fechar', 'Fechar painel…', 'Fechar guia']) assert.ok(isCloseLabel(l))
    for (const l of ['Fecharia', 'Abrir', 'Não fechar']) assert.ok(!isCloseLabel(l))
  })
})
