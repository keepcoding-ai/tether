// The rules of the Regency's "+ Novo" (extensions/regency/create-rules.ts): steps, validation, desks of "Onde", planOf and the run.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  advance, back, channelNameOf, CREATE_TILES, createdText, defaultNameOf, deskChannelOf, deskChoices, failureText, missing, NEW_DESK, patchDraft, planOf, REF_CHANNEL,
  REF_DESK, REF_PANE, runPlan, startCreate, stepsOf,
  type ActResult, type CreateAct, type CreateContext, type CreateDraft, type CreateFixed, type CreateState,
} from '../../extensions/regency/create-rules.ts'
import type { DeskTree } from '../../app/renderer/ext-api.ts'
import type { ChannelSummary } from '../../extensions/channels/daemon/requests.ts'

const desks: DeskTree = {
  desks: [
    { id: 'd1', name: 'obra', color: 'blue', kind: 'queue', asleep: false, panes: [] },
    { id: 'd2', name: 'casa', color: 'green', kind: 'queue', asleep: true, panes: [] },
    { id: 'd3', name: 'estudo', color: 'red', kind: 'queue', asleep: false, panes: [] },
    { id: 'regency.main', name: 'Regência', color: 'gold', kind: 'system', asleep: false, panes: [] },
    { id: 'drawer', name: 'Gaveta', color: 'gray', kind: 'drawer', asleep: false, panes: [] },
  ],
}
const channel = (id: string, extra: Partial<ChannelSummary> = {}): ChannelSummary => ({
  id, name: id, title: id, owner: { kind: 'user' }, members: 1, seenByUser: 0, createdAt: '2026-11-26T10:00:00Z', ...extra,
})
const channels = [channel('obra', { desk: 'd1' }), channel('geral'), channel('velho', { desk: 'd3', closed: { at: 'x', by: 'user' } as ChannelSummary['closed'] })]
const ctx: CreateContext = { desks, channels }

const state = (draft: CreateDraft, fixed: CreateFixed = {}, step: CreateState['step'] = 'what'): CreateState => ({ draft, fixed, step })
const acts = (draft: CreateDraft, fixed: CreateFixed = {}): CreateAct[] => planOf(state(draft, fixed), ctx)
const kinds = (a: CreateAct[]): string[] => a.map(x => x.act)

describe('steps', () => {
  test('the default entry is what › where › details; the desk and the channel have no where', () => {
    assert.deepEqual(stepsOf({ what: 'agent' }), ['what', 'where', 'details'])
    assert.deepEqual(stepsOf({}), ['what', 'where', 'details'])
    assert.deepEqual(stepsOf({ what: 'desk' }), ['what', 'details'])
    assert.deepEqual(stepsOf({ what: 'channel' }), ['what', 'details'])
  })
  test('the "+" of a desk row drops where and pre-fills the desk; "Dar uma mesa nova" is one step', () => {
    const s = startCreate({ deskId: 'd1' })
    assert.equal(s.draft.deskId, 'd1')
    assert.deepEqual(stepsOf(s.draft, s.fixed), ['what', 'details'])
    const g = startCreate({ forAgent: 'a1', forName: 'conferente' })
    assert.deepEqual(stepsOf(g.draft, g.fixed), ['details'])
    assert.equal(g.step, 'details')
    assert.equal(g.draft.giveDesk, true)
    assert.equal(g.draft.movePane, false)
  })
  test('a project\'s "Agente aqui…" fills the folder, which survives choosing the tile; "where" stays', () => {
    const s = startCreate({ cwd: 'C:/obra' }, 'terminal')
    assert.equal(s.draft.cwd, 'C:/obra')
    assert.deepEqual(stepsOf(s.draft, s.fixed), ['what', 'where', 'details'])
    assert.equal(patchDraft(s, { what: 'agent', kind: 'claude' }).draft.cwd, 'C:/obra')
    assert.equal(startCreate({ cwd: '' }).draft.cwd, undefined)
  })
  test('advance walks the steps and marks ready on the last; back walks back and closes at the first', () => {
    let s = startCreate()
    s = patchDraft(s, { what: 'terminal' })
    s = advance(s, ctx)
    assert.equal(s.step, 'where')
    s = patchDraft(s, { deskId: 'd1' })
    s = advance(s, ctx)
    assert.equal(s.step, 'details')
    s = patchDraft(s, { cwd: 'C:/p' })
    s = advance(s, ctx)
    assert.equal(s.outcome, 'ready')
    s = back(s)
    assert.equal(s.outcome, undefined)
    assert.equal(s.step, 'details')
    s = back(back(s))
    assert.equal(s.step, 'what')
    assert.equal(back(s).outcome, 'closed')
  })
  test('a refusal stays on the step with the sentence, and the next try clears it', () => {
    let s = advance(startCreate(), ctx)
    assert.equal(s.step, 'what')
    assert.equal(s.error, 'Escolha o que criar.')
    s = advance(patchDraft(s, { what: 'note' }), ctx)
    assert.equal(s.error, undefined)
    assert.equal(s.step, 'where')
  })
  test('the skipped steps: desk and channel go from what straight to details', () => {
    const s = advance(patchDraft(startCreate(), { what: 'desk' }), ctx)
    assert.equal(s.step, 'details')
    const c = advance(patchDraft(startCreate(), { what: 'channel' }), ctx)
    assert.equal(c.step, 'details')
    const fixed = advance(patchDraft(startCreate({ deskId: 'd1' }), { what: 'note' }), ctx)
    assert.equal(fixed.step, 'details')
  })
  test('changing what drops what belonged to the old one but keeps folder, desk and front', () => {
    const s = patchDraft(state({ what: 'agent', kind: 'claude', profileId: 'p', cwd: 'C:/p', deskId: 'd1', front: true, joinChannel: 'geral' }), { what: 'note' })
    assert.deepEqual(s.draft, { what: 'note', cwd: 'C:/p', deskId: 'd1', front: true })
  })
  test('tiles: agent, terminal, note, browser in a desk; desk and channel in the tether', () => {
    assert.deepEqual(CREATE_TILES.filter(t => t.group === 'desk').map(t => t.what), ['agent', 'terminal', 'note', 'browser'])
    assert.deepEqual(CREATE_TILES.filter(t => t.group === 'tether').map(t => t.what), ['desk', 'channel'])
  })
})

