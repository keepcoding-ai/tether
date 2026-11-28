// RR5 step 5.3 (fio-spec 18): "+ Novo" from afar. Proved here:
// - folderId / knownFolders (src/remote/create.ts): one opaque id per folder, the same for any spelling of it on a
//   case-insensitive disk, projects before recent ones, once each;
// - createSlotArgs / parseCreateSlot: the portal builds the act from the strict body (an engine, a profile by name, a desk by
//   id, a folder by id, a pane's name folded), and tetherd takes only that form;
// - tetherd's Creator (extensions/regency/daemon.ts): the choices without a path for the device to see but the portal's,
//   without a profile's env; the creation resolves the folder id against the list read now, the profile's name within its
//   engine and the desk of the queue, refuses each stale choice by its code, and takes the act from the portal alone;
// - the ActBridge confers a note's folder before the app is asked; the app's half makes a note in the folder its own list
//   has under that id and a tab of the person's, both behind, and says the pane's id.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { ActBridge, Creator, type CreateDeps } from '../../extensions/regency/daemon.ts'
import { remoteActRunner, type RemoteActsUi } from '../../extensions/regency/renderer/remote-acts.ts'
import { appActArgs, parseAppAct } from '../../src/remote/app-acts.ts'
import { createOptionsView, createSlotArgs, folderId, knownFolders, parseCreateSlot } from '../../src/remote/create.ts'

const MARKER = 'canaryCreate7f3a'
const code = (c: string) => (e: unknown): boolean => (e as { code?: string }).code === c
const remote = { client: 'remote' }

describe('folders by id, never by path', () => {
  test('one id per folder: the same for another spelling on a case-insensitive disk, different where case counts', () => {
    const a = folderId('C:\\Projetos\\Obra', true)
    assert.match(a, /^[0-9a-f]{16}$/)
    assert.equal(folderId('c:/projetos/obra/', true), a)
    assert.notEqual(folderId('/home/x/Obra', false), folderId('/home/x/obra', false))
    assert.notEqual(folderId('C:\\Projetos\\Obra2', true), a)
  })

  test('projects first (pinned, then of the agents), then the recent ones, once each, labelled by the last segment', () => {
    const f = knownFolders({ pinned: ['C:\\p\\obra'], agents: ['c:/p/obra', 'C:\\p\\casa'], recent: ['C:\\p\\CASA', 'D:\\velho\\'] }, true)
    assert.deepEqual(f.map((x) => [x.label, x.kind]), [['obra', 'project'], ['casa', 'project'], ['velho', 'recent']])
  })
})

describe('the act of creating a slot: built by the portal, taken by tetherd in that form only', () => {
  const folder = folderId('C:\\p\\obra', true)
  test('an agent: engine, profile by name, desk and folder by id, the pane\'s name folded; a terminal is the shell', () => {
    assert.deepEqual(createSlotArgs('create.agent', { engine: 'claude', profile: ' Claude ', deskId: 'desk-1', folder, name: 'revisor\u202E' }), {
      args: { what: 'agent', engine: 'claude', deskId: 'desk-1', folder, profile: 'Claude', name: 'revisor' }, target: 'desk-1',
    })
    assert.deepEqual(createSlotArgs('create.terminal', { deskId: 'desk-1', folder }), { args: { what: 'terminal', engine: 'shell', deskId: 'desk-1', folder }, target: 'desk-1' })
    for (const b of [
      { engine: 'shell', deskId: 'desk-1', folder }, { engine: 'Claude!', deskId: 'desk-1', folder }, { engine: 'claude', deskId: '../d', folder },
      { engine: 'claude', deskId: 'desk-1', folder: 'C:\\p\\obra' }, { engine: 'claude', deskId: 'desk-1', folder: folder.toUpperCase() },
      { engine: 'claude', deskId: 'desk-1', folder, name: 7 },
    ]) assert.equal(createSlotArgs('create.agent', b), 'bad-request', JSON.stringify(b))
    assert.equal(createSlotArgs('create.agent', { engine: 'claude', deskId: 'desk-1', folder, name: 'n'.repeat(65) }), 'too-long')
  })

  test('tetherd takes the act as built and nothing else: no path, no other field, a name in its folded form', () => {
    const built = createSlotArgs('create.agent', { engine: 'claude', deskId: 'desk-1', folder, name: 'revisor' })
    assert.ok(typeof built !== 'string')
    assert.deepEqual(parseCreateSlot(built.args), built.args)
    for (const v of [
      { ...built.args, cwd: 'C:\\' }, { ...built.args, args: ['--x'] }, { ...built.args, name: ' revisor ' }, { ...built.args, what: 'note' },
      { what: 'terminal', engine: 'claude', deskId: 'desk-1', folder }, undefined, [], 'x',
    ]) assert.equal(parseCreateSlot(v), undefined, JSON.stringify(v))
  })

  test('a note and a tab go to the app with ids only; a folder is its id', () => {
    assert.deepEqual(appActArgs('create.note', { deskId: 'desk-1', folder }), { args: { act: 'create.note', deskId: 'desk-1', folder }, target: 'desk-1' })
    assert.deepEqual(appActArgs('create.browser', { deskId: 'desk-1' }), { args: { act: 'create.browser', deskId: 'desk-1' }, target: 'desk-1' })
    assert.equal(appActArgs('create.note', { deskId: 'desk-1', folder: 'C:\\p' }), 'bad-request')
    assert.equal(parseAppAct({ act: 'create.note', deskId: 'desk-1', folder, cwd: 'C:\\' }), undefined)
    assert.equal(parseAppAct({ act: 'create.browser', deskId: 'desk-1', url: 'http://localhost:1' }), undefined)
  })
})

