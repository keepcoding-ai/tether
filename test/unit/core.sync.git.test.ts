import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { SyncError } from '../../src/core/sync/provider.ts'
import { createGitProvider, maskUrl } from '../../src/core/sync/providers/git.ts'

let root: string
let seq = 0

before(() => {
  root = mkdtempSync(join(tmpdir(), 'tether-sync-git-'))
})
after(() => {
  rmSync(root, { recursive: true, force: true })
})

function put(dir: string, rel: string, text: string): void {
  const file = join(dir, ...rel.split('/'))
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}
const get = (dir: string, rel: string): string => readFileSync(join(dir, ...rel.split('/')), 'utf8')

function newRemote(): string {
  const dir = join(root, `remote-${++seq}.git`)
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', dir])
  return dir
}

function machine(url: string, name: string, extra: { git?: string } = {}) {
  const base = join(root, `${name}-${++seq}`)
  const dir = join(base, 'sync')
  const trashDir = join(base, 'trash')
  const provider = createGitProvider({ dir, url, trashDir, machine: name, now: () => Date.UTC(2026, 10, 23, 10, 0, 0), ...extra })
  return { dir, trashDir, provider }
}

function remoteFiles(remote: string): string[] {
  return execFileSync('git', ['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' })
    .split('\n').filter(Boolean).sort()
}
const remoteShow = (remote: string, rel: string): string =>
  execFileSync('git', ['--git-dir', remote, 'show', `main:${rel}`], { encoding: 'utf8' })

/** Machine A publishes `files`; returns it connected. */
async function seeded(remote: string, files: Record<string, string>) {
  const a = machine(remote, 'a')
  for (const [k, v] of Object.entries(files)) put(a.dir, k, v)
  await a.provider.connect()
  assert.equal((await a.provider.push()).pushed, true)
  return a
}

