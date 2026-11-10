// The notices extensions put on the tray (app/main/tray-notices.ts): raised, updated, resolved; the tray hears each change.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TrayNotices } from '../../app/main/tray-notices.ts'

test('raise, update and resolve notify the tray and keep the list', () => {
  let changes = 0
  const n = new TrayNotices(() => { changes++ })
  const a = n.raise({ slotId: 's1', message: 'um' })
  const b = n.raise({ message: 'dois' })
  assert.deepEqual(n.list().map(x => [x.slotId, x.message]), [['s1', 'um'], [undefined, 'dois']])
  a.update('um de novo')
  a.update('um de novo')
  assert.equal(n.list()[0]!.message, 'um de novo')
  assert.equal(changes, 3, 'an update to the same text is no change')
  a.resolve(); a.resolve()
  b.dispose()
  assert.equal(n.list().length, 0)
  assert.equal(changes, 5)
})
