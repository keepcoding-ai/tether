// The agent door's delivery (slice D6) in a real tetherd on a test home and test pipe. The fake agent is a `claude` slot whose
// process logs every stdin chunk it gets (one JSON per line, its own file per slot) and, when its slot is named "dentro",
// opens the `tether` MCP server's session and GET stream as Claude Code does and logs each channel notification. The turn and
// the attention come from the hook's attention file the test writes. No real agent; the user's home, pipe and tetherd are
// never touched.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { DisposableStore } from '../../app/shared/vscode-lifecycle.ts'
import '../../src/agents/load.ts'
import type { AgentAdapter, LaunchPlan } from '../../src/agents/types.ts'
import { slotAttentionPath } from '../../src/core/paths.ts'
import { deliveryMeta } from '../../src/daemon/door/channel-meta.ts'
import { inboxPath } from '../../src/daemon/door/delivery.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import type { DeliveryMessage, DeliveryReceipt, DoorDelivery, DoorSlots } from '../../src/daemon/door/types.ts'
import { USER_QUIET_MS } from '../../src/daemon/door/user-presence.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { Recorder, removeHome, sleep, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

const FAKE_AGENT = String.raw`
const fs = require('node:fs')
const log = (file, x) => fs.appendFileSync(file, JSON.stringify(x) + '\n')
process.stdout.write('READY\r\n')
if (process.stdin.setRawMode) process.stdin.setRawMode(true)
process.stdin.on('data', (d) => log(process.env.ECHO_LOG, d.toString()))
setInterval(() => {}, 60000)
const argv = process.argv
const file = argv[argv.lastIndexOf('--mcp-config') + 1]
if (process.env.OPEN_STREAM === '1' && file && fs.existsSync(file)) {
  const server = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.tether
  const auth = server.headers.Authorization.replace('\${TETHER_MCP_KEY}', process.env.TETHER_MCP_KEY || '')
  const headers = (session) => ({ 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: auth, ...(session ? { 'mcp-session-id': session } : {}) })
  const post = async (msg, session) => {
    const r = await fetch(server.url, { method: 'POST', headers: headers(session), body: JSON.stringify(msg) })
    await r.text()
    return r.headers.get('mcp-session-id')
  }
  ;(async () => {
    const session = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fake', version: '1' } } })
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, session)
    const r = await fetch(server.url, { method: 'GET', headers: { accept: 'text/event-stream', authorization: auth, 'mcp-session-id': session } })
    log(process.env.CHAN_LOG, { open: r.status })
    const dec = new TextDecoder()
    let buf = ''
    for await (const part of r.body) {
      buf += dec.decode(part, { stream: true })
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (line.startsWith('data: ')) log(process.env.CHAN_LOG, JSON.parse(line.slice(6)))
      }
    }
  })().catch((e) => log(process.env.CHAN_LOG, { failed: e.message }))
}
`

const codeOf = (e: unknown): string | undefined => (e as { code?: string }).code
const readLines = <T>(file: string): T[] => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as T) : [])

const msg = (body: string, over: Partial<DeliveryMessage> = {}): DeliveryMessage => ({ kind: 'message', room: 'kai', from: { name: 'Atrium', id: 'a1b2c3', role: 'member' }, body, ...over })

