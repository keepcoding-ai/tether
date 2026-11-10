// The pane id → tab map (app/renderer/tab-tracking.ts): dockview's overflow rows must not steal the header tab's entry.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { trackedTab } from '../../app/renderer/tab-tracking.ts'

class FakeTab { init(_p: never): void {} dispose(): void {} }

test('trackedTab: an overflow row opening and closing keeps the header tab in the map', () => {
  const map = new Map<string, FakeTab>()
  const header = trackedTab(new FakeTab(), map)
  ;(header.init as (p: unknown) => void)({ api: { id: 's1' }, tabLocation: 'header' })
  assert.equal(map.get('s1'), header)
  const row = trackedTab(new FakeTab(), map)
  ;(row.init as (p: unknown) => void)({ api: { id: 's1' }, tabLocation: 'headerOverflow' })
  assert.equal(map.get('s1'), header, 'the overflow row does not replace the header tab')
  row.dispose()
  assert.equal(map.get('s1'), header, 'closing the dropdown does not drop the header tab')
  header.dispose()
  assert.equal(map.has('s1'), false)
})

test('trackedTab: a tab without tabLocation counts as the header tab', () => {
  const map = new Map<string, FakeTab>()
  const t = trackedTab(new FakeTab(), map)
  ;(t.init as (p: unknown) => void)({ api: { id: 's2' } })
  assert.equal(map.get('s2'), t)
})
