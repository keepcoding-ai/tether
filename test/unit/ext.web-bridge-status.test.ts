// The status icon's rules (F7 C4, extensions/web-bridge/status.ts) and main's poller (status-poll.ts), without Electron:
//   - /status reduced to a snapshot: tabs per browser and per owner, the slot behind `tether:<id>`, browser labels from
//     the user agent, malformed entries dropped, agents ordered by last call;
//   - state/badge/tooltip per design §5 (grey · normal N · busy dot · amber · red after a fall), "ago" in Portuguese,
//     the version footer and its reload hint;
//   - the poller against a fake fetch: bearer from api.key (never in the snapshot), onChange only on change, 15 s / 2 s
//     cadence by watch(), pause → /pause, 404 → "indisponível" and pauseSupported false, releaseAll → one release per client.
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clientIdOf } from '../../extensions/web-bridge/agents.ts'
import { manifest } from '../../extensions/web-bridge/manifest.ts'
import { createStatusPoller } from '../../extensions/web-bridge/status-poll.ts'
import { activeAgents, ago, badgeOf, browserLabel, EMPTY_SNAPSHOT, reduceStatus, slotIdOf, stateOf, TETHER_PREFIX, titleOf, versionLine, type StatusSnapshot } from '../../extensions/web-bridge/status.ts'

const NOW = 1_800_000_000_000
const snap = (patch: Partial<StatusSnapshot>): StatusSnapshot => ({ ...EMPTY_SNAPSHOT, at: NOW, daemon: 'up', everUp: true, version: { vendored: '0.1.0', installed: '0.1.0', pendingReload: false }, ...patch })
const chrome = { id: 'b1', name: 'Chrome', tabs: 0 }
const edge = { id: 'b2', name: 'Edge', tabs: 1 }
const agent = (lastSeenAt: number, slot = 's1') => ({ clientId: `tether:${slot}`, slotId: slot, name: 'Claude · atrium', tabs: 1, lastTool: 'navigate', lastSeenAt, calls: 3 })

describe('web-bridge status: the snapshot from /status', () => {
  test('the manifest declares the icon with the brand monogram, and the client prefix matches agents.ts', () => {
    assert.deepEqual(manifest.contributes?.status, [{ id: 'web-bridge.status', icon: 'brand', order: 50 }])
    assert.equal(clientIdOf('abc'), `${TETHER_PREFIX}abc`)
    assert.equal(slotIdOf(clientIdOf('abc')), 'abc')
    assert.equal(slotIdOf('atrium:xyz'), undefined)
    assert.equal(slotIdOf('tether:'), undefined)
  })

  test('browsers and agents are reduced: tabs by owner, labels from the user agent, bad entries dropped, newest agent first', () => {
    const r = reduceStatus({
      ok: true, paused: 'yes',
      browsers: [
        { id: 'b1', name: 'Chrome', userAgent: 'Mozilla/5.0 Chrome/130 Safari', connectedAt: NOW - 60_000, lastFocusedAt: '2027-01-01T00:00:00.000Z', tabs: [{ id: 1, owner: 'tether:s1' }, { id: 2 }, { id: 3, owner: 'tether:s2' }, { id: 4, owner: 'tether:s1' }] },
        { id: 'b2', name: 'Chrome', userAgent: 'Mozilla/5.0 Chrome/130 Edg/130', tabs: 'nope' },
        { name: 'sem id' }, null, 7,
      ],
      clients: [
        { id: 'tether:s2', name: 'Claude · b', lastTool: 'click', lastSeenAt: NOW - 5000, calls: 2 },
        { id: 'tether:s1', name: 'Claude · a', lastSeenAt: NOW - 1000, calls: '9' },
        { id: 'atrium:x', lastTool: 7 },
        { name: 'sem id' },
      ],
    })
    assert.equal(r.paused, false, 'paused must be the boolean true')
    assert.deepEqual(r.browsers, [
      { id: 'b1', name: 'Chrome', tabs: 3, lastActivityAt: Date.parse('2027-01-01T00:00:00.000Z') },
      { id: 'b2', name: 'Edge', tabs: 0 },
    ])
    assert.deepEqual(r.agents, [
      { clientId: 'tether:s1', slotId: 's1', name: 'Claude · a', tabs: 2, lastSeenAt: NOW - 1000, calls: 0 },
      { clientId: 'tether:s2', slotId: 's2', name: 'Claude · b', tabs: 1, lastTool: 'click', lastSeenAt: NOW - 5000, calls: 2 },
      { clientId: 'atrium:x', name: 'atrium:x', tabs: 0, calls: 0 },
    ])
    assert.deepEqual(reduceStatus(undefined), { paused: false, debug: false, browsers: [], agents: [] })
    assert.deepEqual(reduceStatus('x'), { paused: false, debug: false, browsers: [], agents: [] })
  })

  test('browser labels', () => {
    assert.equal(browserLabel(undefined, 'Mozilla Chrome/1 Edg/1'), 'Edge')
    assert.equal(browserLabel('Chrome', 'Mozilla Chrome/1 Brave'), 'Brave')
    assert.equal(browserLabel('Chrome de teste', undefined), 'Chrome de teste')
    assert.equal(browserLabel(undefined, 'Mozilla Chromium/1'), 'Chromium')
    assert.equal(browserLabel(undefined, undefined), 'Navegador')
  })
})