describe('agent door delivery (D6)', () => {
  let home: string
  let pipe: string
  let daemon: Daemon
  let rec: Recorder
  let door: DoorHost
  let own: DisposableStore
  let slots: DoorSlots
  let delivery: DoorDelivery
  const receipts: DeliveryReceipt[] = []
  const logs: string[] = []

  const echoLog = (slotId: string): string => join(home, `echo-${slotId}.log`)
  const chanLog = (slotId: string): string => join(home, `chan-${slotId}.log`)
  const chunks = (slotId: string): string[] => readLines<string>(echoLog(slotId))

  const fake: AgentAdapter = {
    name: 'claude',
    plan: (input): LaunchPlan => {
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
      delete env.NODE_TEST_CONTEXT
      env.ECHO_LOG = echoLog(input.slot.slotId)
      env.CHAN_LOG = chanLog(input.slot.slotId)
      env.OPEN_STREAM = input.slot.name === 'dentro' ? '1' : '0'
      return { command: process.execPath, args: [join(home, 'fake-agent.cjs')], cwd: input.slot.cwd, env }
    },
    sessionExists: async () => 'unknown',
    title: async (b) => b.title,
  }

  async function boot(): Promise<void> {
    door = new DoorHost({ log: (m) => logs.push(m) })
    own = new DisposableStore()
    daemon = await startDaemon({ home, pipe, memoryIntervalMs: 0, readyFallbackMs: 300, minAgentAgeMs: 0, adapters: { claude: fake }, channelOf: () => undefined, door, log: (m) => logs.push(m) })
    rec = await Recorder.connect(daemon.pipe)
    const api = door.apiFor('probe', own)
    slots = api.slots
    delivery = api.delivery
    delivery.enable()
    delivery.onDidDeliver((r) => receipts.push(r))
  }
  async function shutdown(): Promise<void> {
    await door.delivery.flush()
    own.dispose()
    door.delivery.dispose()
    rec.close()
    await daemon.close()
    await door.mcp.close()
  }

  before(async () => {
    home = tempHome()
    pipe = uniquePipe(home)
    // A script file: a `-e` script does not survive the terminal host's command line on Windows.
    writeFileSync(join(home, 'fake-agent.cjs'), FAKE_AGENT)
    await boot()
  })
  after(async () => {
    await shutdown().catch(() => {})
    await removeHome(home)
  })

  const running = async (name: string): Promise<string> => {
    const id = (await slots.create({ kind: 'claude', cwd: home, name })).slotId
    await waitUntil(() => slots.get(id)?.status === 'running' && chunks(id) !== undefined && slots.readScreen(id).data.includes('READY'), 30_000, `${name} running`)
    return id
  }
  let attentionTs = Date.now()
  const report = (id: string, kind: 'start' | 'done' | 'waiting'): void => {
    attentionTs = Math.max(attentionTs + 1, Date.now())
    writeFileSync(slotAttentionPath(home, id), JSON.stringify({ ts: new Date(attentionTs).toISOString(), kind }) + '\n')
  }
  const receiptOf = (id: string): DeliveryReceipt | undefined => receipts.find((r) => r.id === id)
  const hold = (id: string): Promise<void> => slots.setHeld(id, { ext: 'probe', by: 'owner-slot' })

  test('refusals: an unknown slot, a bad message, empty paths', async () => {
    await assert.rejects(delivery.deliver('ffffffff', msg('x')), (e: unknown) => codeOf(e) === 'unknown-slot')
    const id = (await slots.create({ kind: 'claude', cwd: home, start: false })).slotId
    await assert.rejects(delivery.deliver(id, { kind: 'shout', from: { name: 'a', id: 'b', role: 'member' }, body: 'x' } as never), (e: unknown) => codeOf(e) === 'bad-request')
    await assert.rejects(delivery.deliver(id, msg('x'), { paths: [] }), (e: unknown) => codeOf(e) === 'bad-request')
    await slots.forget(id)
  })

  test('an open stream delivers inside, even with the pane in the user hands and a draft of theirs; the PTY gets no byte', async () => {
    const id = await running('dentro')
    await waitUntil(() => delivery.pathOf(id) === 'inside', 30_000, 'the fake agent opened its stream')
    rec.client.input(id, 'rascunho')
    await waitUntil(() => chunks(id).join('').includes('rascunho'), 10_000, 'the draft reached the PTY')
    const before = chunks(id).length
    assert.equal(slots.get(id)!.held, undefined, 'the pane is with the user')
    const r = await delivery.deliver(id, msg('olá de dentro', { inReplyTo: 'm_prev', from: { name: 'Atrium\n', id: 'a1b2c3', role: 'member' } }))
    assert.equal(r.state, 'inside')
    assert.equal(r.slotId, id)
    await waitUntil(() => readLines<Record<string, any>>(chanLog(id)).some((l) => l.method === 'notifications/claude/channel'), 10_000, 'the channel notification')
    const note = readLines<Record<string, any>>(chanLog(id)).find((l) => l.method === 'notifications/claude/channel')!
    assert.equal(note.params.content, 'olá de dentro')
    assert.deepEqual(note.params.meta, deliveryMeta(msg('', { inReplyTo: 'm_prev' }), 'probe', r.id))
    for (const v of Object.values(note.params.meta)) assert.equal(typeof v, 'string')
    assert.equal('source' in note.params.meta, false)
    assert.equal(receiptOf(r.id)?.state, 'inside')
    await sleep(300)
    assert.equal(chunks(id).length, before, 'not one byte typed')
    await slots.forget(id)
  })

  test('no stream and no held: queued, on disk, and the PTY gets no byte; held and idle: types header+body, then Enter in a separate write', async () => {
    const id = await running('fora')
    const before = chunks(id).length
    const r = await delivery.deliver(id, msg('primeira'))
    assert.equal(r.state, 'queued')
    assert.equal(delivery.pathOf(id), 'wait')
    assert.deepEqual(delivery.pending(id).map((p) => p.id), [r.id])
    assert.equal(readLines(inboxPath(home, id)).length, 1, 'the queue is on disk')
    await sleep(1_000)
    assert.equal(chunks(id).length, before, 'not one byte typed without held')

    await hold(id)
    await waitUntil(() => receiptOf(r.id)?.state === 'typed', 10_000, 'typed once held')
    await waitUntil(() => chunks(id).at(-1) === '\r', 5_000, 'the Enter')
    const typed = chunks(id).slice(before)
    assert.equal(typed.at(-1), '\r', 'Enter alone in its write')
    assert.equal(typed.slice(0, -1).join(''), `[tether · probe · #kai · de Atrium (member) · ${r.id}] primeira`, 'header and body before the Enter, with no CR')
    assert.deepEqual(delivery.pending(id), [])
    await door.delivery.flush()
    assert.equal(existsSync(inboxPath(home, id)), false, 'the inbox goes when the queue empties')

    // Several lines: a bracketed paste, header first, then the Enter apart (after the settle of the previous one).
    const mark = chunks(id).length
    const r2 = await delivery.deliver(id, msg('linha 1\nlinha 2'))
    await waitUntil(() => receiptOf(r2.id)?.state === 'typed', 15_000, 'the multi-line one typed')
    await waitUntil(() => chunks(id).length > mark && chunks(id).at(-1) === '\r', 5_000, 'its Enter')
    const pasted = chunks(id).slice(mark)
    assert.equal(pasted.at(-1), '\r')
    assert.equal(pasted.slice(0, -1).join(''), `\x1b[200~[tether · probe · #kai · de Atrium (member) · ${r2.id}]\rlinha 1\rlinha 2\x1b[201~`)
    await slots.forget(id)
  })

  test('held with a user key less than 10 s ago waits; a draft waits until Enter, then the silence frees it', async () => {
    const id = await running('tecla')
    await hold(id)
    rec.client.input(id, 'meio')
    await waitUntil(() => chunks(id).join('').includes('meio'), 10_000, 'the user key reached the PTY')
    const r = await delivery.deliver(id, msg('espera o usuário'))
    assert.equal(r.state, 'queued')
    await sleep(1_500)
    assert.equal(receiptOf(r.id), undefined, 'a draft holds it')
    rec.client.input(id, '\r')
    const enterAt = Date.now()
    await waitUntil(() => chunks(id).at(-1) === '\r', 10_000, 'the user Enter reached the PTY')
    await waitUntil(() => receiptOf(r.id)?.state === 'typed', USER_QUIET_MS + 10_000, 'typed after the silence')
    assert.ok(Date.now() - enterAt >= USER_QUIET_MS - 500, `typed ${Date.now() - enterAt} ms after the user's Enter`)
    await slots.forget(id)
  })

  test('held with attention waiting waits; the turn done lets it through', async () => {
    const id = await running('cartao')
    report(id, 'waiting')
    await waitUntil(() => slots.get(id)?.attention === 'waiting', 10_000, 'waiting')
    await hold(id)
    const before = chunks(id).length
    const r = await delivery.deliver(id, msg('não responda o cartão'))
    assert.equal(r.state, 'queued')
    assert.equal(delivery.pathOf(id), 'wait')
    await sleep(1_000)
    assert.equal(chunks(id).length, before, 'nothing typed on the card')
    report(id, 'start')
    await waitUntil(() => slots.get(id)?.turn === 'busy', 10_000, 'busy')
    await sleep(500)
    assert.equal(chunks(id).length, before, 'nothing typed while busy')
    report(id, 'done')
    await waitUntil(() => receiptOf(r.id)?.state === 'typed', 10_000, 'typed once the turn is done')
    await slots.forget(id)
  })

  test('forget drops what waits', async () => {
    const id = (await slots.create({ kind: 'claude', cwd: home, start: false })).slotId
    const r = await delivery.deliver(id, msg('nunca'))
    assert.equal(r.state, 'queued')
    await slots.forget(id)
    assert.equal(receiptOf(r.id)?.state, 'dropped')
    assert.deepEqual(delivery.pending(id), [])
    await door.delivery.flush()
    assert.equal(existsSync(inboxPath(home, id)), false)
  })

  test('the queue survives a restart and goes out in order', async () => {
    const id = await running('reinicio')
    const a = await delivery.deliver(id, msg('um'))
    const b = await delivery.deliver(id, msg('dois'))
    assert.deepEqual([a.state, b.state], ['queued', 'queued'])
    assert.deepEqual(readLines<{ id: string }>(inboxPath(home, id)).map((x) => x.id), [a.id, b.id])
    await shutdown()

    await boot()
    await door.delivery.ready
    assert.deepEqual(delivery.pending(id).map((p) => p.id), [a.id, b.id], 'back from disk, in order')
    if (slots.get(id)?.status !== 'running') await slots.start(id)
    await waitUntil(() => slots.get(id)?.status === 'running', 30_000, 'running again')
    const before = chunks(id).join('').length
    await hold(id)
    await waitUntil(() => receiptOf(b.id)?.state === 'typed', 20_000, 'both typed')
    assert.equal(receiptOf(a.id)?.state, 'typed')
    const typed = chunks(id).join('').slice(before)
    assert.ok(typed.indexOf(`${a.id}] um`) >= 0 && typed.indexOf(`${a.id}] um`) < typed.indexOf(`${b.id}] dois`), JSON.stringify(typed))
    await slots.forget(id)
  })
})
