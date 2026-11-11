// The daemon's MCP over Streamable HTTP (src/daemon/mcp-http.ts) against an in-process server (a fake McpBackend):
// every request authenticated by the slot's own key (none, wrong, another slot's, revoked, a browser Origin: refused), no
// server before the session's initialize, the rewriter applied, progress relayed on the request's stream, two slots isolated
// (own instance, own session), NO process spawned, the instance kept across a pause and across a second initialize, and what
// the server sends on its own (a request to the client, a notification) reaching the client's GET stream.
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { McpHttpHost, type McpBackend, type McpBackendSpec, type McpTransport } from '../../src/daemon/mcp-http.ts'
import { McpRewriter, NAVIGATE_NEW } from '../../extensions/browser/mcp-texts.ts'

const KEY_A = 'a'.repeat(32)
const KEY_B = 'b'.repeat(32)
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }

let made = 0
/** A server inside this process: state that must outlive sessions (`calls`), and a way to speak on its own (`push`). */
class FakeBackend implements McpBackend {
  readonly serial = ++made
  calls = 0
  connects = 0
  closed = false
  transport: McpTransport | undefined
  /** Answers of the client to the server's own requests. */
  readonly answers: unknown[] = []
  private readonly slot: string
  constructor(slot: string) { this.slot = slot }
  async connect(t: McpTransport): Promise<void> {
    const previous = this.transport
    this.transport = undefined
    await previous?.close()
    this.connects++
    this.transport = t
    let initialized = false
    t.onmessage = raw => {
      const m = raw as Record<string, any>
      const send = (x: unknown, related?: string | number): void => { void t.send(x, related !== undefined ? { relatedRequestId: related } : undefined) }
      if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } })
      else if (m.method === 'notifications/initialized') initialized = true
      else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'WebNavigate', description: 'Go. Only public http(s) addresses are reachable; addresses inside the machine or its private network are refused.', inputSchema: { type: 'object' } }] } })
      else if (m.method === 'tools/call') {
        if (!initialized) { send({ jsonrpc: '2.0', id: m.id, error: { code: -32002, message: 'not initialized' } }); return }
        const token = m.params?._meta?.progressToken
        if (token !== undefined) send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: 1 } }, m.id)
        if (m.params?.name === 'hang') return
        send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `serial=${this.serial} calls=${++this.calls} slot=${this.slot}` }] } })
      } else if (m.method === undefined && m.id !== undefined) this.answers.push(m)
      else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } })
    }
  }
  /** The server speaks on its own (no request in flight). */
  push(message: unknown): void { void this.transport?.send(message) }
  async close(): Promise<void> { this.closed = true; await this.transport?.close() }
}

const backends = new Map<string, FakeBackend>()
const spec = (slot: string): McpBackendSpec => ({
  create: () => { const b = new FakeBackend(slot); backends.set(slot, b); return b },
  rewriter: () => new McpRewriter({ evaluate: false }),
})

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

/** The client's GET stream: the messages as they arrive, and the raw text (comments included). */
async function stream(url: string, key: string, session: string) {
  const ctl = new AbortController()
  const r = await fetch(url, { headers: { accept: 'text/event-stream', authorization: `Bearer ${key}`, 'mcp-session-id': session }, signal: ctl.signal })
  const messages: Record<string, any>[] = []
  let raw = ''
  let ended = false
  const reader = r.body!.getReader()
  const dec = new TextDecoder()
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        raw += dec.decode(value, { stream: true })
        let i
        while ((i = raw.indexOf('\n\n')) !== -1) {
          const event = raw.slice(0, i)
          raw = raw.slice(i + 2)
          const data = event.split('\n').find(l => l.startsWith('data: '))
          if (data) messages.push(JSON.parse(data.slice(6)) as Record<string, any>)
          else if (event.startsWith(':')) messages.push({ comment: event })
        }
      }
    } catch { /* aborted */ }
    ended = true
  })()
  return { status: r.status, messages, close: () => ctl.abort(), ended: () => ended }
}

const until = async (cond: () => boolean, what: string): Promise<void> => {
  const end = Date.now() + 5000
  while (!cond()) { if (Date.now() > end) throw new Error(`timeout: ${what}`); await new Promise(r => setTimeout(r, 10)) }
}

const hosts: McpHttpHost[] = []
async function host(over: { keepAliveMs?: number; maxQueued?: number } = {}) {
  const h = new McpHttpHost({ name: 'test', log: () => {}, ...over })
  await h.listen()
  hosts.push(h)
  return h
}
after(async () => { for (const h of hosts) await h.close() })