describe('web-bridge status: state, badge, tooltip (design §5)', () => {
  test('grey without a browser, normal with the count, busy within 10 s, amber paused, red after a fall', () => {
    const none = snap({ browsers: [] })
    assert.equal(stateOf(none, NOW), 'idle'); assert.equal(badgeOf(none, NOW), undefined)
    assert.equal(titleOf(none, NOW, 'Tether Bridge'), 'Tether Bridge: nenhum navegador conectado · Instalar…')

    const two = snap({ browsers: [chrome, edge] })
    assert.equal(stateOf(two, NOW), 'normal'); assert.equal(badgeOf(two, NOW), 2)
    assert.equal(titleOf(two, NOW, 'Tether Bridge'), 'Chrome, Edge conectados')
    assert.equal(titleOf(snap({ browsers: [chrome] }), NOW, 'Tether Bridge'), 'Chrome conectado')
    assert.equal(titleOf(snap({ browsers: [chrome, { ...edge, name: 'Chrome' }] }), NOW, 'Tether Bridge'), 'Chrome conectado', 'two windows of the same browser read as one name')

    const busy = snap({ browsers: [chrome], agents: [agent(NOW - 3000)] })
    assert.equal(stateOf(busy, NOW), 'busy'); assert.equal(badgeOf(busy, NOW), 'dot')
    assert.equal(titleOf(busy, NOW, 'Tether Bridge'), 'Claude · atrium está usando o Chrome')
    assert.equal(titleOf(snap({ browsers: [chrome, edge], agents: [agent(NOW)] }), NOW, 'Tether Bridge'), 'Claude · atrium está usando o navegador')
    assert.equal(stateOf(busy, NOW + 10_000), 'normal', 'the window closes at 10 s')
    assert.equal(badgeOf(busy, NOW + 10_000), 1)
    assert.deepEqual(activeAgents(snap({ agents: [agent(NOW - 9999, 'a'), agent(NOW - 10_000, 'b'), agent(NOW + 5000, 'c')] }), NOW).map(a => a.slotId), ['a'], 'a future time stamp never counts')

    const paused = snap({ browsers: [chrome], paused: true, agents: [agent(NOW)] })
    assert.equal(stateOf(paused, NOW), 'warn'); assert.equal(badgeOf(paused, NOW), 1)
    assert.equal(titleOf(paused, NOW, 'Tether Bridge'), 'Tether Bridge pausado')

    const fell = snap({ daemon: 'down', everUp: true, browsers: [chrome] })
    assert.equal(stateOf(fell, NOW), 'error'); assert.equal(badgeOf(fell, NOW), undefined)
    assert.equal(titleOf(fell, NOW, 'Tether Bridge'), 'O daemon do bridge caiu; a próxima chamada o reinicia')
    const starting = snap({ daemon: 'down', everUp: false })
    assert.equal(stateOf(starting, NOW), 'idle', 'never up yet: grey, not red')
    assert.equal(titleOf(starting, NOW, 'Tether Bridge'), 'Tether Bridge: serviço ainda não respondeu')
    assert.match(titleOf(snap({ daemon: 'no-key', everUp: false }), NOW, 'Tether Bridge'), /instalação ainda não preparada/)
    assert.match(titleOf(snap({ daemon: 'refused', everUp: false }), NOW, 'Tether Bridge'), /recusou a chave/)
  })

  test('"ago" in Portuguese and the version footer', () => {
    assert.equal(ago(undefined, NOW), '')
    assert.equal(ago(NOW - 1000, NOW), 'agora')
    assert.equal(ago(NOW - 8000, NOW), 'há 8 s')
    assert.equal(ago(NOW - 3 * 60_000, NOW), 'há 3 min')
    assert.equal(ago(NOW - 2 * 3_600_000, NOW), 'há 2 h')
    assert.equal(ago(NOW - 3 * 86_400_000, NOW), 'há 3 d')
    assert.deepEqual(versionLine({ vendored: '0.1.0', installed: '0.1.0', pendingReload: false }), { text: 'Extensão 0.1.0', reload: false })
    assert.deepEqual(versionLine({ vendored: '0.1.0', installed: '0.1.0', pendingReload: true }), { text: 'Extensão 0.1.0', reload: true })
    assert.deepEqual(versionLine({ vendored: '0.2.0', installed: '0.1.0', pendingReload: false }), { text: 'Extensão: 0.2.0 no Tether · 0.1.0 instalada', reload: true })
    assert.deepEqual(versionLine({ vendored: '0.1.0', pendingReload: false }), { text: 'Extensão 0.1.0 · não instalada neste computador', reload: false })
  })
})

