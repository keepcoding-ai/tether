// The agent door's seams in the renderer (app/renderer/door/host.ts): with no extension registered, the desk pill's menu and
// every pane menu keep today's rows exactly; a registered provider lands where the contract says; the commands carry `arg`.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { DoorHost, withDeskMenuGroup, withPaneMenuItems, withPaneMenuTop } from '../../app/renderer/door/host.ts'
import { CLOSE_LABEL, LINK_LABEL, isCloseLabel } from '../../app/renderer/tab-menu-basics.ts'
import { CommandRegistry, type CommandContext } from '../../app/renderer/commands.ts'
import type { ContextMenuEntry, ContextMenuRow, PaneInfo } from '../../app/renderer/ext-api.ts'

type E = { label: string } | 'sep'
const SEP = 'sep' as E
const labels = (es: readonly E[]): string[] => es.map(e => (e === 'sep' ? '—' : 'heading' in e ? `# ${e.heading}` : e.label))
const items = (...ls: string[]): E[] => ls.map(l => (l === '—' ? SEP : { label: l }))
const labelOf = (e: E): string | undefined => (e === 'sep' ? undefined : e.label)
const isFloor = (e: E): boolean => e !== 'sep' && (e.label === LINK_LABEL || isCloseLabel(e.label))
const ANCHORS = ['Hibernar mesa', 'Fechar mesa…']
const fromExt = (es: ContextMenuRow[]): E[] => es.map(e => (e === 'sep' ? SEP : { label: 'heading' in e ? `# ${e.heading}` : e.label }))

/** The desk pill's menu as showDeskMenu builds it today, for a desk in the middle of three, awake. */
const DESK_MENU = items('Renomear', 'Cor…', 'Nova mesa antes', 'Nova mesa depois', 'Mover para a esquerda', 'Mover para a direita', 'Hibernar mesa', 'Fechar mesa…')
/** The last desk awake: no "Hibernar mesa". The only desk: no "Fechar mesa…" either. */
const DESK_MENU_NO_SLEEP = items('Renomear', 'Cor…', 'Nova mesa antes', 'Nova mesa depois', 'Mover para a esquerda', 'Fechar mesa…')
const DESK_MENU_ALONE = items('Renomear', 'Cor…', 'Nova mesa antes', 'Nova mesa depois')

/** Pane menus as the core and the pane types draw them today (labels only), floor included. */
const PANE_MENUS: Record<string, E[]> = {
  agente: items('Novo painel…', 'Duplicar à direita', 'Duplicar abaixo', 'Novo painel na borda do quadro…', 'Novo quadro…', '—', 'Renomear…', 'Trocar perfil…', 'Reiniciar', 'Hibernar guia', '—', 'Mostrar detalhes', LINK_LABEL, 'Copiar pasta', 'Abrir pasta no Explorer', '—', 'Mover…', '—', 'Fechar painel…'),
  vazio: items('Novo painel…', 'Dividir à direita (vazio)', 'Dividir abaixo (vazio)', '—', 'Mover…', '—', CLOSE_LABEL),
  navegador: items('Recarregar', '—', LINK_LABEL, 'Mover…', '—', 'Fechar guia'),
  'sem menu': items(LINK_LABEL, CLOSE_LABEL),
  nota: items('Revelar no explorador', 'Fechar', '—', LINK_LABEL),
}

const pane: PaneInfo = { id: 'note:1', type: 'note' }

describe('door seams with no provider', () => {
  test('the desk pill menu keeps today\'s rows', () => {
    const door = new DoorHost()
    for (const menu of [DESK_MENU, DESK_MENU_NO_SLEEP, DESK_MENU_ALONE]) {
      const out = withDeskMenuGroup<E>(menu, fromExt(door.deskMenuItems('d1')), SEP, labelOf, ANCHORS)
      assert.deepEqual(labels(out), labels(menu))
    }
  })

  test('every pane menu keeps today\'s rows (tab and manager share this base)', () => {
    const door = new DoorHost()
    for (const [name, menu] of Object.entries(PANE_MENUS)) {
      const out = withPaneMenuItems<E>(menu, fromExt(door.paneMenuItems(pane)), SEP, isFloor)
      assert.deepEqual(labels(out), labels(menu), name)
    }
  })

  test('a provider that returns nothing, or only separators, changes nothing', () => {
    const door = new DoorHost()
    door.deskMenu('x', () => [])
    door.paneMenu('x', () => ['sep', 'sep'])
    assert.deepEqual(labels(withDeskMenuGroup<E>(DESK_MENU, fromExt(door.deskMenuItems('d1')), SEP, labelOf, ANCHORS)), labels(DESK_MENU))
    assert.deepEqual(labels(withPaneMenuItems<E>(PANE_MENUS.agente!, fromExt(door.paneMenuItems(pane)), SEP, isFloor)), labels(PANE_MENUS.agente!))
  })
})

