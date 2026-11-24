import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { after, before, describe, test } from 'node:test'
import type { SlotMeta } from '../../src/core/event.ts'
import type { Profile } from '../../src/core/profile.ts'
import { createSyncEngine, type ApplyPlan, type SyncEngine, type Working } from '../../src/core/sync/engine.ts'
import { readPlaceMap, writePlaceMap } from '../../src/core/sync/places.ts'
import type { PullConflict, SyncProvider } from '../../src/core/sync/provider.ts'
import { createGitProvider } from '../../src/core/sync/providers/git.ts'

let root: string
let seq = 0
before(() => { root = mkdtempSync(join(tmpdir(), 'tether-sync-engine-')) })
after(() => { rmSync(root, { recursive: true, force: true }) })

// ---- files ------------------------------------------------------------------------------------------------------

/** Every file under `dir` ('/' separators), skipping `.git`. */
function scan(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (d: string): void => {
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name === '.git') continue
      const full = join(d, e.name)
      if (e.isDirectory()) walk(full)
      else out.set(relative(dir, full).split('\\').join('/'), readFileSync(full, 'utf8'))
    }
  }
  walk(dir)
  return out
}

function mtimes(dir: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const rel of scan(dir).keys()) out.set(rel, statSync(join(dir, ...rel.split('/'))).mtimeMs)
  return out
}

