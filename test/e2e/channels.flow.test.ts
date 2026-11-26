// V1: the channels end to end WITHOUT the screen and WITHOUT the desk channel. A PRIVATE tetherd (own home, own pipe, own pane host)
// is started the way the app starts it; three fake `claude` agents (test/fixtures/channels/agent-live.cjs, no LLM, no hook) live in
// its panes, found by the daemon as `claude` on the PATH of the test; one `app` client plays the person (the moderator).
// The agents call the verbs the way a real agent does: the CLI (`node "$TETHER_CLI" channels ...`, run by the agent with its own
// pane environment, so its identity is the one of its pane) and, for the agent whose stream is open, the MCP tool
// (`channels_say` ... over the `tether` server it opened). The person's part goes through the `app` requests of the extension
// (`say`, `history`, `members`, `reopen` ...). The script is the scene of the contract (section 8) without the screen:
//   1 create  2 join (by the owner, by itself)  3 say  4 many channels, mute, unmute  5 the moderator speaks and reads
//   6 the merge for a member that does not hear  7 a member that does not hear speaks and reads  8 remove  9 close, read closed, reopen
//   10 a member that stopped, away, and back  11 the MCP exit for reading
// In every step no pane shows attention (the orange mark is for the person; an ordinary line never lights it).
// Run alone: node --test --test-concurrency=1 test/e2e/channels.flow.test.ts
// Never touches the person's tether: home and pipe are the test's, every process is killed by pid + identity (test/kill.ts).
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DaemonClient, DaemonError } from '../../src/daemon/client.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { HostClient } from '../../src/procd/client.ts'
import { claim, killOwned } from '../kill.ts'
import { pidAlive } from './daemon-driver.ts'

const MAIN = resolve(import.meta.dirname, '../../src/daemon/main.ts')
const AGENT = resolve(import.meta.dirname, '../fixtures/channels/agent-live.cjs')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** The agent's fake turn lasts this long (agent-live.cjs); a step is quiet once it is over and the daemon had time to react. */
const SETTLE_MS = 900
/** The longest a `done` may stay on a pane before the extension puts it out (the two states come in the same breath). */
const FLASH_MAX_MS = 250

/** The environment of the test daemon (and so of its agents): no CLAUDE*, no TETHER_* and no NODE_TEST_CONTEXT of where this test runs. */
function cleanDaemonEnv(extra: Record<string, string>, shimDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^CLAUDE/i.test(k) || /^TETHER_/i.test(k) || k === 'NODE_TEST_CONTEXT') continue
    env[k] = v
  }
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  env[pathKey] = `${shimDir}${process.platform === 'win32' ? ';' : ':'}${env[pathKey] ?? ''}`
  return Object.assign(env, extra)
}

interface Note { method?: string; params?: { content: string; meta: Record<string, string> }; open?: number; failed?: string }
interface Res { ok: boolean; data: Record<string, any>; code?: string }

class Rig {
  readonly root: string
  readonly home: string
  readonly work: string
  readonly shim: string
  readonly pipe: string
  readonly ptydPipe: string
  client!: DaemonClient
  app!: DaemonClient
  readonly seen = new Set<number>()
  /** Every state the daemon pushed with an attention on it, whoever the slot is: must stay empty. */
  readonly lit: string[] = []
  private readonly litSince = new Map<string, number>()
  /** How long each flash of attention lasted (ms) before the daemon put it out again. */
  readonly flashes: number[] = []
  readonly events: Array<{ ext: string; name: string; payload: any }> = []
  private nextId = 1

  constructor() {
    this.root = mkdtempSync(join(tmpdir(), 'tether-ch-flow-'))
    this.home = join(this.root, 'home')
    this.work = join(this.root, 'work')
    this.shim = join(this.root, 'shim')
    mkdirSync(this.home); mkdirSync(this.work); mkdirSync(this.shim)
    const id = randomBytes(4).toString('hex')
    const BS = String.fromCharCode(92)
    const winPipe = (n: string): string => [BS, BS, '.', BS, 'pipe', BS, n].join('')
    this.pipe = process.platform === 'win32' ? winPipe(`tether-ch-flow-${id}`) : join(this.home, 'd.sock')
    this.ptydPipe = process.platform === 'win32' ? winPipe(`tether-ch-flow-ptyd-${id}`) : join(this.home, 'ptyd.sock')
  }

