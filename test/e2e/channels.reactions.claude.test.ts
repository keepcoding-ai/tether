// R3 with ONE real Claude Code (haiku): the reactions to its lines ride on the next message of the channel, and it understands them.
// PRIVATE tetherd (own home, pipe and pane host), channels on, for-agents off. One Claude in a bench folder new and empty, outside the
// house. The person creates a channel, joins the Claude and asks it something; it answers in the channel. The person reacts ❓ to that
// answer: NOTHING reaches the Claude (no transcript entry, no turn: the iron rule, with a real engine). Then the person says something
// unrelated to the reaction; that delivery carries the `reactions` attribute with the ❓ on the Claude's line.
// ASSERTIONS: the ❓ alone opened no turn and delivered nothing; the next message carried `reactions="<seq> ❓ …"` (and not in the body).
// MEASURED (todo when not): the Claude's next line in the channel shows it took the ❓ as a doubt (it re-explains or asks what is unclear).
// Run alone: node --test test/e2e/channels.reactions.claude.test.ts
// Env: RRC_EVIDENCE_DIR (keeps the sequence and the assistant trail, without keys; default none).
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { findTranscript } from '../../src/agents/claude-sync.ts'
import { DaemonClient } from '../../src/daemon/client.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { HostClient } from '../../src/procd/client.ts'
import { claim, killOwned } from '../kill.ts'
import { openSlot, pidAlive } from './daemon-driver.ts'

const MAIN = resolve(import.meta.dirname, '../../src/daemon/main.ts')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const MIN_LIFE_MS = 11_000
const NAME = 'claude · revisor'
const evidenceDir = process.env.RRC_EVIDENCE_DIR
if (evidenceDir) mkdirSync(evidenceDir, { recursive: true })

function cleanDaemonEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^CLAUDE/i.test(k) || /^TETHER_/i.test(k) || k === 'NODE_TEST_CONTEXT') continue
    env[k] = v
  }
  return Object.assign(env, extra)
}

interface Entry { at: number; attrs?: Record<string, string>; body: string }
interface HistLine { seq: number; kind: string; from: { id: string; name: string }; body: string }

class Rig {
  readonly root = mkdtempSync(join(tmpdir(), 'tether-rrc-'))
  readonly home = join(this.root, 'home')
  readonly pipe: string
  readonly ptydPipe: string
  readonly benches: string[] = []
  bornAt = 0
  client!: DaemonClient
  app!: DaemonClient
  readonly seen = new Set<number>()
  turns = 0

  constructor() {
    mkdirSync(this.home)
    const id = randomBytes(4).toString('hex')
    const BS = String.fromCharCode(92)
    const winPipe = (n: string): string => [BS, BS, '.', BS, 'pipe', BS, n].join('')
    this.pipe = process.platform === 'win32' ? winPipe(`tether-rrc-${id}`) : join(this.home, 'd.sock')
    this.ptydPipe = process.platform === 'win32' ? winPipe(`tether-rrc-ptyd-${id}`) : join(this.home, 'ptyd.sock')
  }

  async connect(): Promise<void> {
    writeFileSync(join(this.home, 'settings.json'), JSON.stringify({ extensions: { disabled: ['web-bridge', 'browser', 'skills', 'for-agents'] } }))
    const env = cleanDaemonEnv({ TETHER_PANEL_HOST: '1', TETHER_PTYD_PIPE: this.ptydPipe })
    this.client = await DaemonClient.connect({ home: this.home, pipe: this.pipe, client: 'test', mainPath: MAIN, env, startTimeoutMs: 45_000 })
    this.seen.add(this.client.hello.pid)
    await claim(this.client.hello.pid, { cmdIncludes: MAIN, what: 'tetherd (channels reactions claude)' })
    this.app = await DaemonClient.open(this.pipe, 'app', { home: this.home })
    let busy = false
    this.app.on('state', (s: SlotState) => {
      if (s.turn === 'busy' && !busy) this.turns++
      busy = s.turn === 'busy'
    })
  }

  async states(): Promise<SlotState[]> { return (await this.client.request({ t: 'list' })).slots ?? [] }
  async state(slotId: string): Promise<SlotState | undefined> { return (await this.states()).find((s) => s.slotId === slotId) }
  daemonLog(): string { const p = join(this.home, 'tetherd.log'); return existsSync(p) ? readFileSync(p, 'utf8') : '' }

