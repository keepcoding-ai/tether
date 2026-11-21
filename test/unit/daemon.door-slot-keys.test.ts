// The slot key digests survive a tetherd restart (<home>/door/slot-keys.json): the key proves again after a new SlotKeys reads
// the same home; revoke ends it for good; the file holds the sha256 digest and never the key.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { SlotKeys, slotKeysPath } from '../../src/daemon/door/slot-key.ts'
import { removeHome, tempHome } from './daemon.helpers.ts'

async function boot(home: string): Promise<SlotKeys> {
  const keys = new SlotKeys()
  keys.attach(home)
  await keys.ready
  return keys
}

describe('slot keys on disk', () => {
  let home: string
  before(() => { home = tempHome() })
  after(async () => { await removeHome(home) })

  test('a key issued before a restart still proves after it; revoke holds across restarts; the key is not in the file', async () => {
    const first = await boot(home)
    const key = first.issue('aa000001')
    const other = first.issue('aa000002')
    await first.flush()
    const text = readFileSync(slotKeysPath(home), 'utf8')
    assert.ok(!text.includes(key) && !text.includes(other), 'key in the file')
    assert.match(text, /"aa000001":"[0-9a-f]{64}"/)

    const second = await boot(home)
    assert.equal(second.verify('aa000001', key), true)
    assert.equal(second.verify('aa000001', key + 'x'), false)
    assert.equal(second.verify('aa000002', other), true)

    second.revoke('aa000001')
    await second.flush()
    const third = await boot(home)
    assert.equal(third.verify('aa000001', key), false)
    assert.equal(third.verify('aa000002', other), true)

    // A cancelled launch (revoke with a stale key) does not end the newer run's key, on disk either.
    const newer = third.issue('aa000002')
    third.revoke('aa000002', other)
    await third.flush()
    const fourth = await boot(home)
    assert.equal(fourth.verify('aa000002', newer), true)
    assert.equal(fourth.verify('aa000002', other), false)
  })

  test('a missing or unreadable file is ignored', async () => {
    const h = tempHome()
    try {
      assert.equal((await boot(h)).verify('x', 'y'), false)
    } finally { await removeHome(h) }
  })
})
