// The local-network question and the egress proxy's grants (Tether Browser E4): the pure rules (local-network-rules.ts), the
// main-side gate with its per-profile file (local-network.ts) and the copied egress proxy (egress/) as the tabs use it: a
// name that resolves to a local address is refused, a local IP needs one grant per use, and the credential is required.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Egress } from '../../extensions/browser/egress/egress.ts'
import { EgressProxy } from '../../extensions/browser/egress/egress-proxy.ts'
import { LocalNetworkGate } from '../../extensions/browser/local-network.ts'
import {
  choiceOf, decideLocalNetwork, destinationOf, egressGrantUrl, GRANTS_PER_PROFILE_MAX, grantsOf, hasGrant, localNetworkDialog,
  profileKeyOf, settingOf, TAB_EGRESS_POLICY, withGrant, type LocalNetworkAsk,
} from '../../extensions/browser/local-network-rules.ts'

describe('browser: local-network rules', () => {
  test('the setting: unknown is ask', () => {
    assert.equal(settingOf('allow'), 'allow')
    assert.equal(settingOf('deny'), 'deny')
    for (const v of ['ask', undefined, null, true, 'ALLOW', 1]) assert.equal(settingOf(v), 'ask')
  })

  test('destination: host:port, the scheme port when absent, http(s) only', () => {
    assert.equal(destinationOf('http://localhost:5173/x?y=1#z'), 'localhost:5173')
    assert.equal(destinationOf('http://LocalHost./'), 'localhost:80')
    assert.equal(destinationOf('https://192.168.0.10/'), '192.168.0.10:443')
    assert.equal(destinationOf('http://[::1]:8080/'), '[::1]:8080')
    assert.equal(destinationOf('http://user:pw@127.0.0.1:3000/'), '127.0.0.1:3000')
    for (const u of ['file:///C:/x', 'ws://localhost:1/', 'nonsense', 'data:text/html,x']) assert.equal(destinationOf(u), null)
  })

  test('decision by setting, profile and exact destination', () => {
    const g = withGrant({ profiles: {} }, 'p1', 'localhost:5173')
    assert.equal(decideLocalNetwork('allow', { profiles: {} }, 'p1', 'localhost:9'), 'allow')
    assert.equal(decideLocalNetwork('deny', g, 'p1', 'localhost:5173'), 'deny', 'deny wins over an "always"')
    assert.equal(decideLocalNetwork('ask', g, 'p1', 'localhost:5173'), 'allow')
    assert.equal(decideLocalNetwork('ask', g, 'p1', 'localhost:5174'), 'ask', 'another port asks')
    assert.equal(decideLocalNetwork('ask', g, 'p2', 'localhost:5173'), 'ask', 'another profile asks')
    assert.equal(decideLocalNetwork('ask', g, profileKeyOf(undefined), 'localhost:5173'), 'ask', 'no profile is its own key')
    assert.equal(profileKeyOf(undefined), '')
  })

  test('grants: validated from the file, deduplicated, capped, newest last', () => {
    assert.deepEqual(grantsOf(null), { profiles: {} })
    assert.deepEqual(grantsOf({ profiles: [] }), { profiles: {} })
    assert.deepEqual(grantsOf({ profiles: { a: ['localhost:1', 'localhost:1', 'bad', 3, 'x y:1', '[::1]:2'], b: 'no', c: [] } }), { profiles: { a: ['localhost:1', '[::1]:2'] } })
    let g = { profiles: {} as Record<string, string[]> }
    for (let i = 0; i < GRANTS_PER_PROFILE_MAX + 5; i++) g = withGrant(g, 'p', `localhost:${i + 1}`)
    assert.equal(g.profiles.p!.length, GRANTS_PER_PROFILE_MAX)
    assert.ok(!hasGrant(g, 'p', 'localhost:1') && hasGrant(g, 'p', `localhost:${GRANTS_PER_PROFILE_MAX + 5}`))
    g = withGrant(g, 'p', 'localhost:10')
    assert.equal(g.profiles.p!.at(-1), 'localhost:10')
    assert.ok(!hasGrant({ profiles: {} }, '__proto__', 'x:1') && !hasGrant({ profiles: {} }, 'constructor', 'x:1'))
  })

  test('the answer: only once and always grant', () => {
    assert.equal(choiceOf('once'), 'once')
    assert.equal(choiceOf('always'), 'always')
    for (const c of ['deny', 'cancel', undefined, 'ONCE']) assert.equal(choiceOf(c), 'deny')
  })

  test('the dialog: refusing is the default and Esc; the texts name the agent, the destination and the profile', () => {
    const d = localNetworkDialog({ id: 'x', agent: 'Ana', profile: 'trabalho', destination: 'localhost:5173' })
    assert.equal(d.title, 'Permitir que Ana abra localhost:5173?')
    assert.deepEqual(d.choices.map(c => [c.id, c.label, c.tone]), [['once', 'Só desta vez', 'neutral'], ['always', 'Sempre para este perfil', 'neutral'], ['deny', 'Não permitir', 'safe']])
    assert.equal(d.defaultChoice, 'deny')
    assert.equal(d.escChoice, 'deny')
    assert.match(d.choices[1]!.consequence, /perfil trabalho/)
    assert.match(localNetworkDialog({ id: 'y', agent: 'Ana', destination: 'localhost:1' }).choices[1]!.consequence, /sem perfil/)
  })

  test('egress grants: only a local IP literal or localhost (what the proxy would refuse); never a name', () => {
    const e = new Egress(TAB_EGRESS_POLICY)
    const priv = (h: string): boolean => e.isPrivateHost(h)
    assert.equal(egressGrantUrl('http://127.0.0.1:5173/a?b', priv), 'http://127.0.0.1:5173/a?b')
    assert.equal(egressGrantUrl('ws://localhost:5173/hmr', priv), 'ws://localhost:5173/hmr')
    assert.equal(egressGrantUrl('https://[::1]:8443/', priv), 'https://[::1]:8443/')
    assert.equal(egressGrantUrl('http://192.168.0.1/', priv), 'http://192.168.0.1/')
    assert.equal(egressGrantUrl('http://169.254.169.254/latest', priv), 'http://169.254.169.254/latest')
    for (const u of ['http://example.com/', 'http://rebind.test/', 'http://nas.local/', 'http://intranet/', 'http://127.0.0.1.nip.io/', 'file:///x', 'http://8.8.8.8/']) {
      assert.equal(egressGrantUrl(u, priv), null, u)
    }
  })
})

