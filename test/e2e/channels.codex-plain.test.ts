// E4c-plain: the case of the manual scene, WITHOUT crutches, for a REAL Codex (gpt-5.6-luna, low effort, `-a on-request -s read-only`) that is a member of a channel
// by the TERMINAL, in a PRIVATE tetherd (own home, pipe and pane host) with the real channels extension. Unlike channels.codex.test.ts no request tells the Codex which
// tool to use nor to "answer in the channel": the texts of the product itself (entry notice, merge "N falas novas", footer of each line) must be enough.
//   1 a plain line to everybody with the Codex idle ("qual é a capital da França?"): the Codex answers IN THE CHANNEL (a line of its own in the history)
//   2 a line addressed to the Codex
//   3 two lines sent while it is busy (they arrive as the merged notice "N falas novas"): it READS (by tool) and answers in the channel
// The owner (a shell slot running the CLI of `agents`) answers each MCP approval card by `agents answer yes`, never by typing as the person.
// For each proof the test records: answered in the channel; by MCP tool or by the CLI (and what the CLI gave back); time; the Codex screen at the end.
// Run alone: node --test test/e2e/channels.codex-plain.test.ts
// Env: E4P_RUN_ROOT (where homes live, default os tmpdir), E4P_EVIDENCE_DIR (evidence without keys; default a new folder under onda-3/e4c-plain).
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DaemonClient } from '../../src/daemon/client.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { HostClient } from '../../src/procd/client.ts'
import { claim, killOwned } from '../kill.ts'
import { Screen } from './harness.ts'
import { pidAlive } from './daemon-driver.ts'

const MAIN = resolve(import.meta.dirname, '../../src/daemon/main.ts')
const AGENT = resolve(import.meta.dirname, '../fixtures/channels/agent-live.cjs')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const runRoot = process.env.E4P_RUN_ROOT ?? tmpdir()
const evidenceDir = process.env.E4P_EVIDENCE_DIR ?? `C:/atrium/.tmp/tether-agents/onda-3/e4c-plain/run-${new Date().toISOString().replace(/[:.]/g, '-')}`
const WAIT_ANSWER_MS = 180_000

/** Evidence never carries a key: anything that looks like a secret token (32+ url-safe characters mixing letters and digits, once uuids and paths are set aside) is replaced. */
function sanitized(text: string): string {
  assert.ok(!/TETHER_(SLOT|MCP)_KEY/.test(text), 'evidence names a key variable')
  return text.replace(/([A-Za-z]:[\\/][^\s"']+)|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9_-]{32,}/g, (m, path: string | undefined) => {
    if (path || !/^(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}$/.test(m)) return m
    return `<redacted ${m.length} chars>`
  })
}
const evidence = (name: string, text: string): void => {
  mkdirSync(evidenceDir, { recursive: true })
  writeFileSync(join(evidenceDir, name), sanitized(text))
}

/** The environment of the test daemon (and so of its agents): no CLAUDE*, no CODEX_HOME, no TETHER_* and no NODE_TEST_CONTEXT of where this test runs; the fake `claude` first on the PATH. */
function cleanDaemonEnv(extra: Record<string, string>, shimDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^CLAUDE/i.test(k) || /^TETHER_/i.test(k) || k === 'CODEX_HOME' || k === 'NODE_TEST_CONTEXT') continue
    env[k] = v
  }
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  env[pathKey] = `${shimDir}${process.platform === 'win32' ? ';' : ':'}${env[pathKey] ?? ''}`
  return Object.assign(env, extra)
}

// The owner: a process in a shell slot. It runs each command of `cmd.jsonl` as `tether agents ...` (the slot's own environment is the proof of who calls).
function ownerScript(dir: string): string {
  return String.raw`
const fs = require('node:fs'), path = require('node:path')
const { spawnSync } = require('node:child_process')
const dir = ${JSON.stringify(dir)}
const cmdFile = path.join(dir, 'cmd.jsonl'), outFile = path.join(dir, 'out.jsonl'), toldFile = path.join(dir, 'told.log')
let offset = 0
process.stdout.write('OWNER READY\r\n')
if (process.stdin.setRawMode) process.stdin.setRawMode(true)
process.stdin.on('data', (d) => fs.appendFileSync(toldFile, d.toString().replace(/\r/g, '\n')))
setInterval(() => {
  let size = 0
  try { size = fs.statSync(cmdFile).size } catch { return }
  if (size <= offset) return
  const chunk = fs.readFileSync(cmdFile).subarray(offset, size).toString('utf8'); offset = size
  for (const line of chunk.split('\n').filter(Boolean)) {
    const { id, argv } = JSON.parse(line)
    const r = spawnSync(process.execPath, [process.env.TETHER_CLI, 'agents', ...argv, '--json'], { encoding: 'utf8', env: process.env, timeout: 120000 })
    fs.appendFileSync(outFile, JSON.stringify({ id, argv, status: r.status, stdout: r.stdout, stderr: r.stderr }) + '\n')
  }
}, 150)
`
}

