// Unit tests of the fault registry (src/core/faults.ts): append + state, the reopen and ignored rules, the storm
// guard, tolerance to corrupt files, signature stability across builds (with and without source maps) and the
// short ids (first claimant keeps its 4 hex, a later colliding sig gets 6).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assignShortId, createBundleMapper, decodeMappings, faultSig, faultsDir, normalizeMessage, readOccurrences, readState, record, resolveId, STORM_LIMIT, STORM_WINDOW_MS, statePath, writeState, type FaultInput } from '../../src/core/faults.ts'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'tether-faults-'))
const input = (over: Partial<FaultInput> = {}): FaultInput => ({ proc: 'main', kind: 'uncaught', message: 'boom', stack: 'Error: boom\n    at a (C:\\x\\dist\\m.cjs:1:2)', ...over })
const opts = (dir: string, now = 1_700_000_000_000) => ({ dir, now: () => now, version: '1.0.0', mapper: null })

test('faultsDir lives under the user dir', () => {
  assert.equal(faultsDir({ TETHER_USER_DIR: 'X:\\u' }), join('X:\\u', 'faults'))
})

test('record appends a line and creates the state', () => {
  const dir = tmp()
  const r = record(input({ context: { slot: 's1' } }), opts(dir))!
  assert.ok(r.written)
  const { items, skipped } = readOccurrences(dir)
  assert.equal(skipped, 0)
  assert.equal(items.length, 1)
  assert.equal(items[0]!.proc, 'main')
  assert.equal(items[0]!.kind, 'uncaught')
  assert.equal(items[0]!.version, '1.0.0')
  assert.equal(items[0]!.sig, r.sig)
  assert.deepEqual(items[0]!.context, { slot: 's1' })
  const st = readState(dir).state.faults[r.sig]!
  assert.equal(st.status, 'open')
  assert.equal(st.count, 1)
  rmSync(dir, { recursive: true })
})

test('every occurrence is kept; the state counts them', () => {
  const dir = tmp()
  record(input(), opts(dir, 1_000))
  const r = record(input(), opts(dir, 2_000))!
  assert.equal(readOccurrences(dir).items.length, 2)
  assert.equal(r.state.count, 2)
  assert.notEqual(r.state.first, r.state.last)
  rmSync(dir, { recursive: true })
})

test('a done sig that occurs again reopens with `returned`; ignored never reopens', () => {
  const dir = tmp()
  const a = record(input(), opts(dir))!
  const b = record(input({ message: 'other' }), opts(dir))!
  const s = readState(dir).state
  s.faults[a.sig]!.status = 'done'
  s.faults[b.sig]!.status = 'ignored'
  writeState(dir, s)
  const a2 = record(input(), { ...opts(dir), version: '2.0.0' })!
  const b2 = record(input({ message: 'other' }), opts(dir))!
  assert.equal(a2.state.status, 'open')
  assert.equal(a2.state.returned?.version, '2.0.0')
  assert.equal(b2.state.status, 'ignored')
  assert.equal(b2.state.count, 2)
  assert.equal(b2.state.returned, undefined)
  rmSync(dir, { recursive: true })
})

test('storm guard: past the limit inside the window only the count grows; a new window writes again', () => {
  const dir = tmp()
  for (let i = 0; i < STORM_LIMIT + 10; i++) record(input(), opts(dir, 1_000 + i))
  assert.equal(readOccurrences(dir).items.length, STORM_LIMIT)
  const sig = Object.keys(readState(dir).state.faults)[0]!
  assert.equal(readState(dir).state.faults[sig]!.count, STORM_LIMIT + 10)
  record(input(), opts(dir, 1_000 + STORM_WINDOW_MS + 5))
  assert.equal(readOccurrences(dir).items.length, STORM_LIMIT + 1)
  rmSync(dir, { recursive: true })
})

test('a corrupt jsonl line is skipped and counted', () => {
  const dir = tmp()
  record(input(), opts(dir))
  writeFileSync(join(dir, 'faults.jsonl'), readFileSync(join(dir, 'faults.jsonl'), 'utf8') + '{nao eh json\n[1]\n')
  record(input({ message: 'again' }), opts(dir))
  const { items, skipped } = readOccurrences(dir)
  assert.equal(items.length, 2)
  assert.equal(skipped, 2)
  rmSync(dir, { recursive: true })
})

test('a corrupt state file is copied aside and reset; record keeps working', () => {
  const dir = tmp()
  mkdirSync(dir, { recursive: true })
  writeFileSync(statePath(dir), '{ quebrado')
  const r = record(input(), opts(dir))!
  assert.equal(r.state.count, 1)
  assert.ok(readdirSync(dir).some(f => f.startsWith('faults-state.json.corrompido-')))
  assert.equal(readOccurrences(dir).items.length, 1)
  rmSync(dir, { recursive: true })
})

test('normalizeMessage strips numbers, absolute paths and ids but keeps relative module names', () => {
  assert.equal(normalizeMessage("Cannot find module './impl/format' from D:\\a\\b.js (pid 123)"), "Cannot find module './impl/format' from <path> (pid <n>)")
  assert.equal(normalizeMessage('slot 3f2a9c1e-1111-2222-3333-444455556666 failed'), 'slot <id> failed')
})

