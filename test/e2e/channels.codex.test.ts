// E4c: a REAL Codex (gpt-5.6-luna, low effort) as a member of a channel, in a PRIVATE tetherd (own home, pipe and pane host) with the real
// channels extension. The Codex pane is opened by an owner (a shell slot running the CLI of `agents`), so it is commanded: the lines reach it
// by the TERMINAL (the conductor's `send`, which checks the screen and repeats Enter). The other member is the fake agent
// (test/fixtures/channels/agent-live.cjs, no LLM) as a `claude` slot with an open stream: a line to it goes INSIDE. The person (the moderator)
// is one `app` client of the test. The verdict of a delivery comes from the SCREEN of the Codex pane (the daemon's turn mark lies when a line
// is stuck in the box) and from the receipt.
//   1 the entry notice and a LONG line (~300 chars, accents and the middle dot) are SUBMITTED (they become turns), no manual Enter
//   2 the header of the line arrives whole on the screen
//   3 Codex answers by `channels_say` (or the CLI of the notice) and the answer reaches the fake agent (a FINDING when it cannot)
//   4 a line to a member that hears inside (the fake agent): nothing typed in its terminal, nothing lost
// E4C_APPROVAL=on-request: the Codex raises an approval card for each MCP tool call; the test answers it AS THE OWNER (`agents answer yes`, found by the
// conductor's read-screen state `permission`), never as the person typing (that would take the pane back). Lines sent while the Codex is busy become, by
// design (C5: one pending delivery per member and channel), the line itself or the digest `N falas novas`; the header is proved on a short line to the idle Codex.
// Run alone: node --test test/e2e/channels.codex.test.ts
// Env: E4C_RUN_ROOT (where homes live, default os tmpdir), E4C_EVIDENCE_DIR (evidence without keys; default a new folder under onda-3/e4c).
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

const runRoot = process.env.E4C_RUN_ROOT ?? tmpdir()
const evidenceDir = process.env.E4C_EVIDENCE_DIR ?? `C:/atrium/.tmp/tether-agents/onda-3/e4c/run-${new Date().toISOString().replace(/[:.]/g, '-')}`
mkdirSync(evidenceDir, { recursive: true })

