// E2 with TWO real Claude Code (haiku): a poll asked by one agent reaches the other as a request, is answered by a vote and not
// by speech, and its author gets ONE result.
// PRIVATE tetherd (own home, pipe and pane host), channels on, for-agents off. Each Claude in a bench folder new and empty, outside
// the house. The person creates a channel with both and asks the author to get the member's ok by a poll.
// ASSERTIONS: the author opened a poll; the member got exactly one `kind="request"` (with `poll`, `options`, `closes`); it said
// nothing in the channel from the poll's opening until well after the close; the author got exactly one result (`closed_by`).
// MEASURED (todo when not): the member voted and its vote closed the poll (the model may refuse to vote in the person's name).
// SEEN (24/11, 5 runs): the mechanics held every time; in 3 of them the haiku member took the person's line addressed to the
// author as its own (it does not know its own name in the room), opened a poll that called the author, and `vote-first` then
// barred the author's poll as designed: the run times out at "the author opens a poll". The identity is the open question.
// Run alone: node --test test/e2e/channels.polls.claude.test.ts
// Env: PCL_EVIDENCE_DIR (keeps the sequence and the assistant trails, without keys; default none).
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const AUTHOR = 'claude · regente'
const MEMBER = 'claude · conferente'
const evidenceDir = process.env.PCL_EVIDENCE_DIR
if (evidenceDir) mkdirSync(evidenceDir, { recursive: true })
const TOOLS = ['say', 'read', 'list', 'poll', 'vote', 'poll_close'].map((v) => `mcp__tether__channels_${v}`).join(',')

function cleanDaemonEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^CLAUDE/i.test(k) || /^TETHER_/i.test(k) || k === 'NODE_TEST_CONTEXT') continue
    env[k] = v
  }
  return Object.assign(env, extra)
}

interface Entry { attrs: Record<string, string>; body: string }
interface RecLine { seq: number; kind: string; from: { id: string; name: string }; body: string; vote?: { poll: number; option: number }; event?: { type: string }; result?: { by: string; poll: number } }

class Rig {
  readonly root = mkdtempSync(join(tmpdir(), 'tether-pcl-'))
  readonly home = join(this.root, 'home')
  readonly pipe: string
  readonly ptydPipe: string
  readonly benches: string[] = []
  bornAt = 0
  client!: DaemonClient
  app!: DaemonClient
  readonly seen = new Set<number>()

  constructor() {
    mkdirSync(this.home)
    const id = randomBytes(4).toString('hex')
    const BS = String.fromCharCode(92)
    const winPipe = (n: string): string => [BS, BS, '.', BS, 'pipe', BS, n].join('')
    this.pipe = process.platform === 'win32' ? winPipe(`tether-pcl-${id}`) : join(this.home, 'd.sock')
    this.ptydPipe = process.platform === 'win32' ? winPipe(`tether-pcl-ptyd-${id}`) : join(this.home, 'ptyd.sock')
  }

