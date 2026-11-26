// Tether for agents, slice U2: the menus of the gestures (extensions/for-agents/renderer/menus.ts), one case per state of the
// approved preview's section 3 (the pill: common, active, paused, taken, ended; the tab: commanded by the desk, given to
// another, the agent's own, waiting for the owner, waiting for the person, taken, common; the owner's tab), with the pins;
// the picker rows, the dialogs' words and the shape of every write against what the daemon's store writes.
// A = Atrium (the owner of desk 'kai-aware'), K = Kai.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { DisposableStore } from '../../app/shared/vscode-lifecycle.ts'
import type { AgentPane } from '../../app/renderer/agent-panes.ts'
import type { TetherUi } from '../../app/renderer/ext-api.ts'
import { OwnershipStore } from '../../extensions/for-agents/daemon/ownership.ts'
import { gestures, pickItems, writes } from '../../extensions/for-agents/renderer/gestures.ts'
import { heldText } from '../../extensions/for-agents/renderer/holds.ts'
import { deskMenu, paneMenu, readFacts, toRows, type MenuFacts, type Row, type Waiting } from '../../extensions/for-agents/renderer/menus.ts'
import { giveDeskDialog, givePaneDialog, revokeDeskDialog } from '../../extensions/for-agents/renderer/texts.ts'
import type { Frozen, Hand, Ownership } from '../../extensions/for-agents/rules.ts'

const T = '2026-11-21T14:02:00'
const own = (owner: string, extra: Partial<Ownership> = {}): Ownership => ({ owner, since: T, givenBy: 'user', ...extra })
const hand = (why: Hand['why'], since = '2026-11-21T14:10:00'): Hand => ({ with: 'user', why, by: 'gesture', since })
const NAMES: Record<string, string> = { A: 'Atrium', K: 'Kai' }

interface Spec {
  panes?: Array<{ id: string; deskId?: string; type?: string; title?: string; agent?: boolean }>
  desks?: Array<{ id: string; name: string }>
  paneOwner?: Record<string, Ownership>
  paneHand?: Record<string, Hand>
  deskOwner?: Record<string, Ownership>
  deskHand?: Record<string, Hand>
  frozen?: Record<string, Frozen>
  waiting?: Record<string, Waiting>
  opened?: number
}
const facts = (s: Spec): MenuFacts => ({
  panes: (s.panes ?? []).map(p => ({ id: p.id, type: p.type ?? 'terminal', deskId: p.deskId, title: p.title ?? p.id, agent: p.agent ?? true })),
  desks: s.desks ?? [{ id: 'd1', name: 'kai-aware' }],
  paneOwner: new Map(Object.entries(s.paneOwner ?? {})),
  paneHand: new Map(Object.entries(s.paneHand ?? {})),
  deskOwner: new Map(Object.entries(s.deskOwner ?? {})),
  deskHand: new Map(Object.entries(s.deskHand ?? {})),
  frozen: new Map(Object.entries(s.frozen ?? {})),
  nameOf: id => NAMES[id] ?? id,
  waiting: id => s.waiting?.[id],
  ...(s.opened !== undefined ? { openedBy: () => s.opened! } : {}),
  clock: iso => iso.slice(11, 16),
})

/** The labels of a menu, headings as "# text", pinned rows as "label [pin]", submenus with their children indented. */
const labels = (rows: readonly Row[]): string[] => rows.flatMap((r): string[] => {
  if (r.kind === 'info') return [`# ${r.text}`]
  if (r.kind === 'sep') return ['---']
  if (r.kind === 'submenu') return [`${r.label} >`, ...labels(r.children).map(l => `  ${l}`)]
  return [`${r.label}${r.pin ? ` [${r.pin}]` : ''}${r.danger ? ' !' : ''}`]
})

// A desk of five: A (the owner, in the desk), c1 and c2 commanded by the desk, g given to K by A, k = K itself ("de si").
const base: Spec = {
  desks: [{ id: 'd1', name: 'kai-aware' }, { id: 'd2', name: 'geral' }],
  panes: [
    { id: 'A', deskId: 'd1', title: 'Atrium' }, { id: 'c1', deskId: 'd1', title: 'soul · bancada' }, { id: 'c2', deskId: 'd1', title: 'soul · outra' },
    { id: 'g', deskId: 'd1', title: 'codex · conferência' }, { id: 'K', deskId: 'd1', title: 'Kai' },
    { id: 'plain', deskId: 'd2', title: 'soul comum' }, { id: 'notes', deskId: 'd2', title: 'notas', agent: false },
  ],
  deskOwner: { d1: own('A') },
  paneOwner: { g: own('K', { givenBy: 'A' }), K: own('K') },
}
const withBase = (s: Spec): Spec => ({ ...base, ...s, paneOwner: { ...base.paneOwner, ...s.paneOwner }, deskOwner: { ...base.deskOwner, ...s.deskOwner } })

