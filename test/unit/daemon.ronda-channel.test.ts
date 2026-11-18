// The ronda's channel (src/daemon/ronda-channel.ts) on its own: what a launch gets (args, MCP file without the key, the key
// in the env), the handshake (claude/channel declared, the instructions that make the signal legitimate, a legacy protocol
// revision), the era trap (`server/discover` must never get a result: Claude Code drops channels in the modern era), the
// GET stream's edges (connected / not), a sent ronda reaching the stream, the revoke, and the start dialog recognizer.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { after, describe, test } from 'node:test'
import { withMcpConfigFlag } from '../../src/agents/mcp.ts'
import type { LaunchPlan } from '../../src/agents/types.ts'
import { agentRegistry } from '../../src/agents/registry.ts'
import '../../src/agents/load.ts'
import { ENV_RONDA_MCP_KEY, RONDA_INSTRUCTIONS, RONDA_MCP_SERVER, RondaChannel, screenKey, showsConfirm } from '../../src/daemon/ronda-channel.ts'
import { CHANNEL_DIALOG, CHANNEL_DIALOG_OTHER } from './ronda-dialog.fixture.ts'
import { removeHome, tempHome, waitUntil } from './daemon.helpers.ts'

const SLOT = 'slot-a'
const basePlan = (): LaunchPlan => ({ command: 'claude', args: ['--settings', 's.json'], cwd: '.', env: { PATH: 'x' } })
const agent = { args: ['--dangerously-load-development-channels', `server:${RONDA_MCP_SERVER}`], inject: withMcpConfigFlag }