describe('validation, in Portuguese', () => {
  const err = (draft: CreateDraft, fixed: CreateFixed = {}) => missing(state(draft, fixed), ctx)
  test('what', () => {
    assert.deepEqual(err({}), { step: 'what', error: 'Escolha o que criar.' })
    assert.deepEqual(err({ what: 'agent' }), { step: 'what', error: 'Escolha o agente: o motor e o perfil.' })
    assert.equal(err({ what: 'terminal', deskId: 'd1', cwd: 'C:/p' }), undefined)
  })
  test('where: required, the new desk needs a name, asleep and missing desks are refused', () => {
    assert.equal(err({ what: 'terminal' })?.error, 'Escolha a mesa.')
    assert.equal(err({ what: 'terminal', deskId: NEW_DESK })?.error, 'Dê um nome à mesa nova.')
    assert.equal(err({ what: 'terminal', deskId: NEW_DESK, newDesk: { name: 'x'.repeat(41) } })?.error, 'O nome da mesa tem até 40 letras.')
    assert.equal(err({ what: 'terminal', deskId: 'd2' })?.error, 'Essa mesa está hibernando: desperte-a antes de criar nela.')
    assert.equal(err({ what: 'terminal', deskId: 'zz' })?.error, 'Essa mesa não existe mais.')
    assert.equal(err({ what: 'terminal', deskId: 'regency.main' })?.error, 'Essa mesa não existe mais.')
  })
  test('a fixed desk that sleeps is refused in details', () => {
    assert.deepEqual(err({ what: 'note', deskId: 'd2', cwd: 'C:/p' }, { deskId: 'd2' }), { step: 'details', error: 'Essa mesa está hibernando: desperte-a antes de criar nela.' })
  })
  test('details: folder, channel to join, url, channel name, desk name', () => {
    assert.deepEqual(err({ what: 'agent', kind: 'claude', deskId: 'd1' }), { step: 'details', error: 'Escolha a pasta de trabalho.' })
    assert.equal(err({ what: 'note', deskId: 'd1', cwd: '  ' })?.error, 'Escolha a pasta de trabalho.')
    assert.equal(err({ what: 'agent', kind: 'claude', deskId: 'd1', cwd: 'C:/p', joinChannel: 'velho' })?.error, 'Esse canal não está mais aberto.')
    assert.equal(err({ what: 'agent', kind: 'claude', deskId: 'd1', cwd: 'C:/p', joinChannel: 'geral' }), undefined)
    assert.equal(err({ what: 'browser', deskId: 'd1', url: 'a b' })?.error, 'O endereço não pode ter espaços.')
    assert.equal(err({ what: 'browser', deskId: 'd1' }), undefined)
    assert.equal(err({ what: 'channel' })?.error, 'Dê um nome ao canal.')
    assert.equal(err({ what: 'channel', channel: { name: '#Obra Nova' } })?.error, 'O nome do canal usa letras minúsculas sem acento, números e hífen, até 40.')
    assert.equal(err({ what: 'channel', channel: { name: '#GERAL' } })?.error, 'Já existe um canal aberto com esse nome.')
    assert.equal(err({ what: 'channel', channel: { name: 'velho' } }), undefined, 'a closed channel does not hold its name')
    assert.equal(err({ what: 'desk' })?.error, 'Dê um nome à mesa nova.')
    assert.equal(err({ what: 'desk-for', newDesk: { name: 'x' } })?.error, 'Escolha o agente que recebe a mesa.')
  })
  test('channelNameOf', () => assert.equal(channelNameOf('  ##Obra  '), 'obra'))
  test('planOf of an invalid draft is empty', () => assert.deepEqual(acts({ what: 'terminal' }), []))
})