describe('the pill menu (section 3)', () => {
  test('a common desk: only "Dar a mesa a um agente…"', () => {
    assert.deepEqual(labels(deskMenu(facts(base), 'd2')), ['Dar a mesa a um agente…'])
  })
  test('active: the line with the counts, then the six rows, "Tirar a mesa de Atrium…" in danger', () => {
    // c1, c2 are commanded by A; g is K's and A sees it; K is K's own pane and A sees it too (the owner's own pane is not counted).
    assert.deepEqual(labels(deskMenu(facts(base), 'd1')), [
      '# Dono: Atrium · comanda 2 guias, vê 2', 'Ir para Atrium', 'Pausar Atrium nesta mesa', 'Assumir o comando da mesa', 'O que Atrium pode aqui…', 'Dar a mesa a outro agente…', 'Tirar a mesa de Atrium… !',
    ])
  })
  test('paused here: the way back first, then the rest', () => {
    assert.deepEqual(labels(deskMenu(facts(withBase({ deskHand: { d1: hand('paused') } })), 'd1')), [
      '# Dono: Atrium · pausada nesta mesa desde 14:10', 'Retomar Atrium nesta mesa', 'Ir para Atrium', 'Assumir o comando da mesa', 'O que Atrium pode aqui…', 'Dar a mesa a outro agente…', 'Tirar a mesa de Atrium… !',
    ])
  })
  test('paused everywhere (the owner is frozen): "Retomar … em tudo"', () => {
    assert.deepEqual(labels(deskMenu(facts(withBase({ frozen: { A: { since: '2026-11-21T14:12:00' } } })), 'd1')).slice(0, 2), ['# Dono: Atrium · pausada em tudo desde 14:12', 'Retomar Atrium em tudo'])
  })
  test('taken by the person: "Devolver a mesa a Atrium", the inventory and the revoke', () => {
    assert.deepEqual(labels(deskMenu(facts(withBase({ deskHand: { d1: hand('taken') } })), 'd1')), [
      '# Dono: Atrium · a mesa está com você', 'Devolver a mesa a Atrium', 'O que Atrium pode aqui…', 'Tirar a mesa de Atrium… !',
    ])
  })
  test('the owner ended: the line, give again, keep the desk; "Fechar as guias que … abriu (3)…" when the count is known', () => {
    const ended = withBase({ deskOwner: { d1: own('A', { ended: { at: '2026-11-21T13:40:00', name: 'Atrium' } }) } })
    assert.deepEqual(labels(deskMenu(facts(ended), 'd1')), ['# Atrium encerrou às 13:40 · as guias voltaram para você', 'Dar a mesa a um agente…', 'Ficar com a mesa (tira o selo)'])
    assert.deepEqual(labels(deskMenu(facts({ ...ended, opened: 3 }), 'd1')), [
      '# Atrium encerrou às 13:40 · as guias voltaram para você', 'Fechar as guias que Atrium abriu (3)… !', 'Dar a mesa a um agente…', 'Ficar com a mesa (tira o selo)',
    ])
  })
  test('a desk that does not exist has no rows', () => assert.deepEqual(deskMenu(facts(base), 'nope'), []))
})