describe('browser: local-network gate', () => {
  const agentP = { name: 'Ana', profile: { id: 'p1', name: 'trabalho' } }
  const make = (setting: () => unknown) => {
    const dir = mkdtempSync(join(tmpdir(), 'tether-lng-'))
    const asks: LocalNetworkAsk[] = []
    const cancelled: string[] = []
    const gate = new LocalNetworkGate({ dir, setting, ask: a => asks.push(a), cancelled: id => cancelled.push(id), log: () => {} })
    return { dir, asks, cancelled, gate, done: () => rmSync(dir, { recursive: true, force: true }) }
  }

  test('allow and deny never ask', async () => {
    let s: unknown = 'allow'
    const t = make(() => s)
    try {
      assert.equal(await t.gate.request({ tabId: 't', url: 'http://localhost:5173/', agent: agentP }), true)
      s = 'deny'
      assert.equal(await t.gate.request({ tabId: 't', url: 'http://localhost:5173/', agent: agentP }), false)
      assert.equal(t.asks.length, 0)
    } finally { t.done() }
  })

  test('ask: once grants this time only; deny refuses; always is kept per profile in the file and asks no more', async () => {
    const t = make(() => undefined)
    try {
      const r1 = t.gate.request({ tabId: 't', url: 'http://localhost:5173/a', agent: agentP })
      assert.equal(t.asks.length, 1)
      assert.deepEqual({ ...t.asks[0]!, id: '' }, { id: '', agent: 'Ana', profile: 'trabalho', destination: 'localhost:5173' }, 'never the path')
      const dup = t.gate.request({ tabId: 't', url: 'http://localhost:5173/b', agent: agentP })
      assert.equal(t.asks.length, 1, 'the same tab and destination share the open question')
      assert.equal(t.gate.open().length, 1)
      t.gate.answer(t.asks[0]!.id, 'once')
      assert.equal(await r1, true)
      assert.equal(await dup, true)
      t.gate.answer(t.asks[0]!.id, 'deny')
      const r2 = t.gate.request({ tabId: 't', url: 'http://localhost:5173/', agent: agentP })
      assert.equal(t.asks.length, 2, 'once asks again next time')
      t.gate.answer(t.asks[1]!.id, 'cancel')
      assert.equal(await r2, false)
      const r3 = t.gate.request({ tabId: 't', url: 'http://localhost:5173/', agent: agentP })
      t.gate.answer(t.asks[2]!.id, 'always')
      assert.equal(await r3, true)
      assert.deepEqual(JSON.parse(readFileSync(join(t.dir, 'local-network.json'), 'utf8')), { profiles: { p1: ['localhost:5173'] } })
      assert.equal(await t.gate.request({ tabId: 'u', url: 'http://localhost:5173/z', agent: agentP }), true)
      assert.equal(t.asks.length, 3, 'always: no question')
      // Another profile and the agent without a profile still ask; a new gate reads the file.
      void t.gate.request({ tabId: 'u', url: 'http://localhost:5173/', agent: { name: 'Bia', profile: { id: 'p2', name: 'casa' } } })
      void t.gate.request({ tabId: 'v', url: 'http://localhost:5173/', agent: { name: 'Caio' } })
      assert.equal(t.asks.length, 5)
      const again = new LocalNetworkGate({ dir: t.dir, setting: () => 'ask', ask: () => assert.fail('asked'), cancelled: () => {}, log: () => {} })
      assert.equal(await again.request({ tabId: 'w', url: 'http://localhost:5173/', agent: agentP }), true)
      t.gate.dispose()
    } finally { t.done() }
  })

  test('a closed tab withdraws its questions (refused); dispose refuses the rest; a broken file reads as empty', async () => {
    const t = make(() => 'ask')
    try {
      writeFileSync(join(t.dir, 'local-network.json'), '{nope')
      const a = t.gate.request({ tabId: 't1', url: 'http://127.0.0.1:1/', agent: agentP })
      const b = t.gate.request({ tabId: 't2', url: 'http://127.0.0.1:1/', agent: agentP })
      t.gate.cancelTab('t1')
      assert.equal(await a, false)
      assert.deepEqual(t.cancelled, [t.asks[0]!.id])
      t.gate.answer(t.asks[0]!.id, 'always')
      assert.equal(t.gate.open().length, 1)
      t.gate.dispose()
      assert.equal(await b, false)
      assert.equal(await t.gate.request({ tabId: 't3', url: 'http://127.0.0.1:1/', agent: agentP }), false, 'after dispose')
    } finally { t.done() }
  })
})