interface Outcome { id: number; status: number | null; stdout: string; stderr: string }
interface Verb { ok: boolean; data: Record<string, any>; err: string }
interface HistLine { kind: string; seq: number; from: { id: string; name?: string }; body?: string; to?: string[] }
interface Sent { line: { seq: number }; receipts?: Record<string, string> }

class Rig {
  readonly root: string
  readonly home: string
  readonly work: string
  readonly shim: string
  readonly bench: string
  readonly pipe: string
  readonly ptydPipe: string
  client!: DaemonClient
  app!: DaemonClient
  readonly seen = new Set<number>()
  readonly screens = new Map<string, Screen>()
  private nextId = 1

  constructor() {
    mkdirSync(runRoot, { recursive: true })
    this.root = mkdtempSync(join(runRoot, 'tether-e4cp-'))
    this.home = join(this.root, 'home')
    this.work = join(this.root, 'owner')
    this.shim = join(this.root, 'shim')
    // The Codex bench is new and empty, outside the house, in the tmp dir.
    this.bench = mkdtempSync(join(tmpdir(), 'tether-e4cp-bench-'))
    mkdirSync(this.home); mkdirSync(this.work); mkdirSync(this.shim)
    const id = randomBytes(4).toString('hex')
    const BS = String.fromCharCode(92)
    const winPipe = (n: string): string => [BS, BS, '.', BS, 'pipe', BS, n].join('')
    this.pipe = process.platform === 'win32' ? winPipe(`tether-e4cp-${id}`) : join(this.home, 'd.sock')
    this.ptydPipe = process.platform === 'win32' ? winPipe(`tether-e4cp-ptyd-${id}`) : join(this.home, 'ptyd.sock')
  }