describe('web-bridge status: the poller', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'tether-wb-status-'))
  after(() => rmSync(tmp, { recursive: true, force: true }))

  interface Fake {
    calls: { method: string; path: string; auth: string | undefined }[]
    status: () => unknown | Error
    pause: number
    release: number
    timers: { fn: () => void; ms: number }[]
  }
  function setup(key: string | undefined, name: string): { fake: Fake; changes: StatusSnapshot[]; poller: ReturnType<typeof createStatusPoller>; bridgeHome: string; logs: string[] } {
    const bridgeHome = join(tmp, name)
    mkdirSync(bridgeHome, { recursive: true })
    if (key !== undefined) writeFileSync(join(bridgeHome, 'api.key'), `${key}\n`)
    const fake: Fake = { calls: [], status: () => ({ ok: true, paused: false, browsers: [], clients: [] }), pause: 200, release: 200, timers: [] }
    const fetchFake: typeof fetch = async (url, init) => {
      const u = new URL(String(url))
      const headers = init?.headers as Record<string, string> | undefined
      fake.calls.push({ method: init?.method ?? 'GET', path: u.pathname, auth: headers?.authorization })
      if (u.pathname === '/status') {
        const body = fake.status()
        if (body instanceof Error) throw body
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (u.pathname === '/pause' || u.pathname === '/resume') return new Response(fake.pause === 200 ? '{"ok":true}' : 'nope', { status: fake.pause })
      if (/^\/clients\/.+\/release$/.test(u.pathname)) return new Response(fake.release === 200 ? '{"ok":true}' : 'nope', { status: fake.release })
      return new Response('?', { status: 404 })
    }
    const changes: StatusSnapshot[] = []
    const logs: string[] = []
    const poller = createStatusPoller({
      port: 1, bridgeHome, fetch: fetchFake, log: m => logs.push(m), now: () => NOW,
      version: () => ({ vendored: '0.1.0', pendingReload: false }),
      options: () => ({ browserId: 'chrome', browserName: 'Chrome' }),
      onChange: s => changes.push(s),
      setTimer: (fn, ms) => { const t = { fn, ms }; fake.timers.push(t); return t },
      clearTimer: t => { fake.timers = fake.timers.filter(x => x !== t) },
    })
    return { fake, changes, poller, bridgeHome, logs }
  }

  test('bearer from api.key, snapshot without it, onChange only when something changed, 15 s then 2 s while watched', async () => {
    const { fake, changes, poller } = setup('segredo-da-chave', 'a')
    fake.status = () => ({ ok: true, paused: false, browsers: [{ id: 'b1', name: 'Chrome', tabs: [] }], clients: [] })
    poller.start()
    await poller.refresh()
    assert.equal(fake.calls[0]!.auth, 'Bearer segredo-da-chave')
    assert.equal(changes.length, 1)
    assert.equal(changes[0]!.daemon, 'up')
    assert.equal(changes[0]!.everUp, true)
    assert.deepEqual(changes[0]!.browsers, [{ id: 'b1', name: 'Chrome', tabs: 0 }])
    assert.deepEqual(changes[0]!.options, { browserId: 'chrome', browserName: 'Chrome' })
    assert.ok(!JSON.stringify(changes[0]).includes('segredo'), 'the key never reaches the snapshot')
    await new Promise(r => setTimeout(r, 0))
    assert.equal(fake.timers.length, 1)
    assert.equal(fake.timers[0]!.ms, 15_000, 'idle cadence')
    await poller.refresh()
    assert.equal(changes.length, 1, 'same answer: no onChange')
    poller.watch(true)
    await new Promise(r => setTimeout(r, 5))
    assert.equal(fake.calls.filter(c => c.path === '/status').length, 3, 'watch(true) polls at once')
    assert.equal(fake.timers.length, 1)
    assert.equal(fake.timers[0]!.ms, 2_000, 'open cadence')
    fake.status = () => new Error('ECONNREFUSED')
    fake.timers.shift()!.fn() // the timer fires (and, as a real one, leaves the list)
    await new Promise(r => setTimeout(r, 5))
    assert.equal(changes.length, 2)
    assert.equal(changes[1]!.daemon, 'down')
    assert.equal(changes[1]!.everUp, true, 'a fall after being up')
    poller.watch(false)
    assert.equal(fake.timers[0]!.ms, 15_000)
    poller.stop()
    assert.equal(fake.timers.length, 0)
  })

  test('without api.key the daemon is "no-key"; actions say so', async () => {
    const { fake, poller } = setup(undefined, 'b')
    const s = await poller.refresh()
    assert.equal(s.daemon, 'no-key')
    assert.equal(fake.calls.length, 0, 'no call without a key')
    const r = await poller.pause(true)
    assert.equal(r.ok, false)
  })

  test('pause/resume, the 404 of an older bundle, and releaseAll per client', async () => {
    const { fake, poller, logs } = setup('k', 'c')
    fake.status = () => ({ ok: true, paused: false, browsers: [], clients: [{ id: 'tether:s1', name: 'A' }, { id: 'tether:s2', name: 'B' }] })
    await poller.refresh()
    assert.deepEqual(await poller.pause(true), { ok: true })
    assert.deepEqual(fake.calls.filter(c => c.method === 'POST').map(c => c.path), ['/pause'])
    assert.deepEqual(await poller.pause(false), { ok: true })
    assert.deepEqual(fake.calls.filter(c => c.method === 'POST').map(c => c.path), ['/pause', '/resume'])
    fake.pause = 404
    const r = await poller.pause(true)
    assert.equal(r.ok, false)
    assert.match((r as { message: string }).message, /indisponível nesta versão/)
    assert.equal(poller.current().pauseSupported, false, 'the snapshot remembers')
    fake.pause = 401
    assert.match(((await poller.pause(true)) as { message: string }).message, /recusou a chave/)
    assert.deepEqual(await poller.releaseAll(), { ok: true })
    assert.deepEqual(fake.calls.filter(c => c.path.endsWith('/release')).map(c => c.path).sort(), ['/clients/tether%3As1/release', '/clients/tether%3As2/release'])
    fake.release = 404
    const bad = await poller.releaseAll()
    assert.equal(bad.ok, false)
    assert.match((bad as { message: string }).message, /recusou soltar 2 de 2/)
    assert.ok(logs.every(l => !l.includes('Bearer')), 'no bearer in the log')
  })
})