function creatorBench(over: Partial<CreateDeps> = {}) {
  const created: unknown[] = []
  const desks = [
    { id: 'desk-1', name: 'Obra', kind: 'queue' as const, panes: [] },
    { id: 'desk-2', name: 'Dorme', kind: 'queue' as const, asleep: true as const, panes: [] },
    { id: 'regency.main', name: 'Regência', kind: 'system' as const, panes: [] },
  ]
  const profiles = [
    { id: 'claude', name: 'Claude', agent: 'claude', env: { KEY: MARKER } },
    { id: 'claude-2', name: 'Claude rápido', agent: 'claude' },
    { id: 'bash', name: 'Git Bash', agent: 'shell' },
    { id: 'old', name: 'Velho', agent: 'gone' },
  ]
  const deps: CreateDeps = {
    map: () => ({ desks, drawer: [] }),
    slots: {
      list: () => [{ slotId: 's_1', kind: 'claude', cwd: 'C:\\p\\agente', folder: 'C:\\p\\agente' } as never, { slotId: 's_2', kind: 'shell', cwd: 'C:\\shell' } as never],
      create: async (input) => { created.push(input); return { slotId: 's_new' } as never },
    },
    engines: async () => ['claude', 'codex'],
    profiles: async () => profiles,
    defaultFor: (e) => (e === 'claude' ? profiles[0] : e === 'codex' ? { id: 'codex', name: 'Codex', agent: 'codex' } : e === 'shell' ? profiles[2] : undefined),
    appFolders: async () => ({ pinned: ['C:\\p\\obra'], recent: ['C:\\p\\recente', 'C:\\p\\obra'] }),
    exists: async (p) => !p.endsWith('sumiu'),
    caseInsensitive: true,
    ...over,
  }
  return { creator: new Creator(deps), created }
}