describe('the tab menu (section 3)', () => {
  test('(2) commanded by the desk: Tomar and Pausar pinned as icons', () => {
    assert.deepEqual(labels(paneMenu(facts(base), 'c1')), [
      '# Comandada por Atrium, pela mesa', 'Assumir o comando [icon]', 'Pausar Atrium nesta guia [icon]', 'Dar esta guia a outro agente…', 'O que Atrium pode nesta guia…',
    ])
  })
  test('(3) given to another: Atrium sees', () => {
    assert.deepEqual(labels(paneMenu(facts(base), 'g')), [
      '# Dada a Kai · Atrium vê', 'Assumir o comando [icon]', 'Pausar Kai nesta guia [icon]', 'Ir para Kai [icon]', 'Dar a outro agente…', 'Voltar para a mesa (tira de Kai)', 'O que Kai pode nesta guia…',
    ])
  })
  test('(4) the agent\'s own pane that also owns another: the owner\'s section, then the pane\'s own rows', () => {
    assert.deepEqual(labels(paneMenu(facts(base), 'K')), [
      '# É dono de 1 guia em kai-aware', 'Pausar Kai em tudo [icon]', 'O que é de Kai >', '  kai-aware › codex · conferência (guia)',
      '---', '# Dada a Kai, que roda nela (comanda a si mesmo)', 'Pausar Kai em si mesmo', 'O que Kai pode em si…', 'Tirar de Kai (volta para a mesa)',
    ])
  })
  test('(4) with nothing else owned: just the pane rows', () => {
    const s: Spec = { ...base, paneOwner: { K: own('K') } }
    assert.deepEqual(labels(paneMenu(facts(s), 'K')), ['# Dada a Kai, que roda nela (comanda a si mesmo)', 'Pausar Kai em si mesmo', 'O que Kai pode em si…', 'Tirar de Kai (volta para a mesa)'])
  })
  test('(5) waiting for the owner: "Ir para" and "Tomar e responder eu" first', () => {
    const w = { c1: { kind: 'waiting' as const, at: '2026-11-21T14:05:00' } }
    assert.deepEqual(labels(paneMenu(facts({ ...base, waiting: w }), 'c1')), [
      '# Espera Atrium: pediu permissão às 14:05', 'Ir para Atrium [icon]', 'Assumir o comando e responder eu [icon]', 'Pausar Atrium nesta guia [icon]', 'Dar esta guia a outro agente…', 'O que Atrium pode nesta guia…',
    ])
    assert.deepEqual(labels(paneMenu(facts({ ...base, waiting: { g: { kind: 'waiting', at: '2026-11-21T14:05:00' } } }), 'g')).slice(0, 4), [
      '# Espera Kai: pediu permissão às 14:05', 'Ir para Kai [icon]', 'Assumir o comando e responder eu [icon]', 'Pausar Kai nesta guia [icon]',
    ])
  })
  test('(6) waiting for the person: the owner ended, the pane came back', () => {
    const s = withBase({ paneOwner: { x: own('K', { ended: { at: T, name: 'Kai' } }) }, panes: [...base.panes!, { id: 'x', deskId: 'd1', title: 'codex · migração' }] })
    assert.deepEqual(labels(paneMenu(facts(s), 'x')), ['# Kai encerrou · voltou para você', 'Dar esta guia a um agente…', 'Devolver à mesa (Atrium)'])
    assert.deepEqual(labels(paneMenu(facts({ ...s, waiting: { x: { kind: 'waiting' } } }), 'x')).slice(0, 3), ['# Kai encerrou · voltou para você · pede permissão', '# (responde-se na própria guia, como hoje)', 'Dar esta guia a um agente…'])
    const alone: Spec = { ...base, deskOwner: {}, paneOwner: { x: own('K', { ended: { at: T, name: 'Kai' } }) }, panes: [...base.panes!, { id: 'x', deskId: 'd1' }] }
    assert.deepEqual(labels(paneMenu(facts(alone), 'x')).slice(-1), ['Ficar com a guia (tira a marca)'])
  })
  test('(7) taken by the person: "Devolver a Atrium" is the one with the accent', () => {
    assert.deepEqual(labels(paneMenu(facts({ ...base, paneHand: { c1: hand('taken') } }), 'c1')), [
      '# Com você · antes: Atrium, pela mesa', 'Devolver a Atrium [highlight]', 'Dar a outro agente…', 'O que Atrium pode nesta guia…',
    ])
  })
  test('(7) taken because the desk was taken: the way back is the desk\'s', () => {
    const rows = paneMenu(facts({ ...base, deskHand: { d1: hand('taken') } }), 'c1')
    assert.equal(labels(rows)[1], 'Devolver a mesa a Atrium [highlight]')
    assert.deepEqual((rows[1] as { act: unknown }).act, { do: 'resume', target: { kind: 'desk', id: 'd1' } })
    // a pane the desk does not command (given to K) stays with K
    assert.equal(labels(paneMenu(facts({ ...base, deskHand: { d1: hand('taken') } }), 'g'))[0], '# Dada a Kai · Atrium vê')
  })
  test('paused: "Retomar" pinned with its text, in the scope that holds the pause', () => {
    assert.deepEqual(labels(paneMenu(facts({ ...base, paneHand: { c1: hand('paused') } }), 'c1')), [
      '# Pausada às 14:10 · Atrium não age aqui até você retomar', 'Retomar Atrium nesta guia [primary]', 'Dar a outro agente…', 'O que Atrium pode nesta guia…',
    ])
    assert.equal(labels(paneMenu(facts({ ...base, deskHand: { d1: hand('paused') } }), 'c1'))[1], 'Retomar Atrium nesta mesa [primary]')
    assert.equal(labels(paneMenu(facts({ ...base, frozen: { A: { since: '2026-11-21T14:12:00' } } }), 'c1'))[1], 'Retomar Atrium em tudo [primary]')
  })
  test('a pane in a common desk: only "Dar esta guia a um agente…"; so is a note', () => {
    assert.deepEqual(labels(paneMenu(facts(base), 'plain')), ['Dar esta guia a um agente…'])
    assert.deepEqual(labels(paneMenu(facts(base), 'notes')), ['Dar esta guia a um agente…'])
  })
  test('the owner\'s tab (1): what is theirs, "Pausar em tudo", the submenu, and giving its own pane', () => {
    const s = withBase({
      desks: [{ id: 'd1', name: 'kai-aware' }, { id: 'd2', name: 'geral' }, { id: 'd3', name: 'migração' }],
      deskOwner: { d1: own('A'), d3: own('A') },
      paneOwner: { notes: own('A') },
    })
    assert.deepEqual(labels(paneMenu(facts(s), 'A')), [
      '# É dono de 2 mesas (kai-aware, migração) e de 1 guia em geral',
      'Pausar Atrium em tudo [icon]',
      'O que é de Atrium >',
      '  kai-aware (mesa)', '  migração (mesa)', '  geral › notas (guia)',
      '---', 'Dar esta guia a um agente…',
    ])
  })
  test('the owner\'s tab (1) paused in everything: only the way back, with its text', () => {
    const s = withBase({ frozen: { A: { since: '2026-11-21T14:12:00' } } })
    assert.deepEqual(labels(paneMenu(facts(s), 'A')), ['# Pausada em tudo desde 14:12', 'Retomar Atrium em tudo [primary]'])
  })
  test('toRows: headings, separators, pins, danger, and a submenu with its children', () => {
    const picked: string[] = []
    const rows = toRows(paneMenu(facts(base), 'g'), a => { picked.push(a.do) })
    assert.deepEqual(rows[0], { heading: 'Dada a Kai · Atrium vê' })
    const take = rows[1] as { label: string; pin: string; run(): void }
    assert.deepEqual([take.label, take.pin], ['Assumir o comando', 'icon'])
    take.run()
    assert.deepEqual(picked, ['take'])
  })
})