  async waitFor<T>(what: string, fn: () => Promise<T | undefined | false> | T | undefined | false, timeout = 90_000): Promise<T> {
    const deadline = Date.now() + timeout
    for (;;) {
      const v = await fn()
      if (v) return v
      if (Date.now() > deadline) throw new Error(`timeout (${timeout} ms) waiting for ${what}\n--- daemon log (tail) ---\n${this.daemonLog().slice(-2000)}`)
      await sleep(500)
    }
  }

  async claude(): Promise<string> {
    const bench = mkdtempSync(join(tmpdir(), 'tether-rrc-bench-'))
    this.benches.push(bench)
    const args = ['--model', 'haiku', '--allowedTools', 'mcp__tether__channels_say,mcp__tether__channels_read,mcp__tether__channels_react,mcp__tether__channels_list']
    const slot = (await this.client.request({ t: 'create', kind: 'claude', cwd: bench, name: NAME, args })).slot!.slotId
    this.bornAt = Date.now()
    await openSlot(this.client, slot)
    const st = await this.state(slot)
    if (st?.pid) this.seen.add(st.pid)
    return slot
  }

  async ask<T = any>(name: string, args?: unknown): Promise<T> {
    return (await this.app.request({ t: 'ext-request', ext: 'channels', name, ...(args !== undefined ? { args } : {}) })).result as T
  }

  private transcript(state: SlotState | undefined): string[] {
    const b = state?.binding
    if (!b) return []
    const file = findTranscript({ sessionId: b.sessionId, cwd: b.cwd })
    return file && existsSync(file) ? readFileSync(file, 'utf8').split('\n') : []
  }
  /** The channel tags that reached the pane, oldest first. */
  entries(state: SlotState | undefined): Entry[] {
    const out: Entry[] = []
    for (const line of this.transcript(state)) {
      if (!line.includes('"type":"user"') || !line.includes('<channel source=\\"tether\\"')) continue
      let j: { timestamp?: string; message?: { content?: unknown } }
      try { j = JSON.parse(line) as typeof j } catch { continue }
      const c = j.message?.content
      const text = typeof c === 'string' ? c : Array.isArray(c) ? (c as Array<{ type?: string; text?: string }>).filter((x) => x.type === 'text').map((x) => x.text ?? '').join('\n') : ''
      for (const m of text.matchAll(/<channel source="tether"([^>]*)>([\s\S]*?)<\/channel>/g)) {
        const attrs: Record<string, string> = {}
        for (const a of m[1]!.matchAll(/(\w+)="([^"]*)"/g)) attrs[a[1]!] = a[2]!
        out.push({ at: j.timestamp ? Date.parse(j.timestamp) : Date.now(), attrs, body: m[2]!.trim() })
      }
    }
    return out
  }
  trail(state: SlotState | undefined): string[] {
    const out: string[] = []
    for (const line of this.transcript(state)) {
      if (!line.includes('"assistant"')) continue
      let j: { message?: { content?: unknown } }
      try { j = JSON.parse(line) as typeof j } catch { continue }
      if (!Array.isArray(j.message?.content)) continue
      for (const c of j.message!.content as Array<{ type?: string; text?: string; name?: string; input?: unknown }>) {
        if (c.type === 'text' && c.text) out.push(`SAYS ${c.text.replace(/\s+/g, ' ').slice(0, 300)}`)
        if (c.type === 'tool_use' && c.name) out.push(`TOOL ${c.name} ${JSON.stringify(c.input ?? {}).slice(0, 300)}`)
      }
    }
    return out
  }

  async teardown(): Promise<string[]> {
    try {
      if (this.bornAt) await sleep(Math.max(0, this.bornAt + MIN_LIFE_MS - Date.now()))
      for (const s of await this.states()) if (s.pid) await this.client.request({ t: 'stop', slotId: s.slotId }).catch(() => undefined)
      for (const end = Date.now() + 40_000; Date.now() < end; await sleep(250)) {
        if ((await this.states().catch(() => [])).every((s) => !s.pid)) break
      }
    } catch { /* daemon gone */ }
    try { this.app?.close() } catch { /* gone */ }
    try { await this.client.request({ t: 'shutdown' }) } catch { /* gone */ }
    try { this.client.close() } catch { /* gone */ }
    const host = await HostClient.ping(this.ptydPipe, this.home).catch(() => undefined)
    if (host) this.seen.add(host.pid)
    for (const end = Date.now() + 15_000; [...this.seen].some(pidAlive) && Date.now() < end; await sleep(200));
    for (const pid of [...this.seen].reverse()) {
      if (!pidAlive(pid)) continue
      const owned = await claim(pid, { what: 'channels reactions claude process' }).catch(() => undefined)
      if (owned) await killOwned(owned, { tree: true })
    }
    for (const end = Date.now() + 8_000; [...this.seen].some(pidAlive) && Date.now() < end; await sleep(150));
    const left = [...this.seen].filter(pidAlive).map(String)
    for (const dir of [...this.benches, this.root]) {
      for (let i = 0; i < 5; i++) { try { rmSync(dir, { recursive: true, force: true }); break } catch { await sleep(300) } }
    }
    return left
  }
}

