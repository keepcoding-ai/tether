import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import {
  createEntityStore,
  createExtStorage,
  StorageError,
  SYNC_EXT_MAX_BYTES,
  SYNC_KEY_MAX_BYTES,
  storageRoots,
} from '../../src/core/storage/index.ts'

let root: string
let n = 0
before(() => {
  root = mkdtempSync(join(tmpdir(), 'tether-storage-'))
})
after(() => {
  rmSync(root, { recursive: true, force: true })
})
const fresh = (): string => join(root, `t${n++}`)

function code(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (err) {
    return err instanceof StorageError ? err.code : `other:${String(err)}`
  }
  return undefined
}

describe('storageRoots', () => {
  test('sync is the `sync` subfolder of the user dir, local is the home', () => {
    const r = storageRoots({ TETHER_HOME: 'h', TETHER_USER_DIR: 'u' })
    assert.deepEqual(r, { sync: join('u', 'sync'), local: 'h' })
  })
})

describe('entity store', () => {
  test('round trip, delete and missing', () => {
    const s = createEntityStore(fresh())
    assert.equal(s.get('c', 'a'), undefined)
    s.set('c', 'a', { x: 1, list: [3, 1] })
    assert.deepEqual(s.get('c', 'a'), { x: 1, list: [3, 1] })
    assert.equal(s.delete('c', 'a'), true)
    assert.equal(s.delete('c', 'a'), false)
    assert.equal(s.get('c', 'a'), undefined)
  })

  test('key order is stable at every level, arrays keep order', () => {
    const dir = fresh()
    const s = createEntityStore(dir)
    s.set('c', 'one', { b: 1, a: { z: 1, y: [{ q: 1, p: 2 }, 5] } })
    s.set('c', 'two', { a: { y: [{ p: 2, q: 1 }, 5], z: 1 }, b: 1 })
    const one = readFileSync(join(dir, 'c', 'one.json'), 'utf8')
    const two = readFileSync(join(dir, 'c', 'two.json'), 'utf8')
    assert.equal(one, two)
    assert.ok(one.endsWith('}\n'))
    assert.ok(one.indexOf('"a"') < one.indexOf('"b"'))
  })

  test('identical write does not rewrite the file', () => {
    const dir = fresh()
    const s = createEntityStore(dir)
    s.set('c', 'a', { v: 1 })
    const file = join(dir, 'c', 'a.json')
    const old = new Date('2001-01-01T00:00:00Z')
    utimesSync(file, old, old)
    s.set('c', 'a', { v: 1 })
    assert.equal(statSync(file).mtimeMs, old.getTime())
    s.set('c', 'a', { v: 2 })
    assert.notEqual(statSync(file).mtimeMs, old.getTime())
  })

  test('no .tmp file is left behind', () => {
    const dir = fresh()
    const s = createEntityStore(dir)
    for (let i = 0; i < 5; i++) s.set('c', 'a', { i })
    assert.deepEqual(readdirSync(join(dir, 'c')), ['a.json'])
  })

  test('list is sorted and ignores junk', () => {
    const dir = fresh()
    const s = createEntityStore(dir)
    assert.deepEqual(s.list('c'), [])
    s.set('c', 'b', 1)
    s.set('c', 'a', 1)
    writeFileSync(join(dir, 'c', 'a.json.99.tmp'), '{}')
    writeFileSync(join(dir, 'c', 'notes.txt'), 'x')
    mkdirSync(join(dir, 'c', 'sub.json'))
    assert.deepEqual(s.list('c'), ['a', 'b'])
  })

  test('id with a colon goes and comes back', () => {
    const dir = fresh()
    const s = createEntityStore(dir)
    s.set('c', 'slot:1', { ok: true })
    assert.deepEqual(readdirSync(join(dir, 'c')), ['slot%3A1.json'])
    assert.deepEqual(s.get('c', 'slot:1'), { ok: true })
    assert.deepEqual(s.list('c'), ['slot:1'])
    assert.equal(s.delete('c', 'slot:1'), true)
  })

  test('invalid names throw invalid-name', () => {
    const s = createEntityStore(fresh())
    assert.equal(code(() => s.set('c', '..', 1)), 'invalid-name')
    assert.equal(code(() => s.set('c', 'a..b', 1)), 'invalid-name')
    assert.equal(code(() => s.set('c', 'a/b', 1)), 'invalid-name')
    assert.equal(code(() => s.set('c', '', 1)), 'invalid-name')
    assert.equal(code(() => s.set('c', 'Abc', 1)), 'invalid-name')
    assert.equal(code(() => s.get('c', 'A')), 'invalid-name')
    assert.equal(code(() => s.set('', 'a', 1)), 'invalid-name')
    assert.equal(code(() => s.set('Up', 'a', 1)), 'invalid-name')
    assert.equal(code(() => s.set('a/../b', 'a', 1)), 'invalid-name')
    assert.equal(code(() => s.list('a//b')), 'invalid-name')
  })

  test('two-level collection', () => {
    const dir = fresh()
    const s = createEntityStore(dir)
    s.set('ext/my-ext', 'k', 1)
    assert.equal(s.get('ext/my-ext', 'k'), 1)
    assert.deepEqual(readdirSync(join(dir, 'ext', 'my-ext')), ['k.json'])
  })

  test('maxBytes quota writes nothing and names the details', () => {
    const dir = fresh()
    const s = createEntityStore(dir, { maxBytes: 20 })
    s.set('c', 'small', 1)
    let err: unknown
    try {
      s.set('c', 'big', 'x'.repeat(100))
    } catch (e) {
      err = e
    }
    assert.ok(err instanceof StorageError)
    assert.equal(err.code, 'quota-exceeded')
    assert.match(err.message, /c\/big/)
    assert.match(err.message, /20/)
    assert.deepEqual(s.list('c'), ['small'])
  })

  test('corrupt JSON gives undefined', () => {
    const dir = fresh()
    const s = createEntityStore(dir)
    s.set('c', 'a', 1)
    writeFileSync(join(dir, 'c', 'a.json'), '{ nope')
    assert.equal(s.get('c', 'a'), undefined)
  })
})