describe('the picker rows', () => {
  const agent = (slotId: string, name: string, over: Partial<AgentPane> = {}): AgentPane => ({ slotId, kind: 'soul', name, alive: true, paneId: slotId, isSystemDesk: false, inDrawer: false, ...over })
  const ctx = { recent: [] as string[], owns: () => ({ mesas: 0, guias: 0 }) }
  test('only live agents; Recentes, Nesta mesa, Outras mesas; the current owner is not offered', () => {
    const agents = [
      agent('A', 'Atrium · Claude', { deskId: 'd9', deskTitle: 'atrium' }), agent('K', 'kai · Claude', { deskId: 'd1', deskTitle: 'kai-aware' }),
      agent('S', 'soul · bancada', { deskId: 'd1', deskTitle: 'kai-aware' }), agent('C', 'codex · revisão', { deskId: 'd2', deskTitle: 'geral' }),
      agent('D', 'morto', { alive: false, deskId: 'd1' }), agent('G', 'na gaveta', { inDrawer: true }),
    ]
    const items = pickItems(agents, { ...ctx, deskId: 'd1', recent: ['A'], owns: id => (id === 'A' ? { mesas: 1, guias: 0 } : { mesas: 0, guias: 0 }) })
    assert.deepEqual(items.map(i => [i.group, i.label]), [
      ['Recentes', 'Atrium · Claude'], ['Nesta mesa', 'kai · Claude'], ['Nesta mesa', 'soul · bancada'], ['Outras mesas', 'codex · revisão'], ['Outras mesas', 'na gaveta'],
    ])
    assert.equal(items[0]!.detail, 'mora em atrium · dono de 1 mesa')
    assert.equal(items[4]!.detail, 'mora em a Gaveta')
    assert.ok(items.every(i => i.icon === 'robot' && typeof i.hue === 'number'))
    assert.deepEqual(items.map(i => i.letter), ['A', 'K', 'S', 'C', 'N'], 'the initial of the name, as on its tab emblem')
    assert.deepEqual(pickItems(agents, { ...ctx, exclude: 'A' }).map(i => i.value).includes('A'), false)
    assert.equal(pickItems(agents, { ...ctx, paneId: 'K' }).find(i => i.value === 'K')!.detail?.startsWith('ela mesma: de si'), true)
  })
  test('a live agent with no tab goes last, in "Sem mesa", marked "sem mesa" instead of "mora em"; recents keep it first', () => {
    const agents = [
      agent('A', 'Atrium', { deskId: 'd9', deskTitle: 'atrium' }), agent('Z', 'zeta', { placed: false }), agent('B', 'beta', { placed: false }),
      agent('D', 'morto', { placed: false, alive: false }),
    ]
    const items = pickItems(agents, { ...ctx, deskId: 'd1', owns: id => (id === 'B' ? { mesas: 0, guias: 2 } : { mesas: 0, guias: 0 }) })
    assert.deepEqual(items.map(i => [i.group, i.label]), [['Outras mesas', 'Atrium'], ['Sem mesa', 'beta'], ['Sem mesa', 'zeta']])
    assert.equal(items[1]!.detail, 'sem mesa · dono de 2 guias')
    assert.equal(items[2]!.detail, 'sem mesa')
    const recent = pickItems(agents, { ...ctx, recent: ['Z'] })
    assert.deepEqual(recent.map(i => [i.group, i.label]), [['Recentes', 'zeta'], ['Outras mesas', 'Atrium'], ['Sem mesa', 'beta']])
  })
  test('every row names its engine (the agent kind), for the fixed icon column', () => {
    const agents = [agent('A', 'kai', { kind: 'claude' }), agent('S', 'kai', { kind: 'soul' })]
    assert.deepEqual(pickItems(agents, ctx).map(i => i.engine), ['claude', 'soul'])
  })
  test('holds: an agent that owns desks or guias is held; an ended ownership and its own guia do not count', () => {
    const own = (owner: string, ended = false) => ({ owner, since: 't', givenBy: 'user', ...(ended ? { ended: { at: 't', name: 'x' } } : {}) }) as never
    const f = { deskOwner: new Map([['d1', own('A')], ['d2', own('A', true)]]), paneOwner: new Map([['p1', own('A')], ['A', own('A')], ['p2', own('B')]]) }
    assert.equal(heldText(f, 'A'), 'dono de 1 mesa e 1 guia')
    assert.equal(heldText(f, 'B'), 'dono de 1 guia')
    assert.equal(heldText(f, 'C'), undefined)
  })
  test('the emblem of the guia rides on its row; none when the reader has none; the pane itself too', () => {
    const agents = [agent('A', 'Atrium'), agent('K', 'kai')]
    const emblem = { glyph: 'x' } as never
    const withE = pickItems(agents, { ...ctx, paneId: 'K', emblemOf: id => (id === 'A' || id === 'K' ? emblem : undefined) })
    assert.equal(withE.find(i => i.value === 'A')!.emblem, emblem)
    assert.equal(withE.find(i => i.value === 'K')!.emblem, emblem)
    assert.equal(pickItems(agents, { ...ctx, emblemOf: () => undefined }).every(i => !('emblem' in i)), true)
    assert.equal(pickItems(agents, ctx).every(i => !('emblem' in i)), true)
  })
})

