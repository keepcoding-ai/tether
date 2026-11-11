// The daemon's MCP over Streamable HTTP (src/daemon/mcp-http.ts) against a real stdio child (fixtures/fake-mcp-server.mjs):
// every request authenticated by the slot's own key (none, wrong, another slot's, revoked, a browser Origin: refused), no child
// before the session's initialize, the rewriter applied, progress relayed on the request's stream, two slots isolated (own
// child, own env, own session), and an idle child stopped then restarted with the client's handshake replayed and the notice.
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { McpHttpHost, type McpBackendSpec } from '../../src/daemon/mcp-http.ts'
import { McpRewriter, NAVIGATE_NEW } from '../../extensions/browser/mcp-texts.ts'

const FAKE = join(import.meta.dirname, 'fixtures', 'fake-mcp-server.mjs')
const KEY_A = 'a'.repeat(32)
const KEY_B = 'b'.repeat(32)
const spec = (slot: string): McpBackendSpec => ({ command: process.execPath, args: [FAKE], env: { ...process.env as Record<string, string>, FAKE_SLOT: slot }, rewriter: () => new McpRewriter({ evaluate: false }) })
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }

/** POSTs one message; returns the status, the session id and every JSON-RPC message of the answer (SSE or JSON). */
async function post(url: string, key: string | undefined, msg: unknown, session?: string, extra: Record<string, string> = {}) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(key ? { authorization: `Bearer ${key}` } : {}), ...(session ? { 'mcp-session-id': session } : {}), ...extra },
    body: JSON.stringify(msg),
  })
  const text = await r.text()
  const messages = (r.headers.get('content-type') ?? '').includes('event-stream')
    ? text.split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)) as Record<string, any>)
    : text ? [JSON.parse(text) as Record<string, any>] : []
  return { status: r.status, session: r.headers.get('mcp-session-id') ?? undefined, messages }
}

async function open(url: string, key: string) {
  const init = await post(url, key, INIT)
  assert.equal(init.status, 200)
  assert.ok(init.session)
  assert.equal(init.messages.at(-1)!.result.serverInfo.name, 'fake')
  assert.equal((await post(url, key, { jsonrpc: '2.0', method: 'notifications/initialized' }, init.session)).status, 202)
  return init.session!
}

const hosts: McpHttpHost[] = []
async function host(idleMs?: number) {
  const h = new McpHttpHost({ name: 'test', log: () => {}, restartNotice: 'RESTARTED', ...(idleMs ? { idleMs } : {}) })
  await h.listen()
  hosts.push(h)
  return h
}
after(async () => { for (const h of hosts) await h.close() })