/** Evidence never carries a key: anything that looks like a secret token (32+ url-safe characters mixing letters and digits, once uuids and paths are set aside) is replaced. */
function sanitized(text: string): string {
  assert.ok(!/TETHER_(SLOT|MCP)_KEY/.test(text), 'evidence names a key variable')
  return text.replace(/([A-Za-z]:[\\/][^\s"']+)|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9_-]{32,}/g, (m, path: string | undefined) => {
    if (path || !/^(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}$/.test(m)) return m
    return `<redacted ${m.length} chars>`
  })
}
const evidence = (name: string, text: string): void => { writeFileSync(join(evidenceDir, name), sanitized(text)) }

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
interface Note { method?: string; params?: { content: string; meta: Record<string, string> } }

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
    this.root = mkdtempSync(join(runRoot, 'tether-e4c-'))
    this.home = join(this.root, 'home')
    this.work = join(this.root, 'owner')
    this.shim = join(this.root, 'shim')
    // The Codex bench is new and empty, outside the house, in the tmp dir.
    this.bench = mkdtempSync(join(tmpdir(), 'tether-e4c-bench-'))
    mkdirSync(this.home); mkdirSync(this.work); mkdirSync(this.shim)
    const id = randomBytes(4).toString('hex')
    const BS = String.fromCharCode(92)
    const winPipe = (n: string): string => [BS, BS, '.', BS, 'pipe', BS, n].join('')
    this.pipe = process.platform === 'win32' ? winPipe(`tether-e4c-${id}`) : join(this.home, 'd.sock')
    this.ptydPipe = process.platform === 'win32' ? winPipe(`tether-e4c-ptyd-${id}`) : join(this.home, 'ptyd.sock')
  }

  async connect(): Promise<void> {
    // `claude` on the PATH of the daemon is the fake agent (the real adapter resolves it and starts it in a real pane).
    if (process.platform === 'win32') writeFileSync(join(this.shim, 'claude.cmd'), `@echo off\r\n"${process.execPath}" "${AGENT}" %*\r\n`)
    else writeFileSync(join(this.shim, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${AGENT}" "$@"\n`, { mode: 0o755 })
    // The extensions with side effects of their own (a bridge daemon, a browser, skills) are off; for-agents stays: the owner needs it.
    writeFileSync(join(this.home, 'settings.json'), JSON.stringify({ extensions: { disabled: ['web-bridge', 'browser', 'skills', 'conductor-claude', 'conductor-soul'] } }))
    const env = cleanDaemonEnv({ TETHER_PANEL_HOST: '1', TETHER_PTYD_PIPE: this.ptydPipe }, this.shim)
    this.client = await DaemonClient.connect({ home: this.home, pipe: this.pipe, client: 'test', mainPath: MAIN, env, startTimeoutMs: 45_000 })
    const pid = this.client.hello.pid
    this.seen.add(pid)
    await claim(pid, { cmdIncludes: MAIN, what: 'tetherd (channels codex)' })
    this.client.on('data', (slotId: string, data: string) => {
      const screen = this.screens.get(slotId) ?? new Screen(120, 40)
      this.screens.set(slotId, screen)
      screen.write(data)
    })
    this.app = await DaemonClient.open(this.pipe, 'app', { home: this.home })
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

  /** The person's side: a request of the channels extension, as the `app` client. */
  async ask<T = any>(name: string, args?: unknown): Promise<T> {
    return (await this.app.request({ t: 'ext-request', ext: 'channels', name, ...(args !== undefined ? { args } : {}) })).result as T
  }

  // ---- the fake agent (files under <home>/bench/<slot>.*) ----
  private bfile(slot: string, ext: string): string { return join(this.home, 'bench', `${slot}.${ext}`) }
  private lines<T>(slot: string, ext: string): T[] {
    const f = this.bfile(slot, ext)
    return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as T) : []
  }
  /** The channel notifications the fake got through its stream. */
  notes(slot: string): Array<{ content: string; meta: Record<string, string> }> {
    return this.lines<Note>(slot, 'chan.jsonl').filter((n) => n.method === 'notifications/claude/channel').map((n) => n.params!)
  }
  /** What was typed into the fake's terminal. */
  typedInto(slot: string): string { return this.lines<string>(slot, 'stdin.jsonl').join('') }
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
  /** The MCP tool `channels_<verb>`, called by the fake on the `tether` server it opened. */
  async fakeMcp(slot: string, verb: string, args: Record<string, unknown>): Promise<Record<string, any>> {
    const id = this.nextId++
    mkdirSync(join(this.home, 'bench'), { recursive: true })
    appendFileSync(this.bfile(slot, 'cmd.jsonl'), JSON.stringify({ id, via: 'mcp', tool: `channels_${verb}`, arguments: args }) + '\n')
    return this.waitFor(`the fake's outcome ${id}`, () => this.lines<{ id: number }>(slot, 'out.jsonl').find((o) => o.id === id), 60_000) as Promise<Record<string, any>>
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
      const owned = await claim(pid, { what: 'channels codex e2e process' }).catch(() => undefined)
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

const squash = (s: string): string => s.replace(/\s+/g, '')

/**
 * What a delivery became, read from the Codex screen: SUBMITTED when the agent's own output (a `•` row or `Worked for`) sits below the row
 * that carries the tag, STUCK when the tag is on the screen with nothing of the agent's after it, GONE when the tag is not on it.
 */
function verdictOf(screen: string, tag: string): 'submitted' | 'stuck' | 'gone' {
  const rows = screen.split('\n')
  const at = rows.findIndex((r) => r.includes(tag))
  if (at < 0) return 'gone'
  return rows.slice(at + 1).some((r) => /Worked for|^\s*[•●]\s/.test(r)) ? 'submitted' : 'stuck'
}

/** The approval policy of the bench Codex. `never` (default): the MCP tool call is refused (prova 3 becomes a finding). `on-request`: the call raises a card the test approves once. */
const APPROVAL = process.env.E4C_APPROVAL ?? 'never'
assert.ok(APPROVAL === 'on-request' || APPROVAL === 'never', 'E4C_APPROVAL is on-request or never')

const FILL ='Conferência · revisão do relatório, ação pendente, atenção às coerências e às sessões já concluídas; ainda não há nenhum impedimento, só observações. '

test('E4c: a real Codex in a channel by the terminal: entry notice and a long line submitted, header whole, answer by channels_say, a line inside', { timeout: 1_200_000 }, async (t) => {
  const rig = new Rig(); rigs.push(rig)
  const t0 = Date.now()
  const log: string[] = []
  const findings: string[] = []
  const note = (s: string): void => { const l = `[+${Math.round((Date.now() - t0) / 1000)}s] ${s}`; log.push(l); t.diagnostic(l); console.log(`# ${l}`) }
  const finding = (s: string): void => { findings.push(s); note(`FINDING: ${s}`) }
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

  // ---- the Codex, opened by the owner (so its pane is commanded) ----
  assert.equal(readdirSync(rig.bench).length, 0, 'the bench is empty')
  const opened = await rig.verb('open', 'codex', rig.bench, '--model', 'gpt-5.6-luna', '--effort', 'low', '--name', NAME_C, '--json', JSON.stringify({ args: ['-a', APPROVAL, '-s', 'read-only'] }))
  assert.ok(opened.ok, `open: ${opened.err}`)
  const pane = String(opened.data.pane)
  rig.seen.add((await rig.waitFor('the pane has a pid', async () => (await rig.state(pane))?.pid ? await rig.state(pane) : undefined))!.pid!)
  await rig.client.request({ t: 'desk-map', map: mapOf([pane], [owner]) } as never)
  await rig.client.request({ t: 'attach', slotId: pane, cols: 120, rows: 40 })
  const idle = async (timeout = 90_000): Promise<Verb> => rig.waitFor('the Codex at its prompt', async () => {
    const v = await rig.verb('read-screen', pane)
    return v.ok && v.data.state === 'idle' ? v : undefined
  }, timeout)
  await idle().catch((e: Error) => { throw new Error(`${e.message}\n--- the pane's screen ---\n${rig.screenOf(pane)}`) })
  note(`codex ${pane} booted and idle`)

  // ---- the other member: the fake agent with an open stream ----
  const F = await rig.fakeAgent(NAME_F)
  note(`fake agent ${F} up`)

  // ---- the channel; the person joins both (the entry notice reaches the Codex by the terminal) ----
  const { channel } = await rig.ask('create', { name: 'conferencia', title: 'Conferência de teste' })
  const CH: string = channel.id
  await rig.ask('join', { channel: CH, agent: F })
  const joined = await rig.ask('join', { channel: CH, agent: pane })
  note(`joined: ${JSON.stringify(joined)}`)
  const members = await rig.ask('members', { channel: CH })
  note(`members: ${JSON.stringify(members.members.map((m: { name: string; path: string; alive: boolean }) => ({ name: m.name, path: m.path, alive: m.alive })))}`)
  const pathOf = (id: string): string => members.members.find((m: { id: string }) => m.id === id)?.path

  // ---- 1a. the entry notice is SUBMITTED ----
  // An approval card on the Codex screen: the whole screen goes to the evidence; the first one is also the moment to watch what a new line does
  // while the card is up (observed, not asserted); then the card is answered `yes` (the narrowest reach: this one call).
  const cards: string[] = []
  let observed = false
  // The owner's own view of the pane: does it still command it (`hand: owner`) and by which delivery path?
  const handOf = async (): Promise<{ hand: unknown; path: unknown }> => {
    const v = await rig.verb('list')
    const panes = [...((v.data.desks as { panes: { id: string }[] }[] | undefined) ?? []).flatMap((d) => d.panes), ...((v.data.panes as { id: string }[] | undefined) ?? [])]
    const e = panes.find((p) => p.id === pane) as { hand?: unknown; path?: unknown } | undefined
    return { hand: e?.hand, path: e?.path }
  }
  const told = (): string => { const f = join(rig.work, 'told.log'); return existsSync(f) ? readFileSync(f, 'utf8') : '' }
  const askedRe = new RegExp(`pede permissão · guia ${pane}`, 'g')
  const heldChecks: Array<{ at: string; hand: unknown; path: unknown }> = []
  let queuedDuring: unknown
  // When the owner last answered a card: that renews the pane's typing clock, and the door types into the terminal only after
  // USER_QUIET_MS (10 s) of silence from the user side, so a line sent sooner is `queued` by design.
  let lastAnswerAt = 0
  let askNotices = 0
  // What the polling sees on the screen (a busy member gets, by design, at most ONE pending delivery per channel; the rest becomes
  // the digest notice `N falas novas`): a channel item typed AND turned into a turn, and whether the Codex read lines by `channels_read`.
  let channelTurn = ''
  let sawRead = false
  const observe = (): void => {
    const screen = rig.screenOf(pane)
    const flat = squash(screen)
    if (screen.includes('Called tether.channels_read')) sawRead = true
    if (channelTurn) return
    if (verdictOf(screen, 'falas novas desde') === 'submitted') channelTurn = 'digest "falas novas desde"'
    for (const tag of ['E4C01', 'E4C02']) if (flat.includes(`]${tag}`) && verdictOf(screen, tag) === 'submitted') channelTurn = `line with header (${tag})`
  }
  const handleCard = async (): Promise<boolean> => {
    observe()
    // The card is recognised by the conductor (read-screen state `permission`), never by the raw text.
    const v = await rig.verb('read-screen', pane)
    if (!v.ok || v.data.state !== 'permission') return false
    const n = cards.length + 1
    const card = String(v.data.text ?? rig.screenOf(pane))
    cards.push(card)
    evidence(`3-card-${n}-screen.txt`, `conductor read-screen state: ${v.data.state}\n${card}\n`)
    note(`card #${n} on the screen (3-card-${n}-screen.txt); conductor state ${v.data.state}`)
    // Did the owner get the "pede permissão" notice? (it is typed into the owner's terminal; the watch needs a moment)
    await sleep(2500)
    askNotices = (told().match(askedRe) ?? []).length
    note(`owner notices "pede permissão" so far: ${askNotices}`)
    if (!observed) {
      observed = true
      const during = await rig.ask('say', { channel: CH, text: 'E4C02 · fala nova com o cartão na tela' })
      queuedDuring = during.receipts?.[pane]
      await sleep(4000)
      const after = await rig.verb('read-screen', pane)
      const typedOnTop = String(after.data.text ?? '').includes('E4C02')
      note(`OBSERVE a new line with the card up: receipts ${JSON.stringify(during.receipts)}; E4C02 on the screen: ${typedOnTop}; state ${after.data.state}`)
      evidence('3-card-observe.txt', `receipts of the line sent with the card up: ${JSON.stringify(during.receipts)}\nE4C02 on the screen (typed over the card): ${typedOnTop}\nstate after 4 s: ${after.data.state}\n---\n${after.data.text}\n`)
    }
    // Answer AS THE OWNER of the pane (the verb `agents answer`), never as the person typing: that would take the pane back.
    lastAnswerAt = Date.now()
    const ans = await rig.verb('answer', pane, 'yes')
    lastAnswerAt = Date.now()
    note(`card #${n} answered by the owner (agents answer yes): ok ${ans.ok}; ${ans.ok ? JSON.stringify(ans.data) : ans.err}`)
    evidence(`3-card-${n}-answer.json`, JSON.stringify({ ok: ans.ok, data: ans.data, err: ans.err }, null, 2) + '\n')
    const gone = await rig.waitFor(`card #${n} gone`, async () => (await rig.verb('read-screen', pane)).data.state !== 'permission', 30_000).catch(() => false)
    evidence(`3-card-${n}-after-answer.txt`, `card gone (conductor state not permission): ${!!gone}\n${rig.screenOf(pane)}\n`)
    const h = await handOf()
    heldChecks.push({ at: `after card #${n}`, ...h })
    note(`card #${n}: gone ${!!gone}; hand ${JSON.stringify(h.hand)}; path ${JSON.stringify(h.path)}`)
    if (!ans.ok) throw new Error(`agents answer yes failed: ${ans.err}`)
    return true
  }
  const submittedOrStuck = async (tag: string, timeout: number): Promise<'submitted' | 'stuck' | 'gone'> => {
    const end = Date.now() + timeout
    for (;;) {
      await handleCard()
      const v = verdictOf(rig.screenOf(pane), tag)
      if (v === 'submitted') return v
      if (Date.now() > end) return v
      await sleep(500)
    }
  }
  const entry = await submittedOrStuck('você entrou em', 90_000)
  evidence('1a-entry-screen.txt', `verdict: ${entry}\n${rig.screenOf(pane)}\n`)
  note(`1a. entry notice verdict (from the screen): ${entry}`)
  await rig.waitFor('the Codex idle after the entry', async () => (await handleCard()) ? undefined : (await rig.verb('read-screen', pane)).data.state === 'idle', 150_000).catch(() => undefined)

  // ---- 1b. a LONG line (~300 chars, accents and the middle dot) from the moderator is SUBMITTED ----
  const TAG = 'E4C01'
  const ask = 'Responda ao canal pela ferramenta channels_say (nome da sala: conferencia) com o texto CODEX-VIVO e depois escreva só: ok.'
  let longText = `${TAG} · ${FILL.repeat(3)}`.slice(0, 250).trimEnd()
  longText = `${longText} ${ask}`
  const said = await rig.ask('say', { channel: CH, text: longText })
  note(`1b. long line: ${longText.length} chars; receipts ${JSON.stringify(said.receipts)}`)
  const long = await submittedOrStuck(TAG, 90_000)
  const screenLong = rig.screenOf(pane)
  evidence('1b-long-screen.txt', `verdict: ${long}; chars ${longText.length}; receipts ${JSON.stringify(said.receipts)}\n${screenLong}\n`)
  note(`1b. long line verdict (from the screen): ${long}`)

  // ---- 2. the header arrives whole (whitespace squashed: the screen wraps the line) ----
  const header = squash('[tether · channels · #conferencia · de usuário (moderator')
  const flat = squash(screenLong)
  const headerOk = flat.includes(header) && new RegExp(`\\]${TAG}`).test(flat.slice(flat.indexOf(header)))
  note(`2. header whole on the screen: ${headerOk}`)
  evidence('2-header.txt', `expected (squashed) start: ${header}\nwhole header followed by the tag: ${headerOk}\n`)

  // ---- 3. Codex answers by channels_say and the answer reaches the fake agent ----
  const heard = await rig.waitFor('the Codex spoke in the channel after the long line', async () => {
    await handleCard()
    const h = await rig.ask('history', { channel: CH })
    return h.lines.find((l: { kind: string; seq: number; from: { id: string } }) => l.kind === 'message' && l.from.id === pane && l.seq > said.line.seq)
  }, 150_000).catch(() => undefined)
  let heard2 = false
  if (heard) {
    note(`3. Codex spoke: seq ${heard.seq} "${String(heard.body).slice(0, 80)}"`)
    const back = await rig.waitFor('the fake received the Codex line', () => rig.notes(F).find((n) => n.meta.from_id === pane && n.content.includes(String(heard.body).slice(0, 20))), 30_000).catch(() => undefined)
    heard2 = !!back
    note(`3. the other member got it: ${back ? JSON.stringify(back.meta) : 'NO'}`)
    evidence('3-codex-line.json', JSON.stringify({ line: heard, receivedByFake: back ?? null }, null, 2) + '\n')
    if (!back) finding('the Codex spoke in the channel but the fake member did not receive it')
  } else {
    finding(`the Codex did not speak in the channel (path ${pathOf(pane)}); screen kept in 3-no-answer-screen.txt`)
    evidence('3-no-answer-screen.txt', `${rig.screenOf(pane)}\n`)
  }
  await rig.waitFor('the Codex idle after its answer', async () => (await handleCard()) ? undefined : (await rig.verb('read-screen', pane)).data.state === 'idle', 120_000).catch(() => undefined)
  note(`approval policy ${APPROVAL}; cards seen: ${cards.length}`)
  // The line sent with the card up must have been delivered and become a turn once the Codex was idle again.
  let headerIdleOk = false
  if (APPROVAL === 'on-request') {
    // The lines sent while the Codex was busy: something of the channel (the line with its header OR the digest `N falas novas`) was typed and became a turn.
    for (const end = Date.now() + 150_000; !channelTurn && Date.now() < end; await sleep(500)) await handleCard()
    await rig.waitFor('the Codex idle after the queued lines', async () => (await handleCard()) ? undefined : (await rig.verb('read-screen', pane)).data.state === 'idle', 150_000).catch(() => undefined)
    evidence('3-card-queued-line-screen.txt', `channel item typed and turned into a turn: ${channelTurn || 'NONE'}; receipt of the line sent with the card up: ${JSON.stringify(queuedDuring)}\nthe Codex read lines by channels_read: ${sawRead}\n${rig.screenOf(pane)}\n`)
    note(`lines sent while busy (card up receipt ${JSON.stringify(queuedDuring)}): channel item turned into a turn: ${channelTurn || 'NONE'}; read by channels_read: ${sawRead}`)
    heldChecks.push({ at: 'end', ...(await handOf()) })
    // The header whole is proved with a fresh short line delivered to an IDLE Codex.
    const T3 = 'E4C03'
    // Precondition: the Codex is truly idle (the conductor's `idle` read-screen state, the same signal the delivery decides on) and stays so
    // for a quiet window: a pending digest `N falas novas` typed on idle would flip it busy again and a line sent meanwhile would be merged.
    let quietSince = 0
    await rig.waitFor('the Codex idle and quiet before the short line', async () => {
      if (await handleCard()) { quietSince = 0; return undefined }
      const idleNow = (await rig.verb('read-screen', pane)).data.state === 'idle'
      if (!idleNow) { quietSince = 0; return undefined }
      quietSince ||= Date.now()
      return Date.now() - quietSince >= 5_000 && Date.now() - lastAnswerAt >= 11_000
    }, 150_000)
    const short =await rig.ask('say', { channel: CH, text: `${T3} · curta, com você ocioso. Não responda.`, to: [NAME_C] })
    assert.ok(!Object.values(short.receipts ?? {}).includes('queued'), `the short line to the idle Codex was queued, not delivered through the terminal (product finding): ${JSON.stringify(short.receipts)}`)
    const v3 = await submittedOrStuck(T3, 90_000)
    const flat3 = squash(rig.screenOf(pane))
    headerIdleOk = flat3.includes(header) && new RegExp(`\\]${T3}`).test(flat3.slice(flat3.lastIndexOf(header)))
    evidence('2-header-idle.txt', `receipts ${JSON.stringify(short.receipts)}; verdict ${v3}; whole header followed by the tag: ${headerIdleOk}\n${rig.screenOf(pane)}\n`)
    note(`2b. header whole on a short line to the idle Codex: ${headerIdleOk} (receipts ${JSON.stringify(short.receipts)}, verdict ${v3})`)
    await rig.waitFor('the Codex idle after the short line', async () => (await handleCard()) ? undefined : (await rig.verb('read-screen', pane)).data.state === 'idle', 120_000).catch(() => undefined)
  }

  // ---- 4. a line to the member that hears inside (the fake): nothing typed in its terminal, not lost ----
  const IN = 'INSIDE-E4C-04 · fala por dentro, sem digitar'
  const typedBefore = rig.typedInto(F).length
  const inRes = await rig.ask('say', { channel: CH, text: IN, to: [NAME_F] })
  const arrived = await rig.waitFor('the fake got the inside line', () => rig.notes(F).find((n) => n.content.includes('INSIDE-E4C-04')), 20_000).catch(() => undefined)
  await sleep(1500)
  const typedAfter = rig.typedInto(F)
  note(`4. inside line: receipts ${JSON.stringify(inRes.receipts)}; arrived by the stream: ${!!arrived}; typed into the terminal: ${typedAfter.length - typedBefore} chars`)
  evidence('4-inside.json', JSON.stringify({ receipts: inRes.receipts, notification: arrived ?? null, typedIntoTerminal: typedAfter.slice(typedBefore) }, null, 2) + '\n')

  // ---- evidence and end ----
  evidence('history.json', JSON.stringify((await rig.ask('history', { channel: CH })).lines, null, 2) + '\n')
  evidence('daemon-log.txt', rig.daemonLog())
  evidence('final-screen.txt', `${rig.screenOf(pane)}\n`)
  evidence('summary.txt', [...log, '', `OWNER NOTICES "pede permissão": ${askNotices}`, `HAND CHECKS: ${JSON.stringify(heldChecks)}`, `CHANNEL ITEM TURNED INTO A TURN WHILE BUSY: ${channelTurn || 'NONE'}`, `CODEX READ LINES BY channels_read (observed): ${sawRead}`, '', 'FINDINGS:', ...findings, ''].join('\n'))
  evidence('owner-told.txt', told())
  const left = await rig.teardown()
  assert.equal(entry, 'submitted', 'the entry notice became a turn (see 1a-entry-screen.txt)')
  if (APPROVAL === 'never') {
    assert.equal(long, 'submitted', 'the long line became a turn (see 1b-long-screen.txt)')
    assert.ok(headerOk, 'the header of the line arrived whole')
  }
  if (APPROVAL === 'on-request') {
    // C5: a busy member has at most one pending delivery per channel; the rest is the digest notice. So the long line may arrive as it is or as the digest.
    assert.ok(channelTurn, 'something of the channel (the line with header or the digest) was typed and became a turn once the Codex was idle (see 3-card-queued-line-screen.txt)')
    assert.ok(headerIdleOk, 'the header of a short line delivered to the idle Codex arrived whole (see 2-header-idle.txt)')
    assert.ok(cards.length > 0, 'the conductor saw an approval card (state permission)')
    assert.ok(heldChecks.length > 0 && heldChecks.every((h) => h.hand === 'owner'), `the pane stays commanded by its owner after the answer: ${JSON.stringify(heldChecks)}`)
    assert.ok(heard && heard2, 'the Codex answered by channels_say and the answer reached the other member (see 3-*)')
  }
  assert.ok(arrived, 'the inside line reached the fake agent by its stream')
  assert.equal(typedAfter.length, typedBefore, 'nothing was typed into the terminal of the member that hears inside')
  assert.deepEqual(left, [], 'no process left behind')
})
