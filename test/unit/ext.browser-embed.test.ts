// The browser's feed for the Regency ("+ Novo" > Navegador): the pure rules of a tab born for an agent or for her, and the feed
// itself (inactive: `no-browser`; publishing: calls go to the source; a stale handle does not turn a newer source off).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bornForAgentVerdict, personTabRoom, PERSON_OWNER, TABS_PER_OWNER } from '../../extensions/browser/tab-rules.ts'
import { createBrowserEmbeds, type BrowserEmbedSource } from '../../extensions/browser/renderer/embed.ts'

const AGENT = 'a1b2c3d4'

test('born for an agent (verdict): only a live agent under its ceiling, never the person', () => {
  assert.equal(bornForAgentVerdict(AGENT, { alive: true }, 0), 'ok')
  assert.equal(bornForAgentVerdict(AGENT, { alive: false }, 0), 'no-agent')
  assert.equal(bornForAgentVerdict(AGENT, undefined, 0), 'no-agent')
  assert.equal(bornForAgentVerdict(PERSON_OWNER, { alive: true }, 0), 'no-agent')
  assert.equal(bornForAgentVerdict('../x', { alive: true }, 0), 'no-agent')
  assert.equal(bornForAgentVerdict(AGENT, { alive: true }, TABS_PER_OWNER), 'full')
})

test('her tabs: room under the ceiling only', () => {
  assert.equal(personTabRoom(0), true)
  assert.equal(personTabRoom(TABS_PER_OWNER - 1), true)
  assert.equal(personTabRoom(TABS_PER_OWNER), false)
})

test('the feed: off answers no-browser; on forwards; a stale handle leaves the newer source', async () => {
  const feed = createBrowserEmbeds()
  assert.equal(feed.active, false)
  assert.deepEqual(await feed.newTab({ deskId: 'desk-2' }), { ok: false, why: 'no-browser' })
  assert.deepEqual(await feed.newTabFor(AGENT, { deskId: 'desk-2' }), { ok: false, why: 'no-browser' })
  const calls: string[] = []
  const source = (name: string): BrowserEmbedSource => ({
    newTab: async o => { calls.push(`${name}:me:${o.deskId}:${o.url ?? ''}`); return { ok: true, tabId: 't1' } },
    newTabFor: async (s, o) => { calls.push(`${name}:${s}:${o.deskId}`); return { ok: false, why: 'full' } },
  })
  const first = feed.publish(source('a'))
  assert.equal(feed.active, true)
  assert.deepEqual(await feed.newTab({ deskId: 'desk-2', url: 'x.com' }), { ok: true, tabId: 't1' })
  assert.deepEqual(await feed.newTabFor(AGENT, { deskId: 'desk-3' }), { ok: false, why: 'full' })
  const second = feed.publish(source('b'))
  first.dispose()
  assert.equal(feed.active, true, 'the stale handle did not turn the newer source off')
  await feed.newTab({ deskId: 'desk-1' })
  second.dispose()
  assert.equal(feed.active, false)
  assert.deepEqual(calls, ['a:me:desk-2:x.com', `a:${AGENT}:desk-3`, 'b:me:desk-1:'])
})