describe('the dialogs\' words', () => {
  test('giving a desk (step 2): the guias given to others stay, the owner in another desk stays there', () => {
    const d = giveDeskDialog({ desk: 'kai-aware', to: 'Atrium', commands: 5, keptByOthers: [{ title: 'codex · conferência', owner: 'Kai' }], livesIn: 'atrium' })
    assert.equal(d.title, 'Dar a mesa kai-aware a Atrium')
    assert.equal(d.message, 'Atrium passa a comandar as 5 guias desta mesa como você comanda.')
    assert.deepEqual(d.context?.lines, ['1 guia já é de Kai (codex · conferência): continua de Kai, e Atrium só vê.', 'Atrium mora em outra mesa (atrium); continua lá.', 'Tudo começa ligado. Para limitar: “O que Atrium pode aqui…”.'])
    assert.deepEqual(d.choices.map(c => c.label), ['Voltar', 'Dar a mesa'])
    assert.equal(d.cancelLabel, 'Cancelar')
  })
  test('passing a desk', () => {
    const d = giveDeskDialog({ desk: 'kai-aware', to: 'Kai', from: 'Atrium', commands: 4, keptByOthers: [] })
    assert.equal(d.title, 'Passar a mesa kai-aware de Atrium para Kai')
    assert.equal(d.message, 'Atrium deixa de comandar esta mesa. O que Atrium tinha deixado diferente no inventário fica para Kai como está.')
    assert.deepEqual(d.choices.map(c => c.label), ['Voltar', 'Passar a mesa'])
  })
  test('giving a pane, and "de si"', () => {
    const d = givePaneDialog({ pane: 'soul · testes', to: 'Kai', itself: false, from: { name: 'Atrium', byDesk: true }, viewer: 'Atrium', pending: 'permissão, 14:05' })
    assert.equal(d.title, 'Dar a guia soul · testes a Kai')
    assert.equal(d.message, 'Hoje ela é comandada por Atrium, pela mesa. Dada a Kai, Kai comanda e Atrium só vê. O pedido pendente (permissão, 14:05) passa a ir para Kai.')
    assert.deepEqual(d.choices.map(c => c.label), ['Voltar', 'Dar a guia'])
    const self = givePaneDialog({ pane: 'kai · Claude', to: 'Kai', itself: true })
    assert.equal(self.title, 'Dar a guia kai · Claude ao próprio Kai')
    assert.equal(self.message, 'Kai passa a comandar a si mesmo nesta guia (por exemplo, compactar a própria sessão).')
  })
  test('revoking a desk', () => {
    const d = revokeDeskDialog({ desk: 'kai-aware', owner: 'Atrium', commands: 4, keptByOthers: [{ owner: 'Kai' }], waiting: 1 })
    assert.equal(d.title, 'Tirar a mesa kai-aware de Atrium')
    assert.equal(d.message, 'As 4 guias que Atrium comanda voltam para você. Pedidos que esperavam Atrium (1) passam a esperar você. A guia de Kai continua de Kai.')
    assert.deepEqual(d.choices.map(c => [c.label, c.tone]), [['Tirar a mesa', 'destructive']])
    assert.equal(d.tone, 'danger')
  })
})

