// The desk-pill and tab menus aimed at a target for a manager (app/renderer/manager-menu-rules.ts): the same rows, reshaped
// by rule; with nothing asked of them, exactly the menus of today.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DESK_PLACE_LABEL, EMBLEM_LABEL, GO_DESK_LABEL, GO_PANE_LABEL, WAKE_DESK_LABEL, WAKE_PANE_LABEL,
  AGENT_BLOCK, OWNER_BLOCK, PANE_BLOCK, managerDeskItems, managerDeskTail, managerGroupedEntries, managerPaneEntries,
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

  test('a sleeping desk: "Despertar mesa" before "Fechar mesa…" (the pill menu has no "Hibernar mesa" then)', () => {
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

  test('goLast: "Despertar guia" after the name-and-process group, "Emblema…" before the last group', () => {
    const ls = labels(managerPaneEntries(PANE(), TOP(), { extra: [], goLast: full({ wake: it(WAKE_PANE_LABEL), emblem: it(EMBLEM_LABEL) }) }, SEP, labelOf))
    assert.equal(ls[ls.indexOf('Reiniciar agente') + 1], WAKE_PANE_LABEL)
    // The pane's own last group is "Fechar painel…": the emblem comes before its separator, as on the tab.
    assert.deepEqual(ls.slice(ls.indexOf('Copiar link do painel'), ls.indexOf('Fechar painel…') + 1), ['Copiar link do painel', EMBLEM_LABEL, '—', 'Fechar painel…'])
    assert.equal(ls.at(-1), GO_PANE_LABEL)
  })

  test('without groups, the menu of the prancheta and of a plain manager call is the one of before (no block titles)', () => {
    const ls = labels(managerPaneEntries(PANE(), TOP(), { extra: [], goLast: full() }, SEP, labelOf))
    assert.deepEqual(ls, ['Novo painel…', 'Duplicar à direita', '—', 'Renomear…', 'Trocar perfil…', 'Reiniciar agente', 'Marcar como não lida', '—', 'Copiar link do painel', '—', 'Fechar painel…', '—', 'Fechar guia', GO_PANE_LABEL])
  })

  test('goLast on a menu without the name group nor separators: wake first, emblem in a group of its own', () => {
    const ls = labels(managerPaneEntries([it('Recarregar')], TOP(), { extra: [], goLast: full({ wake: it(WAKE_PANE_LABEL), emblem: it(EMBLEM_LABEL) }) }, SEP, labelOf))
    assert.deepEqual(ls, [WAKE_PANE_LABEL, 'Recarregar', '—', EMBLEM_LABEL, '—', 'Fechar guia', GO_PANE_LABEL])
  })
})

