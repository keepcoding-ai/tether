import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import type { SlotMeta, TetherEvent } from '../../src/core/event.ts'
import { slotEventsPath, slotMetaPath, slotRunPath, tetherHome } from '../../src/core/paths.ts'
import {
  appendEvent,
  clearRun,
  createSlot,
  listSlots,
  newSlotId,
  readEvents,
  readRun,
  readSlot,
  removeSlot,
  writeRun,
} from '../../src/core/store.ts'

let home: string
before(() => {
  home = mkdtempSync(join(tmpdir(), 'tether-store-'))
})
after(() => {
  rmSync(home, { recursive: true, force: true })
})

function meta(slotId: string, extra: Partial<SlotMeta> = {}): SlotMeta {
  return { v: 1, slotId, agent: 'claude', cwd: 'D:\\p', args: [], createdAt: '2026-10-29T00:00:00.000Z', ...extra }
}

function ev(slotId: string, n: number): TetherEvent {
  return { v: 1, ts: `2026-10-29T00:00:${String(n).padStart(2, '0')}.000Z`, slotId, agent: 'claude', kind: 'start', source: 'startup', sessionId: `s${n}` }
}

describe('paths', () => {
  test('TETHER_HOME wins; otherwise platform default', () => {
    assert.equal(tetherHome({ TETHER_HOME: 'X:\\th' }), 'X:\\th')
    const def = tetherHome({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' })
    if (process.platform === 'win32') assert.equal(def, join('C:\\Users\\u\\AppData\\Local', 'tether'))
    else assert.ok(def.endsWith(join('.local', 'state', 'tether')))
  })
  test('per-slot files live under <home>/slots', () => {
    assert.equal(slotMetaPath('h', 'ab'), join('h', 'slots', 'ab.json'))
    assert.equal(slotEventsPath('h', 'ab'), join('h', 'slots', 'ab.jsonl'))
    assert.equal(slotRunPath('h', 'ab'), join('h', 'slots', 'ab.run.json'))
  })
})

describe('slots', () => {
  test('newSlotId is short, filename-safe and unique', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 200; i++) ids.add(newSlotId(home))
    assert.equal(ids.size, 200)
    for (const id of ids) assert.match(id, /^[0-9a-f]{8}$/)
  })

  test('newSlotId skips an id that already exists', () => {
    // Fill the id space check by creating a slot and making sure the generator never returns it.
    const taken = newSlotId(home)
    createSlot(home, meta(taken))
    for (let i = 0; i < 50; i++) assert.notEqual(newSlotId(home), taken)
  })

  test('create / read / list / remove', () => {
    const a = meta('aaaa0001', { name: 'first', createdAt: '2026-10-29T00:00:01.000Z' })
    const b = meta('aaaa0002', { agent: 'soul', args: ['-H', 'http://x'], createdAt: '2026-10-29T00:00:02.000Z' })
    createSlot(home, a)
    createSlot(home, b)
    assert.throws(() => createSlot(home, a), /already exists/)
    assert.deepEqual(readSlot(home, 'aaaa0001'), a)
    assert.deepEqual(readSlot(home, 'aaaa0002'), b)
    assert.equal(readSlot(home, 'nope0000'), undefined)

    appendEvent(home, ev('aaaa0001', 1))
    writeRun(home, 'aaaa0001', { pid: 1, startedAt: 'x' })
    // A stray run file or a corrupt meta file must not show up as a slot.
    writeFileSync(slotMetaPath(home, 'bad00000'), '{not json')
    const listed = listSlots(home).map((m) => m.slotId)
    assert.ok(listed.includes('aaaa0001') && listed.includes('aaaa0002'))
    assert.ok(!listed.includes('bad00000'))
    assert.ok(listed.indexOf('aaaa0001') < listed.indexOf('aaaa0002'))

    removeSlot(home, 'aaaa0001')
    assert.equal(readSlot(home, 'aaaa0001'), undefined)
    assert.deepEqual(readEvents(home, 'aaaa0001'), [])
    assert.equal(readRun(home, 'aaaa0001'), undefined)
    assert.ok(readSlot(home, 'aaaa0002'), 'other slot untouched')
    removeSlot(home, 'aaaa0001') // idempotent
  })

  test('rejects ids that are not filename-safe', () => {
    assert.throws(() => createSlot(home, meta('../x')))
    assert.throws(() => readSlot(home, 'a/b'))
    assert.throws(() => removeSlot(home, ''))
  })

  test('listSlots on a missing home is empty', () => {
    assert.deepEqual(listSlots(join(home, 'does-not-exist')), [])
  })
})

describe('events', () => {
  test('appendEvent writes one line per event and creates the dirs', () => {
    const h = join(home, 'fresh', 'deeper')
    appendEvent(h, ev('ev000001', 1))
    appendEvent(h, ev('ev000001', 2))
    const text = readFileSync(slotEventsPath(h, 'ev000001'), 'utf8')
    assert.equal(text.split('\n').length, 3) // two lines + trailing newline
    assert.deepEqual(readEvents(h, 'ev000001').map((e) => e.sessionId), ['s1', 's2'])
  })

  test('readEvents skips blank, corrupt, partial and foreign-version lines', () => {
    const id = 'ev000002'
    const p = slotEventsPath(home, id)
    appendEvent(home, ev(id, 1))
    appendFileSync(p, '\n')
    appendFileSync(p, '{"v":1,"ts":"2026-10-29T00:00:0') // interrupted write, then a writer appended after it
    appendFileSync(p, '\n')
    appendEvent(home, ev(id, 2))
    appendFileSync(p, 'garbage not json\n')
    appendFileSync(p, JSON.stringify({ ...ev(id, 3), v: 2 }) + '\n')
    appendFileSync(p, JSON.stringify({ ...ev(id, 4), kind: 'bogus' }) + '\n')
    appendFileSync(p, '[1,2,3]\n')
    appendFileSync(p, 'null\n')
    appendEvent(home, ev(id, 5))
    appendFileSync(p, JSON.stringify(ev(id, 6)).slice(0, -8)) // partial last line, no newline
    assert.deepEqual(readEvents(home, id).map((e) => e.sessionId), ['s1', 's2', 's5'])
  })

  test('readEvents of a slot without events is empty', () => {
    assert.deepEqual(readEvents(home, 'noevents'), [])
  })
})

describe('run info', () => {
  test('write / read / clear', () => {
    const id = 'run00001'
    assert.equal(readRun(home, id), undefined)
    writeRun(home, id, { pid: 123, agentPid: 456, startedAt: '2026-10-29T00:00:00.000Z' })
    assert.deepEqual(readRun(home, id), { pid: 123, agentPid: 456, startedAt: '2026-10-29T00:00:00.000Z' })
    writeRun(home, id, { pid: 124, startedAt: 'later' })
    assert.deepEqual(readRun(home, id), { pid: 124, startedAt: 'later' })
    clearRun(home, id)
    assert.equal(readRun(home, id), undefined)
    clearRun(home, id)
    writeFileSync(slotRunPath(home, id), '{"pid":"x"}')
    assert.equal(readRun(home, id), undefined)
  })
})