/** A store of objects in memory: what `ui.objects` and the daemon's `DoorObjects` both need. */
class Mem {
  readonly data = new Map<string, unknown>()
  readonly log: Array<[string, string, string, unknown]> = []
  private k = (kind: string, id: string, key: string): string => `${kind}|${id}|${key}`
  get<T>(kind: string, id: string, key: string): T | undefined { return this.data.get(this.k(kind, id, key)) as T | undefined }
  async set(kind: string, id: string, key: string, value: unknown): Promise<void> {
    this.log.push([kind, id, key, value])
    if (value === undefined) this.data.delete(this.k(kind, id, key)); else this.data.set(this.k(kind, id, key), value)
  }
  entries<T>(kind: string, key: string): [string, T][] {
    return [...this.data].filter(([k]) => k.startsWith(`${kind}|`) && k.endsWith(`|${key}`)).map(([k, v]) => [k.split('|')[1]!, v as T])
  }
}

describe('the writes are the daemon store\'s', () => {
  const NOW = '2026-11-21T15:00:00.000Z'
  test('every gesture writes the same key and the same value as OwnershipStore', async () => {
    const appMem = new Mem()
    const daemonMem = new Mem()
    const desks = { map: () => ({ desks: [{ id: 'd1', name: 'kai-aware', kind: 'queue', panes: [{ id: 'p1', type: 'terminal' }] }] }), deskOf: () => undefined }
    const store = new OwnershipStore(daemonMem as never, desks as never, () => NOW)
    const w = writes({ objects: appMem } as unknown as TetherUi, () => NOW)
    await w.give({ kind: 'desk', id: 'd1' }, 'A'); await store.giveDesk('d1', 'A')
    await w.give({ kind: 'pane', id: 'p1' }, 'K'); await store.givePane('p1', 'K', 'user')
    await w.give({ kind: 'pane', id: 'K' }, 'K'); await store.givePane('K', 'K', 'user')
    await w.hand({ kind: 'pane', id: 'p1' }, 'taken'); await store.take({ pane: 'p1' }, 'taken')
    await w.hand({ kind: 'desk', id: 'd1' }, 'paused'); await store.take({ desk: 'd1' }, 'paused')
    await w.freeze('A'); await store.freeze('A')
    assert.deepEqual(appMem.log, daemonMem.log)
    await w.handBack({ kind: 'pane', id: 'p1' }); await store.giveBack({ pane: 'p1' })
    await w.unfreeze('A'); await store.unfreeze('A')
    await w.revoke({ kind: 'pane', id: 'p1' }); await store.revokePane('p1', 'user')
    await w.revoke({ kind: 'desk', id: 'd1' }); await store.revokeDesk('d1')
    assert.deepEqual(appMem.log, daemonMem.log)
    assert.deepEqual(appMem.log[0], ['desk', 'd1', 'owner', { owner: 'A', since: NOW, givenBy: 'user' }])
    assert.deepEqual(appMem.log[3], ['pane', 'p1', 'hand', { with: 'user', why: 'taken', by: 'gesture', since: NOW }])
    assert.deepEqual(appMem.log[5], ['pane', 'A', 'frozen', { since: NOW }])
  })
})