  async connect(): Promise<void> {
    if (process.platform === 'win32') writeFileSync(join(this.shim, 'claude.cmd'), `@echo off\r\n"${process.execPath}" "${AGENT}" %*\r\n`)
    else writeFileSync(join(this.shim, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${AGENT}" "$@"\n`, { mode: 0o755 })
    writeFileSync(join(this.home, 'settings.json'), JSON.stringify({ extensions: { disabled: ['web-bridge', 'browser', 'skills', 'conductor-claude', 'conductor-soul'] } }))
    const env = cleanDaemonEnv({ TETHER_PANEL_HOST: '1', TETHER_PTYD_PIPE: this.ptydPipe }, this.shim)
    this.client = await DaemonClient.connect({ home: this.home, pipe: this.pipe, client: 'test', mainPath: MAIN, env, startTimeoutMs: 45_000 })
    const pid = this.client.hello.pid
    this.seen.add(pid)
    await claim(pid, { cmdIncludes: MAIN, what: 'tetherd (channels codex plain)' })
    this.client.on('data', (slotId: string, data: string) => {
      const screen = this.screens.get(slotId) ?? new Screen(120, 40)
      this.screens.set(slotId, screen)
      screen.write(data)
    })
    this.app = await DaemonClient.open(this.pipe, 'app')
  }

  async states(): Promise<SlotState[]> { return (await this.client.request({ t: 'list' })).slots ?? [] }
  async state(slotId: string): Promise<SlotState | undefined> { return (await this.states()).find((s) => s.slotId === slotId) }
  daemonLog(): string { const p = join(this.home, 'tetherd.log'); return existsSync(p) ? readFileSync(p, 'utf8') : '' }
  screenOf(slotId: string): string { return this.screens.get(slotId)?.text() ?? '(no screen)' }

  async waitFor<T>(what: string, fn: () => Promise<T | undefined | false> | T | undefined | false, timeout = 90_000): Promise<T> {
    const deadline = Date.now() + timeout
    for (;;) {
      const v = await fn()
      if (v) return v
      if (Date.now() > deadline) throw new Error(`timeout (${timeout} ms) waiting for ${what}\n--- daemon log (tail) ---\n${this.daemonLog().slice(-2000)}`)
      await sleep(250)
    }
  }

  /** `tether agents <argv>` as the owner. */
  async verb(...argv: string[]): Promise<Verb> {
    const id = this.nextId++
    appendFileSync(join(this.work, 'cmd.jsonl'), JSON.stringify({ id, argv }) + '\n')
    const out = await this.waitFor(`the owner's outcome of agents ${argv[0]}`, () => this.outcomes().find((o) => o.id === id), 150_000)
    const parse = (s: string): Record<string, any> => { try { return JSON.parse(s) as Record<string, any> } catch { return {} } }
    return { ok: out.status === 0, data: parse(out.status === 0 ? out.stdout : out.stderr), err: out.stderr.trim() }
  }
  outcomes(): Outcome[] {
    const f = join(this.work, 'out.jsonl')
    return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Outcome) : []
  }
  told(): string { const f = join(this.work, 'told.log'); return existsSync(f) ? readFileSync(f, 'utf8') : '' }

  /** The person's side: a request of the channels extension, as the `app` client. */
  async ask<T = any>(name: string, args?: unknown): Promise<T> {
    return (await this.app.request({ t: 'ext-request', ext: 'channels', name, ...(args !== undefined ? { args } : {}) })).result as T
  }

  // ---- the fake agent (files under <home>/bench/<slot>.*): it only keeps the channel company, and is the "other member" ----
  private bfile(slot: string, ext: string): string { return join(this.home, 'bench', `${slot}.${ext}`) }
  async fakeAgent(name: string): Promise<string> {
    const cwd = join(this.work, 'fake')
    mkdirSync(cwd, { recursive: true })
    const slot = (await this.client.request({ t: 'create', kind: 'claude', cwd, name, start: true })).slot!.slotId
    await this.waitFor(`${slot} running with its stream`, async () => {
      const s = await this.state(slot)
      if (s?.pid) this.seen.add(s.pid)
      return s?.status === 'running' && existsSync(this.bfile(slot, 'ready'))
    }, 45_000)
    return slot
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
      const owned = await claim(pid, { what: 'channels codex plain e2e process' }).catch(() => undefined)
      if (owned) await killOwned(owned, { tree: true })
    }
    for (const end = Date.now() + 8_000; [...this.seen].some(pidAlive) && Date.now() < end; await sleep(150));
    const left = [...this.seen].filter(pidAlive).map(String)
    for (const dir of [this.bench, this.root]) {
      for (let i = 0; i < 5; i++) { try { rmSync(dir, { recursive: true, force: true }); break } catch { await sleep(300) } }
    }
    return left
  }
}

const rigs: Rig[] = []
after(async () => { for (const r of rigs) await r.teardown().catch(() => undefined) })

/** What the screen shows of HOW the Codex tried to talk to the channel, accumulated while polling (the screen scrolls). */
interface Means { mcpSay: boolean; mcpRead: boolean; cliTried: string[]; cliErrors: string[] }
const freshMeans = (): Means => ({ mcpSay: false, mcpRead: false, cliTried: [], cliErrors: [] })

interface Result { key: string; answered: boolean; viaMcp: boolean; triedCli: boolean; cliBack: string[]; viaRead: boolean; seconds: number; body?: string; cards: number }

/** The scenario is built once (the Codex boots slowly) and the three proofs run on it, in order. */
interface World {
  rig: Rig; pane: string; CH: string; NAME_C: string
  prove(key: string, run: () => Promise<Sent>, after: number, needs?: RegExp[]): Promise<Result>
  say(text: string, to?: string[]): Promise<Sent>
  settle(): Promise<void>
  isBusy(): Promise<boolean>
  handleCard(): Promise<boolean>
  results: Result[]
  cardOptions: string[][]
}
let world: World | undefined

