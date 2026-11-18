// The closed history (extensions/browser/closed-history.ts): what enters (never an address with a credential), expiry by the
// setting, the ceiling, the file read back, the groups by agent, and which tabs close when their agent ends.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CLOSED_HISTORY_MAX, type ClosedTab, closedEntryOf, closedGroups, keepMs, keepOf, parseClosed, pruneClosed, tabsToCloseOnEnd,
} from '../../extensions/browser/closed-rules.ts'
import { ClosedHistory } from '../../extensions/browser/closed-history.ts'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000
const entry = (id: string, closedAt: number, over: Partial<ClosedTab> = {}): ClosedTab =>
  ({ id, ownerSlotId: 'a', ownerName: 'Sonda', title: id, url: `https://${id}.test/`, closedAt, by: 'agent', ...over })

describe('browser closed history: what enters', () => {
  test('a web address enters with owner, title, when and who', () => {
    const e = closedEntryOf({ tabId: 't1', ownerSlotId: 's1', ownerName: 'Sonda', title: 'Docs', url: 'https://docs.test/a?q=1', closedAt: NOW, by: 'user' })
    assert.deepEqual(e, { id: 't1', ownerSlotId: 's1', ownerName: 'Sonda', title: 'Docs', url: 'https://docs.test/a?q=1', closedAt: NOW, by: 'user' })
  })

  test('an address that carried a credential never enters (the layout.json rule)', () => {
    for (const url of ['https://x.test/cb?token=abc', 'https://x.test/#access_token=abc', 'https://user:pw@x.test/', 'https://x.test/?api-key=1', 'https://x.test/?code=9']) {
      assert.equal(closedEntryOf({ tabId: 't1', ownerSlotId: 's1', url, closedAt: NOW, by: 'agent' }), undefined, url)
    }
  })

  test('the blank page, other schemes and bad ids do not enter', () => {
    for (const url of ['about:blank', 'file:///c:/x', 'javascript:alert(1)', '']) assert.equal(closedEntryOf({ tabId: 't1', ownerSlotId: 's1', url, closedAt: NOW, by: 'agent' }), undefined, url)
    assert.equal(closedEntryOf({ tabId: 'a b', ownerSlotId: 's1', url: 'https://x.test/', closedAt: NOW, by: 'agent' }), undefined)
    assert.equal(closedEntryOf({ tabId: 't1', ownerSlotId: '', url: 'https://x.test/', closedAt: NOW, by: 'agent' }), undefined)
  })
})

describe('browser closed history: expiry and ceiling', () => {
  test('the setting: 7 days by default, an unknown value reads as the default', () => {
    assert.equal(keepOf(undefined), '7d')
    assert.equal(keepOf('2d'), '7d')
    assert.equal(keepOf('never'), 'never')
    assert.deepEqual(['1d', '7d', '30d', 'never'].map(k => keepMs(keepOf(k))), [DAY, 7 * DAY, 30 * DAY, undefined])
  })

  test('older than the setting goes; newest first', () => {
    const items = [entry('old', NOW - 8 * DAY), entry('new', NOW - 1000), entry('mid', NOW - 2 * DAY)]
    assert.deepEqual(pruneClosed(items, NOW, '7d').map(e => e.id), ['new', 'mid'])
    assert.deepEqual(pruneClosed(items, NOW, '1d').map(e => e.id), ['new'])
    assert.deepEqual(pruneClosed(items, NOW, '30d').map(e => e.id), ['new', 'mid', 'old'])
  })

  test('the ceiling drops the oldest, with "never" too', () => {
    const items = Array.from({ length: CLOSED_HISTORY_MAX + 20 }, (_, i) => entry(`t${i}`, NOW - i * 365 * DAY))
    const kept = pruneClosed(items, NOW, 'never')
    assert.equal(kept.length, CLOSED_HISTORY_MAX)
    assert.equal(kept[0]!.id, 't0')
    assert.equal(kept.at(-1)!.id, `t${CLOSED_HISTORY_MAX - 1}`)
    assert.equal(pruneClosed(items.slice(0, 5), NOW, 'never', 3).length, 3)
  })

  test('an entry is kept once', () => {
    assert.deepEqual(pruneClosed([entry('a', NOW), entry('a', NOW - 1)], NOW, '7d').map(e => e.closedAt), [NOW])
  })
})