describe('door seams with a provider', () => {
  const row = (label: string): ContextMenuEntry => ({ icon: 'link', label, run: () => {} })

  test('the desk group goes before "Hibernar mesa", else before "Fechar mesa…", else last', () => {
    const extra = [{ label: 'Canal' }] as E[]
    assert.deepEqual(labels(withDeskMenuGroup<E>(DESK_MENU, extra, SEP, labelOf, ANCHORS)).slice(5), ['Mover para a direita', '—', 'Canal', '—', 'Hibernar mesa', 'Fechar mesa…'])
    assert.deepEqual(labels(withDeskMenuGroup<E>(DESK_MENU_NO_SLEEP, extra, SEP, labelOf, ANCHORS)).slice(-4), ['—', 'Canal', '—', 'Fechar mesa…'])
    assert.deepEqual(labels(withDeskMenuGroup<E>(DESK_MENU_ALONE, extra, SEP, labelOf, ANCHORS)).slice(-2), ['—', 'Canal'])
  })

  test('pane rows go before the floor, after a separator', () => {
    const extra = [{ label: 'Dar a guia' }] as E[]
    assert.deepEqual(labels(withPaneMenuItems<E>(PANE_MENUS.agente!, extra, SEP, isFloor)).slice(-4), ['—', 'Dar a guia', '—', 'Fechar painel…'])
    assert.deepEqual(labels(withPaneMenuItems<E>(PANE_MENUS.navegador!, extra, SEP, isFloor)).slice(-4), ['—', 'Dar a guia', '—', 'Fechar guia'])
    assert.deepEqual(labels(withPaneMenuItems<E>(PANE_MENUS['sem menu']!, extra, SEP, isFloor)), ['Dar a guia', '—', LINK_LABEL, CLOSE_LABEL])
  })

  test('a provider that throws is skipped; the others still show', () => {
    const door = new DoorHost()
    const err = console.error
    console.error = () => {}
    try {
      door.paneMenu('bad', () => { throw new Error('boom') })
      door.paneMenu('good', p => [row(`para ${p.id}`)])
      assert.deepEqual(door.paneMenuItems(pane).map(e => (e === 'sep' ? '—' : 'heading' in e ? `# ${e.heading}` : e.label)), ['para note:1'])
    } finally { console.error = err }
  })

  test('the rows go with their extension (dispose or removeOwner)', () => {
    const door = new DoorHost()
    const d = door.deskMenu('a', () => [row('A')])
    door.deskMenu('b', () => [row('B')])
    door.paneMenu('b', () => [row('B')])
    d.dispose()
    assert.deepEqual(door.deskMenuItems('d1').map(e => (e === 'sep' ? '—' : 'heading' in e ? `# ${e.heading}` : e.label)), ['B'])
    door.removeOwner('b')
    assert.deepEqual(door.deskMenuItems('d1'), [])
    assert.deepEqual(door.paneMenuItems(pane), [])
  })
})

describe('desks.onDidChange', () => {
  test('fires only when the desks actually changed', () => {
    const door = new DoorHost()
    let heard = 0
    door.onDesksChange(() => { heard++ })
    let view = { desks: [{ id: 'd1', name: 'Mesa', color: 'blue', asleep: false, panes: ['s1'] }], activeId: 'd1' }
    door.stripRendered(() => view)
    door.stripRendered(() => view)
    assert.equal(heard, 1)
    view = { ...view, desks: [{ ...view.desks[0]!, panes: ['s1', 's2'] }] }
    door.stripRendered(() => view)
    assert.equal(heard, 2)
  })
})