const rigs: Rig[] = []
after(async () => { for (const r of rigs) await r.teardown().catch(() => undefined) })

test('one real Claude: a ❓ of the person reaches nothing alone, rides on the next message, and the Claude takes it as a doubt', { timeout: 600_000 }, async (t) => {
  const rig = new Rig(); rigs.push(rig)
  const log: string[] = []
  const note = (s: string): void => { log.push(s); t.diagnostic(s); console.log(`# ${s}`) }
  await rig.connect()
  const A = await rig.claude()
  note(`claude open: ${A}`)

  const { channel } = await rig.ask('create', { name: 'revisao', title: 'Revisão' })
  const CH = channel.id as string
  await rig.ask('join', { channel: CH, agent: A })
  const history = async (): Promise<HistLine[]> => (await rig.ask('history', { channel: CH })).lines as HistLine[]
  const mineAfter = async (seq: number): Promise<HistLine | undefined> => (await history()).find((l) => l.seq > seq && l.kind === 'message' && l.from.id === A)
  /** Still: no open turn for 8 s. */
  const settle = async (cap = 120_000): Promise<void> => {
    let since = Date.now()
    for (const end = Date.now() + cap; Date.now() < end && Date.now() - since < 8_000; await sleep(1_000)) {
      if ((await rig.state(A))?.turn === 'busy') since = Date.now()
    }
  }
  await settle()

  // 1. A question; the Claude answers in the channel.
  const q = (await rig.ask('say', { channel: CH, text: 'Revisor, em uma linha: quantas patas tem uma aranha?', to: [NAME] })).line as HistLine
  const answer = await rig.waitFor('the Claude answers in the channel', () => mineAfter(q.seq), 150_000)
  note(`answer #${answer.seq}: ${answer.body.slice(0, 200)}`)
  await settle()

  // 2. The person reacts ❓ to the answer: nothing reaches the Claude (the iron rule with a real engine).
  const entriesBefore = rig.entries(await rig.state(A)).length
  const turnsBefore = rig.turns
  const reacted = await rig.ask('react', { channel: CH, seq: answer.seq, reaction: 'question' })
  assert.equal(reacted.name, 'question')
  await sleep(15_000)
  assert.equal(rig.entries(await rig.state(A)).length, entriesBefore, 'the ❓ alone delivered nothing')
  assert.equal(rig.turns, turnsBefore, 'the ❓ alone opened no turn')
  note('the ❓ alone: no delivery, no turn')

  // 3. The person says something else: the delivery carries the ride.
  const next = (await rig.ask('say', { channel: CH, text: 'Certo. Mais alguma observação?', to: [NAME] })).line as HistLine
  const carried = await rig.waitFor('the next message reached the Claude', async () => rig.entries(await rig.state(A)).find((e) => e.body.includes('Mais alguma observação')), 90_000)
  note(`delivered with attrs ${JSON.stringify(carried.attrs)}`)
  assert.match(carried.attrs?.reactions ?? '', new RegExp(`^${answer.seq} ❓ `), 'the reactions attribute carries the ❓ on its line')
  assert.ok(!carried.body.includes('❓'), 'the ride is not in the body')

  // 4. Measured: its next line shows it took the ❓ as a doubt.
  const reply = await rig.waitFor('the Claude speaks again', () => mineAfter(next.seq), 150_000).catch(() => undefined)
  await settle(60_000)
  const trail = rig.trail(await rig.state(A))
  note(`reply: ${reply ? `#${reply.seq} ${reply.body.slice(0, 300)}` : '(none in the channel)'}`)
  note(`assistant trail:\n${trail.join('\n')}`)
  if (evidenceDir) writeFileSync(join(evidenceDir, 'reacoes-claude.txt'), log.join('\n') + '\n')
  const understood = reply !== undefined && /❓|dúvida|duvida|esclare|explic|não ficou claro|confus|reforç|confirm|correto|de fato|oito|8/i.test(reply.body)
  await t.test('the reply shows the ❓ was read as a doubt', { todo: understood ? false : `not shown: ${reply?.body.slice(0, 160) ?? 'no reply'}` }, () => {
    assert.ok(understood)
  })
  const left = await rig.teardown()
  assert.deepEqual(left, [], 'no process left behind')
})
