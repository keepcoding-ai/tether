// The owner of a desk with its OWN pane inside the desk, with REAL Claude Code agents (haiku): does the desk fall into a loop?
// The fake-agent twin (channels.owner-in-desk.test.ts) measures the path; a real LLM is who reacts to the notices, so this measures
// the reaction. PRIVATE tetherd (own home, pipe and pane host), channels and for-agents extensions on. Three Claudes in bench folders
// new and empty, outside the house: A owns the desk "mesa" (A's own pane is inside it), B and C are its panes. The person gives the desk
// to A by the gestures the app writes (`desk-map`, then `object-set` of the owner), so the desk channel is born by itself.
// Scenario: the person asks A, in A's pane, to ask the desk channel the capital of France and to tell her the answer. Nothing else is
// said to anyone. Observe up to 120 s, then demand 30 s of total silence (no open turn, no new delivery to any pane, no new line).
// MEASURES: lines in the channel per author, turns per pane, every delivery that reached A (text), time until silence.
// ASSERTIONS: silence is reached in time (todo when not: that is the loop); A receives ZERO "terminou" notices; few lines (ceiling 8, todo).
// Run alone: node --test test/e2e/channels.owner-in-desk.claude.test.ts
// Env: OID_ROUND (label of the round, default "x"), OID_EVIDENCE_DIR (keeps log, history and sequence; default none).
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

const ROUND = process.env.OID_ROUND ?? 'x'
const evidenceDir = process.env.OID_EVIDENCE_DIR
if (evidenceDir) mkdirSync(evidenceDir, { recursive: true })

/** Observation window and the silence that proves the system stopped by itself. */
const OBSERVE_MS = 120_000
const SILENCE_MS = 30_000
/** Ceiling of lines in the channel (generous). */
const LINES_CEILING = 8
/** A pane younger than this is never killed. */
const MIN_LIFE_MS = 11_000

/** Evidence never carries a key: anything that looks like a secret token is replaced. */
function sanitized(text: string): string {
  assert.ok(!/TETHER_(SLOT|MCP)_KEY/.test(text), 'evidence names a key variable')
  return text.replace(/([A-Za-z]:[\\/][^\s"']+)|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9_-]{32,}/g, (m, path: string | undefined) => {
    if (path || !/^(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}$/.test(m)) return m
    return `<redacted ${m.length} chars>`
  })
}
const evidence = (name: string, text: string): void => { if (evidenceDir) writeFileSync(join(evidenceDir, `rodada-${ROUND}-${name}`), sanitized(text)) }

/** The environment of the test daemon (and so of its agents): no CLAUDE*, no TETHER_* and no NODE_TEST_CONTEXT of where this test runs. */
function cleanDaemonEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^CLAUDE/i.test(k) || /^TETHER_/i.test(k) || k === 'NODE_TEST_CONTEXT') continue
    env[k] = v
  }
  return Object.assign(env, extra)
}

/** One user-side entry of a transcript: what reached the pane (a channel tag, or text typed into the terminal). */
interface Entry { id: string; at: number; text: string; attrs?: Record<string, string>; body: string }
interface HistLine { at: string; seq: number; kind: string; from: { id: string; name: string }; to?: string[]; body: string }

class Rig {
  readonly root: string
  readonly home: string
  readonly pipe: string
  readonly ptydPipe: string
  readonly benches: string[] = []
  readonly bornAt = new Map<string, number>()
  client!: DaemonClient
  app!: DaemonClient
  readonly seen = new Set<number>()
  /** The turns each pane ran, from the `turn` of its states. */
  readonly turns = new Map<string, Array<{ start: number; end?: number }>>()
  readonly labels = new Map<string, string>()

  constructor() {
    this.root = mkdtempSync(join(tmpdir(), 'tether-oid-'))
    this.home = join(this.root, 'home')
    mkdirSync(this.home)
    const id = randomBytes(4).toString('hex')
    const BS = String.fromCharCode(92)
    const winPipe = (n: string): string => [BS, BS, '.', BS, 'pipe', BS, n].join('')
    this.pipe = process.platform === 'win32' ? winPipe(`tether-oid-${id}`) : join(this.home, 'd.sock')
    this.ptydPipe = process.platform === 'win32' ? winPipe(`tether-oid-ptyd-${id}`) : join(this.home, 'ptyd.sock')
  }

