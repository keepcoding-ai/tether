// V2: two REAL Claude Code agents (haiku) in one channel, in a PRIVATE tetherd (own home, pipe and pane host) with the real channels
// extension. The person (the moderator) is one `app` client of the test. Each Claude lives in its own bench folder, new and empty,
// outside the house. The Claudes learn about the channel ONLY from what the tether gives them (the server instructions and the
// entry notice): the first prompt of each is minimal and never names a verb.
//   1 the moderator creates the channel and joins both; A is asked to put a closed question to the colleague; A speaks by
//     `channels_say` (nobody taught it the verb); B (no prompt) receives it inside, with `room`, `from` and `role`
//   2 B answers by `channels_say` from the line alone; A receives the answer inside
//   3 three lines in a row from the moderator during a turn of B: MEASURED (separate turns or fused), not a pass criterion
//   4 after every turn a line opened no pane stays lit with `done` (`waiting` does not count)
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
const evidence = (name: string, text: string): void => { if (evidenceDir) writeFileSync(join(evidenceDir, `6-${name}`), sanitized(text)) }

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
  /** Rising edges of attention per pane (none -> on), as the person's app would light it. */
  readonly edges: Array<{ slot: string; at: number; attention: string; off?: number }> = []
  private readonly onNow = new Map<string, string>()
  /** The turns each pane ran, from the `turn` of its states (start and end in ms). */
  readonly turns = new Map<string, Array<{ start: number; end?: number }>>()
  /** What happened, in order, with the clock (ms): the timeline the isolation reads. */
  readonly timeline: Array<{ at: number; what: string }> = []
  readonly labels = new Map<string, string>()
  readonly benchOf = new Map<string, string>()
  tl(what: string): void { this.timeline.push({ at: Date.now(), what }) }

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
    this.app = await DaemonClient.open(this.pipe, 'app', { home: this.home })
    this.app.on('state', (s: SlotState) => {
      const on = s.attention ?? (s.attentionFor ? JSON.stringify(s.attentionFor) : undefined)
      if (on) this.lit.push(`${s.slotId}:${on}`)
      const was = this.onNow.get(s.slotId)
      if (on && !was) this.edges.push({ slot: s.slotId, at: Date.now(), attention: s.attention ?? 'for' })
      if (!on && was) { const open = [...this.edges].reverse().find((e) => e.slot === s.slotId && e.off === undefined); if (open) open.off = Date.now() }
      if (on) this.onNow.set(s.slotId, on); else this.onNow.delete(s.slotId)
      const list = this.turns.get(s.slotId) ?? []
      this.turns.set(s.slotId, list)
      const last = list[list.length - 1]
      const who = this.labels.get(s.slotId) ?? s.slotId
      if (s.turn && (!last || last.end !== undefined)) { list.push({ start: Date.now() }); this.tl(`${who}: turn START`) }
      if (!s.turn && last && last.end === undefined) { last.end = Date.now(); this.tl(`${who}: turn END`) }
      if (on && !was) this.tl(`${who}: attention ${on} ON`)
      if (!on && was) this.tl(`${who}: attention OFF (was ${was})`)
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
    const args = ['--model', 'haiku', '--allowedTools', 'mcp__tether__channels_say,mcp__tether__channels_read,mcp__tether__channels_members,mcp__tether__channels_list,mcp__tether__channels_join,mcp__tether__channels_leave,Read']
    const slot = (await this.client.request({ t: 'create', kind: 'claude', cwd: bench, name, args })).slot!.slotId
    await openSlot(this.client, slot)
    const st = await this.state(slot)
    if (st?.pid) this.seen.add(st.pid)
    this.benchOf.set(slot, bench)
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

  /** Every tool_use with its id, the transcript line it sits on and its result (error flag and a snippet), to tell a repeated record from a refused call. */
  static toolDetail(raw: string): string[] {
    const uses: Array<{ id: string; name: string; line: number; input: string }> = []
    const results = new Map<string, string>()
    raw.split('\n').forEach((line, i) => {
      if (!line.includes('"tool_use') ) return
      let content: unknown
      try { content = (JSON.parse(line) as { message?: { content?: unknown } }).message?.content } catch { return }
      if (!Array.isArray(content)) return
      for (const c of content as Array<{ type?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; is_error?: boolean; content?: unknown }>) {
        if (c.type === 'tool_use' && c.name) uses.push({ id: c.id ?? '?', name: c.name, line: i, input: JSON.stringify(c.input ?? {}).slice(0, 160) })
        if (c.type === 'tool_result' && c.tool_use_id) results.set(c.tool_use_id, `${c.is_error ? 'ERROR ' : 'ok '}${JSON.stringify(c.content ?? '').slice(0, 120)}`)
      }
    })
    // tool_result sits on user lines, which do not name "tool_use": read them in a second pass
    raw.split('\n').forEach((line) => {
      if (!line.includes('"tool_result"')) return
      let content: unknown
      try { content = (JSON.parse(line) as { message?: { content?: unknown } }).message?.content } catch { return }
      if (!Array.isArray(content)) return
      for (const c of content as Array<{ type?: string; tool_use_id?: string; is_error?: boolean; content?: unknown }>) {
        if (c.type === 'tool_result' && c.tool_use_id) results.set(c.tool_use_id, `${c.is_error ? 'ERROR ' : 'ok '}${JSON.stringify(c.content ?? '').slice(0, 120)}`)
      }
    })
    return uses.map((u) => `line ${u.line} ${u.name} id=${u.id.slice(-6)} ${u.input} => ${results.get(u.id) ?? '(no result)'}`)
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

test('V2: two real Claudes in a channel: A asks, B answers by channels_say, three lines during a turn of B, no done left lit', { timeout: 1_200_000 }, async (t) => {
  const rig = new Rig(); rigs.push(rig)
  await rig.connect()
  const note = (s: string): void => { t.diagnostic(s); console.log(`# ${s}`) }
  const NAME_A = 'claude · conferente'
  const NAME_B = 'claude · bancada'

  const A = await rig.claude(NAME_A); rig.labels.set(A, 'A')
  const B = await rig.claude(NAME_B); rig.labels.set(B, 'B')
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

  // A is asked, in a few words and without the verb, to put a closed question to the colleague. B has no prompt at all.
  const markEntries = rig.edges.length
  const sentAt = Date.now()
  rig.tl('TEST types the prompt in A')
  await rig.type(A, 'Você tem um colega no canal em que acabou de entrar. Pergunte a ele, por lá, quanto é 17 vezes 3.')
  const spoken = await rig.waitFor('A spoke in the channel', async () => {
    const h = await rig.ask('history', { channel: CH })
    return h.lines.find((l: { kind: string; from: { id: string } }) => l.kind === 'message' && l.from.id === A)
  }, 120_000)
  note(`A spoke after ${Date.now() - sentAt} ms: seq ${spoken.seq} "${String(spoken.body).slice(0, 80)}"`)
  // the line is in the registry before the transcript has flushed the tool call: wait for the transcript
  const aTools = await rig.waitFor('A\'s channels_say in its transcript', async () => {
    const names = Rig.toolUses(await rig.raw(A)).map((u) => u.name)
    return names.includes('mcp__tether__channels_say') ? names : undefined
  }, 30_000)
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

  // ---- 2. B answers by channels_say, from the line alone; A receives the answer inside ----
  const answered = await rig.waitFor('B answered in the channel', async () => {
    const h = await rig.ask('history', { channel: CH })
    return h.lines.find((l: { kind: string; from: { id: string } }) => l.kind === 'message' && l.from.id === B)
  }, 90_000).catch(async (e: unknown) => {
    // A finding, not noise: keep what B did with the line (its turn: what the model said and which tools it called).
    const rawB = await rig.raw(B)
    const said: string[] = []
    for (const line of rawB.split('\n')) {
      if (!line.includes('"assistant"')) continue
      try {
        const c = (JSON.parse(line) as { message?: { content?: unknown } }).message?.content
        if (Array.isArray(c)) for (const p of c as Array<{ type?: string; text?: string }>) if (p.type === 'text' && p.text) said.push(p.text)
      } catch { /* not json */ }
    }
    evidence('2-b-did-not-answer.txt', [`B tool calls:`, ...Rig.toolDetail(rawB), '', 'B text after the entries:', ...said, '', 'B channel tags:', ...Rig.channelTurns(rawB).map(fmt), ''].join('\n'))
    throw e
  })
  const bTools = Rig.toolDetail(await rig.raw(B))
  if (answered) {
    note(`B answered: seq ${answered.seq} "${String(answered.body).slice(0, 80)}"`)
    note(`B tools: ${bTools.map((x) => x.split(' ')[2]).join(', ')}`)
    assert.ok(bTools.some((x) => x.includes('mcp__tether__channels_say')), 'B answered by channels_say')
    const back = await rig.waitFor('A received B\'s answer', async () => Rig.channelTurns(await rig.raw(A)).find((x) => x.attrs.from_id === B && x.attrs.kind === 'message'), 90_000)
    note(`A received: ${fmt(back)}`)
    assert.equal(back.attrs.room, 'conversa')
    assert.equal(back.attrs.from, NAME_B)
    assert.equal(back.attrs.role, 'member')
    assert.equal(back.body, String(answered.body))
  }
  await rig.idle(A); await rig.idle(B)

  // The double channels_say of A in the transcript: a repeated record of one call, or a refused call?
  const aDetail = Rig.toolDetail(await rig.raw(A))
  note(`A calls:\n${aDetail.join('\n')}`)
  evidence('2-a-tool-calls.txt', aDetail.join('\n') + '\n')
  evidence('2-b-tool-calls.txt', bTools.join('\n') + '\n')

  // ---- 3. three lines in a row during a turn of B (sent by the moderator, who is never delivered anything) ----
  const turnsBefore = rig.turns.get(B)!.length
  // B is kept busy by foreground tool calls only (no background task): three small files read one by one.
  for (const f of ['um', 'dois', 'tres']) writeFileSync(join(rig.benchOf.get(B)!, `${f}.txt`), Array.from({ length: 12 + f.length }, (_, i) => `${f} ${i + 1}`).join('\n') + '\n')
  const taskRes = await rig.ask('say', { channel: CH, text: 'Leia, um de cada vez e com a ferramenta de leitura, os arquivos um.txt, dois.txt e tres.txt da sua pasta, e some o número de linhas deles.', to: [NAME_B] })
  rig.tl(`MODERATOR says the task line (receipts ${JSON.stringify(taskRes.receipts)})`)
  await rig.waitFor('B busy', async () => (await rig.state(B))?.turn === 'busy' ? true : undefined, 60_000)
  await sleep(1500) // the model is inside its tool calls by now
  const threeAt = Date.now()
  const marks = ['FALA-1 de 3 (aviso apenas, sem resposta)', 'FALA-2 de 3 (aviso apenas, sem resposta)', 'FALA-3 de 3 (aviso apenas, sem resposta)']
  const receipts: string[] = []
  for (const text of marks) {
    const r = await rig.ask('say', { channel: CH, text, to: [NAME_B] })
    receipts.push(JSON.stringify(r.receipts))
    rig.tl(`MODERATOR says "${text.slice(0, 6)}" (receipts ${JSON.stringify(r.receipts)})`)
    await sleep(400)
  }
  const stillBusy = (await rig.state(B))?.turn === 'busy'
  note(`three lines sent over ${Date.now() - threeAt} ms; B still busy after them: ${stillBusy}; receipts ${receipts.join(' ')}`)
  await rig.waitFor('B idle after the three lines', async () => (await rig.state(B))?.turn ? undefined : true, 120_000)
  await sleep(5000) // a fused or deferred turn would open now
  await rig.idle(B); await rig.idle(A)
  const bTurns = rig.turns.get(B)!.slice(turnsBefore).map((x) => `${x.start - threeAt}..${x.end === undefined ? '?' : x.end - threeAt} ms`)
  const rawB = await rig.raw(B)
  const hits: string[] = []
  rawB.split('\n').forEach((line, i) => {
    const found = [1, 2, 3].filter((n) => line.includes(`FALA-${n} de 3`))
    if (!found.length) return
    let type = '?', ts = '?'
    try { const j = JSON.parse(line) as { type?: string; timestamp?: string; attachment?: { type?: string } }; type = `${j.type}${j.attachment?.type ? '/' + j.attachment.type : ''}`; ts = j.timestamp ?? '?' } catch { /* not json */ }
    hits.push(`transcript line ${i} (${type}, ${ts}) carries FALA ${found.join('+')}`)
  })
  const sameLine = hits.filter((h) => /FALA \d\+/.test(h)).length
  const verdict = hits.length === 0 ? 'NOT FOUND in the transcript' : sameLine ? 'FUSED (several lines in one transcript entry)' : `SEPARATE entries (${hits.length}); turns of B after the three lines: ${bTurns.length}`
  note(`MEASURE three lines during B's turn: ${verdict}`)
  note(`B turns since the sleep line (relative to the first of the three): ${bTurns.join(' | ')}`)
  const afterThree = Rig.channelTurns(rawB).filter((x) => /FALA-\d de 3/.test(x.body))
  evidence('3-three-lines.txt', [`verdict: ${verdict}`, `B turns (ms relative to the first of the three): ${bTurns.join(' | ')}`, `B busy right after the three were sent: ${stillBusy}`, `receipts: ${receipts.join(' ')}`, '', ...hits, '', 'channel tags B holds with a FALA:', ...afterThree.map(fmt), '', 'tool calls of B:', ...Rig.toolDetail(rawB), ''].join('\n'))

  // ---- 4. the `done` of a turn a line opened is never left lit ----
  // The panes the person typed in (A's prompt) may end with their own `done`; everything else is a turn opened by a line.
  const aTyped = rig.turns.get(A)!.find((x) => x.start >= sentAt)
  const allowedA = (at: number): boolean => !!aTyped && at >= aTyped.start && at <= (aTyped.end ?? Date.now()) + 2500
  const lateB = rig.edges.slice(markEntries).filter((e) => e.slot === B)
  const lateA = rig.edges.slice(markEntries).filter((e) => e.slot === A && !allowedA(e.at))
  note(`attention edges after the entries: B ${JSON.stringify(rig.edges.slice(markEntries).filter((e) => e.slot === B).map((e) => e.attention))}, A ${JSON.stringify(rig.edges.slice(markEntries).filter((e) => e.slot === A).map((e) => `${e.attention}@${e.at - sentAt}ms`))} (A's typed turn ${aTyped ? `${aTyped.start - sentAt}..${aTyped.end === undefined ? '?' : aTyped.end - sentAt} ms` : 'unseen'})`)
  // The extension puts a `done` out in the same breath it arrives (the two states come together): a flash is not "lit".
  const stayed = (e: { off?: number; at: number }): boolean => e.off === undefined || e.off - e.at > 250
  const durations = rig.edges.slice(markEntries).map((e) => `${e.slot === A ? 'A' : 'B'}:${e.attention}:${e.off === undefined ? 'still on' : `${e.off - e.at}ms`}`)
  note(`attention durations after the entries: ${durations.join(', ')}`)
  // The timeline of the isolation: state edges (turn, attention), the test's own acts and every line of the channel with its clock.
  const hist = (await rig.ask('history', { channel: CH })).lines as Array<{ at: string; seq: number; kind: string; from: { name: string }; to?: string[]; body: string }>
  const nameLabel = (n: string): string => (n === NAME_A ? 'A' : n === NAME_B ? 'B' : n)
  const all = [...rig.timeline, ...hist.map((l) => ({ at: Date.parse(l.at), what: `LINE #${l.seq} ${l.kind} from ${nameLabel(l.from.name)}${l.to?.length ? ` to ${l.to.map(nameLabel).join(',')}` : ''}: ${l.body.slice(0, 60)}` }))].sort((x, y) => x.at - y.at)
  const t0 = all[0]!.at
  const openers = rig.turns.get(B)!.map((tn, i) => {
    const near = all.filter((e) => e.what.startsWith('LINE') && e.at <= tn.start && tn.start - e.at < 4000 && !/from B/.test(e.what)).pop()
    return `B turn ${i + 1}: ${tn.start - t0}..${tn.end === undefined ? '?' : tn.end - t0} ms; opened by ${near ? `a line (${near.what.slice(0, 70)}, ${tn.start - near.at} ms before)` : 'NOT a line within 4 s (another cause)'}`
  })
  evidence('5-done-isolated.txt', ['timeline (ms from the first event):', ...all.map((e) => `${String(e.at - t0).padStart(7)}  ${e.what}`), '', 'attention durations: ' + durations.join(', '), '', ...openers, ''].join('\n'))
  assert.deepEqual(lateB.filter((e) => e.attention === 'done' && stayed(e)).map((e) => e.off === undefined ? 'still on' : `${e.off - e.at}ms`), [], 'B: no done stayed lit after a turn a line opened')
  assert.deepEqual(lateA.filter((e) => e.attention === 'done' && stayed(e)).map((e) => e.off === undefined ? 'still on' : `${e.off - e.at}ms`), [], 'A: no done stayed lit after a turn a line opened')
  const nowLit = (await rig.states()).filter((s) => s.attention === 'done').map((s) => s.slotId)
  assert.ok(!nowLit.includes(B), 'B shows no done now')
  evidence('4-attention.txt', [`durations: ${durations.join(', ')}`,`edges after the entries: ${JSON.stringify(rig.edges.slice(markEntries).map((e) => ({ slot: e.slot === A ? 'A' : 'B', attention: e.attention, ms: e.at - sentAt })))}`, `A typed turn: ${aTyped ? `${aTyped.start - sentAt}..${aTyped.end === undefined ? '?' : aTyped.end - sentAt} ms` : 'unseen'}`, `panes with done at the end: ${nowLit.map((s) => (s === A ? 'A' : s === B ? 'B' : s)).join(',') || 'none'}`, ''].join('\n'))

  evidence('1-channel-turns.txt', [`A (${NAME_A})`, ...Rig.channelTurns(await rig.raw(A)).map(fmt), '', `B (${NAME_B})`, ...Rig.channelTurns(await rig.raw(B)).map(fmt), ''].join('\n'))
  evidence('1-tools.txt', [`A: ${aTools.join(', ')}`, `B: ${Rig.toolUses(await rig.raw(B)).map((u) => u.name).join(', ')}`, ''].join('\n'))
  evidence('1-history.json', JSON.stringify((await rig.ask('history', { channel: CH })).lines, null, 2) + '\n')
  const left = await rig.teardown()
  assert.deepEqual(left, [], 'no process left behind')
})
