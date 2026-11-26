// The desk-pill and tab menus aimed at a target for a manager (app/renderer/manager-menu-rules.ts): the same rows, reshaped
// by rule; with nothing asked of them, exactly the menus of today.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DESK_PLACE_LABEL, EMBLEM_LABEL, GO_DESK_LABEL, GO_PANE_LABEL, WAKE_DESK_LABEL, WAKE_PANE_LABEL,
  managerDeskItems, managerDeskTail, managerPaneEntries,
} from '../../app/renderer/manager-menu-rules.ts'

type Item = { label: string; pin?: 'primary'; children?: E[]; by?: string }
type E = Item | 'sep'
const SEP = 'sep' as E
const labelOf = (e: E): string | undefined => (e === 'sep' ? undefined : e.label)
const labels = (es: readonly E[]): string[] => es.map(e => (e === 'sep' ? '—' : e.children ? `${e.label} › ${labels(e.children).join(' | ')}` : e.label))
const it = (label: string, extra: Partial<Item> = {}): Item => ({ label, ...extra })
const place = (children: E[]): E => ({ label: DESK_PLACE_LABEL, children })

/** The pill menu's items of a middle desk of four, awake (main.ts deskMenuEntries). */
const DESK = (): E[] => [
  it('Renomear'), it('Cor…'), it('Nova mesa antes'), it('Nova mesa depois'),
  it('Mover para a esquerda'), it('Mover para a direita'), it('Mover para o início'), it('Mover para o fim'),
  it('Hibernar mesa'), it('Fechar mesa…'),
]

describe('managerDeskItems', () => {
  test('the four move rows go under one submenu where the first was; the rest stays in order', () => {
    assert.deepEqual(labels(managerDeskItems(DESK(), { place }, labelOf)), [
      'Renomear', 'Cor…', 'Nova mesa antes', 'Nova mesa depois',
      'Mudar de lugar › Mover para a esquerda | Mover para a direita | Mover para o início | Mover para o fim',
      'Hibernar mesa', 'Fechar mesa…',
    ])
  })

  test('only the move rows the desk has; none: no submenu', () => {
    const first = DESK().filter(e => !['Mover para a esquerda', 'Mover para o início'].includes(labelOf(e) ?? ''))
    assert.deepEqual(labels(managerDeskItems(first, { place }, labelOf))[4], 'Mudar de lugar › Mover para a direita | Mover para o fim')
    const lone = DESK().filter(e => !(labelOf(e) ?? '').startsWith('Mover'))
    assert.ok(!labels(managerDeskItems(lone, { place }, labelOf)).some(l => l.startsWith(DESK_PLACE_LABEL)))
  })

  test('rename: the caller\'s row replaces the pill\'s, in its place', () => {
    const out = managerDeskItems(DESK(), { place, rename: it('Renomear', { by: 'manager' }) }, labelOf)
    assert.equal((out[0] as Item).by, 'manager')
    assert.equal(out.filter(e => labelOf(e) === 'Renomear').length, 1)
  })

  test('a sleeping desk: "Acordar mesa" before "Fechar mesa…" (the pill menu has no "Hibernar mesa" then)', () => {
    const asleep = DESK().filter(e => labelOf(e) !== 'Hibernar mesa')
    const out = labels(managerDeskItems(asleep, { place, wake: it(WAKE_DESK_LABEL) }, labelOf))
    assert.deepEqual(out.slice(-2), [WAKE_DESK_LABEL, 'Fechar mesa…'])
    const alone = labels(managerDeskItems([it('Renomear')], { place, wake: it(WAKE_DESK_LABEL) }, labelOf))
    assert.deepEqual(alone, ['Renomear', WAKE_DESK_LABEL])
  })

  test('the tail: the caller\'s rows, then "Ir até a mesa" alone and last; no extra and no go: as it was', () => {
    const base = [it('Renomear'), SEP, it('Dar a…'), SEP, it('Fechar mesa…')]
    assert.deepEqual(labels(managerDeskTail(base, [], undefined, SEP)), labels(base))
    const out = managerDeskTail(base, [it('Acompanhar #obra aqui')], it(GO_DESK_LABEL, { pin: 'primary' }), SEP)
    assert.deepEqual(labels(out), ['Renomear', '—', 'Dar a…', '—', 'Fechar mesa…', '—', 'Acompanhar #obra aqui', '—', GO_DESK_LABEL])
    assert.deepEqual(labels(managerDeskTail(base, [], it(GO_DESK_LABEL), SEP)).slice(-2), ['—', GO_DESK_LABEL])
    assert.deepEqual(labels(managerDeskTail([...base, SEP], [SEP], undefined, SEP)), labels(base), 'separators never trail nor double')
  })
})

