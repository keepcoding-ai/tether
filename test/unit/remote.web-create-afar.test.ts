// "+ Novo" from afar (RR5 5.3), the pure rules of the web: the tiles by the device's scopes, the choices of
// `create.options` as the app's card reads them, and the card's plan (the app's own planOf) as the portal's ops, with the
// ceilings checked before anything goes and never a path.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { advance, NEW_DESK, patchDraft, planOf, startCreate, stepsOf, type CreateAct, type CreateState } from '../../extensions/regency/create-rules.ts'
import { callsOf, callsWith, createsAny, defaultFolderOf, foldersOf, itemsOf, profileIdOf, profileOfId, tilesOf, unsafeChoice } from '../../remote/web/src/create-afar-rules.ts'
import { capsOf, NO_CAPS, refusalWords, unrestrictedAgentQuestion } from '../../remote/web/src/manage-rules.ts'
import type { CreateOptions } from '../../src/remote/create.ts'

const F1 = '0123456789abcdef'
const F2 = 'fedcba9876543210'
const options: CreateOptions = {
  engines: ['claude', 'shell'],
  profiles: [{ name: 'Claude', engine: 'claude', default: true }, { name: 'pwsh', engine: 'shell', default: true }],
  desks: [{ deskId: 'd1', name: 'Obra' }],
  folders: [{ id: F2, label: 'antiga', kind: 'recent' }, { id: F1, label: 'obra', kind: 'project' }],
}
const desks = { desks: [{ id: 'd1', name: 'Obra', color: 'blue', kind: 'queue' as const, asleep: false, panes: [] }, { id: 'd2', name: 'Sono', color: 'green', kind: 'queue' as const, asleep: true, panes: [] }] }

describe('the tiles by the device\'s scopes (nothing that would be refused shows)', () => {
  test('an agent is manage:agents; a pane and a desk manage:desks; a channel the channels\' scope', () => {
    assert.deepEqual(tilesOf(NO_CAPS), [])
    assert.equal(createsAny(NO_CAPS), false)
    assert.deepEqual(tilesOf(capsOf(['manage:agents'], true)), ['agent'])
    assert.deepEqual(tilesOf(capsOf(['manage:desks'], true)), ['terminal', 'note', 'browser', 'desk'])
    assert.deepEqual(tilesOf(capsOf(['channels'], true)), ['channel'])
    assert.deepEqual(tilesOf(capsOf(['manage:agents', 'manage:desks', 'channels'], false)), [], 'without a presence credential, nothing')
  })
})

describe('the choices of create.options as the card reads them', () => {
  test('profiles are the card\'s items by engine; folders by id and label, projects first; never a path', () => {
    const items = itemsOf(options)
    assert.deepEqual(items.map(i => [i.name, i.engine, i.default === true]), [['Claude', 'claude', true], ['pwsh', 'shell', true]])
    assert.deepEqual(profileOfId(items[0]!.id), { engine: 'claude', name: 'Claude' })
    assert.equal(profileOfId('nada'), undefined)
    assert.deepEqual(foldersOf(options), [{ value: F1, label: 'obra', recent: false }, { value: F2, label: 'antiga', recent: true }])
    assert.equal(defaultFolderOf(options), F1)
  })
})

describe('the steps of the card from afar (the app\'s rules)', () => {
  const ctx = { desks, channels: [] }
  test('a desk row\'s "+" drops "Onde"; a sleeping desk says to wake it first', () => {
    const fromRow = startCreate({ deskId: 'd1' })
    assert.deepEqual(stepsOf(fromRow.draft, fromRow.fixed), ['what', 'details'])
    let s: CreateState = patchDraft(startCreate({ deskId: 'd2' }), { what: 'terminal', kind: 'shell', cwd: F1 })
    s = advance(s, ctx)
    s = advance(s, ctx)
    assert.equal(s.error, 'Essa mesa está hibernando: desperte-a antes de criar nela.')
  })

  test('without a folder the details step stops with the app\'s sentence', () => {
    let s: CreateState = patchDraft(startCreate({ deskId: 'd1' }), { what: 'terminal', kind: 'shell' })
    s = advance(advance(s, ctx), ctx)
    assert.equal(s.error, 'Escolha a pasta de trabalho.')
  })
})