  async connect(): Promise<void> {
    // `claude` on the PATH of the daemon is the fake: the real adapter resolves it, plans the launch and starts it in a real pane.
    if (process.platform === 'win32') writeFileSync(join(this.shim, 'claude.cmd'), `@echo off\r\n"${process.execPath}" "${AGENT}" %*\r\n`)
    else writeFileSync(join(this.shim, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${AGENT}" "$@"\n`, { mode: 0o755 })
    // Only what the flow needs: the extensions with side effects of their own (a bridge daemon, a browser) and the desk's are off.
    writeFileSync(join(this.home, 'settings.json'), JSON.stringify({ extensions: { disabled: ['web-bridge', 'browser', 'skills', 'for-agents', 'conductor-terminal', 'conductor-claude', 'conductor-soul', 'conductor-codex'] } }))
    const env = cleanDaemonEnv({ TETHER_PANEL_HOST: '1', TETHER_PTYD_PIPE: this.ptydPipe }, this.shim)
    this.client = await DaemonClient.connect({ home: this.home, pipe: this.pipe, client: 'test', mainPath: MAIN, env, startTimeoutMs: 45_000 })
    const pid = this.client.hello.pid
    this.seen.add(pid)
    await claim(pid, { cmdIncludes: MAIN, what: 'tetherd (channels flow)' })
    this.app = await DaemonClient.open(this.pipe, 'app', { home: this.home })
    // What the person's app would draw: a state with an attention lights the pane until the next state of it says otherwise.
    this.app.on('state', (s: SlotState) => {
      const on = s.attention ?? (s.attentionFor ? JSON.stringify(s.attentionFor) : undefined)
      const since = this.litSince.get(s.slotId)
      if (on && since === undefined) this.litSince.set(s.slotId, Date.now())
      if (!on && since !== undefined) { this.litSince.delete(s.slotId); this.flashes.push(Date.now() - since) }
      if (on) this.lit.push(`${s.slotId}:${on}`)
    })
    this.app.on('ext-event', (e) => this.events.push(e as { ext: string; name: string; payload: any }))
  }

  daemonLog(): string { const p = join(this.home, 'tetherd.log'); return existsSync(p) ? readFileSync(p, 'utf8') : '' }
  async states(): Promise<SlotState[]> { return (await this.client.request({ t: 'list' })).slots ?? [] }
  async state(slotId: string): Promise<SlotState | undefined> { return (await this.states()).find((s) => s.slotId === slotId) }

  async waitFor<T>(what: string, fn: () => Promise<T | undefined | false> | T | undefined | false, timeout = 30_000): Promise<T> {
    const deadline = Date.now() + timeout
    for (;;) {
      const v = await fn()
      if (v) return v
      if (Date.now() > deadline) throw new Error(`timeout (${timeout} ms) waiting for ${what}\n--- daemon log (tail) ---\n${this.daemonLog().slice(-2500)}`)
      await sleep(100)
    }
  }

  // ---- the agents ----
  private bench(slot: string, ext: string): string { return join(this.home, 'bench', `${slot}.${ext}`) }
  private lines<T>(slot: string, ext: string): T[] {
    const f = this.bench(slot, ext)
    return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as T) : []
  }
  /** The channel notifications an agent got through its stream (the ones that carry text). */
  notes(slot: string): Array<{ content: string; meta: Record<string, string> }> {
    return this.lines<Note>(slot, 'chan.jsonl').filter((n) => n.method === 'notifications/claude/channel').map((n) => n.params!)
  }
  /** What the delivery keeps waiting for a pane (its queue file in the daemon's home). */
  inbox(slot: string): Array<{ msg: { kind: string; room?: string; body: string; from: { role: string } } }> {
    const f = join(this.home, 'slots', `${slot}.inbox.jsonl`)
    return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
  }
  clearReady(slot: string): void { rmSync(this.bench(slot, 'ready'), { force: true }) }

  /** Opens a fake claude pane (`withStream`: its folder lets it open the `tether` MCP stream, as every real Claude does). */
  async agent(name: string, folder: string): Promise<string> {
    const cwd = join(this.work, folder)
    mkdirSync(cwd, { recursive: true })
    const slot = (await this.client.request({ t: 'create', kind: 'claude', cwd, name, start: true })).slot!.slotId
    await this.up(slot)
    return slot
  }
  async up(slot: string): Promise<void> {
    await this.waitFor(`${slot} running with its stream`, async () => {
      const s = await this.state(slot)
      if (s?.pid) this.seen.add(s.pid)
      return s?.status === 'running' && existsSync(this.bench(slot, 'ready'))
    }, 45_000)
  }

  private async command(slot: string, c: Record<string, unknown>): Promise<Record<string, any>> {
    const id = this.nextId++
    const t0 = Date.now()
    try { return await this.command0(slot, c, id) } finally { const ms = Date.now() - t0; if (ms > 3000) console.log(`[v1-time] slow command ${id} ${JSON.stringify(c).slice(0, 70)}: ${(ms / 1000).toFixed(1)} s`) }
  }
  private async command0(slot: string, c: Record<string, unknown>, id: number): Promise<Record<string, any>> {
    mkdirSync(join(this.home, 'bench'), { recursive: true })
    appendFileSync(this.bench(slot, 'cmd.jsonl'), JSON.stringify({ id, ...c }) + '\n')
    return this.waitFor(`the outcome of command ${id} (${JSON.stringify(c).slice(0, 80)})`, () => this.lines<{ id: number }>(slot, 'out.jsonl').find((o) => o.id === id), 60_000) as Promise<Record<string, any>>
  }
  /** `node "$TETHER_CLI" channels <argv> --json`, run by the agent in its own pane environment. */
  async cli(slot: string, ...argv: string[]): Promise<Res> {
    const o = await this.command(slot, { via: 'cli', argv })
    const parse = (s: string): Record<string, any> => { try { return JSON.parse(s) as Record<string, any> } catch { return { text: s.trim() } } }
    return o.status === 0 ? { ok: true, data: parse(o.stdout) } : { ok: false, data: parse(o.stderr), code: parse(o.stderr).error ?? `exit-${o.status}` }
  }
  /** The MCP tool `channels_<verb>`, called by the agent on the `tether` server it opened. */
  async mcp(slot: string, verb: string, args: Record<string, unknown> = {}): Promise<Res> {
    const o = await this.command(slot, { via: 'mcp', tool: `channels_${verb}`, arguments: args })
    assert.ok(!o.failed, `mcp ${verb}: ${o.failed}`)
    const r = o.result as { structuredContent?: Record<string, any>; isError?: boolean }
    const data = r.structuredContent ?? {}
    return r.isError ? { ok: false, data, code: data.error } : { ok: true, data }
  }

  // ---- the person ----
  async ask<T = any>(name: string, args?: unknown, client: DaemonClient = this.app): Promise<T> {
    return (await client.request({ t: 'ext-request', ext: 'channels', name, ...(args !== undefined ? { args } : {}) })).result as T
  }

  /** The end of a step: every fake turn is over and the daemon reacted to it; nothing was ever lit, and nothing is lit now. */
  private mark = Date.now()
  /** Prints how long the step since the last mark took (stdout, one line per step) so the slow ones show. */
  lap(step: string): void {
    const now = Date.now()
    console.log(`[v1-time] ${step}: ${((now - this.mark) / 1000).toFixed(1)} s`)
    this.mark = now
  }

  async quiet(step: string): Promise<void> {
    this.lap(`before quiet of ${step}`)
    await sleep(SETTLE_MS)
    const now = (await this.states()).filter((s) => s.attention || s.attentionFor).map((s) => `${s.slotId}:${s.attention}`)
    assert.deepEqual(now, [], `${step}: a pane shows attention`)
    assert.deepEqual([...this.litSince.keys()], [], `${step}: a pane is still lit for the app`)
    // The end of a turn a line opened reaches the clients as `done` and is put out by the extension in the same breath (contract
    // 2.6): the daemon publishes both states together, so the flash has no duration. Anything that stays lit is a failure.
    assert.ok(this.flashes.every((ms) => ms <= FLASH_MAX_MS), `${step}: a pane stayed lit for the app (flashes ms: ${this.flashes.join(', ')}; ${this.lit.join(', ')})`)
  }

  async teardown(): Promise<string[]> {
    this.lap('end of the test body')
    try {
      // Each stop of a young agent waits for its start report (up to 30 s, the product's guard): ask all of them together.
      await Promise.all((await this.states()).filter((s) => s.pid).map((s) => this.client.request({ t: 'stop', slotId: s.slotId }).catch(() => undefined)))
      this.lap('teardown: stop requests')
      for (const end = Date.now() + 30_000; Date.now() < end; await sleep(250)) {
        if ((await this.states().catch(() => [])).every((s) => !s.pid)) break
      }
      this.lap('teardown: panes gone')
    } catch { /* daemon gone */ }
    try { this.app?.close() } catch { /* gone */ }
    try { await this.client.request({ t: 'shutdown' }) } catch { /* gone */ }
    try { this.client.close() } catch { /* gone */ }
    this.lap('teardown: shutdown')
    const host = await HostClient.ping(this.ptydPipe, this.home).catch(() => undefined)
    if (host) this.seen.add(host.pid)
    for (const end = Date.now() + 15_000; [...this.seen].some(pidAlive) && Date.now() < end; await sleep(200));
    this.lap('teardown: processes gone by themselves')
    for (const pid of [...this.seen].reverse()) {
      if (!pidAlive(pid)) continue
      const owned = await claim(pid, { what: 'channels flow process' }).catch(() => undefined)
      if (owned) await killOwned(owned, { tree: true })
    }
    for (const end = Date.now() + 8_000; [...this.seen].some(pidAlive) && Date.now() < end; await sleep(150));
    const left = [...this.seen].filter(pidAlive).map(String)
    for (let i = 0; i < 5; i++) { try { rmSync(this.root, { recursive: true, force: true }); break } catch { await sleep(300) } }
    return left
  }
}

const rigs: Rig[] = []
after(async () => { for (const r of rigs) await r.teardown().catch(() => undefined) })

const rejectsWith = async (p: Promise<unknown>, code: string): Promise<void> => {
  await assert.rejects(p, (e: unknown) => e instanceof DaemonError && e.code === code, `expected ${code}`)
}

test('channels flow: create, join, say, many channels, mute, remove, close, reopen, the moderator, a member away and back, the merge (no screen)', { timeout: 600_000 }, async (t) => {
  const rig = new Rig(); rigs.push(rig)
  await rig.connect()
  const note = (s: string): void => { t.diagnostic(s) }

  const NAME_A = 'claude · conferente'
  const NAME_B = 'claude · bancada'
  const NAME_C = 'claude · conferência'
  // The three panes start together (each start is a real process boot; they do not depend on one another).
  // C opens no MCP stream (a Claude launched before the extension, as the contract's 2.5): the delivery says `wait` for it.
  const [A, B, C] = await Promise.all([
    rig.agent(NAME_A, 'conferente'),
    rig.agent(NAME_B, 'bancada'),
    rig.agent(NAME_C, 'sem-canal-conferencia'),
  ]) as [string, string, string]
  note(`agents ${A} ${B} ${C}`)
  rig.lap('connect + 3 agents')

  // ---- 1. create ----
  const empty = await rig.cli(A, 'list')
  assert.ok(empty.ok, JSON.stringify(empty))
  assert.deepEqual(empty.data.channels, [], 'step 1: no channel yet')
  assert.deepEqual(empty.data.me, { id: A, name: NAME_A })
  assert.deepEqual((await rig.ask('list')).channels, [])
  const made = await rig.cli(A, 'create', 'mesa', '--title', 'A mesa')
  assert.ok(made.ok, JSON.stringify(made))
  const MESA: string = made.data.channel.id
  assert.equal(made.data.channel.name, 'mesa')
  assert.equal(rig.notes(A).filter((n) => n.content.startsWith('você abriu #mesa')).length, 1, 'the owner is told, inside')
  assert.equal((await rig.ask('members', { channel: MESA })).members.length, 1)
  await rejectsWith(rig.ask('create', { name: 'x' }, rig.client), 'not-moderator')
  await rig.quiet('1 create')

  // ---- 2. join: the owner joins B; C joins by itself (the channel is open) ----
  const joinedB = await rig.cli(A, 'join', 'mesa', NAME_B)
  assert.ok(joinedB.ok, JSON.stringify(joinedB))
  await rig.waitFor('B told it joined', () => rig.notes(B).some((n) => n.content.startsWith('você entrou em #mesa')))
  const toB = rig.notes(B).find((n) => n.content.startsWith('você entrou em #mesa'))!
  assert.equal(toB.meta.role, 'system')
  assert.equal(toB.meta.from_id, 'tether')
  assert.equal(toB.meta.room, 'mesa')
  assert.ok(toB.content.includes(`(por ${NAME_A})`), toB.content)
  assert.ok(!toB.content.includes('TETHER_CLI'), 'inside: no CLI hint')
  const joinedC = await rig.cli(C, 'join', 'mesa')
  assert.ok(joinedC.ok, JSON.stringify(joinedC))
  const members = await rig.ask('members', { channel: MESA })
  const by = Object.fromEntries(members.members.map((m: { id: string }) => [m.id, m]))
  assert.deepEqual(Object.keys(by).sort(), [A, B, C].sort())
  assert.equal(by[A].path, 'inside')
  assert.equal(by[B].path, 'inside')
  assert.equal(by[C].path, 'wait', 'C hears nothing now: the lines wait for it')
  assert.ok([A, B, C].every((id) => by[id].alive === true))
  const waitingC = rig.inbox(C).filter((i) => i.msg.room === 'mesa' && i.msg.body.startsWith('você entrou'))
  assert.equal(waitingC.length, 1, JSON.stringify(waitingC))
  assert.ok(waitingC[0]!.msg.body.includes('channels say mesa'), 'C is told how to speak by the CLI')
  assert.ok(waitingC[0]!.msg.body.includes('elas esperam'), 'and that the lines wait')
  await rig.quiet('2 join')

  // ---- 3. say: A by the CLI, B answers by MCP; the envelope as the agent sees it ----
  const said = await rig.cli(A, 'say', 'mesa', 'Bom dia. Cada um diga o que vê.')
  assert.ok(said.ok, JSON.stringify(said))
  assert.deepEqual(Object.fromEntries(said.data.delivered.map((d: { id: string; state: string }) => [d.id, d.state])), { [B]: 'inside', [C]: 'queued' }, 'the speaker gets nothing back')
  await rig.waitFor('B hears A', () => rig.notes(B).some((n) => n.content === 'Bom dia. Cada um diga o que vê.'))
  const heard = rig.notes(B).find((n) => n.content === 'Bom dia. Cada um diga o que vê.')!
  assert.equal(heard.meta.room, 'mesa')
  assert.equal(heard.meta.kind, 'message')
  assert.equal(heard.meta.origin, 'channels')
  assert.equal(heard.meta.from, NAME_A)
  assert.equal(heard.meta.from_id, A)
  assert.equal(heard.meta.role, 'member', 'the owner speaks as a member')
  assert.equal(heard.meta.ref, `mesa#${said.data.seq}`)
  const reply = await rig.mcp(B, 'say', { canal: 'mesa', text: 'Vejo a pasta da bancada.', to: [NAME_A], reply: said.data.seq })
  assert.ok(reply.ok, JSON.stringify(reply))
  await rig.waitFor('A hears B', () => rig.notes(A).some((n) => n.content === 'Vejo a pasta da bancada.'))
  const back = rig.notes(A).find((n) => n.content === 'Vejo a pasta da bancada.')!
  assert.equal(back.meta.role, 'member')
  assert.equal(back.meta.from, NAME_B)
  assert.equal(back.meta.to, NAME_A)
  assert.equal(back.meta.reply_to, `mesa#${said.data.seq}`)
  assert.ok(rig.events.some((e) => e.name === 'line' && e.payload.room === 'mesa' && e.payload.line.seq === said.data.seq), 'the app was told of the line')
  assert.ok(rig.events.some((e) => e.name === 'channel' && e.payload.channel.id === MESA), 'and of the channel')
  await rig.quiet('3 say')

  // ---- 4. many channels in one agent, mute and the voice back ----
  const second = await rig.cli(A, 'create', 'revisao', '--json', JSON.stringify({ members: [B] }))
  assert.ok(second.ok, JSON.stringify(second))
  const REVISAO: string = second.data.channel.id
  assert.equal(second.data.joined.length, 1)
  await rig.cli(A, 'say', 'revisao', 'Primeiro, a revisão.')
  await rig.cli(A, 'say', 'mesa', 'Depois, a mesa.')
  await rig.waitFor('B hears both rooms', () => rig.notes(B).some((n) => n.content === 'Primeiro, a revisão.') && rig.notes(B).some((n) => n.content === 'Depois, a mesa.'))
  assert.equal(rig.notes(B).find((n) => n.content === 'Primeiro, a revisão.')!.meta.room, 'revisao')
  assert.equal(rig.notes(B).find((n) => n.content === 'Depois, a mesa.')!.meta.room, 'mesa')
  assert.deepEqual((await rig.cli(B, 'list')).data.channels.map((c: { name: string }) => c.name).sort(), ['mesa', 'revisao'])

  const muted = await rig.cli(A, 'mute', 'mesa', NAME_B)
  assert.ok(muted.ok, JSON.stringify(muted))
  await rig.waitFor('B told it was muted', () => rig.notes(B).some((n) => n.content.startsWith('você foi calado em #mesa')))
  const refused = await rig.mcp(B, 'say', { canal: 'mesa', text: 'posso?' })
  assert.equal(refused.code, 'muted')
  assert.ok((await rig.mcp(B, 'say', { canal: 'revisao', text: 'aqui eu posso.' })).ok, 'muting in one channel does not mute in the other')
  const stillHears = await rig.cli(A, 'say', 'mesa', 'Quem está calado ouve.')
  assert.equal(stillHears.data.delivered.find((d: { id: string }) => d.id === B).state, 'inside')
  await rig.waitFor('the muted still hears', () => rig.notes(B).some((n) => n.content === 'Quem está calado ouve.'))
  assert.equal((await rig.cli(C, 'mute', 'mesa', NAME_B)).code, 'not-owner', 'only the owner (or the person) calms')
  assert.ok((await rig.cli(A, 'unmute', 'mesa', NAME_B)).ok)
  await rig.waitFor('B told it can speak', () => rig.notes(B).some((n) => n.content === 'você pode falar de novo em #mesa'))
  assert.ok((await rig.mcp(B, 'say', { canal: 'mesa', text: 'voltei a falar.' })).ok)
  await rig.quiet('4 many channels, mute')

  // ---- 5. the moderator speaks (to B) and reads ----
  const spoken = await rig.ask('say', { channel: MESA, text: 'Quero o resumo em português.', to: [NAME_B] })
  assert.deepEqual(Object.keys(spoken.receipts).sort(), [A, B, C].sort(), 'the person is never delivered to; every member is')
  assert.equal(spoken.receipts[A], 'inside')
  assert.equal(spoken.receipts[C], 'queued')
  for (const agent of [A, B]) {
    await rig.waitFor(`${agent} hears the moderator`, () => rig.notes(agent).some((n) => n.content === 'Quero o resumo em português.'))
    const m = rig.notes(agent).find((n) => n.content === 'Quero o resumo em português.')!
    assert.equal(m.meta.role, 'moderator')
    assert.equal(m.meta.from_id, 'user')
    assert.equal(m.meta.from, 'usuário')
    assert.equal(m.meta.to, NAME_B)
    assert.equal(m.meta.room, 'mesa')
  }
  await rejectsWith(rig.ask('say', { channel: MESA, text: 'eu sou o moderador' }, rig.client), 'not-moderator')
  const hist = await rig.ask('history', { channel: MESA })
  const bodies = hist.lines.map((l: { body: string }) => l.body)
  for (const b of ['Bom dia. Cada um diga o que vê.', 'Vejo a pasta da bancada.', 'Quem está calado ouve.', 'Quero o resumo em português.']) assert.ok(bodies.includes(b), `history has ${b}`)
  assert.ok(hist.lines.every((l: { seq: number }, i: number, all: Array<{ seq: number }>) => i === 0 || l.seq === all[i - 1]!.seq + 1), 'ascending, no gap')
  assert.ok(bodies.some((b: string) => b === `${NAME_B} foi calado em #mesa por ${NAME_A}`), 'the record keeps the system lines')
  const page = await rig.ask('history', { channel: MESA, limit: 2 })
  assert.equal(page.lines.length, 2)
  assert.equal(page.more, true)
  assert.equal(page.lines.at(-1).seq, page.last)
  const listed = (await rig.ask('list')).channels.map((c: { name: string }) => c.name).sort()
  assert.deepEqual(listed, ['mesa', 'revisao'])
  await rig.quiet('5 the moderator')

  // ---- 6. the merge: C hears nothing, so what waited for it is one notice with no word of anyone ----
  // Finding (not fixed here): the notice of its own joining stays queued BESIDE the merged notice; the contract's "one pending
  // per (member, channel)" is one merged notice plus that join notice. Every line after it is in the merged one.
  const pendingC = rig.inbox(C).filter((i) => i.msg.room === 'mesa')
  assert.deepEqual(pendingC.map((i) => i.msg.kind), ['notice', 'notice'])
  assert.ok(pendingC[0]!.msg.body.startsWith('você entrou em #mesa'), 'the join notice came first and is not merged')
  const waiting = pendingC.filter((i) => i.msg.body.startsWith('#mesa:'))
  assert.equal(waiting.length, 1, `one merged notice for (C, mesa): ${JSON.stringify(pendingC.map((w) => w.msg.body))}`)
  assert.equal(waiting[0]!.msg.kind, 'notice')
  assert.equal(waiting[0]!.msg.from.role, 'system')
  assert.match(waiting[0]!.msg.body, /^#mesa: \d+ falas? novas?/)
  assert.ok(waiting[0]!.msg.body.includes('(uma do usuário)'), waiting[0]!.msg.body)
  for (const secret of ['Bom dia', 'resumo', 'pasta da bancada', 'ouve']) assert.ok(!waiting[0]!.msg.body.includes(secret), `no third-party text: ${secret}`)

  // ---- 7. C, that hears nothing, reads what it missed by the CLI and speaks by the CLI ----
  const read = await rig.cli(C, 'read', 'mesa')
  assert.ok(read.ok, JSON.stringify(read))
  assert.ok(read.data.lines.some((l: { body: string }) => l.body === 'Quero o resumo em português.'))
  const cut = read.data.lines.find((l: { body: string }) => l.body === 'Bom dia. Cada um diga o que vê.').seq
  const after1 = await rig.cli(C, 'read', 'mesa', '--since', String(cut), '--limit', '2')
  assert.equal(after1.data.lines.length, 2)
  assert.equal(after1.data.lines[0].seq, cut + 1)
  const fromC = await rig.cli(C, 'say', 'mesa', 'Li tudo pelo terminal.', '--to', 'usuário')
  assert.ok(fromC.ok, JSON.stringify(fromC))
  await rig.waitFor('A and B hear C', () => rig.notes(A).some((n) => n.content === 'Li tudo pelo terminal.') && rig.notes(B).some((n) => n.content === 'Li tudo pelo terminal.'))
  const fromCnote = rig.notes(A).find((n) => n.content === 'Li tudo pelo terminal.')!
  assert.equal(fromCnote.meta.from, NAME_C)
  assert.equal(fromCnote.meta.to, 'usuário')
  await rig.quiet('6 and 7 the merge and C speaking')

  // ---- 8. remove: B is taken out of #revisao, stays in #mesa ----
  const removed = await rig.cli(A, 'remove', 'revisao', NAME_B)
  assert.ok(removed.ok, JSON.stringify(removed))
  await rig.waitFor('B told it was removed', () => rig.notes(B).some((n) => n.content === `você foi tirado de #revisao por ${NAME_A}`))
  assert.equal((await rig.mcp(B, 'say', { canal: 'revisao', text: 'ainda estou?' })).code, 'not-member')
  assert.equal((await rig.cli(B, 'join', 'revisao')).code, 'removed', 'a removed one does not come back by itself')
  assert.deepEqual((await rig.cli(B, 'list')).data.channels.map((c: { name: string }) => c.name), ['mesa'])
  assert.ok((await rig.mcp(B, 'say', { canal: 'mesa', text: 'na mesa eu fico.' })).ok)
  const afterRemove = await rig.ask('members', { channel: REVISAO })
  assert.deepEqual(afterRemove.members.map((m: { id: string }) => m.id), [A])
  assert.deepEqual(afterRemove.removed, [B])
  await rig.quiet('8 remove')

  // ---- 9. close, read what is closed, reopen ----
  assert.equal((await rig.cli(C, 'close', 'revisao')).code, 'not-owner')
  const closed = await rig.cli(A, 'close', 'revisao')
  assert.ok(closed.ok, JSON.stringify(closed))
  assert.equal((await rig.cli(A, 'say', REVISAO, 'ninguém ouve')).code, 'closed')
  assert.deepEqual((await rig.ask('list')).channels.map((c: { name: string }) => c.name), ['mesa'])
  const withClosed = (await rig.ask('list', { closed: true })).channels
  assert.ok(withClosed.find((c: { id: string; closed?: unknown }) => c.id === REVISAO)?.closed)
  const closedHistory = await rig.ask('history', { channel: REVISAO })
  assert.ok(closedHistory.lines.some((l: { body: string }) => l.body === 'Primeiro, a revisão.'), 'a closed channel is still readable')
  assert.ok(closedHistory.lines.some((l: { body: string }) => l.body === 'aqui eu posso.'))
  assert.ok((await rig.cli(C, 'read', REVISAO)).ok, 'by the CLI too, by id')
  await rejectsWith(rig.ask('say', { channel: REVISAO, text: 'nada' }), 'closed')
  await rig.ask('reopen', { channel: REVISAO })
  assert.ok((await rig.ask('list')).channels.some((c: { id: string }) => c.id === REVISAO), 'open again for the person')
  assert.ok((await rig.cli(A, 'say', 'revisao', 'Reaberto.')).ok)
  assert.equal((await rig.cli(A, 'close', 'revisao')).ok, true)
  assert.equal((await rig.cli(A, 'say', 'revisao', 'x')).code, 'unknown-channel', 'a closed channel is found by its id, not by its name')
  assert.ok((await rig.cli(A, 'reopen', 'revisao')).ok, 'the owner reopens it, by name')
  assert.ok((await rig.cli(A, 'say', 'revisao', 'De novo.')).ok)
  await rig.quiet('9 close and reopen')

  // ---- 10. a member that stopped is away, and gets one notice when it is back ----
  rig.lap('10 start')
  await rig.client.request({ t: 'stop', slotId: B })
  rig.lap('10 stop request')
  await rig.waitFor('B stopped', async () => (await rig.state(B))?.status !== 'running')
  rig.lap('10 B stopped')
  await rig.waitFor('the daemon sees B gone', async () => (await rig.ask('members', { channel: MESA })).members.find((m: { id: string }) => m.id === B).alive === false)
  rig.lap('10 daemon sees B gone')
  const away1 = await rig.cli(A, 'say', 'mesa', 'Enquanto você dormia.')
  const away2 = await rig.ask('say', { channel: MESA, text: 'E mais isto.' })
  assert.equal(away1.data.delivered.find((d: { id: string }) => d.id === B).state, 'away')
  assert.equal(away2.receipts[B], 'away')
  const awayMember = (await rig.ask('members', { channel: MESA })).members.find((m: { id: string }) => m.id === B)
  assert.equal(awayMember.path, 'away')
  rig.clearReady(B)
  const before = rig.notes(B).length
  await rig.client.request({ t: 'start', slotId: B, choice: 'new' })
  rig.lap('10 start request')
  await rig.up(B)
  rig.lap('10 B up')
  await rig.waitFor('B gets the notice of its return', () => rig.notes(B).slice(before).some((n) => n.content.startsWith('você voltou · #mesa')), 45_000)
  await sleep(1_000)
  const returned = rig.notes(B).slice(before).filter((n) => n.content.startsWith('você voltou'))
  assert.equal(returned.length, 1, JSON.stringify(returned))
  assert.match(returned[0]!.content, /^você voltou · #mesa: 2 falas novas/)
  assert.ok(!returned[0]!.content.includes('dormia'), 'no third-party text in the notice')
  assert.ok(returned[0]!.content.includes('(uma do usuário)'), returned[0]!.content)
  assert.equal(returned[0]!.meta.role, 'system')
  assert.ok((await rig.mcp(B, 'say', { canal: 'mesa', text: 'Estou de volta.' })).ok)
  await rig.waitFor('A hears B back', () => rig.notes(A).some((n) => n.content === 'Estou de volta.'))
  await rig.quiet('10 away and back')

  // ---- 11. the MCP exit for reading, and the whole run lit nothing ----
  const mcpList = await rig.mcp(B, 'list')
  assert.ok(mcpList.ok, JSON.stringify(mcpList))
  assert.deepEqual(mcpList.data.channels.map((c: { name: string }) => c.name), ['mesa'])
  const mcpRead = await rig.mcp(B, 'read', { canal: 'mesa', limit: 3 })
  assert.equal(mcpRead.data.lines.length, 3)
  assert.equal(mcpRead.data.lines.at(-1).body, 'Estou de volta.')
  const mcpMembers = await rig.mcp(A, 'members', { canal: 'mesa' })
  assert.deepEqual(mcpMembers.data.members.map((m: { id: string }) => m.id).sort(), [A, B, C].sort())
  assert.equal(mcpMembers.data.members.find((m: { id: string }) => m.id === C).path, 'wait')
  await rig.quiet('11 the end')
  assert.ok(!/error|uncaught/i.test(rig.daemonLog().split('\n').filter((l) => /channels/.test(l)).join('\n')), 'the daemon log has no channels error')
})
