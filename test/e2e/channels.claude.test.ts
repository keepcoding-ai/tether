// V2: two REAL Claude Code agents (haiku) in one channel, in a PRIVATE tetherd (own home, pipe and pane host) with the real channels
// extension. The person (the moderator) is one `app` client of the test. Each Claude lives in its own bench folder, new and empty,
// outside the house. The Claudes learn about the channel ONLY from what the tether gives them (the server instructions and the
// entry notice): the first prompt of each is minimal and never names a verb.
// Step 1 (this commit): the moderator creates the channel and joins both; A is asked to greet the colleague; A speaks by
//   `channels_say` (nobody taught it the verb); B receives it inside, as a channel turn with `room`, `from` and `role`.
// Run alone: node --test --test-concurrency=1 test/e2e/channels.claude.test.ts
// Env: V2_RUN_ROOT (where homes live, default os tmpdir), V2_EVIDENCE_DIR (keeps evidence without keys; default none).
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
import { Screen } from './harness.ts'

const MAIN = resolve(import.meta.dirname, '../../src/daemon/main.ts')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const runRoot = process.env.V2_RUN_ROOT ?? tmpdir()
const evidenceDir = process.env.V2_EVIDENCE_DIR
if (evidenceDir) mkdirSync(evidenceDir, { recursive: true })

/** Evidence never carries a key: anything that looks like a secret token (32+ url-safe characters mixing letters and digits, once uuids and paths are set aside) is replaced. */
function sanitized(text: string): string {
  assert.ok(!/TETHER_(SLOT|MCP)_KEY/.test(text), 'evidence names a key variable')
  return text.replace(/([A-Za-z]:[\\/][^\s"']+)|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9_-]{32,}/g, (m, path: string | undefined) => {
    if (path || !/^(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}$/.test(m)) return m
    return `<redacted ${m.length} chars>`
  })
}
const evidence = (name: string, text: string): void => { if (evidenceDir) writeFileSync(join(evidenceDir, name), sanitized(text)) }

/** The environment of the test daemon (and so of its agents): no CLAUDE*, no TETHER_* and no NODE_TEST_CONTEXT of where this test runs. */
function cleanDaemonEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^CLAUDE/i.test(k) || /^TETHER_/i.test(k) || k === 'NODE_TEST_CONTEXT') continue
    env[k] = v
  }
  return Object.assign(env, extra)
}

interface ChannelTurn { attrs: Record<string, string>; body: string }

class Rig {
  readonly root: string
  readonly home: string
  readonly pipe: string
  readonly ptydPipe: string
  readonly benches: string[] = []
  client!: DaemonClient
  app!: DaemonClient
  readonly seen = new Set<number>()
  /** The channels dialog as the terminal showed it, per slot. */
  readonly dialogBy = new Map<string, string>()
  private readonly screens = new Map<string, Screen>()
  /** Every state the daemon pushed to the app with an attention on it: the person's panes. */
  readonly lit: string[] = []

  constructor() {
    this.root = mkdtempSync(join(runRoot, 'tether-v2-'))
    this.home = join(this.root, 'home')
    mkdirSync(this.home)
    const id = randomBytes(4).toString('hex')
    const BS = String.fromCharCode(92)
    const winPipe = (n: string): string => [BS, BS, '.', BS, 'pipe', BS, n].join('')
    this.pipe = process.platform === 'win32' ? winPipe(`tether-v2-${id}`) : join(this.home, 'd.sock')
    this.ptydPipe = process.platform === 'win32' ? winPipe(`tether-v2-ptyd-${id}`) : join(this.home, 'ptyd.sock')
  }