describe('the plan as the portal\'s ops', () => {
  const ctx = { desks, channels: [] }
  const ready = (s: CreateState): CreateState => ({ ...s, outcome: 'ready' })

  test('a terminal in a desk: create.terminal with the folder\'s id, the profile by name, the name the card gives', () => {
    const s = ready(patchDraft(startCreate({ deskId: 'd1' }), { what: 'terminal', kind: 'shell', profileId: profileIdOf('shell', 'pwsh'), cwd: F1 }))
    const acts = planOf(s, ctx)
    assert.deepEqual(acts.flatMap(callsOf), [{ op: 'create.terminal', body: { deskId: 'd1', folder: F1, profile: 'pwsh', name: 'Terminal 1' } }])
  })

  test('an agent in a new desk that joins a channel: the desk, the agent (with the ref of the desk), the join', () => {
    const channels = [{ id: 'c1', name: 'obra', title: '', owner: { kind: 'user' as const }, members: 0, seenByUser: 0, createdAt: '' }]
    const s = ready(patchDraft(startCreate(), {
      what: 'agent', kind: 'claude', profileId: profileIdOf('claude', 'Claude'), profileName: 'Claude', cwd: F1, deskId: NEW_DESK,
      newDesk: { name: 'Nova', color: 'teal' }, joinChannel: 'c1',
    }))
    const calls = planOf(s, { desks, channels }).flatMap(callsOf)
    assert.deepEqual(calls, [
      { op: 'desks.create', body: { name: 'Nova', color: 'teal' } },
      { op: 'create.agent', body: { engine: 'claude', deskId: '$desk', folder: F1, profile: 'Claude', name: 'Claude' } },
      { op: 'channels.join', body: { channel: 'c1', agent: '$pane' } },
    ])
  })

  test('a channel with two agents: create, then one join each; the centre is shown by the screen', () => {
    const s = ready(patchDraft(startCreate({}, 'channel'), { channel: { name: '#Revisao', members: ['a1', 'a2'] } }))
    const acts = planOf(s, ctx)
    assert.deepEqual(acts.map(a => a.act), ['channel', 'join', 'show'])
    assert.deepEqual(acts.slice(0, 2).flatMap(callsOf), [
      { op: 'channels.create', body: { name: 'revisao' } },
      { op: 'channels.join', body: { channel: '$channel', agent: 'a1' } },
      { op: 'channels.join', body: { channel: '$channel', agent: 'a2' } },
    ])
  })

  test('a note and a browser tab: the app\'s own (the bridge), by the desk; the tab has no address from afar', () => {
    const note = ready(patchDraft(startCreate({ deskId: 'd1' }), { what: 'note', cwd: F1 }))
    assert.deepEqual(planOf(note, ctx).flatMap(callsOf), [{ op: 'create.note', body: { deskId: 'd1', folder: F1 } }])
    const tab = ready(patchDraft(startCreate({ deskId: 'd1' }), { what: 'browser', url: 'https://x.y' }))
    assert.deepEqual(planOf(tab, ctx).flatMap(callsOf), [{ op: 'create.browser', body: { deskId: 'd1' } }])
  })

  test('the ceilings before anything goes: a path is never a folder, a name past 64 is refused here', () => {
    const path = ready(patchDraft(startCreate({ deskId: 'd1' }), { what: 'terminal', kind: 'shell', cwd: 'C:\\obra' }))
    assert.deepEqual(planOf(path, ctx).flatMap(callsOf), [{ error: 'Escolha a pasta na lista do tether' }])
    const long = ready(patchDraft(startCreate({ deskId: 'd1' }), { what: 'terminal', kind: 'shell', cwd: F1, name: 'x'.repeat(65) }))
    assert.deepEqual(planOf(long, ctx).flatMap(callsOf), [{ error: 'O nome passa de 64 letras' }])
  })
})

describe('RR5 M-3: a profile "sem restrições" from afar', () => {
  const o: CreateOptions = {
    ...options,
    profiles: [{ name: 'Claude', engine: 'claude', default: true }, { name: 'Claude modo dev', engine: 'claude', unsafe: true }, { name: 'pwsh', engine: 'shell', default: true }],
  }
  const slot = (profile?: string): CreateAct => ({ act: 'slot', runs: 'tetherd', doing: '', done: '', deskId: 'd1', kind: 'claude', cwd: F1, front: false, ...(profile ? { profileId: profileIdOf('claude', profile) } : {}) } as CreateAct)

  test('the card\'s item carries the mark; the act is its own op, the common one for the others and for the safe default', () => {
    assert.deepEqual(itemsOf(o).filter(i => i.unsafe).map(i => i.name), ['Claude modo dev'])
    assert.equal(unsafeChoice(o, 'claude', 'Claude modo dev'), true)
    assert.equal(unsafeChoice(o, 'claude', undefined), false, 'no profile: the default, safe here')
    assert.equal(unsafeChoice({ ...o, profiles: [{ name: 'Claude modo dev', engine: 'claude', default: true, unsafe: true }] }, 'claude', undefined), true, 'the default made unsafe')
    assert.deepEqual(callsWith(slot('Claude modo dev'), o), [{ op: 'create.agent-unrestricted', body: { engine: 'claude', deskId: 'd1', folder: F1, profile: 'Claude modo dev' } }])
    assert.deepEqual(callsWith(slot('Claude'), o).map(c => 'op' in c && c.op), ['create.agent'])
    assert.deepEqual(callsWith(slot(), o).map(c => 'op' in c && c.op), ['create.agent'])
  })

  test('the question before the biometrics says the agent is born without asking permission', () => {
    const q = unrestrictedAgentQuestion('Claude modo dev')
    assert.match(q.title, /sem restrições/)
    assert.match(q.lead ?? '', /nasce sem pedir permissão/)
    assert.equal(q.choices[0]!.proof, true)
    assert.match(refusalWords('unsafe-profile'), /biometria/)
  })
})