describe('door services not built yet', () => {
  test('objects read empty and refuse writes; pick resolves as closed', async () => {
    const door = new DoorHost()
    const objects = door.objectsFor('x')
    assert.equal(objects.get('pane', 's1', 'k'), undefined)
    assert.deepEqual(objects.entries('desk', 'k'), [])
    await assert.rejects(objects.set('pane', 's1', 'k', 1), /door-unavailable/)
    assert.equal(await door.pickList({ title: 't', items: [] }), undefined)
  })
})

describe('Command.run with an argument', () => {
  const ctx = (): CommandContext => ({ pane: false, desks: 1, drawerOpen: false, focus: 'none' })

  test('the argument reaches the handler; without one the call is as before', async () => {
    const calls: unknown[][] = []
    const reg = new CommandRegistry(ctx)
    reg.register({ id: 'canal.open', title: 'Abrir canal', run: (...args: unknown[]) => { calls.push(args) } })
    assert.equal(await reg.run('canal.open', 'menu', { channel: 'geral' }), 'ran')
    assert.equal(await reg.run('canal.open', 'palette'), 'ran')
    assert.deepEqual(calls, [['menu', { channel: 'geral' }], ['palette']])
  })
})

describe('door seams K1.1: headings, submenus and the top of a pane menu', () => {
  const row = (label: string, extra: Partial<ContextMenuEntry & object> = {}): ContextMenuEntry => ({ icon: 'link', label, run: () => {}, ...extra })

  test('with no top provider every pane menu keeps today\'s rows', () => {
    const door = new DoorHost()
    door.paneMenu('x', () => [row('No piso')])
    assert.deepEqual(door.paneMenuTop(pane), [], 'a provider without place: top is not a top row')
    for (const [name, menu] of Object.entries(PANE_MENUS)) {
      assert.deepEqual(labels(withPaneMenuTop<E>(menu, fromExt(door.paneMenuTop(pane)), SEP)), labels(menu), name)
    }
    door.paneMenu('y', () => ['sep'], { place: 'top' })
    assert.deepEqual(labels(withPaneMenuTop<E>(PANE_MENUS.agente!, fromExt(door.paneMenuTop(pane)), SEP)), labels(PANE_MENUS.agente!), 'only separators: nothing')
  })

  test('top rows open the menu, a heading first, then a separator; floor rows stay at the floor', () => {
    const door = new DoorHost()
    door.paneMenu('for-agents', () => [{ heading: 'Comandada por Atrium, pela mesa' }, row('Tomar'), row('O que é de Atrium', { children: [row('kai-aware')] })], { place: 'top' })
    door.paneMenu('outra', () => [row('No piso')])
    const top = door.paneMenuTop(pane)
    assert.deepEqual(top.map(e => (e === 'sep' ? '—' : 'heading' in e ? `# ${e.heading}` : e.label)), ['# Comandada por Atrium, pela mesa', 'Tomar', 'O que é de Atrium'])
    const sub = top[2]!
    assert.ok(sub !== 'sep' && !('heading' in sub) && sub.children?.length === 1, 'the submenu keeps its rows')
    assert.deepEqual(door.paneMenuItems(pane).map(e => (e === 'sep' ? '—' : 'heading' in e ? e.heading : e.label)), ['No piso'])
    const withFloor = withPaneMenuItems<E>(PANE_MENUS.agente!, fromExt(door.paneMenuItems(pane)), SEP, isFloor)
    const out = labels(withPaneMenuTop<E>(withFloor, fromExt(top), SEP))
    assert.deepEqual(out.slice(0, 4), ['# Comandada por Atrium, pela mesa', 'Tomar', 'O que é de Atrium', '—'])
    assert.deepEqual(out.slice(-4), ['—', 'No piso', '—', 'Fechar painel…'])
    door.removeOwner('for-agents')
    assert.deepEqual(door.paneMenuTop(pane), [], 'the top rows go with their extension')
  })

  test('a heading passes through the desk group like a row', () => {
    const door = new DoorHost()
    door.deskMenu('for-agents', () => [{ heading: 'Dona: Atrium · comanda 4 guias, vê 2' }, row('Ir para Atrium')])
    const out = labels(withDeskMenuGroup<E>(DESK_MENU, fromExt(door.deskMenuItems('d1')), SEP, labelOf, ANCHORS))
    assert.deepEqual(out.slice(5), ['Mover para a direita', '—', '# Dona: Atrium · comanda 4 guias, vê 2', 'Ir para Atrium', '—', 'Hibernar mesa', 'Fechar mesa…'])
  })
})
