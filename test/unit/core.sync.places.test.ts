import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import {
  ensureRef,
  fromRef,
  isPlaceName,
  placeName,
  placesPath,
  readPlaceMap,
  toRef,
  writePlaceMap,
} from '../../src/core/sync/places.ts'

const WIN = { platform: 'win32', homedir: 'C:\\Users\\Ana' } as const
const NIX = { platform: 'linux', homedir: '/home/ana' } as const

describe('toRef', () => {
  test('win32 ignores case and mixes separators; rel uses "/"', () => {
    const map = { atrium: 'C:\\atrium' }
    assert.deepEqual(toRef('c:/ATRIUM\\workspace/X/', map, WIN), { place: 'atrium', rel: 'workspace/X' })
  })

  test('posix is exact', () => {
    const map = { atrium: '/srv/atrium' }
    assert.deepEqual(toRef('/srv/atrium/a/b', map, NIX), { place: 'atrium', rel: 'a/b' })
    assert.equal(toRef('/srv/ATRIUM/a', map, NIX), undefined)
  })

  test('the most specific place wins', () => {
    const map = { atrium: 'C:\\atrium', ws: 'C:\\atrium\\workspace' }
    assert.deepEqual(toRef('C:\\atrium\\workspace\\x', map, WIN), { place: 'ws', rel: 'x' })
    assert.deepEqual(toRef('C:\\atrium\\mind', map, WIN), { place: 'atrium', rel: 'mind' })
  })

  test('matches only on segment boundaries', () => {
    assert.equal(toRef('C:\\atrium2\\x', { atrium: 'C:\\atrium' }, WIN), undefined)
    assert.equal(toRef('/srv/atrium2', { atrium: '/srv/atrium' }, NIX), undefined)
  })

  test('the place root gives rel ""', () => {
    assert.deepEqual(toRef('C:\\atrium', { atrium: 'C:\\atrium\\' }, WIN), { place: 'atrium', rel: '' })
    assert.deepEqual(toRef('/srv/atrium/', { atrium: '/srv/atrium' }, NIX), { place: 'atrium', rel: '' })
  })

  test('built-in home, and a map place beats it', () => {
    assert.deepEqual(toRef('C:\\Users\\Ana\\docs', {}, WIN), { place: 'home', rel: 'docs' })
    assert.deepEqual(toRef('/home/ana', {}, NIX), { place: 'home', rel: '' })
    assert.deepEqual(toRef('/home/ana/code/x', { code: '/home/ana/code' }, NIX), { place: 'code', rel: 'x' })
    assert.deepEqual(toRef('/home/ana/x', { home: '/elsewhere' }, NIX), { place: 'home', rel: 'x' })
  })

  test('outside everything is undefined', () => {
    assert.equal(toRef('D:\\other', { atrium: 'C:\\atrium' }, WIN), undefined)
  })
})

describe('fromRef', () => {
  test('round trip on win32 and posix', () => {
    const w = { atrium: 'C:\\atrium' }
    const r = toRef('c:\\atrium\\workspace\\x', w, WIN)!
    assert.equal(fromRef(r, w, WIN), 'C:\\atrium\\workspace\\x')
    const n = { atrium: '/srv/atrium' }
    const r2 = toRef('/srv/atrium/workspace/x', n, NIX)!
    assert.equal(fromRef(r2, n, NIX), '/srv/atrium/workspace/x')
    assert.equal(fromRef({ place: 'home', rel: 'a/b' }, {}, NIX), '/home/ana/a/b')
  })

  test('the same ref resolves on two machines', () => {
    const ref = { place: 'atrium', rel: 'workspace/x' }
    assert.equal(fromRef(ref, { atrium: 'd:\\work\\atrium' }, WIN), 'D:\\work\\atrium\\workspace\\x')
    assert.equal(fromRef(ref, { atrium: '/home/ana/atrium' }, NIX), '/home/ana/atrium/workspace/x')
  })

  test('refuses escapes and absolute rel', () => {
    const m = { a: '/srv/a' }
    assert.equal(fromRef({ place: 'a', rel: '../b' }, m, NIX), undefined)
    assert.equal(fromRef({ place: 'a', rel: 'x/../../b' }, m, NIX), undefined)
    assert.equal(fromRef({ place: 'a', rel: '/etc' }, m, NIX), undefined)
    assert.equal(fromRef({ place: 'a', rel: 'C:/x' }, { a: 'C:\\a' }, WIN), undefined)
    assert.equal(fromRef({ place: 'a', rel: '' }, m, NIX), '/srv/a')
  })

  test('a place without a map entry is undefined', () => {
    assert.equal(fromRef({ place: 'nope', rel: 'x' }, {}, NIX), undefined)
  })
})

