// E4s: a REAL Soul (bench being, cheap model, in process) as a member of a channel, in a PRIVATE tetherd (own home, pipe and pane host) with the
// real channels extension. The Soul pane is opened by an owner (a shell slot running the CLI of `agents`), so it is commanded: the lines reach it by
// the TERMINAL. The other member is the fake agent (test/fixtures/channels/agent-live.cjs, no LLM) as a `claude` slot with an open stream; it speaks
// through the MCP tool `channels_say`. The person (the moderator) is one `app` client of the test. The test never types into the Soul pane as a person
// (that would take the pane, C13): everything goes by owner and by channel; the notice and the `channels` skill (delivered to the Soul) teach it how to answer.
// FINDING (run 1): without the skill a bench Soul (careful/cheap) did not trust the header and asked for confirmation. The skill teaches the roles;
//   the moderator still opens with a legitimate line telling it to answer the colleagues.
//   1 the Soul joins (entry notice by the terminal), the fake speaks, the Soul answers by the CLI and the answer reaches the fake (turn 1)
//   2 the same once more (turn 2)
//   3 the person mutes the Soul; asked to speak again, its CLI attempt answers `muted` and nothing reaches the channel
// The bench being is born new and empty by the engine's own verbs (`soul init -f <source> --replace`, `soul profiles create`), outside the house.
// Run alone: node --test test/e2e/channels.soul.test.ts
// Env: E4S_RUN_ROOT (where homes live, default os tmpdir), E4S_EVIDENCE_DIR (evidence without keys; default a new folder under onda-3/e4s), E4S_SOUL_BIN (the soul-cli bin).
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const SOUL_BIN = process.env.E4S_SOUL_BIN ?? 'D:/atrium/workspace/soul-cli/bin/soul'
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const runRoot = process.env.E4S_RUN_ROOT ?? tmpdir()
const evidenceDir = process.env.E4S_EVIDENCE_DIR ?? `D:/atrium/.tmp/tether-agents/onda-3/e4s/run-${new Date().toISOString().replace(/[:.]/g, '-')}`

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

/** The environment of the test daemon (and so of its agents): no CLAUDE*, no TETHER_* and no NODE_TEST_CONTEXT of where this test runs; the fake `claude` first on the PATH. */
function cleanDaemonEnv(extra: Record<string, string>, shimDir?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^CLAUDE/i.test(k) || /^TETHER_/i.test(k) || k === 'NODE_TEST_CONTEXT') continue
    env[k] = v
  }
  if (shimDir) {
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
    env[pathKey] = `${shimDir}${process.platform === 'win32' ? ';' : ':'}${env[pathKey] ?? ''}`
  }
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

/** The persona source of the bench being (no secret in it). */
const BEING_SOURCE = `---
persona_slug: sonda
persona_name: Sonda
persona_summary: Ser de bancada, descartavel.
persona_description: "Sonda is a bench being: a disposable agent that exists only to prove engine mechanisms. It speaks little, in plain Brazilian Portuguese, says when it does not know, and keeps nothing it was not asked to keep. It is created, exercised and thrown away."
persona_native_language: pt-BR
---

Eu sou a Sonda, um ser de bancada: existo para provar mecanismos do motor.
Falo pouco, em portugues claro, e digo quando nao sei.
Sou descartavel e sei disso; nao guardo nada que nao me peçam.
`

class Rig {
  readonly root: string
  readonly home: string
  readonly work: string
  readonly shim: string
  /** The bench being's folder: new, outside the house, made by the engine's verbs. */
  readonly ser: string
  readonly pipe: string
  readonly ptydPipe: string
  client!: DaemonClient
  app!: DaemonClient
  readonly seen = new Set<number>()
  readonly screens = new Map<string, Screen>()
  private nextId = 1

  constructor() {
    this.root = mkdtempSync(join(runRoot, 'tether-e4s-'))
    this.home = join(this.root, 'home')
    this.work = join(this.root, 'owner')
    this.shim = join(this.root, 'shim')
    this.ser = join(mkdtempSync(join(tmpdir(), 'tether-e4s-bench-')), 'ser')
    mkdirSync(this.home); mkdirSync(this.work); mkdirSync(this.shim); mkdirSync(this.ser)
    const id = randomBytes(4).toString('hex')
    const BS = String.fromCharCode(92)
    const winPipe = (n: string): string => [BS, BS, '.', BS, 'pipe', BS, n].join('')
    this.pipe = process.platform === 'win32' ? winPipe(`tether-e4s-${id}`) : join(this.home, 'd.sock')
    this.ptydPipe = process.platform === 'win32' ? winPipe(`tether-e4s-ptyd-${id}`) : join(this.home, 'ptyd.sock')
  }

