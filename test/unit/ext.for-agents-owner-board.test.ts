// The owner board of for-agents: a publication reaches the readers, an equal one does not, and off it is empty and silent.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createOwnerBoard } from '../../extensions/for-agents/renderer/owner-board.ts'
import type { Ownership } from '../../extensions/for-agents/rules.ts'

const own = (owner: string): Ownership => ({ owner, since: '2026-11-25T10:00:00Z', givenBy: 'user' }) as Ownership

describe('owner board', () => {
  test('starts inactive and empty; publishing while inactive does nothing', () => {
    const b = createOwnerBoard()
    assert.equal(b.active, false)
    b.publish(new Map([['d1', own('s1')]]), new Map())
    assert.equal(b.deskOwner('d1'), undefined)
  })

  test('publishes desks and panes; an equal publication does not notify', () => {
    const b = createOwnerBoard()
    b.setActive(true)
    let n = 0
    b.onDidChange(() => { n++ })
    b.publish(new Map([['d1', own('s1')]]), new Map([['p1', own('s2')]]))
    assert.equal(n, 1)
    assert.equal(b.deskOwner('d1')?.owner, 's1')
    assert.equal(b.paneOwner('p1')?.owner, 's2')
    b.publish(new Map([['d1', own('s1')]]), new Map([['p1', own('s2')]]))
    assert.equal(n, 1)
    b.publish(new Map([['d1', own('s3')]]), new Map([['p1', own('s2')]]))
    assert.equal(n, 2)
    assert.equal(b.deskOwner('d1')?.owner, 's3')
    b.publish(new Map(), new Map())
    assert.equal(n, 3)
    assert.equal(b.deskOwner('d1'), undefined)
  })

  test('turning off clears without notifying', () => {
    const b = createOwnerBoard()
    b.setActive(true)
    b.publish(new Map([['d1', own('s1')]]), new Map())
    let n = 0
    b.onDidChange(() => { n++ })
    b.setActive(false)
    assert.equal(b.active, false)
    assert.equal(b.deskOwner('d1'), undefined)
    assert.equal(n, 0)
    b.setActive(true)
    b.publish(new Map([['d1', own('s1')]]), new Map())
    assert.equal(n, 1, 'a fresh activation starts over')
  })
})