describe('browser: the egress proxy as the tabs use it', () => {
  test('a name resolving to 127.0.0.1 is refused; a local IP needs one grant per use; no credential, no passage', async () => {
    const hits: string[] = []
    const server: Server = createServer((req, res) => { hits.push(req.url ?? ''); res.end('ok') })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    const egress = new Egress(TAB_EGRESS_POLICY, async host => {
      if (host === 'rebind.test') return ['127.0.0.1']
      throw new Error('no lookup in a unit test')
    })
    const proxy = await EgressProxy.start(egress)
    const p = new URL(proxy.server)
    const auth = `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}`
    const get = (url: string, withAuth = true): Promise<string> => new Promise(resolve => {
      const req = request({ host: p.hostname, port: Number(p.port), method: 'GET', path: url, agent: false, headers: withAuth ? { 'proxy-authorization': auth } : {} }, res => {
        let body = ''
        res.on('data', c => { body += c })
        res.on('end', () => resolve(`${res.statusCode} ${body}`))
      })
      req.on('error', () => resolve('dropped'))
      req.end()
    })
    try {
      assert.equal(egressGrantUrl(`http://rebind.test:${port}/name`, h => egress.isPrivateHost(h)), null, 'the filter grants nothing to a name')
      assert.equal(await get(`http://rebind.test:${port}/name`), 'dropped', 'public name → local IP')
      assert.notEqual(proxy.grant(`http://rebind.test:${port}/name2`), null)
      assert.equal(await get(`http://rebind.test:${port}/name2`), 'dropped', 'even a grant does not open a name that resolves local')
      assert.equal(await get(`http://127.0.0.1:${port}/nogrant`), 'dropped', 'local IP without a grant')
      proxy.grant(`http://127.0.0.1:${port}/granted`)
      assert.equal(await get(`http://127.0.0.1:${port}/granted`, false), '407 ', 'no credential')
      assert.equal(await get(`http://127.0.0.1:${port}/granted`), '200 ok', `the grant opens it: ${egress.internalLog.join(' / ')}`)
      assert.equal(await get(`http://127.0.0.1:${port}/granted`), 'dropped', 'once')
      const id = proxy.grant(`http://127.0.0.1:${port}/revoked`)!
      proxy.revoke(id)
      assert.equal(await get(`http://127.0.0.1:${port}/revoked`), 'dropped', 'a revoked grant')
      assert.deepEqual(hits, ['/granted'])
    } finally {
      await proxy.close()
      server.close()
    }
  })
})