  async connect(): Promise<void> {
    // Only what the scene needs: the extensions with side effects of their own (a bridge daemon, a browser, skills) and the desk's are off.
    writeFileSync(join(this.home, 'settings.json'), JSON.stringify({ extensions: { disabled: ['web-bridge', 'browser', 'skills', 'for-agents'] } }))
    const env = cleanDaemonEnv({ TETHER_PANEL_HOST: '1', TETHER_PTYD_PIPE: this.ptydPipe })
    this.client = await DaemonClient.connect({ home: this.home, pipe: this.pipe, client: 'test', mainPath: MAIN, env, startTimeoutMs: 45_000 })
    const pid = this.client.hello.pid
    this.seen.add(pid)
    await claim(pid, { cmdIncludes: MAIN, what: 'tetherd (channels claude)' })
    this.client.on('data', (slotId: string, data: string) => {
      const screen = this.screens.get(slotId) ?? new Screen(120, 40)
      this.screens.set(slotId, screen)
      screen.write(data)
      const text = screen.text()
      if (text.includes('Loading development channels')) this.dialogBy.set(slotId, text)
    })
    this.app = await DaemonClient.open(this.pipe, 'app')
    this.app.on('state', (s: SlotState) => {
      const on = s.attention ?? (s.attentionFor ? JSON.stringify(s.attentionFor) : undefined)
      if (on) this.lit.push(`${s.slotId}:${on}`)
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
      await sleep(250)
    }
  }

  /** The turn is over: no `turn` for three polls in a row (call it after the thing that proves the turn started). */
  async idle(slotId: string, timeout = 90_000): Promise<void> {
    let quiet = 0
    await this.waitFor(`${slotId} idle`, async () => { quiet = (await this.state(slotId))?.turn ? 0 : quiet + 1; return quiet >= 3 ? true : undefined }, timeout)
  }

  /** Types a line the way the app does: text, a pause, Enter. */
  async type(slotId: string, text: string): Promise<void> {
    this.client.input(slotId, text)
    await sleep(150)
    this.client.input(slotId, '\r')
  }

  /** A real Claude (haiku) in a bench folder new and empty, outside the house; open, trust dialog answered, first idle. */
  async claude(name: string): Promise<string> {
    const bench = mkdtempSync(join(tmpdir(), 'tether-v2-bench-'))
    this.benches.push(bench)
    const args = ['--model', 'haiku', '--allowedTools', 'mcp__tether__channels_say,mcp__tether__channels_read,mcp__tether__channels_members,mcp__tether__channels_list,mcp__tether__channels_join,mcp__tether__channels_leave']
    const slot = (await this.client.request({ t: 'create', kind: 'claude', cwd: bench, name, args })).slot!.slotId
    await openSlot(this.client, slot)
    const st = await this.state(slot)
    if (st?.pid) this.seen.add(st.pid)
    return slot
  }

  /** The person's side: a request of the channels extension, as the `app` client. */
  async ask<T = any>(name: string, args?: unknown): Promise<T> {
    return (await this.app.request({ t: 'ext-request', ext: 'channels', name, ...(args !== undefined ? { args } : {}) })).result as T
  }

  /** The transcript of the slot's session, read fresh. */
  transcript(state: SlotState): string {
    const b = state.binding
    if (!b) return ''
    const file = findTranscript({ sessionId: b.sessionId, cwd: b.cwd })
    return file && existsSync(file) ? readFileSync(file, 'utf8') : ''
  }
  async raw(slotId: string): Promise<string> { const st = await this.state(slotId); return st ? this.transcript(st) : '' }

  /** The `<channel ...>` turns of a transcript (attributes and body), oldest first. */
  static channelTurns(raw: string): ChannelTurn[] {
    const out: ChannelTurn[] = []
    for (const line of raw.split('\n')) {
      if (!line.includes('"type":"user"')) continue
      let content: unknown
      try { content = (JSON.parse(line) as { message?: { content?: unknown } }).message?.content } catch { continue }
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c: { text?: string }) => c.text ?? '').join('\n') : ''
      const m = /<channel source="tether"([^>]*)>([\s\S]*?)<\/channel>/.exec(text)
      if (!m) continue
      const attrs: Record<string, string> = {}
      for (const a of m[1]!.matchAll(/(\w+)="([^"]*)"/g)) attrs[a[1]!] = a[2]!
      out.push({ attrs, body: m[2]!.trim() })
    }
    return out
  }

  /** The tool calls the model made (name and, for the channel tools, the input), oldest first. */
  static toolUses(raw: string): Array<{ name: string; input: Record<string, unknown> }> {
    const out: Array<{ name: string; input: Record<string, unknown> }> = []
    for (const line of raw.split('\n')) {
      if (!line.includes('"tool_use"')) continue
      let content: unknown
      try { content = (JSON.parse(line) as { message?: { content?: unknown } }).message?.content } catch { continue }
      if (!Array.isArray(content)) continue
      for (const c of content as Array<{ type?: string; name?: string; input?: Record<string, unknown> }>) if (c.type === 'tool_use' && c.name) out.push({ name: c.name, input: c.input ?? {} })
    }
    return out
  }

  async teardown(): Promise<string[]> {
    try {
      for (const s of await this.states()) if (s.pid) await this.client.request({ t: 'stop', slotId: s.slotId }).catch(() => undefined)
      for (const end = Date.now() + 40_000; Date.now() < end; await sleep(250)) {
        if ((await this.states().catch(() => [])).every((s) => !s.pid)) break
      }
    } catch { /* daemon gone */ }
    try { this.app?.close() } catch { /* gone */ }
    try { await this.client.request({ t: 'shutdown' }) } catch { /* gone */ }
    try { this.client.close() } catch { /* gone */ }
    const host = await HostClient.ping(this.ptydPipe).catch(() => undefined)
    if (host) this.seen.add(host.pid)
    for (const end = Date.now() + 15_000; [...this.seen].some(pidAlive) && Date.now() < end; await sleep(200));
    for (const pid of [...this.seen].reverse()) {
      if (!pidAlive(pid)) continue
      const owned = await claim(pid, { what: 'channels claude e2e process' }).catch(() => undefined)
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

const fmt = (t: ChannelTurn): string => `<channel source="tether" ${Object.entries(t.attrs).map(([k, v]) => `${k}="${v}"`).join(' ')}>${t.body}</channel>`

test('V2 step 1: two real Claudes join a channel; A speaks by channels_say and B receives it inside', { timeout: 1_200_000 }, async (t) => {
  const rig = new Rig(); rigs.push(rig)
  await rig.connect()
  const note = (s: string): void => { t.diagnostic(s); console.log(`# ${s}`) }
  const NAME_A = 'claude · conferente'
  const NAME_B = 'claude · bancada'

  const A = await rig.claude(NAME_A)
  const B = await rig.claude(NAME_B)
  note(`both open: ${A} ${B}`)
  for (const id of [A, B]) assert.ok(rig.dialogBy.get(id), `the channels dialog was shown for ${id}`)

  // The person opens a channel and joins both; each Claude is told only by the entry notice.
  const { channel } = await rig.ask('create', { name: 'conversa', title: 'Conversa de teste' })
  const CH: string = channel.id
  await rig.ask('join', { channel: CH, agent: A })
  const entryA = await rig.waitFor('A got the entry notice', async () => Rig.channelTurns(await rig.raw(A)).find((x) => x.attrs.role === 'system' && x.body.includes('conversa')))
  note(`A entry notice: ${fmt(entryA)}`)
  await rig.idle(A)
  await rig.ask('join', { channel: CH, agent: B })
  const entryB = await rig.waitFor('B got the entry notice', async () => Rig.channelTurns(await rig.raw(B)).find((x) => x.attrs.role === 'system' && x.body.includes('conversa')))
  note(`B entry notice: ${fmt(entryB)}`)
  await rig.idle(B)
  const members = await rig.ask('members', { channel: CH })
  assert.deepEqual(members.members.map((m: { id: string; path: string }) => `${m.id}:${m.path}`).sort(), [`${A}:inside`, `${B}:inside`].sort(), 'both hear inside')

  // A is asked, in a few words and without the verb, to greet the colleague.
  const sentAt = Date.now()
  await rig.type(A, 'Você tem um colega no canal em que acabou de entrar. Cumprimente-o por lá, em uma frase curta.')
  const spoken = await rig.waitFor('A spoke in the channel', async () => {
    const h = await rig.ask('history', { channel: CH })
    return h.lines.find((l: { kind: string; from: { id: string } }) => l.kind === 'message' && l.from.id === A)
  }, 120_000)
  note(`A spoke after ${Date.now() - sentAt} ms: seq ${spoken.seq} "${String(spoken.body).slice(0, 80)}"`)
  const aTools = Rig.toolUses(await rig.raw(A)).map((u) => u.name)
  note(`A tools: ${aTools.join(', ')}`)
  assert.ok(aTools.includes('mcp__tether__channels_say'), `A used channels_say (tools: ${aTools.join(', ')})`)

  // B receives it inside, with room, from and role.
  const heard = await rig.waitFor('B received A\'s line', async () => Rig.channelTurns(await rig.raw(B)).find((x) => x.attrs.from_id === A && x.attrs.kind === 'message'), 90_000)
  note(`B received: ${fmt(heard)}`)
  assert.equal(heard.attrs.room, 'conversa')
  assert.equal(heard.attrs.from, NAME_A)
  assert.equal(heard.attrs.role, 'member')
  assert.equal(heard.attrs.origin, 'channels')
  assert.equal(heard.body, String(spoken.body))

  await rig.idle(A); await rig.idle(B)
  evidence('1-channel-turns.txt', [`A (${NAME_A})`, ...Rig.channelTurns(await rig.raw(A)).map(fmt), '', `B (${NAME_B})`, ...Rig.channelTurns(await rig.raw(B)).map(fmt), ''].join('\n'))
  evidence('1-tools.txt', [`A: ${aTools.join(', ')}`, `B: ${Rig.toolUses(await rig.raw(B)).map((u) => u.name).join(', ')}`, ''].join('\n'))
  evidence('1-history.json', JSON.stringify((await rig.ask('history', { channel: CH })).lines, null, 2) + '\n')
  const left = await rig.teardown()
  assert.deepEqual(left, [], 'no process left behind')
})