describe("tetherd's Creator", () => {
  test('the choices: engines, profiles by name and engine (never env), queue desks, folders with their path for the portal', async () => {
    const { creator } = creatorBench()
    const o = await creator.options()
    assert.deepEqual(o.engines, ['claude', 'codex', 'shell'])
    assert.deepEqual(o.profiles, [
      { name: 'Claude', engine: 'claude', default: true }, { name: 'Claude rápido', engine: 'claude' }, { name: 'Git Bash', engine: 'shell', default: true },
      { name: 'Codex', engine: 'codex', default: true },
    ])
    assert.deepEqual(o.desks, [{ deskId: 'desk-1', name: 'Obra' }, { deskId: 'desk-2', name: 'Dorme', asleep: true }])
    assert.deepEqual(o.folders.map((f) => [f.label, f.kind, f.path]), [['obra', 'project', 'C:\\p\\obra'], ['agente', 'project', 'C:\\p\\agente'], ['recente', 'recent', 'C:\\p\\recente']])
    assert.equal(JSON.stringify(o).includes(MARKER), false)
    const view = createOptionsView(o)
    assert.equal(JSON.stringify(view).includes('C:'), false, 'the device view has no path')
    assert.deepEqual(view.folders[0], { id: folderId('C:\\p\\obra', true), label: 'obra', kind: 'project' })
  })

  test('an agent is born in the desk, in the folder of the id, with the profile of that name, started', async () => {
    const { creator, created } = creatorBench()
    const folder = folderId('C:\\p\\obra', true)
    assert.deepEqual(await creator.create({ what: 'agent', engine: 'claude', profile: 'Claude rápido', deskId: 'desk-1', folder, name: 'revisor' }, remote), { slotId: 's_new' })
    assert.deepEqual(await creator.create({ what: 'terminal', engine: 'shell', deskId: 'desk-1', folder: folderId('C:\\p\\recente', true) }, remote), { slotId: 's_new' })
    assert.deepEqual(created, [
      { kind: 'claude', cwd: 'C:\\p\\obra', profileId: 'claude-2', name: 'revisor', desk: 'desk-1', start: true },
      { kind: 'shell', cwd: 'C:\\p\\recente', profileId: 'bash', desk: 'desk-1', start: true },
    ])
  })

  test('each stale or foreign choice is refused by its code, before anything is created; only the portal may ask', async () => {
    const { creator, created } = creatorBench()
    const folder = folderId('C:\\p\\obra', true)
    const ok = { what: 'agent', engine: 'claude', deskId: 'desk-1', folder }
    await assert.rejects(creator.create({ ...ok, folder: folderId('C:\\Windows', true) }, remote), code('unknown-folder'))
    await assert.rejects(creator.create({ ...ok, deskId: 'desk-9' }, remote), code('unknown-desk'))
    await assert.rejects(creator.create({ ...ok, deskId: 'regency.main' }, remote), code('unknown-desk'), 'a system desk is no target')
    await assert.rejects(creator.create({ ...ok, deskId: 'desk-2' }, remote), code('desk-asleep'))
    await assert.rejects(creator.create({ ...ok, profile: 'Git Bash' }, remote), code('unknown-profile'), 'a profile of another engine')
    await assert.rejects(creator.create({ ...ok, engine: 'gone' }, remote), code('unknown-engine'))
    await assert.rejects(creator.create({ ...ok, cwd: 'C:\\' }, remote), code('bad-request'))
    for (const client of ['app', 'cli', 'test']) await assert.rejects(creator.create(ok, { client }), code('door-denied'), client)
    assert.deepEqual(created, [])
    const gone = creatorBench({ appFolders: async () => ({ pinned: ['C:\\p\\sumiu'], recent: [] }) })
    await assert.rejects(gone.creator.create({ ...ok, folder: folderId('C:\\p\\sumiu', true) }, remote), code('cwd-missing'))
    const failing = creatorBench({ slots: { list: () => [], create: async () => { throw Object.assign(new Error(MARKER), { code: 'spawn-failed' }) } } })
    await assert.rejects(failing.creator.create(ok, remote), (e: unknown) => code('spawn-failed')(e) && !String((e as Error).message).includes(MARKER))
  })
})

describe('a note and a tab: tetherd confers, the app makes them behind', () => {
  test('the bridge refuses a note in a folder outside its list before the app is asked', async () => {
    const emitted: unknown[] = []
    const bridge = new ActBridge({
      map: () => ({ desks: [{ id: 'desk-1', name: 'Obra', kind: 'queue', panes: [] }], drawer: [] }),
      slots: { get: () => undefined, userFree: () => true, start: async () => ({}) as never },
      app: () => ({ live: true }), emit: (_n, p) => { emitted.push(p) }, ackMs: 20,
      folderKnown: async (id) => id === folderId('C:\\p\\obra', true),
    })
    await assert.rejects(bridge.act({ act: 'create.note', deskId: 'desk-1', folder: folderId('C:\\outra', true) }, remote), code('unknown-folder'))
    await assert.rejects(bridge.act({ act: 'create.browser', deskId: 'desk-9' }, remote), code('unknown-desk'))
    assert.deepEqual(emitted, [])
    await assert.rejects(bridge.act({ act: 'create.note', deskId: 'desk-1', folder: folderId('C:\\p\\obra', true) }, remote), code('no-app'), 'asked, nobody took it')
    assert.equal(emitted.length, 1)
  })

  test('the app makes the note in the folder its own list has under that id, the tab of the person, and says the pane', async () => {
    const calls: unknown[] = []
    const ui = {
      desks: { list: () => [{ id: 'desk-1', name: 'Obra', color: 'blue', asleep: false, panes: [] }, { id: 'desk-2', name: 'Dorme', color: 'red', asleep: true, panes: [] }], activeId: () => 'desk-1', tree: () => ({ desks: [] }) },
    } as unknown as RemoteActsUi
    const run = remoteActRunner(ui, {
      owners: {} as never, notice: () => {},
      create: {
        note: async (spec) => { calls.push(['note', spec]); return { paneId: 'note-7', deskId: spec.deskId } as never },
        tab: async (deskId) => { calls.push(['tab', deskId]); return { paneId: 'web:t1' } },
        folders: async () => ['C:\\p\\obra', 'C:\\p\\recente'],
        caseInsensitive: true,
      },
    })
    assert.deepEqual(await run({ act: 'create.note', deskId: 'desk-1', folder: folderId('c:/p/obra', true) }), { ok: true, state: 'done', said: 'nota criada na mesa Obra', paneId: 'note-7' })
    assert.deepEqual(await run({ act: 'create.browser', deskId: 'desk-1' }), { ok: true, state: 'done', said: 'aba aberta na mesa Obra', paneId: 'web:t1' })
    assert.deepEqual(await run({ act: 'create.note', deskId: 'desk-1', folder: folderId('C:\\outra', true) }), { ok: false, code: 'unknown-folder' })
    assert.deepEqual(await run({ act: 'create.browser', deskId: 'desk-2' }), { ok: false, code: 'cannot' }, 'a hibernating desk')
    assert.deepEqual(await run({ act: 'create.browser', deskId: 'desk-9' }), { ok: false, code: 'unknown-desk' })
    assert.deepEqual(calls, [['note', { deskId: 'desk-1', cwd: 'C:\\p\\obra' }], ['tab', 'desk-1']])
  })
})