describe('extension storage', () => {
  const roots = () => ({ sync: fresh(), local: fresh() })

  test('round trip, keys, delete, undefined deletes', () => {
    const e = createExtStorage(roots(), 'ext-a')
    e.sync.set('b', { v: 1 })
    e.sync.set('a', 2)
    assert.deepEqual(e.sync.keys(), ['a', 'b'])
    assert.deepEqual(e.sync.get('b'), { v: 1 })
    e.sync.set('a', undefined)
    assert.deepEqual(e.sync.keys(), ['b'])
    assert.equal(e.sync.delete('b'), true)
    assert.equal(e.sync.delete('b'), false)
  })

  test('sync lives under the sync root, local under the local root', () => {
    const r = roots()
    const e = createExtStorage(r, 'ext-a')
    e.sync.set('k', 1)
    e.local.set('k', 2)
    assert.equal(readFileSync(join(r.sync, 'ext', 'ext-a', 'k.json'), 'utf8').trim(), '1')
    assert.equal(readFileSync(join(r.local, 'ext', 'ext-a', 'k.json'), 'utf8').trim(), '2')
  })

  test('sync per-key quota', () => {
    const e = createExtStorage(roots(), 'ext-a')
    e.sync.set('ok', 'x'.repeat(SYNC_KEY_MAX_BYTES - 100))
    assert.equal(code(() => e.sync.set('big', 'x'.repeat(SYNC_KEY_MAX_BYTES))), 'quota-exceeded')
    assert.equal(e.sync.get('big'), undefined)
  })

  test('sync total quota counts the new value in place of the old', () => {
    const e = createExtStorage(roots(), 'ext-a')
    const chunk = 'x'.repeat(SYNC_KEY_MAX_BYTES - 100)
    const fit = Math.floor(SYNC_EXT_MAX_BYTES / (SYNC_KEY_MAX_BYTES - 90))
    for (let i = 0; i < fit; i++) e.sync.set(`k${i}`, chunk)
    assert.equal(code(() => e.sync.set('more', chunk)), 'quota-exceeded')
    assert.equal(e.sync.get('more'), undefined)
    e.sync.set('k0', chunk) // replacing an existing key still fits
    e.sync.delete('k1')
    e.sync.set('more', chunk) // freed space is usable
  })

  test('local has no quota', () => {
    const e = createExtStorage(roots(), 'ext-a')
    e.local.set('big', 'x'.repeat(SYNC_EXT_MAX_BYTES * 2))
    assert.equal((e.local.get('big') as string).length, SYNC_EXT_MAX_BYTES * 2)
  })

  test('extensions do not see each other', () => {
    const r = roots()
    const a = createExtStorage(r, 'ext-a')
    const b = createExtStorage(r, 'ext-b')
    a.sync.set('k', 1)
    a.local.set('k', 1)
    assert.deepEqual(b.sync.keys(), [])
    assert.deepEqual(b.local.keys(), [])
    assert.equal(b.sync.get('k'), undefined)
    assert.equal(code(() => createExtStorage(r, '../x').sync.set('k', 1)), 'invalid-name')
  })
})
