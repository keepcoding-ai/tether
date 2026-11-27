// The Regency's place in the remote web client's address: channel, phone tab, "Por mesa / Por agente" and filter. Pure
// (remote/web/src/url-state.ts): string <-> state, whatever the address holds read as hostile, nothing sensitive in it.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { readLayout } from '../../extensions/regency/renderer/layout-rules.ts'
import { formatUrlState, paramsOfUrlState, parseUrlState, urlStateOf, writeUrlState, type UrlState } from '../../remote/web/src/url-state.ts'

describe('the Regency\'s state in the address', () => {
  test('goes and comes back: parse(format(state)) is the state', () => {
    const states: UrlState[] = [
      {},
      { channelId: 'c_k3j9x2a' },
      { channelId: 'c_k3j9x2a', narrowTab: 'conversation' },
      { narrowTab: 'tether', view: 'agent', filter: 'busy' },
      { channelId: 'desk:7', narrowTab: 'tether', view: 'agent', filter: 'asleep' },
    ]
    for (const s of states) assert.deepEqual(parseUrlState(formatUrlState(s)), s)
  })

  test('the defaults stay out of the address, and the keys come in a fixed order', () => {
    assert.equal(formatUrlState({ narrowTab: 'waiting', view: 'desk', filter: 'all' }), '')
    assert.equal(formatUrlState({ filter: 'idle', channelId: 'c_a', view: 'agent', narrowTab: 'tether' }), '?c=c_a&tab=tether&view=agent&filter=idle')
  })

  test('a layout goes to the address and its parameters come back as the same layout', () => {
    const l = readLayout({ channelId: 'c_abc', narrowTab: 'tether', view: 'agent', filter: 'waiting', collapsed: ['d1'], membersOpen: true })
    const back = readLayout(paramsOfUrlState(parseUrlState(formatUrlState(urlStateOf(l)))))
    assert.deepEqual([back.channelId, back.narrowTab, back.view, back.filter], ['c_abc', 'tether', 'agent', 'waiting'])
    // What the address does not keep falls to the default (it is the pane's, not the address's).
    assert.deepEqual([back.collapsed, back.membersOpen], [[], false])
  })

  test('hostile values are dropped one by one, and what is valid still stands', () => {
    const hostile = [
      '?c=<script>alert(1)</script>', '?c=' + 'a'.repeat(81), '?c=a b', '?c=../../etc', '?c=a%00b', '?c=%E0%A4%A', '?c=javascript:1', '?c=',
      '?tab=__proto__', '?tab=constructor', '?view=toString', '?filter=all%20or%201=1', '?filter=ALL', '?tab=waiting&tab=tether&c=a&c=b',
      '?__proto__[channelId]=x', '?pair=abc', '?code=123456789012', '??&&==', '#pair=abc',
    ]
    for (const q of hostile) {
      const s = parseUrlState(q)
      for (const k of Object.keys(s)) assert.ok(['channelId', 'narrowTab', 'view', 'filter'].includes(k), `${q}: key ${k}`)
      assert.ok(s.channelId === undefined || /^[A-Za-z0-9_.:-]{1,80}$/.test(s.channelId), `${q}: ${s.channelId}`)
      assert.ok(s.narrowTab === undefined || ['waiting', 'conversation', 'tether'].includes(s.narrowTab), q)
      assert.ok(s.view === undefined || ['desk', 'agent'].includes(s.view), q)
      assert.ok(s.filter === undefined || ['all', 'waiting', 'busy', 'idle', 'asleep'].includes(s.filter), q)
    }
    assert.deepEqual(parseUrlState('?c=<b>&tab=conversation&view=nope&filter=busy'), { narrowTab: 'conversation', filter: 'busy' })
    assert.deepEqual(parseUrlState('?tab=waiting&tab=tether'), { narrowTab: 'waiting' })
    // What is not the Regency's is not read: a pairing code or a key in the query is ignored, never carried over.
    assert.deepEqual(parseUrlState('?code=123456789012&key=abc&text=hello'), {})
  })

  test('format refuses to write a value that is not valid', () => {
    assert.equal(formatUrlState({ channelId: '<x>' }), '')
    assert.equal(formatUrlState({ channelId: 'secret text with spaces' }), '')
    assert.equal(formatUrlState({ narrowTab: 'nope' as never, view: 'x' as never, filter: 'y' as never }), '')
  })

  test('writing the address keeps the path and the fragment, and writes only what changed', () => {
    const calls: string[] = []
    const hist = { replaceState: (_d: unknown, _u: string, url: string) => { calls.push(url) } }
    writeUrlState({ pathname: '/app/', search: '', hash: '' }, hist, { channelId: 'c_a', view: 'agent' })
    writeUrlState({ pathname: '/app/', search: '?c=c_a&view=agent', hash: '' }, hist, { channelId: 'c_a', view: 'agent' })
    writeUrlState({ pathname: '/app/', search: '?c=c_a', hash: '#x' }, hist, {})
    assert.deepEqual(calls, ['/app/?c=c_a&view=agent', '/app/#x'])
  })
})
