// The executor of the Regency's "+ Novo" (extensions/regency/renderer/create-run.ts): each act of planOf done by the seams, on
// fake seams (no app, no daemon). The plan's refs flow from act to act; a browser tab for an agent is born its own (no give);
// a failure in the middle keeps what was made and says so.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { planOf, runPlan, NEW_DESK, type CreateDraft, type CreateFixed } from '../../extensions/regency/create-rules.ts'
import { createRunner, errorField, type CreateSeams } from '../../extensions/regency/renderer/create-run.ts'

const plan = (draft: CreateDraft, fixed: CreateFixed = {}) => planOf({ draft, fixed, step: 'details' })

describe('regency: the executor of "+ Novo"', () => {
  test('a terminal on a desk: one slot, nothing else', async () => {
    const { seams, calls } = fakeSeams()
    const acts = plan({ what: 'terminal', kind: 'shell', deskId: 'd2', cwd: 'C:/p' })
    const runner = createRunner(acts, seams)
    const run = await runPlan(acts, runner.exec)
    assert.equal(run.ok, true)
    assert.deepEqual(calls, [['slot', { deskId: 'd2', kind: 'shell', cwd: 'C:/p', front: false }]])
    assert.deepEqual(run.announce, { paneId: 'p1', deskId: 'd2' })
    assert.deepEqual(runner.made, { deskId: 'd2', paneId: 'p1' })
  })

  test('an agent in a new desk, joining a channel: the desk, the slot there, the join of the new pane', async () => {
    const { seams, calls } = fakeSeams()
    const acts = plan({ what: 'agent', kind: 'claude', profileId: 'cl', deskId: NEW_DESK, newDesk: { name: 'Prova', color: 'teal' }, cwd: 'C:/p', joinChannel: 'c9' })
    const run = await runPlan(acts, createRunner(acts, seams).exec)
    assert.equal(run.ok, true)
    assert.deepEqual(calls.map(c => c[0]), ['desk', 'slot', 'join'])
    assert.deepEqual(calls[0]![1], { name: 'Prova', color: 'teal' })
    assert.equal((calls[1]![1] as { deskId: string }).deskId, 'new-desk-1', 'the slot is born in the desk just made')
    assert.deepEqual(calls[2]![1], { channelId: 'c9', agent: 'p1' })
    assert.deepEqual(run.announce, { paneId: 'p1', deskId: 'new-desk-1' })
  })

  test('a note: the note-new item with the folder', async () => {
    const { seams, calls } = fakeSeams()
    const acts = plan({ what: 'note', deskId: 'd2', cwd: 'C:/p', front: true }, { deskId: 'd2' })
    const run = await runPlan(acts, createRunner(acts, seams).exec)
    assert.equal(run.ok, true)
    assert.deepEqual(calls, [['item', { deskId: 'd2', itemId: 'note-new', cwd: 'C:/p', front: true }]])
  })

  test('a browser tab for the person: her tab on the desk, the pane id of the tab', async () => {
    const { seams, calls } = fakeSeams()
    const acts = plan({ what: 'browser', deskId: 'd2', url: 'https://a.test' })
    const run = await runPlan(acts, createRunner(acts, seams).exec)
    assert.deepEqual(calls, [['tab', { deskId: 'd2', url: 'https://a.test' }]])
    assert.deepEqual(run.announce, { paneId: 'web:t1', deskId: 'd2' })
  })

  test('a browser tab for an agent is born the agent\'s: no give after it', async () => {
    const { seams, calls } = fakeSeams()
    const acts = plan({ what: 'browser', deskId: 'd2', browserFor: 'a7' })
    assert.deepEqual(acts.map(a => a.act), ['browser', 'give'], 'the plan has the give')
    const run = await runPlan(acts, createRunner(acts, seams).exec)
    assert.equal(run.ok, true)
    assert.deepEqual(calls, [['tabFor', { agent: 'a7', deskId: 'd2' }]], 'born the agent\'s, the give not asked again')
    assert.equal(run.done, 2)
  })

  test('a channel with two agents: created, joined, shown in the centre; a refusal is a warning', async () => {
    const { seams, calls } = fakeSeams({ joinRefuses: 'a2' })
    const acts = plan({ what: 'channel', channel: { name: '#Revisao-1', members: ['a1', 'a2'] } })
    const run = await runPlan(acts, createRunner(acts, seams).exec)
    assert.equal(run.ok, true)
    assert.deepEqual(calls.map(c => c[0]), ['channel', 'join', 'join', 'show'])
    assert.deepEqual(calls[3]![1], { channelId: 'ch1' })
    assert.equal(run.channelId, 'ch1')
    assert.match(run.text ?? '', /Não entraram no canal: bancada \(já saiu\)/)
  })

  test('"Dar uma mesa nova": the desk, then the give of it; with "levar", the move', async () => {
    const { seams, calls } = fakeSeams()
    const acts = plan({ what: 'desk-for', newDesk: { name: 'Prova-web' }, giveDesk: true, movePane: true }, { forAgent: 'a1', forName: 'conferente' })
    const runner = createRunner(acts, seams)
    const run = await runPlan(acts, runner.exec)
    assert.equal(run.ok, true)
    assert.deepEqual(calls, [['desk', { name: 'Prova-web' }], ['give', { kind: 'desk', id: 'new-desk-1', to: 'a1' }], ['move', { pane: 'a1', deskId: 'new-desk-1' }]])
    assert.equal(runner.made.deskId, 'new-desk-1')
  })

  test('a failure in the middle: what was made stays, the sentence says up to where it went', async () => {
    const { seams, calls } = fakeSeams({ slotError: 'a pasta não existe' })
    const acts = plan({ what: 'terminal', deskId: NEW_DESK, newDesk: { name: 'Prova' }, cwd: 'C:/nada' })
    const runner = createRunner(acts, seams)
    const run = await runPlan(acts, runner.exec)
    assert.equal(run.ok, false)
    assert.deepEqual(calls.map(c => c[0]), ['desk', 'slot'])
    assert.equal(run.text, 'Criei a mesa «Prova». Mas não consegui criar o terminal: a pasta não existe. O que já foi feito ficou.')
    assert.deepEqual(runner.made, { deskId: 'new-desk-1' }, 'the desk made is still lit')
  })

  test('a give the tether does not take: the desk stays the person\'s, said', async () => {
    const { seams } = fakeSeams({ giveError: 'o tether não confirmou a posse' })
    const acts = plan({ what: 'desk-for', newDesk: { name: 'Prova-web' }, giveDesk: true }, { forAgent: 'a1', forName: 'conferente' })
    const run = await runPlan(acts, createRunner(acts, seams).exec)
    assert.equal(run.ok, false)
    assert.equal(run.text, 'Criei a mesa «Prova-web». Mas não consegui dar a mesa a conferente: o tether não confirmou a posse. A mesa «Prova-web» ficou com você.')
  })

  test('the browser\'s refusals in plain words; a cancelled note is a failure', async () => {
    const { seams } = fakeSeams({ tabRefuses: 'no-browser', itemCancels: true })
    let acts = plan({ what: 'browser', deskId: 'd2' })
    let run = await runPlan(acts, createRunner(acts, seams).exec)
    assert.equal(run.text, 'Não consegui abrir o navegador: o navegador está desligado. Nada foi criado.')
    acts = plan({ what: 'note', deskId: 'd2', cwd: 'C:/p' })
    run = await runPlan(acts, createRunner(acts, seams).exec)
    assert.equal(run.text, 'Não consegui criar a nota: a criação foi cancelada. Nada foi criado.')
  })

  test('the field a sentence of validation goes beside', () => {
    assert.equal(errorField('Escolha o agente: o motor e o perfil.'), 'what')
    assert.equal(errorField('Dê um nome à mesa nova.'), 'desk-name')
    assert.equal(errorField('Essa mesa está dormindo: acorde-a antes de criar nela.'), 'desk')
    assert.equal(errorField('Escolha a pasta de trabalho.'), 'cwd')
    assert.equal(errorField('Esse canal não está mais aberto.'), 'join')
    assert.equal(errorField('Já existe um canal aberto com esse nome.'), 'channel-name')
    assert.equal(errorField('O endereço não pode ter espaços.'), 'url')
  })
})