describe('desks of "Onde"', () => {
  const owners = { desk: { d1: { id: 'a9', name: 'conferente' } }, pane: {} }
  test('only awake queue desks (with the owner), "Mesa nova…" last, the origin marked', () => {
    assert.deepEqual(deskChoices(desks, owners, 'd3'), [
      { id: 'd1', name: 'obra', color: 'blue', owner: 'conferente' },
      { id: 'd3', name: 'estudo', color: 'red', origin: true },
      { id: NEW_DESK, name: 'Mesa nova…', color: 'gray', isNew: true },
    ])
  })
  test('deskChannelOf: the desk\'s open channel', () => {
    assert.equal(deskChannelOf('d1', channels)?.id, 'obra')
    assert.equal(deskChannelOf('d3', channels), undefined, 'closed')
    assert.equal(deskChannelOf('d2', channels), undefined)
  })
})

describe('planOf', () => {
  test('terminal in a desk: one slot act, kind shell by default', () => {
    const a = acts({ what: 'terminal', deskId: 'd1', cwd: ' C:/p ', name: ' build ' })
    assert.deepEqual(a, [{ act: 'slot', runs: 'tetherd', deskId: 'd1', kind: 'shell', cwd: 'C:/p', name: 'build', front: false, doing: 'criar o terminal', done: 'criei o terminal' }])
  })
  test('agent with profile, in front, no channel', () => {
    const a = acts({ what: 'agent', kind: 'claude', profileId: 'p1', deskId: 'd3', cwd: 'C:/p', front: true })
    assert.equal(a.length, 1)
    assert.deepEqual(a[0], { act: 'slot', runs: 'tetherd', deskId: 'd3', kind: 'claude', cwd: 'C:/p', profileId: 'p1', front: true, doing: 'criar o agente', done: 'criei o agente' })
  })
  test('agent already in a channel: slot, then join with the new pane', () => {
    const a = acts({ what: 'agent', kind: 'claude', deskId: 'd3', cwd: 'C:/p', joinChannel: 'geral' })
    assert.deepEqual(kinds(a), ['slot', 'join'])
    assert.deepEqual(a[1], { act: 'join', runs: 'tetherd', channel: 'geral', agents: [REF_PANE], optional: true, doing: 'chamar o agente ao canal', done: 'chamei o agente ao canal' })
  })
  test('the desk\'s own channel is not joined again (F1 joins by desk)', () => {
    assert.deepEqual(kinds(acts({ what: 'agent', kind: 'claude', deskId: 'd1', cwd: 'C:/p', joinChannel: 'obra' })), ['slot'])
  })
  test('agent in a new desk: desk first, the slot uses the desk reference', () => {
    const a = acts({ what: 'agent', kind: 'claude', deskId: NEW_DESK, newDesk: { name: ' Nova  mesa ', color: 'red' }, cwd: 'C:/p', joinChannel: 'obra' })
    assert.deepEqual(kinds(a), ['desk', 'slot', 'join'])
    assert.deepEqual(a[0], { act: 'desk', runs: 'app-bridge', name: 'Nova mesa', color: 'red', doing: 'criar a mesa «Nova mesa»', done: 'criei a mesa «Nova mesa»' })
    assert.equal((a[1] as { deskId: string }).deskId, REF_DESK)
    assert.equal((a[2] as { channel: string }).channel, 'obra', 'a new desk has no channel of its own')
  })
  test('note: the note-new item with the folder and the destination', () => {
    assert.deepEqual(acts({ what: 'note', deskId: 'd1', cwd: 'C:/p', name: 'ideias' }, { deskId: 'd1' }), [
      { act: 'item', runs: 'renderer', deskId: 'd1', itemId: 'note-new', cwd: 'C:/p', destination: 'ideias', front: false, doing: 'criar a nota', done: 'criei a nota' },
    ])
  })
  test('browser for you, and for an agent (then the tab is given)', () => {
    const mine = acts({ what: 'browser', deskId: 'd1', url: 'https://a.test' })
    assert.deepEqual(mine, [{ act: 'browser', runs: 'renderer', deskId: 'd1', url: 'https://a.test', doing: 'abrir o navegador', done: 'abri o navegador' }])
    const theirs = acts({ what: 'browser', deskId: 'd1', browserFor: 'a9' })
    assert.deepEqual(kinds(theirs), ['browser', 'give'])
    assert.deepEqual(theirs[1], { act: 'give', runs: 'tetherd', kind: 'pane', id: REF_PANE, to: 'a9', doing: 'dar a aba ao agente', done: 'dei a aba ao agente', ifFails: 'A aba ficou com você.' })
  })
  test('channel: create, join the members, show in the centre (no pane)', () => {
    const a = acts({ what: 'channel', channel: { name: '#Nova', members: ['a1', 'a2'] } })
    assert.deepEqual(kinds(a), ['channel', 'join', 'show'])
    assert.equal((a[0] as { name: string }).name, 'nova')
    assert.deepEqual((a[1] as { channel: string; agents: string[] }).agents, ['a1', 'a2'])
    assert.equal((a[2] as { channel: string }).channel, REF_CHANNEL)
    assert.deepEqual(kinds(acts({ what: 'channel', channel: { name: 'sozinho' } })), ['channel', 'show'])
  })
  test('typed names go through the one filter: no control, bidi or zero-width characters (R-9)', () => {
    const d = acts({ what: 'desk', newDesk: { name: 'Ca\u202Esa\u0007\n nova\u200B' } })
    assert.equal((d[0] as { name: string }).name, 'Casa nova')
    const s = acts({ what: 'terminal', deskId: 'd1', cwd: 'C:/p', name: '\u202Econf\u0000erente\u2066' }).find(x => x.act === 'slot') as { name?: string }
    assert.equal(s.name, 'conferente')
  })
  test('desk: only the desk', () => {
    const a = acts({ what: 'desk', newDesk: { name: 'Casa', after: 'd1' } })
    assert.deepEqual(a, [{ act: 'desk', runs: 'app-bridge', name: 'Casa', after: 'd1', doing: 'criar a mesa «Casa»', done: 'criei a mesa «Casa»' }])
  })
  test('"Dar uma mesa nova": creates and gives; "Levar a guia" is off by default and adds the move when on', () => {
    const fixed = { forAgent: 'a1', forName: 'conferente' }
    const plain = planOf(startCreate(fixed), ctx)
    assert.deepEqual(plain, [], 'no name yet')
    const s = patchDraft(startCreate(fixed), { newDesk: { name: 'Foco' } })
    const a = planOf(s, ctx)
    assert.deepEqual(kinds(a), ['desk', 'give'])
    assert.deepEqual(a[1], { act: 'give', runs: 'tetherd', kind: 'desk', id: REF_DESK, to: 'a1', doing: 'dar a mesa a conferente', done: 'dei a mesa a conferente', ifFails: 'A mesa «Foco» ficou com você.' })
    const moved = planOf(patchDraft(s, { movePane: true }), ctx)
    assert.deepEqual(kinds(moved), ['desk', 'give', 'move'])
    assert.deepEqual(moved[2], { act: 'move', runs: 'renderer', pane: 'a1', deskId: REF_DESK, doing: 'levar a guia de conferente para a mesa nova', done: 'levei a guia de conferente para a mesa nova' })
    assert.deepEqual(kinds(planOf(patchDraft(s, { giveDesk: false }), ctx)), ['desk'])
  })
  test('every act says who runs it', () => {
    const all = [
      ...acts({ what: 'agent', kind: 'claude', deskId: NEW_DESK, newDesk: { name: 'n' }, cwd: 'C:/p', joinChannel: 'geral' }),
      ...acts({ what: 'note', deskId: 'd1', cwd: 'C:/p' }), ...acts({ what: 'browser', deskId: 'd1', browserFor: 'a' }),
      ...acts({ what: 'channel', channel: { name: 'c', members: ['a'] } }),
    ]
    for (const a of all) assert.ok(['tetherd', 'app-bridge', 'renderer'].includes(a.runs), a.act)
  })
  test('the plan, the state and the card survive JSON', () => {
    const s = patchDraft(startCreate({ forAgent: 'a1', forName: 'c' }), { newDesk: { name: 'Foco' }, movePane: true })
    const a = planOf(s, ctx)
    assert.deepEqual(JSON.parse(JSON.stringify(a)), a)
    assert.deepEqual(JSON.parse(JSON.stringify(s)), s)
    const adv = advance(s, ctx)
    assert.deepEqual(JSON.parse(JSON.stringify(adv)), adv)
    assert.deepEqual(JSON.parse(JSON.stringify(deskChoices(desks, { desk: {}, pane: {} }))), deskChoices(desks, { desk: {}, pane: {} }))
  })
})