test('sig is stable across builds: other line numbers and bundle folders (no map)', () => {
  const a = 'TypeError: x is 5\n    at fn (D:\\one\\app\\dist\\main-app.cjs:120:7)\n    at run (D:\\one\\app\\dist\\main-app.cjs:300:1)'
  const b = 'TypeError: x is 9\n    at fn (/home/u/other/app/dist/main-app.cjs:4410:99)\n    at run (/home/u/other/app/dist/main-app.cjs:12:3)'
  assert.equal(faultSig('TypeError: x is 5', a, null), faultSig('TypeError: x is 9', b, null))
  const c = a.replace('at run', 'at walk')
  assert.notEqual(faultSig('TypeError: x is 5', a, null), faultSig('TypeError: x is 5', c, null))
})

// ---- source maps: a tiny VLQ encoder to build synthetic maps ----
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function vlq(n: number): string {
  let v = n < 0 ? (-n << 1) | 1 : n << 1
  let s = ''
  do { let d = v & 31; v >>>= 5; if (v) d |= 32; s += B64[d] } while (v)
  return s
}
const seg = (...f: number[]): string => f.map(vlq).join('')

/** A bundle folder whose map sends generated line `line` (1-based) to the given source, at column 0. */
function build(root: string, name: string, line: number, source: string): string {
  const dist = join(root, name, 'app', 'dist')
  mkdirSync(dist, { recursive: true })
  writeFileSync(join(root, name, 'package.json'), '{}')
  writeFileSync(join(dist, 'main-app.cjs'), '')
  const mappings = ';'.repeat(line - 1) + seg(0, 0, 4, 0)
  writeFileSync(join(dist, 'main-app.cjs.map'), JSON.stringify({ version: 3, sources: [source], names: [], mappings }))
  return join(dist, 'main-app.cjs')
}

test('decodeMappings reads relative segments across lines', () => {
  const lines = decodeMappings(`${seg(0, 0, 4, 2)},${seg(10, 0, 1, 3)};;${seg(5, 0, -5, 0)}`)
  assert.deepEqual([...lines[0]!], [0, 0, 4, 2, 10, 0, 5, 5])
  assert.equal(lines[1]!.length, 0)
  assert.deepEqual([...lines[2]!], [5, 0, 0, 5])
})

test('sig is stable across builds when a source map exists, and moves with the original source', () => {
  const root = tmp()
  const a = build(root, 'buildA', 3, '../../src/core/thing.ts')
  const b = build(root, 'buildB', 40, '../../src/core/thing.ts') // same source, shifted far down the bundle
  const other = build(root, 'buildC', 3, '../../src/core/different.ts')
  const stack = (file: string, line: number): string => `Error: boom\n    at doIt (${file}:${line}:9)`
  const mapper = createBundleMapper()
  const sa = faultSig('boom', stack(a, 3), mapper)
  assert.equal(sa, faultSig('boom', stack(b, 40), mapper))
  assert.notEqual(sa, faultSig('boom', stack(other, 3), mapper))
  // without the map the base name is the same here, so the mapped sig is what tells the sources apart
  assert.equal(faultSig('boom', stack(a, 3), null), faultSig('boom', stack(other, 3), null))
  rmSync(root, { recursive: true })
})

test('short ids: the first sig keeps 4 hex, a later one sharing the prefix gets 6, then 8', () => {
  const sigA = 'abcd1111' + '0'.repeat(56)
  const sigB = 'abcd2222' + '0'.repeat(56)
  const sigC = 'abcd2233' + '3'.repeat(56)
  const faults: Record<string, { shortId: string }> = {}
  for (const s of [sigA, sigB, sigC]) faults[s] = { shortId: assignShortId(s, Object.values(faults).map(f => f.shortId)) }
  assert.equal(faults[sigA]!.shortId, 'abcd')
  assert.equal(faults[sigB]!.shortId, 'abcd22')
  assert.equal(faults[sigC]!.shortId, 'abcd2233')
})

test('resolveId: stored short id first, then unique prefix of the sig, else candidates', () => {
  const sigA = 'abcd1111' + '0'.repeat(56)
  const sigB = 'abcd2222' + '0'.repeat(56)
  const faults = { [sigA]: { shortId: 'abcd' }, [sigB]: { shortId: 'abcd22' } }
  assert.deepEqual(resolveId(faults, 'abcd'), { sig: sigA }) // exact stored id wins although 'abcd' prefixes both
  assert.deepEqual(resolveId(faults, 'abcd22'), { sig: sigB })
  assert.deepEqual(resolveId(faults, 'abcd2'), { sig: sigB })
  assert.deepEqual(resolveId(faults, 'abc'), { candidates: [sigA, sigB] })
  assert.deepEqual(resolveId(faults, 'ffff'), { candidates: [] })
  assert.deepEqual(resolveId(faults, sigA), { sig: sigA })
})

test('record assigns the short id once and keeps it when a colliding sig arrives later', () => {
  const dir = tmp()
  const first = record(input(), opts(dir))!
  const state = readState(dir).state
  // forge a later sig that collides with the first one's 4-hex id
  const forged = first.sig.slice(0, 4) + 'f'.repeat(60)
  assert.equal(assignShortId(forged, Object.values(state.faults).map(f => f.shortId)), forged.slice(0, 6))
  record(input(), opts(dir))
  assert.equal(readState(dir).state.faults[first.sig]!.shortId, first.sig.slice(0, 4))
  assert.ok(existsSync(statePath(dir)))
  rmSync(dir, { recursive: true })
})