describe('the commands', () => {
  /** A `ui` with only what the gestures read and write: commands, objects, panes, the picker and the dialogs, recorded. */
  function fakeUi() {
    const mem = new Mem()
    const handlers = new Map<string, (s?: unknown, arg?: unknown) => void>()
    const calls: string[] = []
    const ui = {
      objects: mem,
      commands: {
        registerCommand: (id: string, run: (s?: unknown, arg?: unknown) => void) => { handlers.set(id, run); return { dispose() {} } },
        run: async () => 'ran',
      },
      panes: { activeId: () => 'c1', all: () => [], reveal: () => {}, tabMenu: () => ({ dispose() {} }) },
      desks: { list: () => [], menu: () => ({ dispose() {} }) },
      agents: { list: () => [], get: () => undefined, focus: (id: string) => { calls.push(`focus:${id}`); return true } },
      pick: { list: async () => { calls.push('pick'); return undefined } },
      dialogs: { ask: async () => { calls.push('ask'); return { choice: 'cancel', remember: false } } },
      test: { expose: () => {} },
    } as unknown as TetherUi
    return { ui, mem, handlers, calls }
  }
  const settle = (): Promise<void> => new Promise(r => setTimeout(r, 10))

  test('with an argument they act there, and giving with `to` skips the picker and the dialog', async () => {
    const { ui, mem, handlers, calls } = fakeUi()
    const d = new DisposableStore()
    for (const x of gestures(ui)) d.add(x)
    handlers.get('for-agents.give')!(undefined, { kind: 'desk', id: 'd1', to: 'A' })
    handlers.get('for-agents.take')!(undefined, { kind: 'pane', id: 'p9' })
    handlers.get('for-agents.pause')!(undefined, { kind: 'pane', id: 'A', scope: 'all' })
    await settle()
    assert.deepEqual(calls, [], 'no picker, no dialog')
    assert.deepEqual(mem.log.map(([k, id, key]) => `${k}:${id}:${key}`), ['desk:d1:owner', 'pane:p9:hand', 'pane:A:frozen'])
    handlers.get('for-agents.resume')!(undefined, { kind: 'pane', id: 'A', scope: 'all' })
    handlers.get('for-agents.return')!(undefined, { kind: 'pane', id: 'p9' })
    handlers.get('for-agents.revoke')!(undefined, { kind: 'desk', id: 'd1' })
    await settle()
    assert.equal(mem.data.size, 0, 'taking the key away undoes each')
  })
  test('without an argument they act on the active pane; giving without `to` opens the picker', async () => {
    const { ui, mem, handlers, calls } = fakeUi()
    gestures(ui)
    handlers.get('for-agents.take')!()
    handlers.get('for-agents.give')!()
    await settle()
    assert.deepEqual(mem.log.map(([k, id, key]) => `${k}:${id}:${key}`), ['pane:c1:hand'])
    assert.deepEqual(calls, ['pick'])
  })
  test('a malformed argument does nothing', async () => {
    const { ui, mem, handlers, calls } = fakeUi()
    gestures(ui)
    handlers.get('for-agents.take')!(undefined, { kind: 'wall', id: 'x' })
    handlers.get('for-agents.give')!(undefined, 'p1')
    await settle()
    assert.deepEqual([mem.log.length, calls.length], [0, 0])
  })
})