async function build(note: (s: string) => void): Promise<World> {
  const rig = new Rig(); rigs.push(rig)
  await rig.connect()
  const NAME_F = 'claude · conferente'
  const NAME_C = 'codex · conferência'

  // ---- the owner: a shell slot running the script, owner of the desk "cena" and of itself ----
  const ownerFile = join(rig.root, 'owner.cjs')
  writeFileSync(ownerFile, ownerScript(rig.work))
  const owner = (await rig.client.request({ t: 'create', kind: 'shell', cwd: rig.work, name: 'dono', args: [process.execPath, ownerFile], start: true })).slot!.slotId
  await rig.waitFor('the owner runs', async () => { const s = await rig.state(owner); return s?.status === 'running' ? s : undefined })
  rig.seen.add((await rig.state(owner))!.pid!)
  const mapOf = (cena: string[], casa: string[]): unknown => {
    const desk = (id: string, panes: string[], kind: 'queue' | 'system' = 'queue') => ({ id, name: id, kind, panes: panes.map((p) => ({ id: p, type: 'terminal' })) })
    return { desks: [desk('cena', cena), desk('casa', casa), desk('sistema', [], 'system')], drawer: [] }
  }
  await rig.client.request({ t: 'desk-map', map: mapOf([], [owner]) } as never)
  const since = new Date().toISOString()
  for (const [kind, objectId] of [['desk', 'cena'], ['pane', owner]] as const) {
    await rig.client.request({ t: 'object-set', ext: 'for-agents', kind, objectId, key: 'owner', value: { owner, since, givenBy: 'user' } })
  }
  await rig.waitFor('the owner sees its desk', async () => {
    const v = await rig.verb('list')
    return v.ok && (v.data.desks as { id: string }[] | undefined)?.some((d) => d.id === 'cena') ? v : undefined
  }, 60_000)

  // ---- the Codex, opened by the owner (so its pane is commanded), as channels.codex.test.ts opens it ----
  assert.equal(readdirSync(rig.bench).length, 0, 'the bench is empty')
  const opened = await rig.verb('open', 'codex', rig.bench, '--model', 'gpt-5.6-luna', '--effort', 'low', '--name', NAME_C, '--json', JSON.stringify({ args: ['-a', 'on-request', '-s', 'read-only'] }))
  assert.ok(opened.ok, `open: ${opened.err}`)
  const pane = String(opened.data.pane)
  rig.seen.add((await rig.waitFor('the pane has a pid', async () => (await rig.state(pane))?.pid ? await rig.state(pane) : undefined))!.pid!)
  await rig.client.request({ t: 'desk-map', map: mapOf([pane], [owner]) } as never)
  await rig.client.request({ t: 'attach', slotId: pane, cols: 120, rows: 40 })

  let means = freshMeans()
  const results: Result[] = []
  const cardOptions: string[][] = []
  let cards = 0
  let cardsInProof = 0
  let lastAnswerAt = 0

  /** Accumulate, from the visible screen, how the Codex tried to reach the channel. The footer of a line mentions the CLI, so only a command it RAN counts. */
  const observe = (): void => {
    const screen = rig.screenOf(pane)
    if (/Called tether\.channels_say/.test(screen)) means.mcpSay = true
    if (/Called tether\.channels_read/.test(screen)) means.mcpRead = true
    for (const row of screen.split('\n')) {
      const r = row.trim()
      if (/\b(Ran|Running)\b.*TETHER_CLI/.test(r) && !means.cliTried.includes(r)) means.cliTried.push(r)
      if (/EPERM|operation not permitted|Acesso negado|access is denied|sandbox/i.test(r) && !means.cliErrors.includes(r)) means.cliErrors.push(r)
    }
  }

  const handleCard = async (): Promise<boolean> => {
    observe()
    const v = await rig.verb('read-screen', pane)
    if (!v.ok || v.data.state !== 'permission') return false
    cards++; cardsInProof++
    const card = String(v.data.text ?? rig.screenOf(pane))
    const options = card.split('\n').map((l) => l.trim()).filter((l) => /^[›>]?\s*\d+\.\s/.test(l))
    cardOptions.push(options)
    evidence(`card-${cards}-screen.txt`, `conductor read-screen state: ${v.data.state}\noptions: ${JSON.stringify(options)}\n${card}\n`)
    // E4C_PLAIN_ANSWER=session picks option 2 ("Allow for this session") by number: `agents answer` has no named choice for it.
    // Never option 3 ("Always allow"): it may write to the user's real Codex configuration.
    const choice = process.env.E4C_PLAIN_ANSWER === 'session' ? '2' : 'yes'
    const tool = /tool "([^"]+)"/.exec(card)?.[1] ?? 'unknown'
    const ans = await rig.verb('answer', pane, choice)
    lastAnswerAt = Date.now()
    note(`card #${cards} (tool ${tool}) answered by the owner (agents answer ${choice}): ok ${ans.ok}; options ${JSON.stringify(options)}`)
    if (!ans.ok) throw new Error(`agents answer ${choice} failed: ${ans.err}`)
    await sleep(1000)
    return true
  }

  const isBusy = async (): Promise<boolean> => (await rig.verb('read-screen', pane)).data.state !== 'idle'

  /** Idle (the conductor's `idle`), quiet for a while and 11 s after the last card answer: the door types only after the user side is silent. */
  const settle = async (): Promise<void> => {
    let quietSince = 0
    await rig.waitFor('the Codex idle and quiet', async () => {
      if (await handleCard()) { quietSince = 0; return undefined }
      const v = await rig.verb('read-screen', pane)
      if (v.data.state !== 'idle') { quietSince = 0; return undefined }
      quietSince ||= Date.now()
      return Date.now() - quietSince >= 5_000 && Date.now() - lastAnswerAt >= 11_000
    }, 180_000).catch((e: Error) => { throw new Error(`${e.message}\n--- the pane's screen ---\n${rig.screenOf(pane)}`) })
  }

  await settle()
  note(`codex ${pane} booted and idle`)

  // ---- the other member (the fake) and the channel; the person joins both. The Codex gets the entry notice by the terminal ----
  const F = await rig.fakeAgent(NAME_F)
  const { channel } = await rig.ask('create', { name: 'conferencia', title: 'Conferência de teste' })
  const CH: string = channel.id
  await rig.ask('join', { channel: CH, agent: F })
  const joined = await rig.ask('join', { channel: CH, agent: pane })
  const members = await rig.ask('members', { channel: CH })
  note(`joined: ${JSON.stringify(joined)}; members ${JSON.stringify(members.members.map((m: { name: string; path: string }) => ({ name: m.name, path: m.path })))}`)
  await rig.waitFor('the entry notice on the Codex screen', async () => {
    await handleCard()
    return rig.screenOf(pane).replace(/\s+/g, '').includes('vocêentrouem#conferencia')
  }, 120_000).catch(() => note('the entry notice was not seen on the screen'))
  await settle()
  evidence('0-entry-screen.txt', `${rig.screenOf(pane)}\n`)
  note('entry notice handled; Codex idle again')

  const codexLines = async (): Promise<HistLine[]> => {
    const hist = await rig.ask('history', { channel: CH })
    return (hist.lines as HistLine[]).filter((l) => l.kind === 'message' && l.from.id === pane)
  }

  return {
    rig, pane, CH, NAME_C, results, cardOptions, isBusy, handleCard, settle,
    say: (text, to) => rig.ask<Sent>('say', { channel: CH, text, ...(to ? { to } : {}) }),
    /** Wait for a line of the Codex in the channel with seq > after; record how it tried and the screen. `run` sends the lines. */
    async prove(key, run, after, needs) {
      means = freshMeans(); cardsInProof = 0
      const t0 = Date.now()
      const sent = await run()
      note(`(${key}) sent; last seq ${sent.line.seq}; receipts ${JSON.stringify(sent.receipts)}`)
      const line = await rig.waitFor(`(${key}) a line of the Codex in the channel`, async () => {
        await handleCard()
        const lines = await codexLines()
        const mine = lines.filter((l) => l.seq > Math.max(after, sent.line.seq))
        if (!needs) return mine[0]
        // The answer must carry what only the merged lines asked: the lines after the last one, together, hold every needle.
        const all = mine.map((l) => l.body ?? '').join('\n')
        return needs.every((re) => re.test(all)) ? mine[mine.length - 1] : undefined
      }, WAIT_ANSWER_MS).catch(() => undefined)
      const seconds = Math.round((Date.now() - t0) / 1000)
      // The screen at the end (answer or failure) is kept: when it fails this is the screen at the moment of the failure.
      observe()
      evidence(`${key}-screen-at-end.txt`, `answered: ${!!line}; ${seconds}s\n${rig.screenOf(pane)}\n`)
      const screenNow = await rig.verb('read-screen', pane)
      evidence(`${key}-read-screen.txt`, `${JSON.stringify({ ok: screenNow.ok, state: screenNow.data.state })}\n${String(screenNow.data.text ?? '')}\n`)
      const r: Result = {
        key, answered: !!line, viaMcp: means.mcpSay, triedCli: means.cliTried.length > 0, cliBack: means.cliErrors, viaRead: means.mcpRead,
        seconds, body: line?.body, cards: cardsInProof,
      }
      results.push(r)
      note(`(${key}) answered in the channel: ${r.answered} (${seconds}s); mcp say ${means.mcpSay}, mcp read ${means.mcpRead}; CLI tried ${JSON.stringify(means.cliTried)}; CLI back ${JSON.stringify(means.cliErrors)}; cards ${cardsInProof}; body ${JSON.stringify(line?.body)}`)
      evidence(`${key}-result.json`, JSON.stringify({ ...r, mcpRead: means.mcpRead, cliTried: means.cliTried }, null, 2) + '\n')
      await settle().catch(() => undefined)
      return r
    },
  }
}