describe('placeName', () => {
  test('slugs accents, spaces and symbols', () => {
    assert.equal(placeName('/x/Meus Projetos Ação', [], NIX), 'meus-projetos-acao')
    assert.equal(placeName('C:\\x\\__My_App!!', [], WIN), 'my-app')
    assert.equal(placeName('C:\\', [], WIN), 'place')
    assert.equal(placeName('/', [], NIX), 'place')
  })

  test('collisions and the reserved home', () => {
    assert.equal(placeName('/x/atrium', ['atrium'], NIX), 'atrium-2')
    assert.equal(placeName('/y/atrium', ['atrium', 'atrium-2'], NIX), 'atrium-3')
    assert.equal(placeName('/x/Home', [], NIX), 'home-2')
  })

  test('isPlaceName', () => {
    assert.equal(isPlaceName('a-1'), true)
    assert.equal(isPlaceName('-a'), false)
    assert.equal(isPlaceName('A'), false)
    assert.equal(isPlaceName(3), false)
  })
})

describe('ensureRef', () => {
  test('known path: same map, no add', () => {
    const map = { atrium: '/srv/atrium' }
    const r = ensureRef('/srv/atrium/x', map, NIX)
    assert.deepEqual(r.ref, { place: 'atrium', rel: 'x' })
    assert.equal(r.added, undefined)
    assert.equal(r.map, map)
  })

  test('unknown path: new place rooted there, input untouched', () => {
    const map = { atrium: '/srv/atrium' }
    const r = ensureRef('/data/atrium/', map, NIX)
    assert.deepEqual(r.ref, { place: 'atrium-2', rel: '' })
    assert.equal(r.added, 'atrium-2')
    assert.deepEqual(r.map, { atrium: '/srv/atrium', 'atrium-2': '/data/atrium' })
    assert.deepEqual(map, { atrium: '/srv/atrium' })
    assert.equal(ensureRef('d:/Work/App', {}, WIN).map.app, 'D:\\Work\\App')
  })
})

describe('place map on disk', () => {
  let root: string
  let n = 0
  before(() => { root = mkdtempSync(join(tmpdir(), 'tether-places-')) })
  after(() => { rmSync(root, { recursive: true, force: true }) })
  const fresh = (): string => join(root, `h${n++}`)

  test('round trip, sorted keys, no tmp left', () => {
    const home = fresh()
    writePlaceMap(home, { b: '/b', a: '/a' })
    assert.deepEqual(readPlaceMap(home), { a: '/a', b: '/b' })
    const text = readFileSync(placesPath(home), 'utf8')
    assert.equal(text, JSON.stringify({ v: 1, places: { a: '/a', b: '/b' } }, null, 2) + '\n')
    assert.deepEqual(readdirSync(home), ['places.json'])
  })

  test('absent file gives {}', () => {
    assert.deepEqual(readPlaceMap(fresh()), {})
  })

  test('corrupt JSON gives {}', () => {
    const home = fresh()
    writePlaceMap(home, {})
    writeFileSync(placesPath(home), '{ not json')
    assert.deepEqual(readPlaceMap(home), {})
    writeFileSync(placesPath(home), '[1]')
    assert.deepEqual(readPlaceMap(home), {})
  })

  test('malformed entries are dropped, the rest kept', () => {
    const home = fresh()
    writePlaceMap(home, {})
    writeFileSync(placesPath(home), JSON.stringify({
      v: 1,
      places: { ok: '/ok', Bad: '/x', num: 3, empty: '', home: '/h', '-x': '/y' },
    }))
    assert.deepEqual(readPlaceMap(home), { ok: '/ok' })
    assert.equal(existsSync(placesPath(home)), true)
  })
})