describe('McpHttpHost', () => {
  test('binds 127.0.0.1 and refuses: no key, a wrong key, another slot\'s key, an unknown slot, a revoked key, a browser Origin', async () => {
    const h = await host()
    h.grant('slotA', KEY_A, spec('A'))
    h.grant('slotB', KEY_B, spec('B'))
    const a = h.urlOf('slotA')!
    assert.match(a, /^http:\/\/127\.0\.0\.1:\d+\/mcp\/slotA$/)
    assert.equal((await post(a, undefined, INIT)).status, 401)
    assert.equal((await post(a, 'x'.repeat(32), INIT)).status, 401)
    assert.equal((await post(a, KEY_B, INIT)).status, 401, 'slot B\'s key does not open slot A')
    assert.equal((await post(h.urlOf('nobody')!, KEY_A, INIT)).status, 401)
    assert.equal((await post(a, KEY_A, INIT, undefined, { origin: 'https://evil.example' })).status, 403)
    assert.equal(h.running(), 0, 'no refused request started a child')
    const session = await open(a, KEY_A)
    assert.equal(h.running(), 1)
    h.revoke('slotA')
    assert.equal(h.running(), 0, 'the revoked slot\'s child is stopped')
    assert.equal((await post(a, KEY_A, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, session)).status, 401)
  })

  test('no child before initialize; the session id is required; the rewriter and progress go through', async () => {
    const h = await host()
    h.grant('s1', KEY_A, spec('one'))
    const url = h.urlOf('s1')!
    assert.equal(h.running(), 0)
    assert.equal((await post(url, KEY_A, { jsonrpc: '2.0', id: 9, method: 'tools/list' })).status, 400, 'no session yet')
    const session = await open(url, KEY_A)
    assert.equal((await post(url, KEY_A, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, 'wrong-session')).status, 404)
    const list = await post(url, KEY_A, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, session)
    assert.equal(list.messages.at(-1)!.result.tools[0].description, `Go. ${NAVIGATE_NEW}`)
    const call = await post(url, KEY_A, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'whoami', arguments: {}, _meta: { progressToken: 'p1' } } }, session)
    assert.deepEqual(call.messages.map(m => m.method ?? 'result'), ['notifications/progress', 'result'])
    assert.match(call.messages[1]!.result.content[0].text, /slot=one/)
    assert.equal(h.startsOf('s1'), 1)
  })

  test('two slots: own child, own env, own session', async () => {
    const h = await host()
    h.grant('A', KEY_A, spec('A'))
    h.grant('B', KEY_B, spec('B'))
    const sa = await open(h.urlOf('A')!, KEY_A)
    const sb = await open(h.urlOf('B')!, KEY_B)
    const call = (slot: string, key: string, session: string) => post(h.urlOf(slot)!, key, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'whoami', arguments: {} } }, session)
    const ta = (await call('A', KEY_A, sa)).messages.at(-1)!.result.content[0].text as string
    const tb = (await call('B', KEY_B, sb)).messages.at(-1)!.result.content[0].text as string
    assert.match(ta, /slot=A$/)
    assert.match(tb, /slot=B$/)
    assert.notEqual(ta.split(' ')[0], tb.split(' ')[0], 'different processes')
    assert.equal((await call('A', KEY_A, sb)).status, 404, 'B\'s session does not exist on A')
    assert.equal(h.running(), 2)
  })

  test('an idle child is stopped; the next call restarts it, replays the handshake and carries the notice once', async () => {
    const h = await host(150)
    h.grant('s', KEY_A, spec('s'))
    const url = h.urlOf('s')!
    const session = await open(url, KEY_A)
    const call = (id: number) => post(url, KEY_A, { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'whoami', arguments: {} } }, session)
    const first = (await call(2)).messages.at(-1)!.result.content as Array<{ text: string }>
    assert.equal(first.length, 1)
    for (let i = 0; i < 50 && h.running() > 0; i++) await new Promise(r => setTimeout(r, 50))
    assert.equal(h.running(), 0, 'stopped after the idle time')
    const again = await call(3)
    const content = again.messages.at(-1)!.result.content as Array<{ text: string }>
    assert.equal(content[0]!.text, 'RESTARTED')
    assert.match(content[1]!.text, /slot=s/, 'the call went through: the replayed handshake made the child initialized')
    assert.notEqual(content[1]!.text.split(' ')[0], first[0]!.text.split(' ')[0])
    assert.equal(h.startsOf('s'), 2)
    const third = (await call(4)).messages.at(-1)!.result.content as Array<{ text: string }>
    assert.equal(third.length, 1, 'the notice comes once')
  })

  test('DELETE ends the session and stops the child', async () => {
    const h = await host()
    h.grant('d', KEY_A, spec('d'))
    const url = h.urlOf('d')!
    const session = await open(url, KEY_A)
    const r = await fetch(url, { method: 'DELETE', headers: { authorization: `Bearer ${KEY_A}`, 'mcp-session-id': session } })
    assert.equal(r.status, 200)
    assert.equal(h.running(), 0)
    assert.equal((await post(url, KEY_A, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, session)).status, 404)
  })
})