const t00 = Date.now()
const note = (s: string): void => { const l = `[+${Math.round((Date.now() - t00) / 1000)}s] ${s}`; console.log(`# ${l}`); try { mkdirSync(evidenceDir, { recursive: true }); appendFileSync(join(evidenceDir, 'log.txt'), sanitized(`${l}\n`)) } catch { /* evidence is best effort */ } }

test('E4c-plain: setup (a real Codex by the terminal in a channel)', { timeout: 900_000 }, async () => {
  world = await build(note)
})

test('E4c-plain 1: a plain line to everybody with the Codex idle is answered IN THE CHANNEL', { timeout: 600_000 }, async () => {
  assert.ok(world, 'the setup ran')
  const w = world
  const r = await w.prove('1', () => w.say('Qual é a capital da França?'), 0)
  assert.equal(r.answered, true, `the Codex did not answer in the channel: ${JSON.stringify(r)} (evidence in ${evidenceDir})`)
})

test('E4c-plain 2: a line addressed to the Codex is answered IN THE CHANNEL', { timeout: 600_000 }, async () => {
  assert.ok(world, 'the setup ran')
  const w = world
  const r = await w.prove('2', () => w.say('Qual é o nome deste canal?', [w.NAME_C]), 0)
  assert.equal(r.answered, true, `the Codex did not answer in the channel: ${JSON.stringify(r)} (evidence in ${evidenceDir})`)
})