describe('browser closed history: the file', () => {
  test('read back: only well-formed entries; a credential written by hand is dropped again', () => {
    const raw = { v: 1, items: [entry('ok', NOW), { ...entry('cred', NOW), url: 'https://x.test/?token=1' }, { id: 'x' }, null, { ...entry('by', NOW), by: 'hacker' }] }
    const out = parseClosed(raw)
    assert.deepEqual(out.map(e => e.id), ['ok', 'by'])
    assert.equal(out[1]!.by, 'user')
    assert.deepEqual(parseClosed({ v: 2, items: [entry('a', NOW)] }), [])
    assert.deepEqual(parseClosed('junk'), [])
  })

  test('the store: records, expires at read with the setting of now, reopens and clears', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tether-closed-'))
    try {
      const file = join(dir, 'browser', 'closed-tabs.json')
      let now = NOW
      let keep: '1d' | '7d' = '7d'
      const h = await ClosedHistory.open({ file, keep: () => keep, now: () => now })
      assert.equal(h.record(entry('a', NOW - 2 * DAY)), true)
      assert.equal(h.record(entry('b', NOW)), true)
      assert.equal(h.record(entry('b', NOW)), false, 'twice: once')
      assert.equal(h.record(undefined), false)
      assert.deepEqual(h.list().map(e => e.id), ['b', 'a'])
      await h.flush()
      if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600)
      keep = '1d'
      assert.deepEqual(h.list().map(e => e.id), ['b'], 'the setting changed: expired at the next read')
      await h.flush()
      assert.deepEqual(parseClosed(JSON.parse(readFileSync(file, 'utf8'))).map(e => e.id), ['b'], 'and written back')
      now = NOW + 2 * DAY
      const again = await ClosedHistory.open({ file, keep: () => '7d', now: () => now })
      assert.deepEqual(again.list().map(e => e.id), ['b'], 'a new opening reads the file')
      again.remove('b')
      assert.deepEqual(again.list(), [])
      again.record(entry('c', now))
      again.clear()
      await again.flush()
      assert.deepEqual((await ClosedHistory.open({ file, keep: () => '7d', now: () => now })).list(), [])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('expired at start: the file is rewritten without them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tether-closed-'))
    try {
      const file = join(dir, 'closed-tabs.json')
      const first = await ClosedHistory.open({ file, keep: () => '30d', now: () => NOW })
      first.record(entry('old', NOW - 10 * DAY))
      await first.flush()
      await (await ClosedHistory.open({ file, keep: () => '7d', now: () => NOW })).flush()
      assert.deepEqual(parseClosed(JSON.parse(readFileSync(file, 'utf8'))), [])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('browser closed history: by agent', () => {
  test('owners in the order of their newest entry, each newest first', () => {
    const g = closedGroups([entry('a1', NOW - 5), entry('b1', NOW - 1, { ownerSlotId: 'b', ownerName: 'Beta' }), entry('a2', NOW)])
    assert.deepEqual(g.map(x => [x.slotId, x.name, x.items.map(i => i.id)]), [['a', 'Sonda', ['a2', 'a1']], ['b', 'Beta', ['b1']]])
  })
})

describe('browser closed history: an agent that ended', () => {
  const tabs = [{ tabId: 't1', ownerSlotId: 'a' }, { tabId: 't2', ownerSlotId: 'a' }, { tabId: 't3', ownerSlotId: 'a' }, { tabId: 't4', ownerSlotId: 'b' }, { tabId: 't5', ownerSlotId: 'a' }]
  const controls: Record<string, { holder: 'agent' | 'user'; asking: boolean }> = {
    t1: { holder: 'agent', asking: false }, t2: { holder: 'user', asking: false }, t3: { holder: 'user', asking: true },
  }
  test('its tabs close, except the ones with the person (taken, or a request open); other agents\' stay', () => {
    assert.deepEqual(tabsToCloseOnEnd(tabs, 'a', id => controls[id]).map(t => t.tabId), ['t1', 't5'])
  })
  test('a request flagged on a tab still marked as the agent\'s keeps it open', () => {
    assert.deepEqual(tabsToCloseOnEnd([{ tabId: 'x', ownerSlotId: 'a' }], 'a', () => ({ holder: 'agent', asking: true })), [])
  })
})