function put(dir: string, rel: string, text: string): void {
  const file = join(dir, ...rel.split('/'))
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

// ---- an in-memory remote with a git-like provider over the folder ------------------------------------------------

interface Remote { files: Map<string, string>; version: number; commits: number }
const newRemote = (): Remote => ({ files: new Map(), version: 0, commits: 0 })

interface FakeProvider extends SyncProvider {
  calls: string[]
  active: number
  maxActive: number
  beforePush?: () => Promise<void> | void
  gate?: Promise<void>
}

function fakeProvider(dir: string, remote: Remote): FakeProvider {
  let synced = new Map<string, string>() // the folder as of the last pull/push
  let seen = -1 // remote version this machine merged
  let linked = false
  const enter = async (p: FakeProvider, name: string): Promise<void> => {
    p.calls.push(name)
    p.active++
    p.maxActive = Math.max(p.maxActive, p.active)
    await new Promise((r) => setTimeout(r, 2))
    if (p.gate) await p.gate
  }
  const p: FakeProvider = {
    kind: 'fake',
    calls: [],
    active: 0,
    maxActive: 0,
    async connect() {
      await enter(p, 'connect')
      linked = true
      p.active--
      return { remoteEmpty: remote.version === 0 }
    },
    async pull() {
      await enter(p, 'pull')
      try {
        const local = scan(dir)
        const changed: string[] = []
        const conflicts: PullConflict[] = []
        if (seen !== remote.version) {
          for (const path of new Set([...remote.files.keys(), ...synced.keys()])) {
            const theirs = remote.files.get(path)
            if (theirs === synced.get(path)) continue // the remote did not change it
            const mine = local.get(path)
            if (mine !== synced.get(path) && mine !== theirs) conflicts.push({ path, trashed: mine !== undefined })
            if (mine === theirs) continue
            if (theirs === undefined) rmSync(join(dir, ...path.split('/')), { force: true })
            else put(dir, path, theirs)
            changed.push(path)
          }
          synced = new Map(remote.files) // local changes that did not collide stay pending for the push
          seen = remote.version
        }
        return { changed: changed.sort(), conflicts }
      } finally { p.active-- }
    },
    async push() {
      await enter(p, 'push')
      try {
        if (p.beforePush) { const hook = p.beforePush; p.beforePush = undefined; await hook() }
        const local = scan(dir)
        const same = local.size === synced.size && [...local].every(([k, v]) => synced.get(k) === v)
        if (same && seen === remote.version) return { pushed: false }
        if (seen !== remote.version) return { pushed: false, reason: 'behind' as const }
        remote.files = new Map(local)
        remote.version++
        remote.commits++
        synced = new Map(local)
        seen = remote.version
        return { pushed: true }
      } finally { p.active-- }
    },
    async status() {
      return { connected: linked, dirty: 0, ahead: 0, behind: 0 }
    },
    async disconnect() { linked = false },
  }
  return p
}

// ---- a machine: folder, home, working files in memory ----------------------------------------------------------

interface Machine {
  name: string
  dir: string
  home: string
  user: string
  work: Working
  plans: ApplyPlan[]
  reads: number
  engine: SyncEngine
  provider: SyncProvider
}

function emptyWork(): Working {
  return { profiles: [], layout: { v: 4, desks: [], activeDesk: '' }, slots: [], settings: { theme: 'dark' }, keybindings: undefined }
}

function machine(name: string, makeProvider: (dir: string) => SyncProvider, work: Working = emptyWork()): Machine {
  const base = join(root, `${name}-${++seq}`)
  const m = {
    name,
    dir: join(base, 'sync'),
    home: join(base, 'tether'),
    user: join(base, 'user'), // this machine's home dir
    work,
    plans: [] as ApplyPlan[],
    reads: 0,
  } as Machine
  mkdirSync(m.dir, { recursive: true })
  m.provider = makeProvider(m.dir)
  let n = 0
  m.engine = createSyncEngine({
    dir: m.dir,
    home: m.home,
    provider: m.provider,
    opts: { homedir: m.user, newUid: () => `${name}${++n}` },
    ports: {
      async read() { m.reads++; return structuredClone(m.work) },
      async apply(plan) {
        assert.ok(Object.keys(plan).length > 0, 'apply called with an empty plan')
        m.plans.push(structuredClone(plan))
        if (plan.profiles) m.work.profiles = structuredClone(plan.profiles)
        if (plan.layout) m.work.layout = structuredClone(plan.layout)
        if (plan.settings) m.work.settings = structuredClone(plan.settings)
        if (plan.keybindings !== undefined) m.work.keybindings = structuredClone(plan.keybindings)
        if (plan.slots) {
          for (const r of plan.slots.rename) {
            const s = m.work.slots.find((x) => x.slotId === r.slotId)!
            if (r.name === undefined) delete s.name
            else s.name = r.name
          }
          m.work.slots.push(...structuredClone(plan.slots.create))
        }
      },
    },
  })
  return m
}

/** A path inside this machine's home dir (the built-in `home` place). */
const at = (m: Machine, ...segs: string[]): string => join(m.user, ...segs)

function terminal(slot: string, cwd: string): Record<string, unknown> {
  return { id: slot, contentComponent: 'terminal', params: { slotId: slot, hint: { kind: 'claude', cwd } }, title: slot }
}

function desk(id: string, name: string, panels: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    name,
    frames: {
      grid: { root: { type: 'leaf', data: { id: 'f1' } } },
      views: { f1: { grid: { root: { type: 'leaf', data: { views: Object.keys(panels) } } }, panels } },
    },
  }
}

function slot(id: string, cwd: string, name?: string): SlotMeta {
  return { v: 1, slotId: id, agent: 'claude', cwd, args: [], createdAt: '2026-11-23T10:00:00.000Z', ...(name ? { name } : {}) }
}

function profile(id: string, cwd?: string): Profile {
  return { id, name: id.toUpperCase(), agent: 'claude', args: ['--x'], ...(cwd ? { cwd } : {}) }
}

/** Machine A with one desk holding slot s1, and one profile; both inside its home dir. */
function seedA(m: Machine): void {
  m.work.layout = { v: 4, desks: [desk('desk-1', 'Mesa A', { s1: terminal('s1', at(m, 'work', 'proj')) })], activeDesk: 'desk-1' }
  m.work.slots = [slot('s1', at(m, 'work', 'proj'), 'Alfa'), slot('loose', at(m, 'work'))]
  m.work.profiles = [profile('main', at(m, 'work'))]
}

const deskNames = (m: Machine): string[] => (m.work.layout.desks as { name: string }[]).map((d) => d.name)