describe('git provider', () => {
  test('first machine: empty remote, connect + push lands in the bare repo', async () => {
    const remote = newRemote()
    const a = machine(remote, 'a')
    put(a.dir, 'desks/d1.json', '{"id":"d1"}')
    put(a.dir, 'settings.json', '{"v":1}')
    assert.deepEqual(await a.provider.connect(), { remoteEmpty: true })
    assert.deepEqual(await a.provider.connect(), { remoteEmpty: true }) // idempotent
    assert.deepEqual(await a.provider.push(), { pushed: true })
    assert.deepEqual(remoteFiles(remote), ['desks/d1.json', 'settings.json'])
    assert.equal(remoteShow(remote, 'desks/d1.json'), '{"id":"d1"}')
    assert.deepEqual(await a.provider.push(), { pushed: false }) // nothing to send
  })

  test('second machine with an empty folder receives everything', async () => {
    const remote = newRemote()
    await seeded(remote, { 'desks/d1.json': 'one', 'profiles/p1.json': 'two' })
    const b = machine(remote, 'b')
    assert.deepEqual(await b.provider.connect(), { remoteEmpty: false })
    const r = await b.provider.pull()
    assert.deepEqual(r, { changed: ['desks/d1.json', 'profiles/p1.json'], conflicts: [] })
    assert.equal(get(b.dir, 'desks/d1.json'), 'one')
  })

  test('different files on two machines converge', async () => {
    const remote = newRemote()
    const a = await seeded(remote, { 'desks/d1.json': 'base' })
    const b = machine(remote, 'b')
    await b.provider.connect()
    await b.provider.pull()
    put(a.dir, 'desks/d2.json', 'from-a')
    put(b.dir, 'profiles/p2.json', 'from-b')
    assert.equal((await a.provider.push()).pushed, true)
    const pb = await b.provider.pull()
    assert.deepEqual(pb, { changed: ['desks/d2.json'], conflicts: [] })
    assert.equal((await b.provider.push()).pushed, true)
    assert.deepEqual((await a.provider.pull()).changed, ['profiles/p2.json'])
    assert.equal(get(a.dir, 'profiles/p2.json'), 'from-b')
    assert.equal(get(b.dir, 'desks/d2.json'), 'from-a')
    assert.deepEqual(remoteFiles(remote), ['desks/d1.json', 'desks/d2.json', 'profiles/p2.json'])
  })

  test('same entity on both: the remote wins and the local version goes to the trash', async () => {
    const remote = newRemote()
    const a = await seeded(remote, { 'desks/d1.json': 'base\n' })
    const b = machine(remote, 'b')
    await b.provider.connect()
    await b.provider.pull()
    put(a.dir, 'desks/d1.json', 'remote edit\n')
    await a.provider.push()
    put(b.dir, 'desks/d1.json', 'local edit\n')
    const r = await b.provider.pull()
    assert.deepEqual(r.conflicts, [{ path: 'desks/d1.json', trashed: true }])
    assert.deepEqual(r.changed, ['desks/d1.json'])
    assert.equal(get(b.dir, 'desks/d1.json'), 'remote edit\n')
    const trashed = join(b.trashDir, '2026-11-23T100000.000Z', 'desks', 'd1.json')
    assert.equal(readFileSync(trashed, 'utf8'), 'local edit\n')
    assert.deepEqual((await b.provider.status()).dirty, 0)
    // the merge is concluded: a later push is accepted
    assert.equal((await b.provider.push()).pushed, true)
  })

  test('modify/delete: the remote deleted, local modified', async () => {
    const remote = newRemote()
    const a = await seeded(remote, { 'desks/d1.json': 'base', 'desks/keep.json': 'k' })
    const b = machine(remote, 'b')
    await b.provider.connect()
    await b.provider.pull()
    rmSync(join(a.dir, 'desks', 'd1.json'))
    await a.provider.push()
    put(b.dir, 'desks/d1.json', 'local change')
    const r = await b.provider.pull()
    assert.deepEqual(r.conflicts, [{ path: 'desks/d1.json', trashed: true }])
    assert.equal(existsSync(join(b.dir, 'desks', 'd1.json')), false)
    assert.equal(readFileSync(join(b.trashDir, '2026-11-23T100000.000Z', 'desks', 'd1.json'), 'utf8'), 'local change')
    assert.equal(get(b.dir, 'desks/keep.json'), 'k')
  })

  test('modify/delete: the local deleted, remote modified (restored, nothing to trash)', async () => {
    const remote = newRemote()
    const a = await seeded(remote, { 'desks/d1.json': 'base' })
    const b = machine(remote, 'b')
    await b.provider.connect()
    await b.provider.pull()
    put(a.dir, 'desks/d1.json', 'remote change')
    await a.provider.push()
    rmSync(join(b.dir, 'desks', 'd1.json'))
    const r = await b.provider.pull()
    assert.deepEqual(r.conflicts, [{ path: 'desks/d1.json', trashed: false }])
    assert.equal(get(b.dir, 'desks/d1.json'), 'remote change')
  })

  test('second machine with local files joins a remote with content (unrelated histories)', async () => {
    const remote = newRemote()
    await seeded(remote, { 'desks/d1.json': 'remote d1', 'settings.json': 'remote settings' })
    const b = machine(remote, 'b')
    put(b.dir, 'desks/d1.json', 'local d1')
    put(b.dir, 'profiles/mine.json', 'only local')
    assert.deepEqual(await b.provider.connect(), { remoteEmpty: false })
    const r = await b.provider.pull()
    assert.deepEqual(r.conflicts, [{ path: 'desks/d1.json', trashed: true }])
    assert.equal(get(b.dir, 'desks/d1.json'), 'remote d1')
    assert.equal(get(b.dir, 'settings.json'), 'remote settings')
    assert.equal(get(b.dir, 'profiles/mine.json'), 'only local')
    assert.deepEqual(r.changed, ['desks/d1.json', 'settings.json'])
    assert.equal((await b.provider.push()).pushed, true)
    assert.deepEqual(remoteFiles(remote), ['desks/d1.json', 'profiles/mine.json', 'settings.json'])
  })

  test('push rejected as behind, then passes after a pull', async () => {
    const remote = newRemote()
    const a = await seeded(remote, { 'desks/d1.json': 'base' })
    const b = machine(remote, 'b')
    await b.provider.connect()
    await b.provider.pull()
    put(a.dir, 'desks/a.json', 'a')
    await a.provider.push()
    put(b.dir, 'desks/b.json', 'b')
    assert.deepEqual(await b.provider.push(), { pushed: false, reason: 'behind' })
    await b.provider.pull()
    assert.deepEqual(await b.provider.push(), { pushed: true })
    assert.deepEqual(remoteFiles(remote), ['desks/a.json', 'desks/b.json', 'desks/d1.json'])
  })

  test('pull with nothing new, and pull from an empty remote', async () => {
    const empty = machine(newRemote(), 'e')
    await empty.provider.connect()
    assert.deepEqual(await empty.provider.pull(), { changed: [], conflicts: [] })

    const remote = newRemote()
    const a = await seeded(remote, { 'x.json': '1' })
    assert.deepEqual(await a.provider.pull(), { changed: [], conflicts: [] })
  })

  test('status: dirty, ahead, behind (no network)', async () => {
    const remote = newRemote()
    const a = await seeded(remote, { 'desks/d1.json': 'base' })
    assert.deepEqual(await a.provider.status(), { connected: true, url: remote, dirty: 0, ahead: 0, behind: 0 })
    put(a.dir, 'desks/d2.json', 'x')
    put(a.dir, 'desks/d3.json', 'y')
    assert.equal((await a.provider.status()).dirty, 2)
    await a.provider.pull() // commits the pending files
    const s = await a.provider.status()
    assert.deepEqual([s.dirty, s.ahead, s.behind], [0, 1, 0])

    const b = machine(remote, 'b')
    await b.provider.connect() // fetched, not merged
    assert.deepEqual(await b.provider.status().then((x) => [x.ahead, x.behind]), [0, 1])
  })

  test('status of a folder that was never connected', async () => {
    const m = machine(newRemote(), 'n')
    assert.deepEqual(await m.provider.status(), { connected: false, dirty: 0, ahead: 0, behind: 0 })
  })

  test('disconnect drops the remote and keeps files and .git', async () => {
    const remote = newRemote()
    const a = await seeded(remote, { 'desks/d1.json': 'base' })
    await a.provider.disconnect()
    assert.equal((await a.provider.status()).connected, false)
    assert.equal(existsSync(join(a.dir, '.git')), true)
    assert.equal(get(a.dir, 'desks/d1.json'), 'base')
    await a.provider.disconnect() // idempotent
    assert.deepEqual(await a.provider.connect(), { remoteEmpty: false }) // reconnects
  })

  test('a missing git binary is git-missing', async () => {
    const m = machine(newRemote(), 'g', { git: 'git-that-does-not-exist-xyz' })
    await assert.rejects(m.provider.connect(), (e: unknown) => e instanceof SyncError && e.code === 'git-missing')
  })

  test('an unreachable remote is network, and credentials in the URL are masked', async () => {
    const url = 'https://user:s3cret@localhost:1/nope.git'
    const m = machine(url, 'u')
    await assert.rejects(m.provider.connect(), (e: unknown) => {
      assert.ok(e instanceof SyncError)
      assert.equal(e.code, 'network')
      assert.ok(!e.message.includes('s3cret'), e.message)
      return true
    })
    assert.equal((await m.provider.status()).url, 'https://***@localhost:1/nope.git')
  })

  test('maskUrl', () => {
    assert.equal(maskUrl('fatal: unable to access https://u:p@host/x.git/: boom'), 'fatal: unable to access https://***@host/x.git/: boom')
    assert.equal(maskUrl('git@github.com:a/b.git'), 'git@github.com:a/b.git')
  })
})