  async connect(): Promise<void> {
    writeFileSync(join(this.home, 'settings.json'), JSON.stringify({ extensions: { disabled: ['web-bridge', 'browser', 'skills', 'for-agents'] } }))
    const env = cleanDaemonEnv({ TETHER_PANEL_HOST: '1', TETHER_PTYD_PIPE: this.ptydPipe })
    this.client = await DaemonClient.connect({ home: this.home, pipe: this.pipe, client: 'test', mainPath: MAIN, env, startTimeoutMs: 45_000 })
    this.seen.add(this.client.hello.pid)
    await claim(this.client.hello.pid, { cmdIncludes: MAIN, what: 'tetherd (channels polls claude)' })
    this.app = await DaemonClient.open(this.pipe, 'app', { home: this.home })
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
      await sleep(1_000)
    }
  }

  async claude(name: string): Promise<string> {
    const bench = mkdtempSync(join(tmpdir(), 'tether-pcl-bench-'))
    this.benches.push(bench)
    const slot = (await this.client.request({ t: 'create', kind: 'claude', cwd: bench, name, args: ['--model', 'haiku', '--allowedTools', TOOLS] })).slot!.slotId
    this.bornAt = Date.now()
    await openSlot(this.client, slot)
    const st = await this.state(slot)
    if (st?.pid) this.seen.add(st.pid)
    return slot
  }

  async ask<T = any>(name: string, args?: unknown): Promise<T> {
    return (await this.app.request({ t: 'ext-request', ext: 'channels', name, ...(args !== undefined ? { args } : {}) })).result as T
  }

  /** Every line of the channel's record, poll lines and votes included (the moderator's history leaves those out). */
  record(channelId: string): RecLine[] {
    const dir = join(this.home, 'channels', channelId)
    if (!existsSync(dir)) return []
    return readdirSync(dir).filter((f) => /^\d{6}\.jsonl$/.test(f)).sort()
      .flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as RecLine))
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
      let j: { message?: { content?: unknown } }
      try { j = JSON.parse(line) as typeof j } catch { continue }
      const c = j.message?.content
      const text = typeof c === 'string' ? c : Array.isArray(c) ? (c as Array<{ type?: string; text?: string }>).filter((x) => x.type === 'text').map((x) => x.text ?? '').join('\n') : ''
      for (const m of text.matchAll(/<channel source="tether"([^>]*)>([\s\S]*?)<\/channel>/g)) {
        const attrs: Record<string, string> = {}
        for (const a of m[1]!.matchAll(/(\w+)="([^"]*)"/g)) attrs[a[1]!] = a[2]!
        out.push({ attrs, body: m[2]!.trim() })
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
      const owned = await claim(pid, { what: 'channels polls claude process' }).catch(() => undefined)
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

test('two real Claudes: the author asks by a poll, the member votes without speaking, the author gets one result', { timeout: 570_000 }, async (t) => {
  const rig = new Rig(); rigs.push(rig)
  const log: string[] = []
  const note = (s: string): void => { log.push(s); t.diagnostic(s); console.log(`# ${s}`) }
  await rig.connect()
  const A = await rig.claude(AUTHOR)
  const B = await rig.claude(MEMBER)
  note(`claudes open: author ${A}, member ${B}`)

  const { channel } = await rig.ask('create', { name: 'ata', title: 'Ata' })
  const CH = channel.id as string
  await rig.ask('join', { channel: CH, agent: A })
  await rig.ask('join', { channel: CH, agent: B })
  /** Still: no open turn in either for 8 s. */
  const settle = async (cap = 120_000): Promise<void> => {
    let since = Date.now()
    for (const end = Date.now() + cap; Date.now() < end && Date.now() - since < 8_000; await sleep(1_000)) {
      if ((await rig.states()).some((s) => (s.slotId === A || s.slotId === B) && s.turn === 'busy')) since = Date.now()
    }
  }
  await settle()

  // The person asks the author to get the member's ok by a poll.
  await rig.ask('say', { channel: CH, to: [AUTHOR], text: 'Regente, preciso do ok do conferente para subir a ata. Abra você uma enquete neste canal com prazo de 3 minutos e me diga aqui o resultado quando ele chegar. Conferente, a ata é curta e eu a aprovo: "24/11, três decisões, nenhuma pendência". Não abra enquete: espere a do regente e responda a ela.' })
  /** On a failure: what each pane's screen shows and what the door logged, for the evidence. */
  const diagnose = async (): Promise<void> => {
    for (const [who, s] of [['author', A], ['member', B]] as const) {
      const r = await rig.client.request({ t: 'read-screen', slotId: s } as never).catch(() => undefined) as { screen?: { data: string } } | undefined
      // Spaces are kept (only the control sequences go); the tail is read as the pane shows it.
      const text = (r?.screen?.data ?? JSON.stringify(r ?? {})).replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '')
      note(`${who} screen (tail): ${text.slice(-2500)}`)
      const st = await rig.state(s)
      note(`${who} channel tags: ${JSON.stringify(rig.entries(st))}`)
      note(`${who} trail:\n${rig.trail(st).join('\n')}`)
    }
    note(`daemon log (door):\n${rig.daemonLog().split('\n').filter((l) => /entrega|canais|door/.test(l)).slice(-40).join('\n')}`)
    if (evidenceDir) writeFileSync(join(evidenceDir, 'enquete-claude.txt'), log.join('\n') + '\n')
  }
  const personLine = (e: Entry): boolean => /ok do conferente para subir a ata/.test(e.body)
  const delivered = async (): Promise<boolean> => rig.entries(await rig.state(A)).some(personLine)
  // Wait for the poll, or for the author to have heard the person and gone idle without opening one (the model's refusal).
  let idleSince = 0
  const outcome = await rig.waitFor('the author opens a poll or refuses', async () => {
    const p = rig.record(CH).find((l) => l.kind === 'poll' && l.from.id === A)
    if (p) return { poll: p }
    const st = await rig.state(A)
    if (st?.turn === 'busy' || !(await delivered())) { idleSince = 0; return undefined }
    idleSince ||= Date.now()
    if (Date.now() - idleSince >= 30_000) return { refused: true as const }
    return undefined
  }, 180_000).catch(async (e) => { await diagnose(); throw e })
  // HARD: the person's line reached the author inside (the tag is written by the tether).
  const heard = rig.entries(await rig.state(A)).filter(personLine)
  if (!('poll' in outcome)) await diagnose()
  assert.ok(heard.length >= 1, 'the person\'s line was delivered to the author')
  note(`author heard the person: ${JSON.stringify(heard.map((e) => e.attrs))}`)
  if (!('poll' in outcome)) {
    const said = rig.trail(await rig.state(A)).filter((l) => l.startsWith('SAYS')).slice(-1)[0] ?? '(nothing)'
    // MEASURED: opening the poll is the model's judgment; the delivery above is asserted.
    await t.test('the author opened the poll', { todo: `author did not open it; it said: ${said}` }, () => { assert.fail('the author did not open a poll') })
    const left0 = await rig.teardown()
    assert.deepEqual(left0, [], 'no process left behind')
    return
  }
  const poll = outcome.poll!
  note(`poll #${poll.seq} opened by the author`)
  const closed = await rig.waitFor('the poll closes', () => rig.record(CH).find((l) => l.kind === 'notice' && l.event?.type === 'poll-close' && l.result?.poll === poll.seq), 240_000).catch(async (e) => { await diagnose(); throw e })
  if (closed.result?.by !== 'all-voted') await diagnose()
  note(`closed #${closed.seq}: ${closed.result?.by} · ${closed.body.replace(/\n/g, ' / ')}`)
  await settle()
  await sleep(20_000)
  await settle()

  const rec = rig.record(CH)
  const votes = rec.filter((l) => l.kind === 'vote' && l.from.id === B && l.vote?.poll === poll.seq)
  const memberSpoke = rec.filter((l) => l.kind === 'message' && l.from.id === B && l.seq > poll.seq)
  const bEntries = rig.entries(await rig.state(B))
  const aEntries = rig.entries(await rig.state(A))
  const requests = bEntries.filter((e) => e.attrs.kind === 'request' && e.attrs.ref === `ata#${poll.seq}`)
  const results = aEntries.filter((e) => e.attrs.closed_by !== undefined && e.attrs.poll === `ata#${poll.seq}`)
  const otherPolls = rec.filter((l) => l.kind === 'poll' && l.seq !== poll.seq).map((l) => `#${l.seq} by ${l.from.name}`)
  note(`other polls in the channel: ${JSON.stringify(otherPolls)}`)
  note(`member got: ${JSON.stringify(requests)} (of ${bEntries.length} channel tags: ${JSON.stringify(bEntries.map((e) => e.attrs.kind))})`)
  note(`member state: ${JSON.stringify(await rig.state(B))}`)
  note(`daemon log (delivery):\n${rig.daemonLog().split('\n').filter((l) => /entrega|canais|door: slot/.test(l)).slice(-40).join('\n')}`)
  note(`author got results: ${JSON.stringify(results)}`)
  note(`member spoke after the poll: ${JSON.stringify(memberSpoke.map((l) => l.body))}`)
  note(`member trail:\n${rig.trail(await rig.state(B)).join('\n')}`)
  note(`author trail:\n${rig.trail(await rig.state(A)).join('\n')}`)
  if (evidenceDir) writeFileSync(join(evidenceDir, 'enquete-claude.txt'), log.join('\n') + '\n')

  assert.equal(requests.length, 1, 'the member got ONE request')
  assert.match(requests[0]!.attrs.poll ?? '', /^(ok|choice)$/, 'the type (the author may write ok / não ok as options: a choice)')
  assert.equal(requests[0]!.attrs.ref, `ata#${poll.seq}`)
  assert.ok(requests[0]!.attrs.options && requests[0]!.attrs.closes, 'options and closes are attributes')
  // MEASURED (todo when not): whether the member chose to vote is the model's judgment (haiku has refused, saying the vote goes
  // out in the person's name); the mechanics above and below are asserted.
  await t.test('the member voted and its vote closed the poll', { todo: votes.length && closed.result?.by === 'all-voted' ? false : `not voted (closed by ${closed.result?.by})` }, () => {
    assert.ok(votes.length >= 1)
    assert.equal(closed.result?.by, 'all-voted')
  })
  assert.deepEqual(memberSpoke.map((l) => l.body), [], 'the member voted WITHOUT speaking in the channel')
  assert.equal(results.length, 1, 'the author got ONE result')
  assert.equal(results[0]!.attrs.poll, `ata#${poll.seq}`)
  assert.equal(aEntries.filter((e) => e.attrs.kind === 'request' && e.attrs.ref === `ata#${poll.seq}`).length, 0, 'the author is not asked its own poll')
  const left = await rig.teardown()
  assert.deepEqual(left, [], 'no process left behind')
})