/** A slot pane's own menu (main.ts slotMenuEntries), its primaries already unpinned for the manager. */
const PANE = (): E[] => [
  it('Novo painel…'), it('Duplicar à direita'), SEP,
  it('Renomear…'), it('Trocar perfil…'), it('Reiniciar agente'), it('Marcar como não lida'), SEP,
  it('Copiar link do painel'), SEP,
  it('Fechar painel…'),
]
const TOP = (): E[] => [it('Focar guia', { pin: 'primary' }), it('Fechar guia', { pin: 'primary' })]
const full = (more: Partial<{ wake: E; emblem: E }> = {}) => ({ go: it(GO_PANE_LABEL, { pin: 'primary' }) as E, close: it('Fechar guia') as E, ...more })

describe('managerPaneEntries', () => {
  test('nothing asked: "Focar guia", "Fechar guia", then the menu, exactly as before', () => {
    assert.deepEqual(labels(managerPaneEntries(PANE(), TOP(), { extra: [] }, SEP, labelOf)), labels([...TOP(), SEP, ...PANE()]))
  })

  test('rename and extra without goLast: the top stays, the rename row is the caller\'s, its rows at the end', () => {
    const out = managerPaneEntries(PANE(), TOP(), { rename: it('Renomear…', { by: 'manager' }), extra: [it('Visão rápida')] }, SEP, labelOf)
    assert.deepEqual(labels(out).slice(0, 2), ['Focar guia', 'Fechar guia'])
    assert.equal((out.find(e => labelOf(e) === 'Renomear…') as Item).by, 'manager')
    assert.deepEqual(labels(out).slice(-2), ['—', 'Visão rápida'])
  })

  test('goLast: "Ir até a guia" last and the only primary; "Focar guia" leaves the top; "Fechar guia" just before it', () => {
    const out = managerPaneEntries(PANE(), TOP(), { extra: [it('Visão rápida')], goLast: full() }, SEP, labelOf)
    const ls = labels(out)
    assert.ok(!ls.includes('Focar guia'))
    assert.equal(ls[0], 'Novo painel…')
    assert.deepEqual(ls.slice(-6), ['Fechar painel…', '—', 'Visão rápida', '—', 'Fechar guia', GO_PANE_LABEL])
    assert.equal(ls.indexOf('Visão rápida') < ls.indexOf(GO_PANE_LABEL), true, 'the caller\'s rows before "Ir até…"')
    assert.deepEqual(out.filter(e => e !== 'sep' && e.pin === 'primary').map(labelOf), [GO_PANE_LABEL])
    assert.equal(ls.filter(l => l === 'Fechar guia').length, 1)
  })

  test('goLast: "Acordar guia" after the name-and-process group, "Emblema…" before the last group', () => {
    const ls = labels(managerPaneEntries(PANE(), TOP(), { extra: [], goLast: full({ wake: it(WAKE_PANE_LABEL), emblem: it(EMBLEM_LABEL) }) }, SEP, labelOf))
    assert.equal(ls[ls.indexOf('Reiniciar agente') + 1], WAKE_PANE_LABEL)
    // The pane's own last group is "Fechar painel…": the emblem comes before its separator, as on the tab.
    assert.deepEqual(ls.slice(ls.indexOf('Copiar link do painel'), ls.indexOf('Fechar painel…') + 1), ['Copiar link do painel', EMBLEM_LABEL, '—', 'Fechar painel…'])
    assert.equal(ls.at(-1), GO_PANE_LABEL)
  })

  test('goLast on a menu without the name group nor separators: wake first, emblem in a group of its own', () => {
    const ls = labels(managerPaneEntries([it('Recarregar')], TOP(), { extra: [], goLast: full({ wake: it(WAKE_PANE_LABEL), emblem: it(EMBLEM_LABEL) }) }, SEP, labelOf))
    assert.deepEqual(ls, [WAKE_PANE_LABEL, 'Recarregar', '—', EMBLEM_LABEL, '—', 'Fechar guia', GO_PANE_LABEL])
  })
})