  /** The engine's own verbs, run in the bench folder with no CLAUDE* and no TETHER_* in the environment. */
  soul(...args: string[]): string {
    const r = spawnSync(process.execPath, [SOUL_BIN, ...args], { cwd: this.ser, encoding: 'utf8', env: cleanDaemonEnv({}), timeout: 120_000 })
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
    assert.equal(r.status, 0, `soul ${args.join(' ')} failed (${r.status}):\n${out.slice(-1500)}`)
    return out
  }

  async connect(): Promise<void> {
    // `claude` on the PATH of the daemon is the fake agent (the real adapter resolves it and starts it in a real pane).
    if (process.platform === 'win32') writeFileSync(join(this.shim, 'claude.cmd'), `@echo off\r\n"${process.execPath}" "${AGENT}" %*\r\n`)
    else writeFileSync(join(this.shim, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${AGENT}" "$@"\n`, { mode: 0o755 })
    // Extensions with side effects of their own are off; for-agents stays (the owner needs it), so does conductor-soul (the real Soul needs it)
    // and so does skills (it hands the Soul the `channels` skill, which teaches it the header and the roles).
    writeFileSync(join(this.home, 'settings.json'), JSON.stringify({ extensions: { disabled: ['web-bridge', 'browser', 'conductor-claude'] } }))
    const env = cleanDaemonEnv({ TETHER_PANEL_HOST: '1', TETHER_PTYD_PIPE: this.ptydPipe, TETHER_SOUL_CMD: `node ${SOUL_BIN}` }, this.shim)
    this.client = await DaemonClient.connect({ home: this.home, pipe: this.pipe, client: 'test', mainPath: MAIN, env, startTimeoutMs: 45_000 })
    const pid = this.client.hello.pid
    this.seen.add(pid)
    await claim(pid, { cmdIncludes: MAIN, what: 'tetherd (channels soul)' })
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
      const owned = await claim(pid, { what: 'channels soul e2e process' }).catch(() => undefined)
      if (owned) await killOwned(owned, { tree: true })
    }
    for (const end = Date.now() + 8_000; [...this.seen].some(pidAlive) && Date.now() < end; await sleep(150));
    const left = [...this.seen].filter(pidAlive).map(String)
    for (const dir of [resolve(this.ser, '..'), this.root]) {
      for (let i = 0; i < 5; i++) { try { rmSync(dir, { recursive: true, force: true }); break } catch { await sleep(300) } }
    }
    return left
  }
}

const rigs: Rig[] = []
after(async () => { for (const r of rigs) await r.teardown().catch(() => undefined) })

const skip = existsSync(SOUL_BIN) ? false : `the Soul is not available (${SOUL_BIN})`

test('E4s: a real Soul in a channel by the terminal: entry notice, two turns answered by the CLI, then muted', { timeout: 1_200_000, skip }, async (t) => {
  const rig = new Rig(); rigs.push(rig)
  const t0 = Date.now()
  const log: string[] = []
  const note = (s: string): void => { const l = `[+${Math.round((Date.now() - t0) / 1000)}s] ${s}`; log.push(l); t.diagnostic(l); console.log(`# ${l}`) }
  const NAME_F = 'claude · conferente'
  const NAME_S = 'soul · bancada'
  const CHANNEL = 'bancada'
  let pane = ''

  const dump = (extra: string): void => {
    evidence('summary.txt', `${log.join('\n')}\n${extra}\n`)
    evidence('daemon-log.txt', rig.daemonLog())
    if (pane) evidence('soul-screen.txt', `${rig.screenOf(pane)}\n`)
    evidence('owner-told.txt', rig.told())
  }

  let verdict = ''
  let left: string[] = []
  try {
    // ---- 0. the bench being, born new and empty by the engine's verbs ----
    const source = join(rig.root, 'soul.md')
    writeFileSync(source, BEING_SOURCE)
    rig.soul('init', '-f', source, '--replace')
    rig.soul('profiles', 'create', 'ana-teste', '--name', 'Ana Teste')
    await rig.connect()
    const client = rig.client

    // ---- the owner: a shell slot running the script, owner of the desk "cena" and of itself ----
    const ownerFile = join(rig.root, 'owner.cjs')
    writeFileSync(ownerFile, ownerScript(rig.work))
    const owner = (await client.request({ t: 'create', kind: 'shell', cwd: rig.work, name: 'dono', args: [process.execPath, ownerFile], start: true })).slot!.slotId
    await rig.waitFor('the owner runs', async () => { const s = await rig.state(owner); return s?.status === 'running' ? s : undefined })
    rig.seen.add((await rig.state(owner))!.pid!)
    const mapOf = (cena: string[], casa: string[]): unknown => {
      const desk = (id: string, panes: string[], kind: 'queue' | 'system' = 'queue') => ({ id, name: id, kind, panes: panes.map((p) => ({ id: p, type: 'terminal' })) })
      return { desks: [desk('cena', cena), desk('casa', casa), desk('sistema', [], 'system')], drawer: [] }
    }
    await client.request({ t: 'desk-map', map: mapOf([], [owner]) } as never)
    const since = new Date().toISOString()
    for (const [kind, objectId] of [['desk', 'cena'], ['pane', owner]] as const) {
      await client.request({ t: 'object-set', ext: 'for-agents', kind, objectId, key: 'owner', value: { owner, since, givenBy: 'user' } })
    }
    await rig.waitFor('the owner sees its desk', async () => {
      const v = await rig.verb('list')
      return v.ok && (v.data.desks as { id: string }[] | undefined)?.some((d) => d.id === 'cena') ? v : undefined
    }, 60_000)

    // ---- the Soul, opened by the owner (so its pane is commanded) ----
    const opened = await rig.verb('open', 'soul', rig.ser, '--profile', 'soul', '--model', 'cheap', '--effort', 'low', '--name', NAME_S, '--json', JSON.stringify({ args: ['-P', 'ana-teste', '--strategy', 'economy'] }))
    assert.ok(opened.ok, `open: ${opened.err}`)
    pane = String(opened.data.pane)
    rig.seen.add((await rig.waitFor('the pane has a pid', async () => (await rig.state(pane))?.pid ? await rig.state(pane) : undefined))!.pid!)
    await client.request({ t: 'desk-map', map: mapOf([pane], [owner]) } as never)
    await client.request({ t: 'attach', slotId: pane, cols: 120, rows: 40 })

    // A permission card is answered AS THE OWNER (`agents answer yes`), never by typing as the person: that would take the pane back.
    let cards = 0
    const handleCard = async (): Promise<boolean> => {
      const v = await rig.verb('read-screen', pane)
      if (!v.ok || v.data.state !== 'permission') return false
      cards++
      evidence(`card-${cards}-screen.txt`, `${String(v.data.text ?? rig.screenOf(pane))}\n`)
      const ans = await rig.verb('answer', pane, 'yes')
      note(`card #${cards} answered by the owner: ok ${ans.ok}`)
      await sleep(1000)
      return true
    }
    const idle = async (timeout = 120_000): Promise<void> => {
      await rig.waitFor('the Soul at its prompt', async () => {
        if (await handleCard()) return undefined
        const v = await rig.verb('read-screen', pane)
        return v.ok && v.data.state === 'idle'
      }, timeout)
    }
    await idle().catch((e: Error) => { throw new Error(`${e.message}\n--- the pane's screen ---\n${rig.screenOf(pane)}`) })
    note(`soul ${pane} booted and idle`)

    // ---- the other member: the fake agent with an open stream; the channel; the person joins both ----
    const F = await rig.fakeAgent(NAME_F)
    const { channel } = await rig.ask('create', { name: CHANNEL, title: 'Bancada de teste' })
    const CH: string = channel.id
    await rig.ask('join', { channel: CH, agent: F })
    const joined = await rig.ask('join', { channel: CH, agent: pane })
    const members = await rig.ask('members', { channel: CH })
    note(`joined: ${JSON.stringify(joined)}; members: ${JSON.stringify(members.members.map((m: { name: string; path: string; alive: boolean }) => ({ name: m.name, path: m.path, alive: m.alive })))}`)

    // ---- 1. the entry notice arrives by the terminal and the Soul reads it ----
    await rig.waitFor('the entry notice on the Soul screen', async () => {
      await handleCard()
      return rig.screenOf(pane).replace(/\s+/g, '').includes('vocêentrouem#' + CHANNEL)
    }, 90_000)
    note('1. entry notice on the screen')
    await sleep(2000)
    await idle(150_000)
    evidence('1-entry-screen.txt', `${rig.screenOf(pane)}\n`)

    // ---- the person's authorization: a bench Soul (careful mode, cheap model) does NOT answer a member without it (run 1: it asked the
    // person for confirmation instead of speaking). The moderator says so in natural language, without dictating the command. ----
    await rig.ask('say', { channel: CH, text: 'Pode ficar tranquilo: neste canal você tem a minha autorização para responder aos colegas, sempre pelo próprio canal, sem me pedir confirmação.' })
    await sleep(2000)
    await idle(150_000)
    evidence('1b-authorized-screen.txt', `${rig.screenOf(pane)}\n`)
    note('1b. the moderator authorized the Soul to answer the colleagues')

    // ---- 2 and 3. two turns: the fake speaks; the Soul answers by the CLI of the notice; the answer reaches the fake ----
    const said: Record<string, boolean> = {}
    for (const [n, word] of [[1, 'ALFA-OK'], [2, 'BETA-OK']] as const) {
      const spoken = await rig.fakeMcp(F, 'say', { canal: CHANNEL, text: `Pedido ${n} do colega: responda aqui no canal ${CHANNEL} apenas com a palavra ${word}.` })
      note(`turn ${n}: the fake spoke: ${JSON.stringify(spoken).slice(0, 200)}`)
      const back = await rig.waitFor(`the fake got ${word} from the Soul`, async () => {
        await handleCard()
        return rig.notes(F).find((x) => x.meta.from_id === pane && x.content.toUpperCase().includes(word))
      }, 180_000).catch(() => undefined)
      said[word] = !!back
      note(`turn ${n}: the answer reached the other member: ${back ? JSON.stringify(back.meta) : 'NO'}`)
      evidence(`${n + 1}-turn-${n}-screen.txt`, `${rig.screenOf(pane)}\n`)
      if (!back) break
      await idle(150_000)
    }

    // ---- 4. the person mutes the Soul; asked to speak, its CLI attempt answers `muted` ----
    let mutedSeen = false
    let leaked = true
    if (said['ALFA-OK'] && said['BETA-OK']) {
      const muted = await rig.ask('mute', { channel: CH, agent: pane })
      note(`4. muted: ${JSON.stringify(muted)}`)
      await sleep(2000)
      await idle(150_000)
      const before = rig.screenOf(pane).length
      await rig.ask('say', { channel: CH, text: `Pedido 3: responda agora no canal ${CHANNEL} com a palavra GAMA-OK, por favor.` })
      mutedSeen = await rig.waitFor('the Soul tried and got muted', async () => {
        await handleCard()
        const s = rig.screenOf(pane)
        return s.length !== before && /muted|calado/i.test(s.slice(Math.max(0, s.indexOf('GAMA-OK'))))
      }, 150_000).catch(() => false)
      await idle(150_000).catch(() => undefined)
      const hist = await rig.ask('history', { channel: CH })
      leaked = hist.lines.some((l: { kind: string; from: { id: string }; body?: string }) => l.kind === 'message' && l.from.id === pane && String(l.body ?? '').toUpperCase().includes('GAMA-OK'))
        || rig.notes(F).some((x) => x.content.toUpperCase().includes('GAMA-OK') && x.meta.from_id === pane)
      note(`4. the Soul's attempt answered muted on the screen: ${mutedSeen}; GAMA-OK reached the channel: ${leaked}`)
      evidence('4-muted-screen.txt', `${rig.screenOf(pane)}\n`)
      evidence('history.json', JSON.stringify(hist.lines, null, 2) + '\n')
    }
    verdict = `ALFA ${said['ALFA-OK']}; BETA ${said['BETA-OK']}; muted seen ${mutedSeen}; leaked ${leaked}; cards ${cards}`
    dump(verdict)
  } catch (e) {
    dump(`FAILED: ${(e as Error).message}`)
    throw e
  } finally {
    left = await rig.teardown()
  }
  assert.equal(verdict.includes('ALFA true; BETA true; muted seen true; leaked false'), true, `the scenario did not hold: ${verdict} (see the evidence in ${evidenceDir})`)
  assert.deepEqual(left, [], 'no process left behind')
})