describe('what the app tells the menus (slot facts): the three lines the model waited for', () => {
  const ENDED = { owner: 'A', since: T, givenBy: 'user', ended: { at: '2026-11-21T14:30:00', name: 'Atrium' } }
  type Facts = { createdBy?: { ext: string; slotId?: string }; attention?: { value: 'done' | 'waiting'; since: string }; routed?: { owner: string; value: 'done' | 'waiting'; since: string; hue: number; tooltip: string } }

  /** A `ui` with a desk d1 of three terminals: x (opened by A), y (opened by someone else), z (nobody's). */
  function appWith(slotFacts: Record<string, Facts>, objects: Array<['pane' | 'desk', string, string, unknown]>) {
    const mem = new Mem()
    for (const [k, id, key, v] of objects) mem.data.set(`${k}|${id}|${key}`, v)
    const closed: string[] = []
    const asked: string[] = []
    let desk: ((id: string) => unknown[]) | undefined
    const answers: string[] = []
    const ui = {
      objects: mem,
      commands: { registerCommand: () => ({ dispose() {} }), run: async () => 'ran' },
      panes: {
        activeId: () => undefined,
        all: () => ['x', 'y', 'z'].map(id => ({ id, type: 'terminal', agent: 'soul' })),
        slotFacts: (id: string) => slotFacts[id],
        closeGuide: async (id: string, o?: { process?: string }) => { closed.push(`${id}:${o?.process}`) },
        reveal: () => {},
        tabMenu: () => ({ dispose() {} }),
      },
      desks: { list: () => [{ id: 'd1', name: 'kai-aware', color: '', asleep: false, panes: ['x', 'y', 'z'] }], menu: (p: (id: string) => unknown[]) => { desk = p; return { dispose() {} } } },
      agents: { list: () => [], get: (id: string) => (id === 'A' ? { name: 'Atrium' } : undefined), focus: () => true },
      pick: { list: async () => undefined },
      dialogs: { ask: async (spec: { title: string }) => { asked.push(spec.title); return { choice: answers.shift() ?? 'cancel', remember: false } } },
      test: { expose: () => {} },
    } as unknown as TetherUi
    return { ui, mem, closed, asked, answers, deskRows: () => desk!('d1') as Array<{ label?: string; run?: () => void }> }
  }
  const settle = (): Promise<void> => new Promise(r => setTimeout(r, 10))

  test('opened by: only panes of the desk that this extension opened for that owner count', () => {
    const { ui } = appWith({ x: { createdBy: { ext: 'for-agents', slotId: 'A' } }, y: { createdBy: { ext: 'for-agents', slotId: 'K' } }, z: {} }, [])
    const f = readFacts(ui)
    assert.equal(f.openedBy?.('A', 'd1'), 1)
    assert.equal(f.openedBy?.('K', 'd1'), 1)
    assert.equal(f.openedBy?.('A', 'd2'), 0)
    const other = appWith({ x: { createdBy: { ext: 'other', slotId: 'A' } } }, [])
    assert.equal(readFacts(other.ui).openedBy?.('A', 'd1'), 0, 'another extension\'s guias are not ours to close')
  })

  test('waiting (5): a commanded pane waits for its owner when the daemon routed the attention, with the time', () => {
    const routed = { owner: 'A', value: 'waiting' as const, since: '2026-11-21T14:05:00', hue: 300, tooltip: 'Esperando Atrium' }
    const { ui } = appWith({ x: { routed } }, [['desk', 'd1', 'owner', { owner: 'A', since: T, givenBy: 'user' }]])
    assert.deepEqual(readFacts(ui).waiting?.('x'), { kind: 'waiting', at: '2026-11-21T14:05:00' })
    assert.equal(readFacts(ui).waiting?.('y'), undefined)
    const rows = paneMenu(readFacts(ui), 'x')
    const heads = rows.filter(r => r.kind === 'info').map(r => (r as { text: string }).text)
    assert.equal(heads[0], 'Espera Atrium: pediu permissão às 14:05')
  })

  test('waiting (6): a pane nobody commands (the owner ended) waits for the person; an attention of the person on a commanded pane is not the owner\'s', () => {
    const own = { since: T, givenBy: 'user' }
    const ended = appWith({ x: { attention: { value: 'waiting', since: '2026-11-21T14:05:00' } } }, [['pane', 'x', 'owner', ENDED]])
    assert.deepEqual(readFacts(ended.ui).waiting?.('x'), { kind: 'waiting', at: '2026-11-21T14:05:00' })
    assert.match((paneMenu(readFacts(ended.ui), 'x')[0] as { text: string }).text, /encerrou · voltou para você · pede permissão/)
    const commanded = appWith({ x: { attention: { value: 'waiting', since: '2026-11-21T14:05:00' } } }, [['pane', 'x', 'owner', { owner: 'A', ...own }]])
    assert.equal(readFacts(commanded.ui).waiting?.('x'), undefined)
  })

  test('"Fechar as guias que Atrium abriu (N)…": the dialog says what happens, and each choice closes the guias the way it says', async () => {
    const desks = [['desk', 'd1', 'owner', { ...ENDED, ended: { at: '2026-11-21T14:30:00', name: 'Atrium' } }] as ['desk', string, string, unknown]]
    const app = appWith({ x: { createdBy: { ext: 'for-agents', slotId: 'A' } }, y: { createdBy: { ext: 'for-agents', slotId: 'A' } }, z: {} }, desks)
    for (const x of gestures(app.ui)) x.dispose()
    const row = app.deskRows().find(r => r.label === 'Fechar as guias que Atrium abriu (2)…')!
    assert.ok(row, 'the row is there')
    app.answers.push('close')
    row.run!(); await settle()
    assert.deepEqual(app.asked, ['Fechar as 2 guias que Atrium abriu'])
    assert.deepEqual(app.closed, ['x:keep', 'y:keep'], 'closed with the processes running, z (nobody\'s) untouched')
    app.answers.push('stop')
    row.run!(); await settle()
    assert.deepEqual(app.closed.slice(2), ['x:stop', 'y:stop'])
    app.answers.push('cancel')
    row.run!(); await settle()
    assert.equal(app.closed.length, 4, 'cancel closes nothing')
  })
})