describe('runPlan and the failure in the middle', () => {
  const agentInNewDesk = (): CreateAct[] => acts({ what: 'agent', kind: 'claude', deskId: NEW_DESK, newDesk: { name: 'Foco' }, cwd: 'C:/p', joinChannel: 'geral' })

  test('success: refs are filled, the announce is the last pane and its desk', async () => {
    const seen: CreateAct[] = []
    const run = await runPlan(agentInNewDesk(), async (act) => {
      seen.push(act)
      if (act.act === 'desk') return { ok: true, deskId: 'd9' }
      if (act.act === 'slot') return { ok: true, paneId: 'p5', deskId: 'd9' }
      return { ok: true }
    })
    assert.deepEqual({ ok: run.ok, done: run.done, text: run.text, announce: run.announce }, { ok: true, done: 3, text: undefined, announce: { paneId: 'p5', deskId: 'd9' } })
    assert.equal((seen[1] as { deskId: string }).deskId, 'd9')
    assert.deepEqual((seen[2] as { agents: string[] }).agents, ['p5'])
  })
  test('a required act fails in the middle: what is done stays and the sentence says how far it went', async () => {
    const run = await runPlan(agentInNewDesk(), async (act): Promise<ActResult> => act.act === 'desk' ? { ok: true, deskId: 'd9' } : { ok: false, error: 'a pasta não existe.' })
    assert.equal(run.ok, false)
    assert.equal(run.done, 1)
    assert.deepEqual(run.failed, { index: 1, error: 'a pasta não existe.' })
    assert.equal(run.text, 'Criei a mesa «Foco». Mas não consegui criar o agente: a pasta não existe. O que já foi feito ficou.')
    assert.equal(run.announce, undefined)
  })
  test('nothing was done: the sentence says so', async () => {
    const run = await runPlan(acts({ what: 'terminal', deskId: 'd1', cwd: 'C:/p' }), async () => ({ ok: false, error: 'sem espaço' }))
    assert.equal(run.text, 'Não consegui criar o terminal: sem espaço. Nada foi criado.')
  })
  test('"Dar uma mesa nova" refused by the give: the desk stays with the person, the move never runs', async () => {
    const s = patchDraft(startCreate({ forAgent: 'a1', forName: 'conferente' }), { newDesk: { name: 'Foco' }, movePane: true })
    const ran: string[] = []
    const run = await runPlan(planOf(s, ctx), async (act): Promise<ActResult> => {
      ran.push(act.act)
      return act.act === 'desk' ? { ok: true, deskId: 'd9' } : { ok: false, error: 'o agente já encerrou' }
    })
    assert.deepEqual(ran, ['desk', 'give'])
    assert.equal(run.text, 'Criei a mesa «Foco». Mas não consegui dar a mesa a conferente: o agente já encerrou. A mesa «Foco» ficou com você.')
  })
  test('an optional act that fails does not stop the plan: it becomes a warning', async () => {
    const run = await runPlan(acts({ what: 'agent', kind: 'claude', deskId: 'd3', cwd: 'C:/p', joinChannel: 'geral' }), async (act): Promise<ActResult> =>
      act.act === 'join' ? { ok: false, error: 'canal fechado' } : { ok: true, paneId: 'p1', deskId: 'd3' })
    assert.equal(run.ok, true)
    assert.deepEqual(run.warnings, ['Não consegui chamar o agente ao canal: canal fechado.'])
    assert.equal(run.text, 'Não consegui chamar o agente ao canal: canal fechado.')
    assert.deepEqual(run.announce, { paneId: 'p1', deskId: 'd3' })
  })
  test('the channel plan: the centre shows the channel made; refused members are a warning', async () => {
    const seen: CreateAct[] = []
    const run = await runPlan(acts({ what: 'channel', channel: { name: 'nova', members: ['a1', 'a2'] } }), async (act): Promise<ActResult> => {
      seen.push(act)
      if (act.act === 'channel') return { ok: true, channelId: 'c7' }
      if (act.act === 'join') return { ok: true, refused: ['a2'] }
      return { ok: true }
    })
    assert.equal((seen[2] as { channel: string }).channel, 'c7')
    assert.equal(run.channelId, 'c7')
    assert.equal(run.announce, undefined, 'a channel makes no pane')
    assert.equal(run.text, 'Não entraram no canal: a2.')
  })
  test('an executor that throws is a failure', async () => {
    const run = await runPlan(acts({ what: 'desk', newDesk: { name: 'x' } }), async () => { throw new Error('sem app') })
    assert.deepEqual(run.failed, { index: 0, error: 'sem app' })
  })
  test('the run itself is JSON', async () => {
    const run = await runPlan(agentInNewDesk(), async () => ({ ok: false, error: 'x' }))
    assert.deepEqual(JSON.parse(JSON.stringify(run)), run)
  })
  test('failureText out of range falls back to the error alone', () => assert.equal(failureText([], 3, 'x.'), 'x.'))
})