describe('managerGroupedEntries (the Regency\'s menu in blocks)', () => {
  type G = Item | 'sep' | { heading: string }
  const gLabel = (e: G): string | undefined => (e === 'sep' || 'heading' in e ? undefined : e.label)
  const gText = (es: readonly G[]): string[] => es.map(e => (e === 'sep' ? '—' : 'heading' in e ? `# ${e.heading}` : e.label))
  const groupsOf = (more: Partial<{ agent: string; owner: string; peek: G }> = {}) => ({
    heading: (t: string): G => ({ heading: t }), headingOf: (e: G) => (e !== 'sep' && 'heading' in e ? e.heading : undefined), owner: 'você', ...more,
  })
  /** The slot menu of an agent as the core gives it (main.ts slotMenuEntries), its own rows before the floor. */
  const SLOT = (): G[] => [
    it('Novo painel…'), it('Duplicar painel à direita'), it('Duplicar painel abaixo'), it('Novo painel na borda do quadro…'), it('Novo quadro…'), 'sep',
    it('Renomear…'), it('Trocar perfil…'), it('Reiniciar agente'), it('Hibernar guia'), it('Marcar como não lido'), 'sep',
    it('Mostrar barra de status'), it('Copiar link do painel'), it('Copiar pasta'), it('Abrir pasta no Explorer'), 'sep',
    it('Espiar'), it('Mover…'), 'sep', it('Chamar para um canal…'), 'sep', it('Fechar painel…'),
  ]
  const OWNED = (): G[] => [{ heading: 'Comandada por conferente, pela mesa' }, it('Tomar'), it('Pausar conferente nesta guia'), it('Dar esta guia a outro agente…')]
  const fullG = { go: it(GO_PANE_LABEL, { pin: 'primary' }) as G, close: it('Fechar guia') as G, emblem: it(EMBLEM_LABEL) as G }
  const EXTRA = (): G[] => [it('Falar com bancada'), it('O que bancada tem'), it('Dar uma mesa nova…')]

  test('an agent: three blocks with titles, in order; no frame gestures; one close; "Ir até a guia" last', () => {
    const out = gText(managerGroupedEntries<G>(SLOT(), OWNED(), { extra: EXTRA(), goLast: fullG }, groupsOf({ agent: 'bancada', owner: 'conferente' }), 'sep', gLabel))
    assert.deepEqual(out, [
      `# ${AGENT_BLOCK('bancada')}`, 'Falar com bancada', 'O que bancada tem', 'Chamar para um canal…', 'Dar uma mesa nova…', 'Trocar perfil…', 'Reiniciar agente', '—',
      `# ${PANE_BLOCK}`, 'Espiar', 'Renomear…', 'Mover…', EMBLEM_LABEL, 'Hibernar guia', 'Marcar como não lido', 'Copiar link do painel', '—', 'Copiar pasta', 'Abrir pasta no Explorer', '—', 'Fechar guia', '—',
      `# ${OWNER_BLOCK('conferente')}`, 'Tomar', 'Pausar conferente nesta guia', 'Dar esta guia a outro agente…', '—',
      GO_PANE_LABEL,
    ])
  })

  test('the caller\'s "Espiar" replaces the tab\'s; a status line of ownership that says more than the title stays', () => {
    const peek = it('Espiar', { by: 'regency' }) as G
    const top: G[] = [{ heading: 'Pausada às 10:00 · conferente não age aqui até você retomar' }, it('Retomar conferente nesta guia')]
    const out = managerGroupedEntries<G>(SLOT(), top, { extra: [], goLast: fullG }, groupsOf({ agent: 'bancada', owner: 'conferente', peek }), 'sep', gLabel)
    assert.equal(out.filter(e => gLabel(e) === 'Espiar').length, 1)
    assert.equal((out.find(e => gLabel(e) === 'Espiar') as Item).by, 'regency')
    assert.ok(gText(out).includes('# Pausada às 10:00 · conferente não age aqui até você retomar'))
  })

  test('what the agent owns goes to its block; a plain pane (no agent) has no agent block; no ownership rows: no owner block', () => {
    const top: G[] = [{ heading: 'É dono de 1 mesa (obra)' }, it('Pausar bancada em tudo'), 'sep', it('Dar esta guia a um agente…')]
    const out = gText(managerGroupedEntries<G>(SLOT(), top, { extra: EXTRA(), goLast: fullG }, groupsOf({ agent: 'bancada' }), 'sep', gLabel))
    assert.ok(out.indexOf('# É dono de 1 mesa (obra)') < out.indexOf(`# ${PANE_BLOCK}`))
    assert.ok(out.indexOf('Dar esta guia a um agente…') > out.indexOf(`# ${OWNER_BLOCK('você')}`))
    const channel: G[] = [{ heading: 'Dono: Você · 2 membros' }, it('Juntar agente…'), 'sep', it('Copiar link do painel'), it('Mover…'), it('Espiar'), it('Fechar painel'), 'sep', it('Encerrar canal…')]
    const plain = gText(managerGroupedEntries<G>(channel, [], { extra: [], goLast: fullG }, groupsOf(), 'sep', gLabel))
    assert.equal(plain[0], `# ${PANE_BLOCK}`)
    assert.ok(!plain.some(l => l.startsWith('# O agente') || l.startsWith('# Quem manda')))
    assert.ok(!plain.includes('Fechar painel'))
    assert.deepEqual(plain.slice(-4), ['—', 'Fechar guia', '—', GO_PANE_LABEL], 'the close in a group of its own, after "Encerrar canal…"')
    assert.ok(plain.includes('Encerrar canal…') && plain.includes('# Dono: Você · 2 membros'))
  })
})