function assertNoAbsolutePaths(files: Map<string, string>): void {
  for (const [path, text] of files) {
    assert.doesNotMatch(text, /[A-Za-z]:[\\/]|"\/(?:Users|home|tmp|var|private)\//, `absolute path in ${path}`)
    assert.ok(!text.includes(root) && !text.includes(root.replaceAll('\\', '\\\\')), `machine folder in ${path}`)
  }
}

// ---- tests with the in-memory provider ---------------------------------------------------------------------------

describe('sync engine (in-memory provider)', () => {
  test('first sync exports one file per entity, persists the maps, and leaks no machine path', async () => {
    const remote = newRemote()
    const a = machine('a', (d) => fakeProvider(d, remote))
    seedA(a)
    const r = await a.engine.connect()
    assert.equal(r.connect?.remoteEmpty, true)
    assert.equal(r.pushed, true)
    assert.deepEqual(r.written, ['desks/a1', 'layout/order', 'profiles.meta/order', 'profiles/main', 'settings/settings', 'slots/s1'])
    assert.deepEqual([...remote.files.keys()].sort(), r.written.map((k) => `${k}.json`))
    assert.equal(remote.files.has('slots/loose.json'), false, 'a slot on no desk stays')
    assertNoAbsolutePaths(remote.files)
    assert.deepEqual(JSON.parse(readFileSync(join(a.home, 'desk-ids.json'), 'utf8')).ids, { 'desk-1': 'a1' })
    assert.ok(existsSync(join(a.home, 'sync-state.json')))
    assert.equal(a.plans.length, 0)
  })

  test('idempotent: a second sync rewrites nothing, applies nothing, commits nothing', async () => {
    const remote = newRemote()
    const a = machine('a', (d) => fakeProvider(d, remote))
    const b = machine('b', (d) => fakeProvider(d, remote))
    seedA(a)
    await a.engine.connect()
    await b.engine.connect() // b receives (an import happened, so the base went through the import path)
    for (const m of [a, b]) {
      await m.engine.sync()
      const commits = remote.commits
      const plans = m.plans.length
      const before = mtimes(m.dir)
      const stateBefore = readFileSync(join(m.home, 'sync-state.json'), 'utf8')
      await new Promise((r) => setTimeout(r, 20))
      const r = await m.engine.sync()
      assert.deepEqual(r.written, [], `${m.name} wrote`)
      assert.deepEqual(r.removed, [])
      assert.equal(r.pushed, false)
      assert.deepEqual(r.pulled, [])
      assert.equal(m.plans.length, plans, `${m.name} applied`)
      assert.equal(remote.commits, commits, `${m.name} committed`)
      assert.deepEqual(mtimes(m.dir), before)
      assert.equal(readFileSync(join(m.home, 'sync-state.json'), 'utf8'), stateBefore)
    }
  })

  test('two machines: B receives desk, slot and profile; B renames, A sees it', async () => {
    const remote = newRemote()
    const a = machine('a', (d) => fakeProvider(d, remote))
    const b = machine('b', (d) => fakeProvider(d, remote))
    seedA(a)
    b.work.settings = { theme: 'light', window: { x: 1 } }
    await a.engine.connect()
    const rb = await b.engine.connect()
    assert.equal(rb.connect?.remoteEmpty, false)
    assert.deepEqual(rb.applied, { profiles: true, layout: true, slots: true, settings: true, keybindings: false })
    assert.deepEqual(deskNames(b), ['Mesa A'])
    assert.deepEqual(rb.arrivedDesks, ['desk-1'])
    assert.equal(b.work.profiles[0]?.cwd, at(b, 'work'))
    assert.deepEqual(b.work.slots.map((s) => [s.slotId, s.cwd, s.name]), [['s1', at(b, 'work', 'proj'), 'Alfa']])
    assert.deepEqual(b.work.settings, { theme: 'dark', window: { x: 1 } }, 'the persistent wins; the window stays')

    ;(b.work.layout.desks as { name: string }[])[0]!.name = 'Mesa B'
    const r2 = await b.engine.sync()
    assert.deepEqual(r2.written, ['desks/a1'])
    assert.equal(r2.pushed, true)
    const ra = await a.engine.sync()
    assert.deepEqual(ra.pulled, ['desks/a1.json'])
    assert.deepEqual(deskNames(a), ['Mesa B'])
    assert.deepEqual(ra.applied, { profiles: false, layout: true, slots: false, settings: false, keybindings: false })
    assert.equal((a.work.layout.desks as { id: string }[])[0]!.id, 'desk-1', 'the local id stays')
  })

  test('a local keybindings edit made after the export survives an import of the older folder copy', async () => {
    const remote = newRemote()
    const a = machine('a', (d) => fakeProvider(d, remote))
    const b = machine('b', (d) => fakeProvider(d, remote))
    seedA(a)
    a.work.keybindings = [{ key: 'ctrl+k', command: 'old' }]
    await a.engine.connect()
    await b.engine.connect()
    assert.deepEqual(b.work.keybindings, [{ key: 'ctrl+k', command: 'old' }])

    // A pushes a newer version; B edits locally before importing it.
    a.work.keybindings = [{ key: 'ctrl+k', command: 'fromA' }]
    await a.engine.sync()
    await b.provider.pull() // the folder now holds A's version
    b.work.keybindings = [{ key: 'ctrl+j', command: 'mine' }] // edited after B's last export
    await b.engine.importAll()
    assert.deepEqual(b.work.keybindings, [{ key: 'ctrl+j', command: 'mine' }], 'the unsent local edit wins')
    await b.engine.sync()
    const text = readFileSync(join(b.dir, 'settings', 'keybindings.json'), 'utf8')
    assert.match(text, /mine/, 'and it is exported on the next cycle')
  })

  test('a removal propagates: profile and desk gone on A disappear on B', async () => {
    const remote = newRemote()
    const a = machine('a', (d) => fakeProvider(d, remote))
    const b = machine('b', (d) => fakeProvider(d, remote))
    seedA(a)
    a.work.profiles.push(profile('extra'))
    ;(a.work.layout.desks as unknown[]).push(desk('desk-2', 'Mesa 2', {}))
    await a.engine.connect()
    await b.engine.connect()
    assert.deepEqual(b.work.profiles.map((p) => p.id), ['main', 'extra'])
    assert.deepEqual(deskNames(b), ['Mesa A', 'Mesa 2'])

    a.work.profiles = a.work.profiles.filter((p) => p.id !== 'extra')
    a.work.layout.desks = (a.work.layout.desks as { id: string }[]).filter((d) => d.id !== 'desk-2')
    const ra = await a.engine.sync()
    assert.deepEqual(ra.removed, ['desks/a2', 'profiles/extra'])
    assert.ok(!remote.files.has('desks/a2.json') && !remote.files.has('profiles/extra.json'))
    const rb = await b.engine.sync()
    assert.deepEqual(b.work.profiles.map((p) => p.id), ['main'])
    assert.deepEqual(deskNames(b), ['Mesa A'])
    assert.equal(rb.removedDesks.length, 1)
    assert.equal(existsSync(join(b.dir, 'desks', 'a2.json')), false)
  })

  test('ext/ and anything outside the owned collections is never touched', async () => {
    const remote = newRemote()
    const a = machine('a', (d) => fakeProvider(d, remote))
    seedA(a)
    put(a.dir, 'ext/browser/state.json', '{"keep":true}\n')
    put(a.dir, 'notes.txt', 'mine\n')
    await a.engine.connect()
    a.work.profiles = []
    a.work.layout.desks = []
    a.work.slots = []
    const r = await a.engine.sync()
    assert.deepEqual(r.removed, ['desks/a1', 'profiles/main', 'slots/s1'])
    assert.equal(readFileSync(join(a.dir, 'ext', 'browser', 'state.json'), 'utf8'), '{"keep":true}\n')
    assert.equal(readFileSync(join(a.dir, 'notes.txt'), 'utf8'), 'mine\n')
    assert.ok(remote.files.has('ext/browser/state.json'))
  })

  test('an arrangement that is not v4 leaves desks, layout and slots alone', async () => {
    const remote = newRemote()
    const a = machine('a', (d) => fakeProvider(d, remote))
    seedA(a)
    await a.engine.connect()
    a.work.layout = { v: 3 }
    const r = await a.engine.sync()
    assert.deepEqual(r.removed, [])
    assert.ok(r.skipped.includes('layout'))
    assert.ok(existsSync(join(a.dir, 'desks', 'a1.json')) && existsSync(join(a.dir, 'slots', 's1.json')))
  })

  test('a slot whose place is unmapped stays pending, is not created, and its entity is not deleted', async () => {
    const remote = newRemote()
    const a = machine('a', (d) => fakeProvider(d, remote))
    const b = machine('b', (d) => fakeProvider(d, remote))
    const proj = join(root, `outside-${++seq}`, 'proj') // outside A's home dir: travels under its own place
    a.work.layout = { v: 4, desks: [desk('desk-1', 'Mesa', { s9: terminal('s9', proj) })], activeDesk: 'desk-1' }
    a.work.slots = [slot('s9', proj)]
    await a.engine.connect()
    assert.deepEqual(Object.keys(readPlaceMap(a.home)), ['proj'])

    const rb = await b.engine.connect()
    assert.deepEqual(rb.pending, [{ slotId: 's9', place: 'proj' }])
    assert.deepEqual(rb.unmappedPlaces, ['proj'])
    assert.equal(b.work.slots.length, 0)
    assert.equal(b.plans[0]?.slots, undefined)

    const again = await b.engine.sync()
    assert.deepEqual(again.removed, [])
    assert.ok(existsSync(join(b.dir, 'slots', 's9.json')))
    assert.ok(remote.files.has('slots/s9.json'))
    assert.ok(remote.files.get('desks/a1.json')!.includes('"place": "proj"'), 'the pane keeps its place in the remote')

    const there = join(root, `b-proj-${++seq}`)
    writePlaceMap(b.home, { proj: there })
    const im = await b.engine.importAll()
    assert.deepEqual(im.pending, [])
    assert.deepEqual(b.work.slots.map((s) => [s.slotId, s.cwd]), [['s9', there]])
    const last = await b.engine.sync()
    assert.deepEqual([last.written, last.removed, last.pushed], [[], [], false])
  })

  test('behind: the push retries after a pull and lands the other machine\'s change too', async () => {
    const remote = newRemote()
    const a = machine('a', (d) => fakeProvider(d, remote))
    const b = machine('b', (d) => fakeProvider(d, remote))
    seedA(a)
    await a.engine.connect()
    await b.engine.connect()
    ;(a.work.layout.desks as { name: string }[])[0]!.name = 'Nome A'
    b.work.profiles.push(profile('from-b'))
    const pa = a.provider as FakeProvider
    pa.beforePush = async () => { await b.engine.sync() } // B lands first, between A's pull and A's push
    pa.calls.length = 0
    const r = await a.engine.sync()
    assert.equal(r.pushed, true)
    assert.equal(r.behind, false)
    assert.deepEqual(pa.calls, ['pull', 'push', 'pull', 'push'])
    assert.ok(r.pulled.includes('profiles/from-b.json'))
    assert.ok(r.applied.profiles)
    assert.deepEqual(a.work.profiles.map((p) => p.id), ['main', 'from-b'])
    await b.engine.sync()
    assert.deepEqual(deskNames(b), ['Nome A'])
  })

  test('behind forever: gives up after three retries and says so', async () => {
    const remote = newRemote()
    const a = machine('a', (d) => fakeProvider(d, remote))
    seedA(a)
    await a.engine.connect()
    a.work.profiles.push(profile('more'))
    const pa = a.provider as FakeProvider
    const realPush = pa.push
    pa.push = async () => { pa.calls.push('push'); return { pushed: false, reason: 'behind' } }
    pa.calls.length = 0
    const r = await a.engine.sync()
    assert.deepEqual([r.pushed, r.behind], [false, true])
    assert.equal(pa.calls.filter((c) => c === 'push').length, 4)
    pa.push = realPush
  })

  test('concurrent calls run one at a time; syncs asked while one waits join it', async () => {
    const remote = newRemote()
    const a = machine('a', (d) => fakeProvider(d, remote))
    seedA(a)
    await a.engine.connect()
    const pa = a.provider as FakeProvider
    pa.calls.length = 0
    pa.maxActive = 0

    const [x, y, z] = [a.engine.sync(), a.engine.sync(), a.engine.sync()]
    assert.equal(x, y)
    assert.equal(y, z)
    await x
    assert.deepEqual(pa.calls, ['pull', 'push'])

    pa.calls.length = 0
    let open!: () => void
    pa.gate = new Promise((r) => { open = r })
    const first = a.engine.sync()
    while (pa.calls.length === 0) await new Promise((r) => setTimeout(r, 1)) // the first sync is inside pull
    const second = a.engine.sync()
    const third = a.engine.sync()
    const exp = a.engine.exportAll()
    assert.notEqual(first, second)
    assert.equal(second, third)
    pa.gate = undefined
    open()
    await Promise.all([first, second, third, exp])
    assert.deepEqual(pa.calls, ['pull', 'push', 'pull', 'push'])
    assert.equal(pa.maxActive, 1)
  })

  test('a failed apply is retried on the next sync even with nothing new in the remote', async () => {
    const remote = newRemote()
    const a = machine('a', (d) => fakeProvider(d, remote))
    seedA(a)
    await a.engine.connect()
    let fail = true
    const b = machine('b', (d) => fakeProvider(d, remote))
    const engineB = createSyncEngine({
      dir: b.dir, home: b.home, provider: b.provider, opts: { homedir: b.user },
      ports: {
        read: async () => structuredClone(b.work),
        apply: async (plan) => { if (fail) throw new Error('disk full'); b.plans.push(plan); if (plan.layout) b.work.layout = plan.layout },
      },
    })
    await assert.rejects(engineB.connect(), /disk full/)
    fail = false
    const r = await engineB.sync()
    assert.deepEqual(r.pulled, [])
    assert.ok(r.applied.layout)
    assert.deepEqual(deskNames(b), ['Mesa A'])
  })
})

// ---- end to end with git and a local bare remote -----------------------------------------------------------------

describe('sync engine (git provider, bare remote)', () => {
  test('A creates, B connects and receives, B renames, A sees; no absolute path in the bare', async () => {
    const bare = join(root, `remote-${++seq}.git`)
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare])
    const gitFor = (name: string) => (dir: string) =>
      createGitProvider({ dir, url: bare, trashDir: join(dirname(dir), 'trash'), machine: name, now: () => Date.UTC(2026, 10, 23) })
    const a = machine('a', gitFor('a'))
    const b = machine('b', gitFor('b'))
    seedA(a)

    const ra = await a.engine.connect()
    assert.deepEqual([ra.connect?.remoteEmpty, ra.pushed], [true, true])

    const rb = await b.engine.connect()
    assert.equal(rb.connect?.remoteEmpty, false)
    assert.deepEqual(deskNames(b), ['Mesa A'])
    assert.deepEqual(b.work.profiles.map((p) => [p.id, p.cwd]), [['main', at(b, 'work')]])
    assert.deepEqual(b.work.slots.map((s) => s.slotId), ['s1'])

    ;(b.work.layout.desks as { name: string }[])[0]!.name = 'Renomeada em B'
    const rb2 = await b.engine.sync()
    assert.equal(rb2.pushed, true)
    const ra2 = await a.engine.sync()
    assert.deepEqual(ra2.pulled, ['desks/a1.json'])
    assert.deepEqual(deskNames(a), ['Renomeada em B'])

    const log = (): string => execFileSync('git', ['--git-dir', bare, 'rev-list', '--count', 'main'], { encoding: 'utf8' }).trim()
    const commits = log()
    const again = await a.engine.sync()
    assert.deepEqual([again.written, again.pushed, log()], [[], false, commits])

    const names = execFileSync('git', ['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' }).split('\n').filter(Boolean)
    const files = new Map(names.map((n) => [n, execFileSync('git', ['--git-dir', bare, 'show', `main:${n}`], { encoding: 'utf8' })]))
    assert.ok(files.size >= 6)
    assertNoAbsolutePaths(files)
  })
})