async function post(url: string, key: string, msg: unknown, session?: string) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}`, ...(session ? { 'mcp-session-id': session } : {}) },
    body: JSON.stringify(msg),
  })
  const text = await r.text()
  const lines = text.split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)) as Record<string, any>)
  return { status: r.status, session: r.headers.get('mcp-session-id') ?? undefined, msg: lines.at(-1) ?? (text ? JSON.parse(text) as Record<string, any> : undefined), text }
}
const initialize = (version: string) => ({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 't', version: '1' } } })

describe('ronda channel', () => {
  const homes: string[] = []
  const channels: RondaChannel[] = []
  after(async () => {
    for (const c of channels) await c.close()
    for (const h of homes) await removeHome(h)
  })
  async function make() {
    const home = tempHome()
    homes.push(home)
    const changes: Array<[string, boolean]> = []
    const logs: string[] = []
    const ch: RondaChannel = new RondaChannel({ home, log: m => logs.push(m), onChange: id => changes.push([id, ch.connected(id)]) })
    channels.push(ch)
    await ch.listen()
    return { home, ch, changes, logs }
  }
  async function launch(ch: RondaChannel) {
    const out = await ch.prepare(basePlan(), SLOT, agent)
    assert.ok(out.offered)
    const file = out.plan.args[out.plan.args.indexOf('--mcp-config') + 1]!
    const cfg = JSON.parse(readFileSync(file, 'utf8')).mcpServers[RONDA_MCP_SERVER]
    return { plan: out.plan, file, url: cfg.url as string, key: out.plan.env[ENV_RONDA_MCP_KEY]! }
  }

  test('a launch gets the channel args first, the MCP file (no key in it) last, the key in the env; no agent = nothing', async () => {
    const { ch } = await make()
    const plain = basePlan()
    assert.deepEqual(await ch.prepare(plain, SLOT, undefined), { plan: plain, offered: false })
    const { plan, file, key } = await launch(ch)
    assert.deepEqual(plan.args.slice(0, 2), agent.args, 'variadic channel flag before the slot\'s own args')
    assert.deepEqual(plan.args.slice(-2), ['--mcp-config', file], 'the MCP file at the end')
    assert.equal(key.length, 32)
    const text = readFileSync(file, 'utf8')
    assert.ok(!text.includes(key), 'the file holds no key')
    assert.match(text, new RegExp(`Bearer \\$\\{${ENV_RONDA_MCP_KEY}\\}`))
    assert.deepEqual(plan.mcpServers, { [RONDA_MCP_SERVER]: file })
  })

  test('era: server/discover never gets a result (Claude Code would drop the channel); initialize is legacy, declares the channel and the instructions', async () => {
    const { ch, logs } = await make()
    const { url, key } = await launch(ch)
    // The probe Claude Code sends first, with no session: refused by the host, so the client falls back to initialize.
    const probe = await post(url, key, { jsonrpc: '2.0', id: 0, method: 'server/discover', params: {} })
    assert.notEqual(probe.status, 200)
    assert.ok(!probe.text.includes('supportedVersions'), 'no discover result before a session')

    const init = await post(url, key, initialize('2025-11-25'))
    assert.equal(init.status, 200)
    const r = init.msg!.result
    assert.equal(r.protocolVersion, '2025-11-25')
    assert.deepEqual(r.capabilities.experimental, { 'claude/channel': {} })
    assert.equal(r.instructions, RONDA_INSTRUCTIONS)
    assert.match(RONDA_INSTRUCTIONS, /você mesmo ligou neste painel/)
    assert.match(RONDA_INSTRUCTIONS, /faça a ronda combinada/)
    assert.doesNotMatch(RONDA_INSTRUCTIONS, /responda/i, 'the instructions ask for the ronda, not for a given answer')
    assert.ok(logs.includes(`slot ${SLOT}: ronda channel session (era legacy, protocol 2025-11-25)`))

    // Inside a session too: "method not found", never a result.
    const inside = await post(url, key, { jsonrpc: '2.0', id: 2, method: 'server/discover', params: {} }, init.session)
    assert.equal(inside.msg!.error.code, -32601)
    assert.equal(inside.msg!.result, undefined)

    // A modern revision asked through initialize is answered with the newest legacy one.
    const modern = await post(url, key, initialize('2026-07-28'))
    assert.equal(modern.msg!.result.protocolVersion, '2025-11-25')
    assert.ok(logs.includes(`slot ${SLOT}: ronda channel session (era legacy, protocol 2025-11-25, asked 2026-07-28)`))
  })

  test('connected only while the GET stream is open; a sent ronda reaches it; revoke drops it, the key and the file', async () => {
    const { ch, changes } = await make()
    const { url, key, file } = await launch(ch)
    const init = await post(url, key, initialize('2025-11-25'))
    assert.equal(ch.connected(SLOT), false, 'no stream yet')
    assert.equal(ch.send(SLOT, 'x'), false, 'nothing sent without a stream')

    const ac = new AbortController()
    const get = await fetch(url, { headers: { accept: 'text/event-stream', authorization: `Bearer ${key}`, 'mcp-session-id': init.session! }, signal: ac.signal })
    await waitUntil(() => ch.connected(SLOT), 5_000, 'connected')
    assert.deepEqual(changes, [[SLOT, true]])

    assert.equal(ch.send(SLOT, '[ronda] olá'), true)
    const reader = get.body!.getReader()
    let seen = ''
    while (!seen.includes('notifications/claude/channel')) seen += new TextDecoder().decode((await reader.read()).value)
    const note = JSON.parse(seen.split('\n').find(l => l.includes('notifications/claude/channel'))!.slice(6))
    assert.deepEqual(note, { jsonrpc: '2.0', method: 'notifications/claude/channel', params: { content: '[ronda] olá', meta: { kind: 'ronda' } } })

    ch.revoke(SLOT)
    await ch.flush() // the file goes behind its write, through the store
    assert.equal(ch.connected(SLOT), false)
    assert.deepEqual(changes, [[SLOT, true], [SLOT, false]])
    assert.ok(!existsSync(file))
    assert.equal((await post(url, key, initialize('2025-11-25'))).status, 401, 'the key died with the run')
    ac.abort()
  })

  test('the start dialog: Claude\'s exact screen matches; "Exit" selected, a half-drawn screen or plain output do not', () => {
    const confirm = agentRegistry.get('claude')!.channelConfirm!
    assert.equal(showsConfirm(CHANNEL_DIALOG, confirm), true)
    assert.equal(showsConfirm(CHANNEL_DIALOG_OTHER, confirm), false)
    assert.equal(showsConfirm(CHANNEL_DIALOG.slice(0, CHANNEL_DIALOG.indexOf('Enter')), confirm), false)
    assert.equal(showsConfirm('I am using this for local development', confirm), false)
    assert.equal(screenKey('\u001b[1mWARNING:\u001b[1CLoading\u001b]0;t\u0007 x'), 'WARNING:Loadingx')
  })
})