describe('RR5 M-3: a profile "sem restrições" from afar', () => {
  const folder = folderId('C:\\p\\obra', true)
  const dev = { id: 'claude-dev', name: 'Claude modo dev', agent: 'claude', args: ['--dangerously-skip-permissions'] }
  const safe = { id: 'claude', name: 'Claude', agent: 'claude', args: [] }
  const bench = (defaultId: string) => creatorBench({
    profiles: async () => [safe, dev],
    defaultFor: (e) => (e === 'claude' ? [safe, dev].find((p) => p.id === defaultId) : undefined),
  })

  test('create.options marks it unsafe, as the app badges it; never its args', async () => {
    const { creator } = bench('claude')
    const o = await creator.options()
    assert.deepEqual(o.profiles.filter((p) => p.engine === 'claude'), [{ name: 'Claude', engine: 'claude', default: true }, { name: 'Claude modo dev', engine: 'claude', unsafe: true }])
    assert.equal(JSON.stringify(o).includes('dangerously'), false)
    assert.deepEqual(createOptionsView(o).profiles.find((p) => p.name === 'Claude modo dev'), { name: 'Claude modo dev', engine: 'claude', unsafe: true }, 'the device sees the mark')
  })

  test('by create.agent: unsafe-profile, nothing created; by its own op (unrestricted): created', async () => {
    const { creator, created } = bench('claude')
    const ok = { what: 'agent', engine: 'claude', deskId: 'desk-1', folder, profile: 'Claude modo dev' }
    await assert.rejects(creator.create(ok, remote), code('unsafe-profile'))
    assert.deepEqual(created, [])
    assert.deepEqual(await creator.create({ ...ok, unrestricted: true }, remote), { slotId: 's_new' })
    assert.equal((created[0] as unknown as { profileId: string }).profileId, 'claude-dev')
    assert.deepEqual(await creator.create({ ...ok, profile: 'Claude' }, remote), { slotId: 's_new' }, 'a safe profile by the common op')
  })

  test('no profile named: the engine\'s default as the app opens it; "Claude modo dev" made the default is unsafe', async () => {
    const devDefault = bench('claude-dev')
    const none = { what: 'agent', engine: 'claude', deskId: 'desk-1', folder }
    await assert.rejects(devDefault.creator.create(none, remote), code('unsafe-profile'))
    assert.deepEqual(devDefault.created, [])
    assert.deepEqual(await devDefault.creator.create({ ...none, unrestricted: true }, remote), { slotId: 's_new' })
    assert.deepEqual(await bench('claude').creator.create(none, remote), { slotId: 's_new' }, 'the safe default needs nothing more')
  })

  test('the act: `unrestricted` only from its op, only for an agent, only `true`', () => {
    assert.deepEqual(createSlotArgs('create.agent-unrestricted', { engine: 'claude', deskId: 'desk-1', folder }), { args: { what: 'agent', unrestricted: true, engine: 'claude', deskId: 'desk-1', folder }, target: 'desk-1' })
    assert.deepEqual(parseCreateSlot({ what: 'agent', unrestricted: true, engine: 'claude', deskId: 'desk-1', folder }), { what: 'agent', unrestricted: true, engine: 'claude', deskId: 'desk-1', folder })
    for (const v of [
      { what: 'agent', unrestricted: 'yes', engine: 'claude', deskId: 'desk-1', folder }, { what: 'agent', unrestricted: false, engine: 'claude', deskId: 'desk-1', folder },
      { what: 'terminal', unrestricted: true, engine: 'shell', deskId: 'desk-1', folder },
    ]) assert.equal(parseCreateSlot(v), undefined, JSON.stringify(v))
  })
})