  async connect(): Promise<void> {
    // Channels and the desk's ownership (for-agents) stay ON; what has side effects of its own is off.
    writeFileSync(join(this.home, 'settings.json'), JSON.stringify({ extensions: { disabled: ['web-bridge', 'browser', 'skills'] } }))
    const env = cleanDaemonEnv({ TETHER_PANEL_HOST: '1', TETHER_PTYD_PIPE: this.ptydPipe })
    this.client = await DaemonClient.connect({ home: this.home, pipe: this.pipe, client: 'test', mainPath: MAIN, env, startTimeoutMs: 45_000 })
    const pid = this.client.hello.pid
    this.seen.add(pid)
    await claim(pid, { cmdIncludes: MAIN, what: 'tetherd (channels owner-in-desk claude)' })
    this.app = await DaemonClient.open(this.pipe, 'app')
    this.app.on('state', (s: SlotState) => {
      const list = this.turns.get(s.slotId) ?? []
      this.turns.set(s.slotId, list)
      const last = list[list.length - 1]
      if (s.turn && (!last || last.end !== undefined)) list.push({ start: Date.now() })
      if (!s.turn && last && last.end === undefined) last.end = Date.now()
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

  /** Types a line the way the app does: text, a pause, Enter. */
  async type(slotId: string, text: string): Promise<void> {
    this.client.input(slotId, text)
    await sleep(150)
    this.client.input(slotId, '\r')
  }

  /** A real Claude (haiku) in a bench folder new and empty, outside the house; open, trust dialog answered, first idle. */
  async claude(name: string): Promise<string> {
    const bench = mkdtempSync(join(tmpdir(), 'tether-oid-bench-'))
    this.benches.push(bench)
    // Channel verbs and read-only views of the owner are pre-approved; anything else would stop at a permission card (and show as such).
    const args = ['--model', 'haiku', '--allowedTools', 'mcp__tether__channels_say,mcp__tether__channels_read,mcp__tether__channels_members,mcp__tether__channels_list,mcp__tether__channels_join,mcp__tether__channels_leave,mcp__tether__agents_list,mcp__tether__agents_read_screen,mcp__tether__agents_last_answer,Read']
    const slot = (await this.client.request({ t: 'create', kind: 'claude', cwd: bench, name, args })).slot!.slotId
    this.bornAt.set(slot, Date.now())
    await openSlot(this.client, slot)
    const st = await this.state(slot)
    if (st?.pid) this.seen.add(st.pid)
    return slot
  }

  /** The person's side: a request of the channels extension, as the `app` client. */
  async ask<T = any>(name: string, args?: unknown): Promise<T> {
    return (await this.app.request({ t: 'ext-request', ext: 'channels', name, ...(args !== undefined ? { args } : {}) })).result as T
  }

  /** Everything that reached a pane as a user entry of its transcript (channel tags and typed text), oldest first, no tool results. */
  entries(state: SlotState | undefined): Entry[] {
    const b = state?.binding
    if (!b) return []
    const file = findTranscript({ sessionId: b.sessionId, cwd: b.cwd })
    if (!file || !existsSync(file)) return []
    const out: Entry[] = []
    const seenIds = new Set<string>()
    for (const [i, line] of readFileSync(file, 'utf8').split('\n').entries()) {
      if (!line.includes('"type":"user"')) continue
      let j: { uuid?: string; timestamp?: string; message?: { content?: unknown } }
      try { j = JSON.parse(line) as typeof j } catch { continue }
      const content = j.message?.content
      const text = typeof content === 'string' ? content : Array.isArray(content) ? (content as Array<{ type?: string; text?: string }>).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n') : ''
      if (!text.trim()) continue
      const id = j.uuid ?? `line-${i}`
      if (seenIds.has(id)) continue
      seenIds.add(id)
      const m = /<channel source="tether"([^>]*)>([\s\S]*?)<\/channel>/.exec(text)
      const attrs: Record<string, string> | undefined = m ? {} : undefined
      if (m && attrs) for (const a of m[1]!.matchAll(/(\w+)="([^"]*)"/g)) attrs[a[1]!] = a[2]!
      out.push({ id, at: j.timestamp ? Date.parse(j.timestamp) : Date.now(), text, ...(attrs ? { attrs } : {}), body: m ? m[2]!.trim() : text.trim() })
    }
    return out
  }

  /** The assistant text and the tool calls of a pane, in order (for the report). */
  assistantTrail(state: SlotState | undefined): string[] {
    const b = state?.binding
    if (!b) return []
    const file = findTranscript({ sessionId: b.sessionId, cwd: b.cwd })
    if (!file || !existsSync(file)) return []
    const out: string[] = []
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('"assistant"')) continue
      let j: { timestamp?: string; message?: { content?: unknown } }
      try { j = JSON.parse(line) as typeof j } catch { continue }
      if (!Array.isArray(j.message?.content)) continue
      for (const c of j.message!.content as Array<{ type?: string; text?: string; name?: string; input?: unknown }>) {
        if (c.type === 'text' && c.text) out.push(`${j.timestamp ?? ''} SAYS ${c.text.replace(/\s+/g, ' ').slice(0, 300)}`)
        if (c.type === 'tool_use' && c.name) out.push(`${j.timestamp ?? ''} TOOL ${c.name} ${JSON.stringify(c.input ?? {}).slice(0, 240)}`)
      }
    }
    return out
  }

  async teardown(): Promise<string[]> {
    try {
      // No Claude is killed before it lived MIN_LIFE_MS.
      const youngest = Math.max(0, ...[...this.bornAt.values()])
      if (youngest) await sleep(Math.max(0, youngest + MIN_LIFE_MS - Date.now()))
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
      const owned = await claim(pid, { what: 'channels owner-in-desk claude process' }).catch(() => undefined)
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

test('owner of a desk with its own pane inside, three real Claudes: the question about France ends and the desk falls silent (no loop)', { timeout: 900_000 }, async (t) => {
  const rig = new Rig(); rigs.push(rig)
  const logLines: string[] = []
  const note = (s: string): void => {
    logLines.push(`[${new Date().toISOString()}] ${s}`)
    t.diagnostic(s); console.log(`# ${s}`)
    if (evidenceDir) appendFileSync(join(evidenceDir, `rodada-${ROUND}.log`), sanitized(`[${new Date().toISOString()}] ${s}\n`))
  }
  await rig.connect()

  // One at a time (real LLM agents), each in its own bench folder.
  const A = await rig.claude('claude · dona'); rig.labels.set(A, 'A')
  const B = await rig.claude('claude · bancada'); rig.labels.set(B, 'B')
  const C = await rig.claude('claude · conferencia'); rig.labels.set(C, 'C')
  const label = (id: string): string => rig.labels.get(id) ?? id
  note(`three Claudes open: A=${A} B=${B} C=${C}`)

  // ---- the person gives the desk to A, A's own pane being inside it ----
  const desk = (id: string, panes: string[], kind: 'queue' | 'system' = 'queue') => ({ id, name: id, kind, panes: panes.map((p) => ({ id: p, type: 'terminal' })) })
  await rig.client.request({ t: 'desk-map', map: { desks: [desk('mesa', [A, B, C]), desk('sistema', [], 'system')], drawer: [] } })
  await rig.client.request({ t: 'object-set', ext: 'for-agents', kind: 'desk', objectId: 'mesa', key: 'owner', value: { owner: A, since: new Date().toISOString(), givenBy: 'user' } })
  const deskChannel = await rig.waitFor('the desk channel is born with A, B and C', async () => {
    const list = (await rig.ask('list')).channels as Array<{ id: string; name: string }>
    const ch = list.find((c) => c.id === 'desk_mesa')
    if (!ch) return undefined
    const members = (await rig.ask('members', { channel: ch.id })).members as Array<{ id: string; role?: string }>
    return members.length === 3 ? { ch, members } : undefined
  }, 60_000)
  const CH = deskChannel.ch.id
  const NAME = deskChannel.ch.name
  note(`desk channel ${CH} (#${NAME}); members ${JSON.stringify(deskChannel.members.map((m) => [label(m.id), m.role]))}`)

  const history = async (): Promise<HistLine[]> => (await rig.ask('history', { channel: CH })).lines as HistLine[]
  const nameLabel = (n: string): string => (n === 'claude · dona' ? 'A' : n === 'claude · bancada' ? 'B' : n === 'claude · conferencia' ? 'C' : n)
  const fromLabel = (l: HistLine): string => rig.labels.get(l.from.id) ?? l.from.name

  // ---- setup settles by itself (the entry notices open a turn in each pane): the baseline is what exists when it is still ----
  interface Snap { open: string[]; lines: number; delivered: Record<string, number>; attention: Record<string, string> }
  const snap = async (): Promise<Snap> => {
    const states = await rig.states()
    const open: string[] = []
    const attention: Record<string, string> = {}
    const delivered: Record<string, number> = {}
    for (const slot of [A, B, C]) {
      const s = states.find((x) => x.slotId === slot)
      if (s?.turn) open.push(label(slot))
      if (s?.attention) attention[label(slot)] = s.attention
      delivered[label(slot)] = rig.entries(s).length
    }
    return { open, lines: (await history()).length, delivered, attention }
  }
  const sameSnap = (x: Snap, y: Snap): boolean => x.lines === y.lines && JSON.stringify(x.delivered) === JSON.stringify(y.delivered)
  {
    let last = await snap()
    let stillSince = Date.now()
    const capAt = Date.now() + 150_000
    while (Date.now() < capAt && Date.now() - stillSince < 20_000) {
      await sleep(1_500)
      const now = await snap()
      if (!sameSnap(now, last) || now.open.length) stillSince = Date.now()
      last = now
    }
    note(`setup settled (still ${Math.round((Date.now() - stillSince) / 1000)} s): lines ${last.lines}, deliveries ${JSON.stringify(last.delivered)}`)
  }
  const baseHist = await history()
  const baseSeq = Math.max(0, ...baseHist.map((l) => l.seq))
  const baseDeliveries = new Map<string, number>()
  for (const slot of [A, B, C]) baseDeliveries.set(slot, rig.entries(await rig.state(slot)).length)
  const baseTurns = new Map<string, number>([...[A, B, C]].map((s) => [s, rig.turns.get(s)?.length ?? 0]))
  note(`baseline (not counted): ${baseHist.length} lines ${JSON.stringify(baseHist.map((l) => `${fromLabel(l)}:${l.kind}:${l.body.slice(0, 50)}`))}`)

  // ---- 1. the person asks A, in A's pane ----
  const promptAt = Date.now()
  await rig.type(A, 'Pergunte no canal da mesa qual é a capital da França e me diga a resposta.')
  note('the person typed the request in A')

  // ---- 2. observe up to 120 s, then 30 s of total silence ----
  let lastActivity = promptAt
  let prev: Snap | undefined
  let sawStart = false
  let quietReached = false
  const deadline = promptAt + OBSERVE_MS + SILENCE_MS
  while (Date.now() < deadline) {
    await sleep(1_500)
    const now = await snap()
    const turnsNow = [A, B, C].reduce((n, s) => n + (rig.turns.get(s)?.length ?? 0) - (baseTurns.get(s) ?? 0), 0)
    if (turnsNow > 0 || now.open.length) sawStart = true
    const delivered = { ...now.delivered }
    const changed = !prev
      ? true
      : now.lines !== prev.lines || JSON.stringify(delivered) !== JSON.stringify(prev.delivered)
    // The typed prompt itself changes A's deliveries on the first poll(s): that is activity too.
    if (changed || now.open.length) lastActivity = Date.now()
    prev = now
    if (sawStart && Date.now() - lastActivity >= SILENCE_MS) { quietReached = true; break }
  }
  const timeToSilenceS = Math.round((lastActivity - promptAt) / 100) / 10
  note(`silence ${quietReached ? 'REACHED' : 'NOT reached'}; last activity ${timeToSilenceS} s after the request (observed ${Math.round((Date.now() - promptAt) / 1000)} s)`)
  const finalSnap = await snap()

  // ---- 3. the numbers ----
  const hist = (await history()).filter((l) => l.seq > baseSeq)
  const falas = hist.filter((l) => l.kind === 'message')
  const byAuthor: Record<string, number> = {}
  for (const l of falas) byAuthor[fromLabel(l)] = (byAuthor[fromLabel(l)] ?? 0) + 1
  const turnsOf = (slot: string): number => (rig.turns.get(slot)?.length ?? 0) - (baseTurns.get(slot) ?? 0)
  const turnsPer = { A: turnsOf(A), B: turnsOf(B), C: turnsOf(C) }
  const states = await rig.states()
  const entriesOf = (slot: string): Entry[] => rig.entries(states.find((s) => s.slotId === slot)).slice(baseDeliveries.get(slot) ?? 0)
  const toA = entriesOf(A)
  const terminouToA = toA.filter((e) => /terminou/i.test(e.text))
  const trail = rig.assistantTrail(states.find((s) => s.slotId === A))
  const answeredParis = trail.some((x) => / SAYS /.test(x) && /Paris/i.test(x))
  const peerToPeer = falas.filter((l) => (fromLabel(l) === 'B' && (l.to ?? []).map(nameLabel).includes('C')) || (fromLabel(l) === 'C' && (l.to ?? []).map(nameLabel).includes('B')))
  note(`MEASURE lines in the channel per author: ${JSON.stringify(byAuthor)} (total ${falas.length}; other kinds: ${hist.length - falas.length})`)
  note(`MEASURE turns per pane since the request: ${JSON.stringify(turnsPer)}`)
  note(`MEASURE deliveries to B: ${entriesOf(B).length}, to C: ${entriesOf(C).length}, to A: ${toA.length} (of them "terminou": ${terminouToA.length})`)
  note(`MEASURE B<->C lines addressed to each other: ${peerToPeer.length}`)
  note(`MEASURE A said Paris in its own turn text: ${answeredParis}; panes still lit at the end: ${JSON.stringify(finalSnap.attention)}; open turns: ${JSON.stringify(finalSnap.open)}`)
  note(`MEASURE time until silence: ${timeToSilenceS} s`)

  // The exact sequence: lines of the channel, deliveries to each pane, turns of each pane, on one clock.
  const events: Array<{ at: number; what: string }> = [{ at: promptAt, what: 'PERSON types the request in A' }]
  for (const l of hist) events.push({ at: Date.parse(l.at), what: `LINE #${l.seq} ${l.kind} from ${fromLabel(l)}${l.to?.length ? ` to ${l.to.map(nameLabel).join(',')}` : ''}: ${l.body.replace(/\s+/g, ' ').slice(0, 220)}` })
  for (const slot of [A, B, C]) {
    for (const e of entriesOf(slot)) events.push({ at: e.at, what: `DELIVERY -> ${label(slot)} [${e.attrs ? `origin=${e.attrs.origin} kind=${e.attrs.kind} from=${e.attrs.from} role=${e.attrs.role} room=${e.attrs.room}` : 'typed'}] ${e.body.replace(/\s+/g, ' ').slice(0, 220)}` })
    for (const [i, tn] of (rig.turns.get(slot) ?? []).slice(baseTurns.get(slot) ?? 0).entries()) {
      events.push({ at: tn.start, what: `TURN ${i + 1} of ${label(slot)} START` })
      if (tn.end !== undefined) events.push({ at: tn.end, what: `TURN ${i + 1} of ${label(slot)} END` })
    }
  }
  events.sort((x, y) => x.at - y.at)
  const seq = events.map((e) => `${((e.at - promptAt) / 1000).toFixed(1).padStart(7)} s  ${e.what}`).join('\n')
  evidence('sequencia.txt', [`round ${ROUND}; silence ${quietReached ? 'reached' : 'NOT reached'}; time until silence ${timeToSilenceS} s`, '', seq, '', 'A assistant trail:', ...trail, ''].join('\n'))
  evidence('historico.json', JSON.stringify(await history(), null, 2) + '\n')
  evidence('entregas-A.txt', toA.map((e) => `${new Date(e.at).toISOString()} ${e.attrs ? `[origin=${e.attrs.origin} kind=${e.attrs.kind} from=${e.attrs.from} role=${e.attrs.role} room=${e.attrs.room}]` : '[typed]'} ${e.body.replace(/\s+/g, ' ')}`).join('\n') + '\n')
  note(`SEQUENCE:\n${seq}`)

  // ---- 4. assertions (the loop ones are `todo` when they fail: the loop is recorded, not fixed) ----
  const loopTodo = (failed: boolean, why: string): string | false => (failed ? `LOOP MEASURED (round ${ROUND}): ${why}` : false)
  await t.test('the system reaches total silence within the deadline', { todo: loopTodo(!quietReached, `no ${SILENCE_MS / 1000} s silence within ${(OBSERVE_MS + SILENCE_MS) / 1000} s; lines ${falas.length}, turns ${JSON.stringify(turnsPer)}`) }, () => {
    assert.ok(quietReached, `no silence of ${SILENCE_MS / 1000} s within ${(OBSERVE_MS + SILENCE_MS) / 1000} s; lines ${falas.length}; turns ${JSON.stringify(turnsPer)}`)
  })
  await t.test('A receives zero "terminou" of turns a channel line opened', () => {
    assert.deepEqual(terminouToA.map((e) => e.body), [], 'A was told "terminou" by a guia of its desk')
  })
  await t.test(`the desk channel carries few lines (ceiling ${LINES_CEILING})`, { todo: loopTodo(falas.length > LINES_CEILING, `${falas.length} lines in the channel ${JSON.stringify(byAuthor)}`) }, () => {
    assert.ok(falas.length <= LINES_CEILING, `${falas.length} lines in the channel ${JSON.stringify(byAuthor)}`)
  })
  assert.ok(!/uncaught/i.test(rig.daemonLog().split('\n').filter((l) => /channels|for-agents/.test(l)).join('\n')), 'the daemon log has no channels/for-agents uncaught error')
  const left = await rig.teardown()
  assert.deepEqual(left, [], 'no process left behind')
})