interface FakeOpts { slotError?: string; giveError?: string; joinRefuses?: string; tabRefuses?: 'no-browser'; itemCancels?: boolean }

function fakeSeams(o: FakeOpts = {}): { seams: CreateSeams; calls: [string, unknown][] } {
  const calls: [string, unknown][] = []
  let desks = 0
  let panes = 0
  const seams: CreateSeams = {
    slot: async spec => { calls.push(['slot', spec]); return o.slotError ? { error: o.slotError } : { paneId: `p${++panes}`, deskId: spec.deskId } },
    item: async spec => { calls.push(['item', spec]); return o.itemCancels ? undefined : { paneId: `p${++panes}`, deskId: spec.deskId } },
    desk: spec => { calls.push(['desk', spec]); return `new-desk-${++desks}` },
    tab: async opts => { calls.push(['tab', opts]); return o.tabRefuses ? { ok: false, why: o.tabRefuses } : { ok: true, tabId: 't1' } },
    tabFor: async (agent, opts) => { calls.push(['tabFor', { agent, ...opts }]); return { ok: true, tabId: 't2' } },
    tabPane: tabId => `web:${tabId}`,
    channel: async name => { calls.push(['channel', { name }]); return { ok: true, id: 'ch1' } },
    join: async (channelId, agent) => { calls.push(['join', { channelId, agent }]); return agent === o.joinRefuses ? { refusal: 'já saiu.' } : { ok: true } },
    show: channelId => { calls.push(['show', { channelId }]) },
    give: async (kind, id, to) => { calls.push(['give', { kind, id, to }]); return o.giveError },
    move: (pane, deskId) => { calls.push(['move', { pane, deskId }]); return true },
    nameOf: id => (id === 'a2' ? 'bancada' : id),
  }
  return { seams, calls }
}
