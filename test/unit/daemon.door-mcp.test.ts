// The agent door's MCP server `tether` (src/daemon/door/mcp.ts) over real HTTP on http://localhost:<port>: nothing offered (and
// the plan untouched) while no verb has the `mcp` exit and no delivery is on; with the ronda's channel already in the plan, both
// servers under ONE channel flag; the era trap (`server/discover` never gets a result, `initialize` stays legacy); the verbs
// with the `mcp` exit as tools; a tool call reaching the handler with the slot of the route; a wrong key refused; tools/list_changed
// when a verb comes in; the revoke; and the key never in a log line or in the MCP file. A fake port first; then one real launch
// in a test tetherd (own home and pipe, a fake agent process, no LLM) proving the server awaits the door's offer.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { DisposableStore } from '../../app/shared/vscode-lifecycle.ts'
import '../../src/agents/load.ts'
import { agentRegistry, channelArgsOf, type AgentContribution } from '../../src/agents/registry.ts'
import type { AgentAdapter, LaunchPlan } from '../../src/agents/types.ts'
import type { SlotMeta } from '../../src/core/event.ts'
import { soulChannelPlan } from '../../extensions/soul/daemon.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import { DoorMcp, DOOR_INSTRUCTIONS, toolNameOf } from '../../src/daemon/door/mcp.ts'
import type { LaunchContext, SlotPort } from '../../src/daemon/door/port.ts'
import { SlotKeys } from '../../src/daemon/door/slot-key.ts'
import { DOOR_MCP_SERVER, ENV_DOOR_MCP_KEY, type VerbCaller, type VerbContribution } from '../../src/daemon/door/types.ts'
import { VerbRegistry } from '../../src/daemon/door/verbs.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { RONDA_MCP_SERVER } from '../../src/daemon/ronda-channel.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { Recorder, removeHome, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'
import { CHANNEL_DIALOG } from './ronda-dialog.fixture.ts'

const claude = (): AgentContribution => agentRegistry.get('claude')!
const RONDA_ARGS = ['--dangerously-load-development-channels', `server:${RONDA_MCP_SERVER}`]
const RONDA_FILE = 'ronda.json'

/** A plan as the ronda leaves it: its channel flag first, its MCP file last. */
const rondaPlan = (): LaunchPlan => ({
  command: 'claude',
  args: [...RONDA_ARGS, '--settings', 's.json', '--mcp-config', RONDA_FILE],
  cwd: '.',
  env: { PATH: 'x' },
  mcpServers: { [RONDA_MCP_SERVER]: RONDA_FILE },
})
const plainPlan = (): LaunchPlan => ({ command: 'claude', args: ['--settings', 's.json'], cwd: '.', env: { PATH: 'x' } })

function ctxOf(slotId: string, over: Partial<LaunchContext> = {}): LaunchContext {
  return {
    meta: { slotId } as SlotMeta,
    agent: claude(),
    channel: { args: RONDA_ARGS, inject: claude().mcp!.inject },
    rondaOffered: true,
    ...over,
  }
}

const verb = (name: string, over: Partial<VerbContribution> = {}): VerbContribution => ({
  ns: 'probe', name, description: `The ${name} verb.`, help: `verbo ${name}`,
  input: { type: 'object', properties: { text: { type: 'string' } } },
  run: () => ({ text: name }),
  ...over,
})

async function post(url: string, key: string, msg: unknown, session?: string) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}`, ...(session ? { 'mcp-session-id': session } : {}) },
    body: JSON.stringify(msg),
  })
  const text = await r.text()
  const lines = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)) as Record<string, any>)
  return { status: r.status, session: r.headers.get('mcp-session-id') ?? undefined, msg: lines.at(-1) ?? (text ? JSON.parse(text) as Record<string, any> : undefined), text }
}
const initialize = (version: string, id = 1) => ({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 't', version: '1' } } })

describe('agent door MCP server (D5)', () => {
  const homes: string[] = []
  const servers: DoorMcp[] = []
  after(async () => {
    for (const s of servers) await s.close()
    for (const h of homes) await removeHome(h)
  })

  function make() {
    const home = tempHome()
    homes.push(home)
    const logs: string[] = []
    const verbs = new VerbRegistry({ keys: new SlotKeys(), stateOf: () => undefined })
    const states = new Map<string, SlotState>()
    const port = { home, stateOf: (id: string) => states.get(id) } as unknown as SlotPort
    const mcp = new DoorMcp({ log: (m) => logs.push(m), verbs, port: () => port })
    servers.push(mcp)
    const addSlot = (slotId: string): void => { states.set(slotId, { slotId } as unknown as SlotState) }
    return { home, logs, verbs, mcp, addSlot }
  }

  async function launch(mcp: DoorMcp, slotId: string) {
    const out = await mcp.prepare(rondaPlan(), ctxOf(slotId))
    assert.ok(out.offered)
    const file = out.plan.args[out.plan.args.lastIndexOf('--mcp-config') + 1]!
    const cfg = JSON.parse(readFileSync(file, 'utf8')).mcpServers[DOOR_MCP_SERVER]
    return { out, file, url: cfg.url as string, key: out.plan.env[ENV_DOOR_MCP_KEY]! }
  }

  test('no verb with the mcp exit and no delivery: the plan goes out as it came in, and nothing listens', async () => {
    const { mcp, verbs } = make()
    const plan = rondaPlan()
    const out = await mcp.prepare(plan, ctxOf('s1'))
    assert.equal(out.plan, plan, 'the very same plan')
    assert.deepEqual(out.plan, rondaPlan())
    assert.equal(out.offered, false)
    assert.equal(mcp.port, undefined, 'the host never listened')
    // A verb shown only on the CLI does not make the server wanted either.
    const own = new DisposableStore()
    own.add(verbs.register('ext', verb('cli-only', { exits: ['cli'] })))
    assert.equal((await mcp.prepare(plan, ctxOf('s1'))).plan, plan)
    // An agent without HTTP MCP servers gets nothing, even with a tool.
    own.add(verbs.register('ext', verb('tool')))
    const noHttp = { ...claude(), mcp: { inject: claude().mcp!.inject } }
    assert.equal((await mcp.prepare(plan, ctxOf('s1', { agent: noHttp }))).plan, plan)
    assert.equal(mcp.port, undefined)
    own.dispose()
  })

  test('with the ronda and tether: one channel flag with both servers, the MCP file last, the key in the env only', async () => {
    const { mcp, verbs, logs } = make()
    const own = new DisposableStore()
    own.add(verbs.register('ext', verb('tool')))
    const { out, file, url, key } = await launch(mcp, 's1')
    const flag = RONDA_ARGS[0]!
    assert.deepEqual(out.plan.args.slice(0, 3), [flag, `server:${RONDA_MCP_SERVER}`, `server:${DOOR_MCP_SERVER}`])
    assert.equal(out.plan.args.filter((a) => a === flag).length, 1, 'one flag only')
    assert.equal(out.channel, true)
    assert.deepEqual(out.plan.args.slice(-4), ['--mcp-config', RONDA_FILE, '--mcp-config', file])
    assert.deepEqual(out.plan.mcpServers, { [RONDA_MCP_SERVER]: RONDA_FILE, [DOOR_MCP_SERVER]: file })
    assert.equal(file, join(homesLast(), 'door', 'mcp', 's1.json'))
    assert.match(url, /^http:\/\/localhost:\d+\/mcp\/s1$/)
    assert.equal(key.length, 32)
    const text = readFileSync(file, 'utf8')
    assert.ok(!text.includes(key), 'the file holds no key')
    assert.match(text, new RegExp(`Bearer \\$\\{${ENV_DOOR_MCP_KEY}\\}`))
    // Without the ronda's offer and with only tools (no delivery), the door adds no channel.
    const alone = await mcp.prepare(plainPlan(), ctxOf('s2', { rondaOffered: false }))
    assert.equal(alone.offered, true)
    assert.equal(alone.channel, false)
    assert.ok(!alone.plan.args.includes(flag))
    assert.ok(logs.every((l) => !l.includes(key) && !l.includes(alone.plan.env[ENV_DOOR_MCP_KEY]!)), 'no log line carries a key')
    own.dispose()
  })

  test('without the ronda: the delivery on gives the door its own channel flag; the tools alone or nothing give no channel', async () => {
    const { mcp, verbs } = make()
    const flag = RONDA_ARGS[0]!
    // Nothing wanted: the very plan, with or without the ronda.
    const plain = plainPlan()
    assert.equal((await mcp.prepare(plain, ctxOf('n1', { rondaOffered: false }))).plan, plain)
    // The delivery on, no ronda: the flag with tether only, first; the channel told to the grant.
    const on = mcp.enableDelivery()
    const alone = await mcp.prepare(plainPlan(), ctxOf('d1', { rondaOffered: false }))
    assert.equal(alone.offered, true)
    assert.equal(alone.channel, true)
    assert.deepEqual(alone.plan.args.slice(0, 2), [flag, `server:${DOOR_MCP_SERVER}`])
    assert.equal(alone.plan.args.filter((a) => a === flag).length, 1)
    assert.ok(!alone.plan.args.includes(`server:${RONDA_MCP_SERVER}`))
    // The delivery on, with the ronda: one flag with both, as before.
    const both = await mcp.prepare(rondaPlan(), ctxOf('d2'))
    assert.deepEqual(both.plan.args.slice(0, 3), [flag, `server:${RONDA_MCP_SERVER}`, `server:${DOOR_MCP_SERVER}`])
    assert.equal(both.plan.args.filter((a) => a === flag).length, 1)
    on.dispose()
    // Only a tool, no ronda: the server without a channel.
    const own = new DisposableStore()
    own.add(verbs.register('ext', verb('tool')))
    const tools = await mcp.prepare(plainPlan(), ctxOf('t1', { rondaOffered: false }))
    assert.equal(tools.channel, false)
    assert.ok(!tools.plan.args.includes(flag))
    own.dispose()
  })

  test('the host grant carries the channel of the MCP offer', async () => {
    const host = new DoorHost({ log: () => {} })
    const home = tempHome()
    homes.push(home)
    host.attach({ home, stateOf: () => undefined } as unknown as SlotPort)
    const on = host.mcp.enableDelivery()
    const g = await host.prepareLaunch(plainPlan(), ctxOf('h1', { rondaOffered: false }))
    assert.equal(g.channel, true)
    g.revoke()
    on.dispose()
    const plain = await host.prepareLaunch(plainPlan(), ctxOf('h2', { rondaOffered: false }))
    assert.equal(plain.channel, undefined, 'nothing wanted: the plain grant')
    await host.mcp.close()
  })

  test('era: server/discover never gets a result; initialize is legacy, declares tools that change, the channel and the instructions', async () => {
    const { mcp, verbs, logs } = make()
    const own = new DisposableStore()
    own.add(verbs.register('ext', verb('tool')))
    own.add(verbs.instructions('ext', 'Use probe_tool to probe.'))
    const { url, key } = await launch(mcp, 's1')
    const probe = await post(url, key, { jsonrpc: '2.0', id: 0, method: 'server/discover', params: {} })
    assert.notEqual(probe.status, 200, 'the probe before a session is refused: the client falls back to initialize')
    assert.ok(!probe.text.includes('supportedVersions'))

    const init = await post(url, key, initialize('2025-11-25'))
    assert.equal(init.status, 200)
    const r = init.msg!.result
    assert.equal(r.protocolVersion, '2025-11-25')
    assert.deepEqual(r.capabilities, { tools: { listChanged: true }, experimental: { 'claude/channel': {} } })
    assert.equal(r.serverInfo.name, DOOR_MCP_SERVER)
    assert.equal(r.instructions, `${DOOR_INSTRUCTIONS}\n\n[ext]\nUse probe_tool to probe.`)
    assert.ok(logs.includes('door: slot s1: sessão do servidor tether (era legada, protocolo 2025-11-25, cliente t 1)'))

    const inside = await post(url, key, { jsonrpc: '2.0', id: 2, method: 'server/discover', params: {} }, init.session)
    assert.equal(inside.msg!.error.code, -32601)
    assert.equal(inside.msg!.result, undefined)

    const modern = await post(url, key, initialize('2026-07-28', 3))
    assert.equal(modern.msg!.result.protocolVersion, '2025-11-25')
    own.dispose()
  })

  test('tools/list shows the mcp verbs; tools/call gives the handler the slot of the route; a wrong key is 401', async () => {
    const { mcp, verbs, addSlot } = make()
    addSlot('s1')
    addSlot('s2')
    const calls: Array<{ caller: VerbCaller; args: Record<string, unknown> }> = []
    const own = new DisposableStore()
    own.add(verbs.register('ext', verb('read-screen', { run: (caller, args) => { calls.push({ caller, args }); return { text: `ok ${caller.slotId}`, data: { slot: caller.slotId } } } })))
    own.add(verbs.register('ext', verb('cli-only', { exits: ['cli'] })))
    own.add(verbs.register('ext', verb('boom', { run: () => { throw new Error('quebrou') } })))
    const a = await launch(mcp, 's1')
    const b = await launch(mcp, 's2')

    const init = await post(b.url, b.key, initialize('2025-06-18'))
    const list = await post(b.url, b.key, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, init.session)
    assert.deepEqual(list.msg!.result.tools.map((t: { name: string }) => t.name), ['probe_read_screen', 'probe_boom'])
    assert.deepEqual(list.msg!.result.tools[0], { name: 'probe_read_screen', description: 'The read-screen verb.', inputSchema: verb('x').input })

    const call = await post(b.url, b.key, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'probe_read_screen', arguments: { text: 'oi' } } }, init.session)
    assert.deepEqual(call.msg!.result, { content: [{ type: 'text', text: 'ok s2' }], structuredContent: { slot: 's2' } })
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0]!.args, { text: 'oi' })
    assert.equal(calls[0]!.caller.slotId, 's2', 'the slot of the route, never anything the agent says')
    assert.equal(calls[0]!.caller.via, 'mcp')
    assert.equal(calls[0]!.caller.proven, true)
    assert.equal(calls[0]!.caller.state.slotId, 's2')

    const boom = await post(b.url, b.key, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'probe_boom' } }, init.session)
    assert.equal(boom.msg!.result.isError, true)
    const unknown = await post(b.url, b.key, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'probe_cli_only' } }, init.session)
    assert.equal(unknown.msg!.error.code, -32602, 'a cli-only verb is no tool')

    assert.equal((await post(b.url, 'x'.repeat(32), initialize('2025-06-18'))).status, 401, 'wrong key')
    assert.equal((await post(b.url, a.key, initialize('2025-06-18'))).status, 401, 'another slot\'s key')
    own.dispose()
  })

  test('tools/list_changed reaches the open stream when a verb comes in; the stream edges are told; a channel message goes out', async () => {
    const { mcp, verbs } = make()
    const own = new DisposableStore()
    own.add(verbs.register('ext', verb('first')))
    const edges: Array<[string, boolean]> = []
    own.add(mcp.onDidStream((id, open) => edges.push([id, open])))
    const { url, key } = await launch(mcp, 's1')
    const init = await post(url, key, initialize('2025-11-25'))
    assert.equal(mcp.connected('s1'), false)
    assert.equal(mcp.sendChannel('s1', 'x', {}), false, 'nothing sent without a stream')
    const ac = new AbortController()
    const get = await fetch(url, { headers: { accept: 'text/event-stream', authorization: `Bearer ${key}`, 'mcp-session-id': init.session! }, signal: ac.signal })
    await waitUntil(() => mcp.connected('s1'), 5_000, 'stream open')
    assert.deepEqual(edges, [['s1', true]])

    const reader = get.body!.getReader()
    let seen = ''
    const until = async (needle: string): Promise<void> => { while (!seen.includes(needle)) seen += new TextDecoder().decode((await reader.read()).value) }
    own.add(verbs.instructions('ext', 'only instructions: the tool list is the same')) // no list_changed for this one
    own.add(verbs.register('ext', verb('second')))
    await until('notifications/tools/list_changed')
    assert.equal(seen.split('notifications/tools/list_changed').length - 1, 1, 'one notice, for the verb only')

    assert.equal(mcp.sendChannel('s1', 'corpo', { kind: 'message', from: 'Atrium' }), true)
    await until('notifications/claude/channel')
    const note = JSON.parse(seen.split('\n').find((l) => l.includes('notifications/claude/channel'))!.slice(6))
    assert.deepEqual(note, { jsonrpc: '2.0', method: 'notifications/claude/channel', params: { content: 'corpo', meta: { kind: 'message', from: 'Atrium' } } })

    mcp.revoke('s1')
    assert.deepEqual(edges, [['s1', true], ['s1', false]])
    ac.abort()
    own.dispose()
  })

  test('the delivery alone makes it wanted; revoke ends the key and removes the file', async () => {
    const { mcp } = make()
    const plan = plainPlan()
    const on = mcp.enableDelivery()
    const { file, url, key } = await launch(mcp, 's1')
    assert.ok(existsSync(file))
    mcp.revoke('s1')
    await mcp.flush()
    assert.ok(!existsSync(file), 'the file goes with the run')
    assert.equal((await post(url, key, initialize('2025-11-25'))).status, 401, 'the key died with the run')
    on.dispose()
    on.dispose() // twice is once
    assert.equal(mcp.wanted, false)
    assert.equal((await mcp.prepare(plan, ctxOf('s1'))).plan, plan)
  })

  test('channelArgsOf: one flag for several servers; the agent\'s own `channels` wins; no channel is []', () => {
    assert.deepEqual(channelArgsOf(claude(), ['a', 'b']), ['--dangerously-load-development-channels', 'server:a', 'server:b'])
    assert.deepEqual(channelArgsOf(claude(), ['a']), ['--dangerously-load-development-channels', 'server:a'])
    assert.deepEqual(channelArgsOf(claude(), []), [])
    assert.deepEqual(channelArgsOf({}, ['a']), [])
    assert.deepEqual(channelArgsOf({ channel: (s) => ['--ch', s], channels: (ss) => ['--all', ss.join(',')] }, ['a', 'b']), ['--all', 'a,b'])
    assert.deepEqual(channelArgsOf({ channel: (s) => (s === 'a' ? ['--x', s] : ['--y', s]) }, ['a', 'b']), ['--x', 'a', '--y', 'b'])
    assert.equal(toolNameOf({ ns: 'my-ext', name: 'read-screen' }), 'my_ext_read_screen')
  })

  test('soul: the delivery on appends `--channels tether` after its MCP file; nothing on, or a remote host, gives no channel', async () => {
    const { mcp, verbs } = make()
    const soul = agentRegistry.get('soul')!
    assert.equal(soul.mcp?.http, true)
    assert.equal(soul.channel, undefined, 'no ronda for soul')
    const soulPlan = (...args: string[]): LaunchPlan => ({ command: 'node', args: ['soul.mjs', '-g', ...args], cwd: '.', env: { PATH: 'x' } })
    const sctx = (slotId: string): LaunchContext => ctxOf(slotId, { agent: soul, channel: undefined, rondaOffered: false })
    const own = new DisposableStore()
    own.add(verbs.register('ext', verb('tool')))
    const tools = await mcp.prepare(soulPlan(), sctx('st'))
    assert.equal(tools.offered, true)
    assert.equal(tools.channel, false, 'the tools alone take no channel')
    assert.ok(!tools.plan.args.includes('--channels'))
    own.dispose()
    const on = mcp.enableDelivery()
    const out = await mcp.prepare(soulPlan(), sctx('s1'))
    assert.equal(out.channel, true)
    const file = out.plan.args[out.plan.args.indexOf('--mcp-config') + 1]!
    assert.deepEqual(out.plan.args, ['soul.mjs', '-g', '--mcp-config', file, '--channels', DOOR_MCP_SERVER], 'the script stays first, the channel last')
    for (const remote of [['-H', 'https://x'], ['--host=https://x'], ['--target', 'y']]) {
      const r = await mcp.prepare(soulPlan(...remote), sctx('s2'))
      assert.equal(r.offered, true)
      assert.equal(r.channel, false, `no channel with ${remote.join(' ')}`)
      assert.ok(!r.plan.args.includes('--channels'))
    }
    on.dispose()
    assert.equal(soulChannelPlan(soulPlan(), []), undefined)
    assert.deepEqual(soulChannelPlan(soulPlan(), ['a', 'b'])!.args.slice(-2), ['--channels', 'a,b'])
  })

  test('wakes: soul only when its launch took --channels tether (the declared capability proves nothing); codex never; claude by the stream', async () => {
    const { mcp, verbs } = make()
    const own = new DisposableStore()
    const streams: AbortController[] = []
    const open = async (slotId: string, client: string, ctx: LaunchContext): Promise<void> => {
      const out = await mcp.prepare(plainPlan(), ctx)
      assert.ok(out.offered)
      const file = out.plan.args[out.plan.args.lastIndexOf('--mcp-config') + 1]!
      const url = JSON.parse(readFileSync(file, 'utf8')).mcpServers[DOOR_MCP_SERVER].url as string
      const key = out.plan.env[ENV_DOOR_MCP_KEY]!
      const init = await post(url, key, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: { experimental: { 'claude/channel': {} } }, clientInfo: { name: client, version: '1' } } })
      const ac = new AbortController()
      streams.push(ac)
      await fetch(url, { headers: { accept: 'text/event-stream', authorization: `Bearer ${key}`, 'mcp-session-id': init.session! }, signal: ac.signal })
      await waitUntil(() => mcp.connected(slotId), 5_000, `${slotId} stream open`)
    }
    const soulCtx = (slotId: string): LaunchContext => ctxOf(slotId, { agent: agentRegistry.get('soul')!, channel: undefined, rondaOffered: false })
    // Tools only, no ronda: soul's stream opens and its client declares the capability (as soul does), but the plan took no channel.
    own.add(verbs.register('ext', verb('tool')))
    await open('w1', 'claude-code', soulCtx('w1'))
    assert.equal(mcp.wakes('w1'), false, 'soul: declared capability, no --channels in the plan')
    await open('w2', 'claude-code', ctxOf('w2', { rondaOffered: false }))
    assert.equal(mcp.wakes('w2'), true, 'claude: the stream (provisional rule, unchanged)')
    const on = mcp.enableDelivery()
    await open('w3', 'codex-mcp-client', ctxOf('w3', { rondaOffered: false }))
    assert.equal(mcp.wakes('w3'), false, 'codex stays out')
    await open('w4', 'claude-code', soulCtx('w4'))
    assert.equal(mcp.wakes('w4'), true, 'soul launched with --channels tether')
    // A new launch of the same slot without the channel takes the wake back; the revoke clears the mark.
    on.dispose()
    await open('w4', 'claude-code', soulCtx('w4'))
    assert.equal(mcp.wakes('w4'), false, 'relaunched without the channel')
    mcp.revoke('w1')
    assert.equal(mcp.wakes('w1'), false)
    for (const ac of streams) ac.abort()
    own.dispose()
  })

  function homesLast(): string { return homes.at(-1)! }
})

/**
 * A fake agent for a real launch (a .cjs file: a `node -e` process dies at once under the panel host on Windows). At start it
 * says whether the `tether` MCP file of its last `--mcp-config` is already on disk, then, as Claude Code would, initializes
 * with the bearer from its env and calls the tool; it prints the tool's text. It never prints the key.
 */
const FAKE_AGENT = `
const fs = require('node:fs')
const argv = process.argv.slice(2)
const file = argv[argv.lastIndexOf('--mcp-config') + 1]
const present = !!file && fs.existsSync(file)
process.stdout.write('DOOR-FILE ' + (present ? 'present' : 'absent') + '\\n')
setInterval(() => {}, 60000)
if (!present) return
const server = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.tether
const auth = server.headers.Authorization.replace('\${TETHER_MCP_KEY}', process.env.TETHER_MCP_KEY || '')
const post = async (msg, session) => {
  const r = await fetch(server.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: auth, ...(session ? { 'mcp-session-id': session } : {}) }, body: JSON.stringify(msg) })
  const text = await r.text()
  const lines = text.split('\\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)))
  return { session: r.headers.get('mcp-session-id'), body: lines[lines.length - 1] || (text ? JSON.parse(text) : undefined) }
}
;(async () => {
  const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fake', version: '1' } } })
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, init.session)
  const call = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'probe_whoami', arguments: {} } }, init.session)
  process.stdout.write('TOOL{{' + call.body.result.content[0].text + '}}\\n')
})().catch((e) => process.stdout.write('TOOL-FAILED ' + e.message + '\\n'))
`

describe('agent door MCP server in a real launch (D5)', () => {
  let home: string
  let daemon: Daemon | undefined
  let rec: Recorder | undefined
  const own = new DisposableStore()
  const logs: string[] = []
  after(async () => {
    own.dispose()
    rec?.close()
    await daemon?.close()
    await door.mcp.close()
    await removeHome(home)
  })
  const door = new DoorHost({ log: (m) => logs.push(m) })

  test('with an mcp verb registered, the launch plan carries the tether server and its file is on disk before the process starts', async () => {
    home = tempHome()
    const script = join(home, 'fake-door-agent.cjs')
    writeFileSync(script, FAKE_AGENT)
    let launched: LaunchPlan | undefined
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'NODE_TEST_CONTEXT') env[k] = v
    const fake: AgentAdapter = { name: 'claude', plan: (input) => ({ command: process.execPath, args: [script], cwd: input.slot.cwd, env }), sessionExists: async () => 'unknown', title: async (b) => b.title }
    const calls: VerbCaller[] = []
    own.add(door.apiFor('probe', own).verbs.register(verb('whoami', { run: (caller) => { calls.push(caller); return { text: `slot=${caller.slotId}` } } })))
    // Spy on the plan the door hands back (the hook's promise is awaited by the server before the spawn).
    const real = door.prepareLaunch.bind(door)
    door.prepareLaunch = async (plan, ctx) => { const g = await real(plan, ctx); launched = g.plan; return g }
    daemon = await startDaemon({ home, pipe: uniquePipe(home), readyFallbackMs: 300, minAgentAgeMs: 0, memoryIntervalMs: 0, adapters: { claude: fake }, channelOf: () => undefined, door, log: (m) => logs.push(m) })
    rec = await Recorder.connect(daemon.pipe)
    const { slot } = await rec.client.request({ t: 'create', kind: 'claude', cwd: home, start: true })
    const id = slot!.slotId
    await rec.client.request({ t: 'attach', slotId: id, cols: 200, rows: 30 })
    await rec.see(id, /DOOR-FILE (present|absent)/, 30_000)
    assert.match(rec.text(id), /DOOR-FILE present/, 'the MCP file was on disk when the process started')
    const file = join(home, 'door', 'mcp', `${id}.json`)
    assert.ok(launched, 'the door hook ran')
    assert.deepEqual(launched!.args.slice(-2), ['--mcp-config', file])
    assert.equal(launched!.mcpServers?.[DOOR_MCP_SERVER], file)
    assert.equal(typeof launched!.env[ENV_DOOR_MCP_KEY], 'string')
    await rec.see(id, /TOOL\{\{[^}]*\}\}/, 30_000)
    assert.match(rec.text(id), new RegExp(`TOOL\\{\\{slot=${id}\\}\\}`), 'the tool call reached the handler with the launched slot')
    assert.equal(calls.at(-1)?.via, 'mcp')
    const key = launched!.env[ENV_DOOR_MCP_KEY]!
    assert.ok(!logs.some((l) => l.includes(key)), 'no log line carries the key')
    assert.ok(!readFileSync(file, 'utf8').includes(key), 'the file holds no key')
    // Forget ends the run's grant and removes the file.
    await rec.client.request({ t: 'forget', slotId: id })
    await door.mcp.flush()
    assert.ok(!existsSync(file))
  })
})

describe('the door channel without the ronda in a real launch (D6b)', () => {
  const homes: string[] = []
  after(async () => { for (const h of homes) await removeHome(h) })
  // Prints Claude's channel dialog (captured screen) and echoes each key as <...> (the dialog turns on the win32 input mode,
  // so a key may come as an escape sequence: the test counts that something came, not its bytes).
  const DIALOG_AGENT = `