describe('regency create: the name it is born with and the notice after', () => {
  const pane = (id: string, title: string) => ({ id, type: 'agent', icon: 'terminal', title })
  const withTitles = (...titles: string[]): CreateContext => ({
    desks: { desks: desks.desks.map(d => (d.id === 'd1' ? { ...d, panes: titles.map((t, i) => pane(`p${i}`, t)) } : d)) }, channels,
  })
  test('a terminal with no name: "Terminal 1", then the first number nobody has (never the folder\'s name)', () => {
    assert.equal(defaultNameOf({ what: 'terminal', cwd: 'C:/tether-daemon-xHa13I' }, ctx), 'Terminal 1')
    assert.equal(defaultNameOf({ what: 'terminal' }, withTitles('Terminal 1', 'terminal 3')), 'Terminal 2')
    assert.equal(defaultNameOf({ what: 'terminal', name: '  build  ' }, ctx), 'build', 'a typed name wins')
  })
  test('an agent with no name: its profile\'s name, numbered from 2 when taken; no profile name: none given', () => {
    assert.equal(defaultNameOf({ what: 'agent', profileName: 'Claude' }, ctx), 'Claude')
    assert.equal(defaultNameOf({ what: 'agent', profileName: 'Claude' }, withTitles('Claude', 'Claude 2')), 'Claude 3')
    assert.equal(defaultNameOf({ what: 'agent' }, ctx), '')
    const a = acts({ what: 'agent', kind: 'claude', profileId: 'p1', profileName: 'Claude', deskId: 'd3', cwd: 'C:/p' })
    assert.equal((a[0] as { name?: string }).name, 'Claude')
  })
  test('a note keeps its place in `name` (the destination), no default name', () => {
    const a = acts({ what: 'note', deskId: 'd1', cwd: 'C:/p' })
    assert.equal((a[0] as { destination?: string }).destination, undefined)
  })
  test('"Ir até a guia depois de criar" survives a change of tile; the notice says what and where', () => {
    assert.equal(patchDraft(state({ what: 'agent', goAfter: true }), { what: 'terminal' }).draft.goAfter, true)
    assert.equal(createdText('terminal', 'Mesa 2'), 'Terminal criado em Mesa 2')
    assert.equal(createdText('agent', 'Prova'), 'Agente criado em Prova')
    assert.equal(createdText('note', 'Mesa 2'), 'Nota criada em Mesa 2')
    assert.equal(createdText('desk', 'Prova'), 'Mesa Prova criada')
    assert.equal(createdText('channel', undefined), undefined)
  })
})
