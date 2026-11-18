// `perf` request: the daemon's ruler snapshot (pull only).
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { perf } from '../../src/core/perf.ts'
import { AgentRegistry } from '../../src/agents/registry.ts'
import { DaemonExtensionHost } from '../../src/daemon/ext-host.ts'
import { McpHttpHost } from '../../src/daemon/mcp-http.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import type { ExtensionManifest } from '../../extensions/types.ts'
import { Recorder, removeHome, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

let home: string
let daemon: Daemon

before(async () => {
  home = tempHome()
  daemon = await startDaemon({ home, pipe: uniquePipe(home) })
})
after(async () => {
  await daemon.close()
  await removeHome(home)
})

test('perf: replies with samples and incidents, and `since` filters them', async () => {
  const c = await Recorder.connect(daemon.pipe)
  perf.incident('test-incident', { x: 1 })
  await waitUntil(() => perf.snapshot().samples.length > 0, 5_000, 'the first sample')
  const r = await c.client.request({ t: 'perf' })
  assert.ok(r.perf)
  assert.ok(r.perf.samples.length > 0)
  assert.equal(typeof r.perf.samples[0]!.maxMs, 'number')
  assert.ok(r.perf.incidents.some((i) => i.kind === 'test-incident'))
  const later = await c.client.request({ t: 'perf', since: r.perf.now + 60_000 })
  assert.equal(later.perf!.samples.length, 0)
  assert.equal(later.perf!.incidents.length, 0)
  c.client.close()
})

test('perf: a blocked request handler shows up as a slow incident with its label', async () => {
  process.env.TETHER_TEST_BLOCK = '1'
  try {
    const c = await Recorder.connect(daemon.pipe)
    await c.client.request({ t: 'debug-block', ms: 250 })
    await waitUntil(() => perf.snapshot().incidents.some((i) => i.kind === 'slow' && (i.data as { label?: string }).label === 'req:debug-block'), 5_000, 'the slow incident')
    const r = await c.client.request({ t: 'perf' })
    const slow = r.perf!.incidents.find((i) => i.kind === 'slow')!
    assert.ok((slow.data as { ms: number }).ms >= 200)
    assert.ok(r.perf!.labels!['req:debug-block']!.n >= 1)
    assert.ok(r.perf!.labels!['req:perf']!.n >= 1)
    c.client.close()
  } finally {
    delete process.env.TETHER_TEST_BLOCK
  }
})

test('perf: a request records its wall time apart from its synchronous part', async () => {
  const c = await Recorder.connect(daemon.pipe)
  await c.client.request({ t: 'perf' })
  const r = await c.client.request({ t: 'perf' })
  const labels = r.perf!.labels!
  assert.ok(labels['req:perf']!.n >= 1, 'the synchronous part')
  assert.ok(labels['req:perf:wall']!.n >= 1, 'the wall part')
  c.client.close()
})

test('perf: a slow MCP handler shows up as slow mcp:<server>:<method>', async () => {
  const host = new McpHttpHost({ name: 'perfsrv', log: () => {} })
  await host.listen()
  const key = 'k'.repeat(32)
  host.grant('s1', key, {
    create: () => ({
      async connect(t) {
        t.onmessage = (raw) => {
          const m = raw as { id?: number; method?: string }
          if (m.method === 'tools/list') { const end = Date.now() + 120; while (Date.now() < end) { /* a handler that blocks the loop */ } }
          if (m.id !== undefined) void t.send({ jsonrpc: '2.0', id: m.id, result: {} })
        }
      },
      async close() {},
    }),
  })
  try {
    const url = host.urlOf('s1')!
    const post = (body: unknown, session?: string) => fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${key}`, ...(session ? { 'mcp-session-id': session } : {}) },
      body: JSON.stringify(body),
    })
    const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    const session = init.headers.get('mcp-session-id')!
    await init.text()
    await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, session)).text()
    const slow = perf.snapshot().incidents.find((i) => i.kind === 'slow' && (i.data as { label?: string }).label === 'mcp:perfsrv:tools/list')
    assert.ok(slow, 'slow mcp:perfsrv:tools/list')
    assert.ok((slow!.data as { ms: number }).ms >= 100)
    assert.ok(perf.snapshot().labels!['mcp:perfsrv:parse']!.n >= 2)
  } finally { await host.close() }
})

test('perf: a slow extension launch middleware and slot listener are named ext:<id>:plan and ext:<id>:slot', async () => {
  const busy = (ms: number): void => { const end = Date.now() + ms; while (Date.now() < end) { /* block */ } }
  const ext = new DaemonExtensionHost({
    home, log: () => {}, agents: new AgentRegistry(),
    extensions: [{
      manifest: { id: 'perfext', version: '0.0.0', displayName: 'perf', hosts: ['daemon'] } as ExtensionManifest,
      activate: (api) => [api.launch.use((plan) => { busy(80); return plan }), api.onSlot(() => busy(80))],
    }],
  })
  ext.activate()
  try {
    await ext.transformPlan({ command: 'x', args: [], env: {} } as never, { slotId: 'a', agent: 'claude' } as never)
    ext.emitSlot('changed', {} as never)
    const names = perf.snapshot().incidents.filter((i) => i.kind === 'slow').map((i) => (i.data as { label: string }).label)
    assert.ok(names.includes('ext:perfext:plan'), names.join())
    assert.ok(names.includes('ext:perfext:slot'), names.join())
  } finally { ext.dispose() }
})