process.stdout.write(${JSON.stringify(CHANNEL_DIALOG)})
process.stdin.setRawMode?.(true)
process.stdin.on('data', (d) => process.stdout.write('<' + String(d).split(String.fromCharCode(13)).join('#CR#') + '>'))
setInterval(() => {}, 60000)
`

  async function launch(delivery: boolean): Promise<{ logs: string[]; typed: string }> {
    const home = tempHome()
    homes.push(home)
    const script = join(home, 'dialog-agent.cjs')
    writeFileSync(script, DIALOG_AGENT)
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'NODE_TEST_CONTEXT') env[k] = v
    const fake: AgentAdapter = { name: 'claude', plan: (input) => ({ command: process.execPath, args: [script], cwd: input.slot.cwd, env }), sessionExists: async () => 'unknown', title: async (b) => b.title }
    const logs: string[] = []
    const door = new DoorHost({ log: (m) => logs.push(m) })
    const own = new DisposableStore()
    if (delivery) own.add(door.apiFor('probe', own).delivery.enable())
    // The fake is `node <script>`: the channel flag must be an arg node takes before a script. Claude's dialog stays the real one.
    const contribution = claude() as { channels?: AgentContribution['channels'] }
    const saved = contribution.channels
    contribution.channels = () => ['--no-warnings']
    const daemon = await startDaemon({ home, pipe: uniquePipe(home), readyFallbackMs: 300, minAgentAgeMs: 0, memoryIntervalMs: 0, adapters: { claude: fake }, channelOf: () => undefined, door, log: (m) => logs.push(m) })
    const rec = await Recorder.connect(daemon.pipe)
    try {
      const { slot } = await rec.client.request({ t: 'create', kind: 'claude', cwd: home })
      const id = slot!.slotId
      await rec.client.request({ t: 'attach', slotId: id, cols: 140, rows: 40 })
      await rec.client.request({ t: 'start', slotId: id, choice: 'new' })
      await rec.see(id, /Enter[\s\S]*cancel/, 8_000)
      if (delivery) await waitUntil(() => logs.some((l) => l.endsWith('channel confirmation recognized; answering')), 10_000, 'the dialog answered')
      await new Promise((r) => setTimeout(r, 1_500))
      return { logs, typed: (rec.text(id).match(/<[^>]*>/g) ?? []).join('') }
    } finally {
      contribution.channels = saved
      own.dispose()
      rec.close()
      await daemon.close()
      await door.mcp.close()
    }
  }

  test('no ronda, the delivery on: the door channel goes in and its start dialog is answered once', async () => {
    const { logs, typed } = await launch(true)
    assert.equal(logs.filter((l) => l.endsWith('channel confirmation recognized; answering')).length, 1, 'answered once')
    assert.ok(typed.length > 0, 'a key reached the agent')
  })

  test('no ronda, nothing on: no channel, the dialog gets no key', async () => {
    const { logs, typed } = await launch(false)
    assert.ok(!logs.some((l) => l.includes('channel confirmation recognized')))
    assert.equal(typed, '')
  })
})