describe('McpHttpHost', () => {
  test('binds 127.0.0.1 and refuses: no key, a wrong key, another slot\'s key, an unknown slot, a revoked key, a browser Origin', async () => {
    const h = await host()
    h.grant('slotA', KEY_A, spec('slotA'))
    h.grant('slotB', KEY_B, spec('slotB'))
    const a = h.urlOf('slotA')!
    assert.match(a, /^http:\/\/127\.0\.0\.1:\d+\/mcp\/slotA$/)
    assert.equal((await post(a, undefined, INIT)).status, 401)
    assert.equal((await post(a, 'x'.repeat(32), INIT)).status, 401)
    assert.equal((await post(a, KEY_B, INIT)).status, 401, 'slot B\'s key does not open slot A')
    assert.equal((await post(h.urlOf('nobody')!, KEY_A, INIT)).status, 401)
    assert.equal((await post(a, KEY_A, INIT, undefined, { origin: 'https://evil.example' })).status, 403)
    assert.equal(h.running(), 0, 'no refused request made a server')
    const session = await open(a, KEY_A)
    assert.equal(h.running(), 1)
    h.revoke('slotA')
    assert.equal(h.running(), 0)
    await until(() => backends.get('slotA')!.closed, 'the revoked slot\'s server to be closed')
    assert.equal((await post(a, KEY_A, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, session)).status, 401)
  })

  test('no server before initialize; the session id is required; the rewriter and progress go through', async () => {
    const h = await host()
    h.grant('s1', KEY_A, spec('s1'))
    const url = h.urlOf('s1')!
    assert.equal(h.running(), 0)
    assert.equal((await post(url, KEY_A, { jsonrpc: '2.0', id: 9, method: 'tools/list' })).status, 400, 'no session yet')
    const session = await open(url, KEY_A)
    assert.equal((await post(url, KEY_A, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, 'wrong-session')).status, 404)
    const list = await post(url, KEY_A, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, session)
    assert.equal(list.messages.at(-1)!.result.tools[0].description, `Go. ${NAVIGATE_NEW}`)
    const call = await post(url, KEY_A, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'whoami', arguments: {}, _meta: { progressToken: 'p1' } } }, session)
    assert.deepEqual(call.messages.map(m => m.method ?? 'result'), ['notifications/progress', 'result'])
    assert.match(call.messages[1]!.result.content[0].text, /slot=s1/)
    assert.equal(h.createsOf('s1'), 1)
  })

  test('a client that only takes JSON gets the answer as JSON', async () => {
    const h = await host()
    h.grant('j', KEY_A, spec('j'))
    const url = h.urlOf('j')!
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${KEY_A}` }, body: JSON.stringify(INIT) })
    assert.equal(r.status, 200)
    assert.match(r.headers.get('content-type') ?? '', /application\/json/)
    assert.equal(((await r.json()) as Record<string, any>).result.serverInfo.name, 'fake')
  })

  test('two slots: own instance, own session, and no process is spawned', async () => {
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
    assert.notEqual(ta.split(' ')[0], tb.split(' ')[0], 'different instances')
    assert.equal((await call('A', KEY_A, sb)).status, 404, 'B\'s session does not exist on A')
    assert.equal(h.running(), 2)
    // The handles of this process: sockets and the server, never a child process.
    const children = (process as unknown as { _getActiveHandles(): Array<{ constructor: { name: string } }> })._getActiveHandles().filter(x => x.constructor.name === 'ChildProcess')
    assert.equal(children.length, 0)
  })

  test('the instance is never stopped for being idle, and a second initialize is a new session on the SAME instance', async () => {
    const h = await host({ keepAliveMs: 30 })
    h.grant('s', KEY_A, spec('s'))
    const url = h.urlOf('s')!
    const session = await open(url, KEY_A)
    const call = (id: number, s: string) => post(url, KEY_A, { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'whoami', arguments: {} } }, s)
    assert.match((await call(2, session)).messages.at(-1)!.result.content[0].text, /calls=1 /)
    await new Promise(r => setTimeout(r, 400)) // a pause, many keep-alive periods long
    assert.equal(h.running(), 1)
    const after = (await call(3, session)).messages.at(-1)!.result
    assert.equal(after.content.length, 1, 'no restart notice: nothing was restarted')
    assert.match(after.content[0].text, /calls=2 /, 'what the server held is still there')
    // The client reconnects: a new session, the old one is gone, the instance and its state are the same.
    const again = await open(url, KEY_A)
    assert.notEqual(again, session)
    assert.equal((await call(4, session)).status, 404)
    const text = (await call(5, again)).messages.at(-1)!.result.content[0].text as string
    assert.match(text, /calls=3 /)
    assert.equal(h.createsOf('s'), 1)
    assert.equal(backends.get('s')!.connects, 2)
  })

  test('what the server sends on its own reaches the GET stream; the client\'s answer reaches the server; keep-alive comments flow', async () => {
    const h = await host({ keepAliveMs: 40 })
    h.grant('g', KEY_A, spec('g'))
    const url = h.urlOf('g')!
    const session = await open(url, KEY_A)
    const b = backends.get('g')!
    // Said before the client opened its stream: kept, then delivered in order.
    b.push({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
    const s = await stream(url, KEY_A, session)
    assert.equal(s.status, 200)
    await until(() => s.messages.some(m => m.method === 'notifications/tools/list_changed'), 'the queued notification')
    // A request of the server (an elicitation) with no call in flight.
    b.push({ jsonrpc: '2.0', id: 'srv-1', method: 'elicitation/create', params: { message: 'allow?', requestedSchema: { type: 'object', properties: {} } } })
    await until(() => s.messages.some(m => m.method === 'elicitation/create'), 'the elicitation on the GET stream')
    const answer = await post(url, KEY_A, { jsonrpc: '2.0', id: 'srv-1', result: { action: 'accept', content: {} } }, session)
    assert.equal(answer.status, 202)
    await until(() => b.answers.length === 1, 'the client\'s answer at the server')
    assert.deepEqual((b.answers[0] as Record<string, any>).result, { action: 'accept', content: {} })
    await until(() => s.messages.some(m => typeof m.comment === 'string'), 'a keep-alive comment')
    // Another slot's key cannot listen in.
    const spy = await fetch(url, { headers: { accept: 'text/event-stream', authorization: `Bearer ${KEY_B}`, 'mcp-session-id': session } })
    assert.equal(spy.status, 401)
    s.close()
  })

  test('a request of the server during a call goes on that call\'s stream (an elicitation inside a tool call)', async () => {
    const h = await host()
    h.grant('e', KEY_A, spec('e'))
    const url = h.urlOf('e')!
    const session = await open(url, KEY_A)
    const b = backends.get('e')!
    const s = await stream(url, KEY_A, session)
    const hanging = fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${KEY_A}`, 'mcp-session-id': session },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'hang', arguments: {} } }),
    })
    const r = await hanging
    const reader = r.body!.getReader()
    void b.transport!.send({ jsonrpc: '2.0', id: 'srv-2', method: 'elicitation/create', params: { message: 'm' } }, { relatedRequestId: 7 })
    const { value } = await reader.read()
    assert.match(new TextDecoder().decode(value), /"elicitation\/create"/)
    assert.equal(s.messages.some(m => m.method === 'elicitation/create'), false, 'not on the GET stream')
    // The session ends while the call waits: the call is answered with an error, never left hanging.
    h.revoke('e')
    let rest = ''
    for (;;) { const x = await reader.read(); if (x.done) break; rest += new TextDecoder().decode(x.value) }
    assert.match(rest, /"error"/)
    await until(() => s.ended(), 'the GET stream to end with the session')
  })

  test('DELETE ends the session and keeps the slot\'s server', async () => {
    const h = await host()
    h.grant('d', KEY_A, spec('d'))
    const url = h.urlOf('d')!
    const session = await open(url, KEY_A)
    const r = await fetch(url, { method: 'DELETE', headers: { authorization: `Bearer ${KEY_A}`, 'mcp-session-id': session } })
    assert.equal(r.status, 200)
    assert.equal(h.running(), 1)
    assert.equal((await post(url, KEY_A, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, session)).status, 404)
    await open(url, KEY_A)
    assert.equal(h.createsOf('d'), 1)
  })

  test('a server that cannot be made: the initialize is answered with an error and the next one tries again', async () => {
    const h = await host()
    let fail = true
    h.grant('f', KEY_A, { create: () => { if (fail) throw new Error('boom'); return new FakeBackend('f') } })
    const url = h.urlOf('f')!
    const bad = await post(url, KEY_A, INIT)
    assert.equal(bad.messages.at(-1)!.error.code, -32000)
    assert.equal(h.running(), 0)
    fail = false
    await open(url, KEY_A)
    assert.equal(h.running(), 1)
  })
})