test('E4c-plain 3: two lines sent while it is busy arrive merged; it READS by tool and answers in the channel', { timeout: 900_000 }, async () => {
  assert.ok(world, 'the setup ran')
  const w = world
  let busyAt = false
  const r = await w.prove('3', async () => {
    // The first line gives the Codex something long to do (no tool is named); while it is busy, two more lines come in.
    await w.say('Liste 30 países europeus com a capital de cada um, um por linha, e comente em uma frase a história de cada capital.')
    for (const end = Date.now() + 40_000; !busyAt && Date.now() < end; await sleep(300)) busyAt = await w.isBusy()
    note(`(3) busy when the two lines are sent: ${busyAt}`)
    await w.say('Segunda fala: quanto é 17 vezes 23?')
    return w.say('Terceira fala: qual é a capital do Japão?')
  }, 0, [/391/, /T[óo]quio|Tokyo/i])
  evidence('3-busy.txt', `busy when the two lines were sent: ${busyAt}\n`)
  assert.equal(r.answered, true, `the Codex did not answer in the channel what the merged lines asked (391 and Tóquio): ${JSON.stringify(r)} (evidence in ${evidenceDir})`)
  assert.equal(r.viaRead, true, `the Codex did not read the merged lines by the tool channels_read: ${JSON.stringify(r)}`)
})

test('E4c-plain: summary and teardown', { timeout: 300_000 }, async () => {
  assert.ok(world, 'the setup ran')
  const w = world
  evidence('summary.json', JSON.stringify({ results: w.results, cardOptions: w.cardOptions, cards: w.cardOptions.length }, null, 2) + '\n')
  evidence('history.json', JSON.stringify((await w.rig.ask('history', { channel: w.CH })).lines, null, 2) + '\n')
  evidence('daemon-log.txt', w.rig.daemonLog())
  evidence('owner-told.txt', w.rig.told())
  note(`cards seen: ${w.cardOptions.length}; options of each: ${JSON.stringify(w.cardOptions)}`)
  const left = await w.rig.teardown()
  assert.deepEqual(left, [], 'no process left behind')
})
