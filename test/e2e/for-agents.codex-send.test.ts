// `agents send` WITH the owner's envelope to an idle REAL Codex (gpt-5.6-luna, low effort), by the terminal path (no --raw): the turn must start
// with no Enter by hand, and the owner is told it finished with the answer. A PRIVATE tetherd (own home, pipe, pane host), the verbs driven as
// the owner through the real CLI from a node process in a shell slot (the test never reads a key). Same rig as for-agents.codex.test.ts, trimmed.
// Run alone: node --test --test-concurrency=1 test/e2e/for-agents.codex-send.test.ts
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DaemonClient } from '../../src/daemon/client.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { HostClient } from '../../src/procd/client.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { pidAlive } from './daemon-driver.ts'

const MAIN = resolve(import.meta.dirname, '../../src/daemon/main.ts')
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** The daemon's environment: no CLAUDE*, no CODEX_HOME and no TETHER_* of the tether this test may run in. */
function cleanDaemonEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^CLAUDE/i.test(k) && !/^TETHER_/i.test(k) && k !== 'CODEX_HOME') env[k] = v
  return Object.assign(env, extra)
}

// The owner: a process in a shell slot that runs each command of `cmd.jsonl` as `tether agents ...` and appends the outcome to `out.jsonl`;
// what the delivery types into it (the notices) goes to `told.log`.
function ownerScript(dir: string): string {
  return String.raw`
const fs = require('node:fs'), path = require('node:path')
const { spawnSync } = require('node:child_process')
delete process.env.NODE_TEST_CONTEXT
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

interface Outcome { id: number; argv: string[]; status: number | null; stdout: string; stderr: string }
interface Verb { ok: boolean; data: Record<string, any>; err: string }

class Rig {
  readonly root = mkdtempSync(join(tmpdir(), 'c3s-'))
  readonly home = join(this.root, 'home')
  readonly work = join(this.root, 'owner')
  readonly bench = mkdtempSync(join(tmpdir(), 'tether-c3s-bench-'))
  readonly pipe: string
  readonly ptydPipe: string
  client!: DaemonClient
  readonly seen = new Set<number>()
  private nextId = 1

  constructor() {
    mkdirSync(this.home); mkdirSync(this.work)
    const id = randomBytes(4).toString('hex')
    const BS = String.fromCharCode(92)
    const winPipe = (n: string): string => [BS, BS, '.', BS, 'pipe', BS, n].join('')
    this.pipe = process.platform === 'win32' ? winPipe(`tether-c3s-${id}`) : join(this.home, 'd.sock')
    this.ptydPipe = process.platform === 'win32' ? winPipe(`tether-c3s-ptyd-${id}`) : join(this.home, 'ptyd.sock')
  }

  async connect(): Promise<void> {
    const env = cleanDaemonEnv({ TETHER_PANEL_HOST: '1', TETHER_PTYD_PIPE: this.ptydPipe })
    this.client = await DaemonClient.connect({ home: this.home, pipe: this.pipe, client: 'test', mainPath: MAIN, env })
    this.seen.add(this.client.hello.pid)
    await claim(this.client.hello.pid, { cmdIncludes: MAIN, what: 'tetherd (c3s)' })
  }

  async states(): Promise<SlotState[]> { return (await this.client.request({ t: 'list' })).slots ?? [] }
  async state(slotId: string): Promise<SlotState | undefined> { return (await this.states()).find(s => s.slotId === slotId) }
  daemonLog(): string { const p = join(this.home, 'tetherd.log'); return existsSync(p) ? readFileSync(p, 'utf8') : '' }

  async waitFor<T>(what: string, fn: () => Promise<T | undefined> | T | undefined, timeout = 90_000): Promise<T> {
    const deadline = Date.now() + timeout
    for (;;) {
      const v = await fn()
      if (v) return v
      if (Date.now() > deadline) throw new Error(`timeout (${timeout} ms) waiting for ${what}\n--- daemon log (tail) ---\n${this.daemonLog().slice(-2500)}`)
      await sleep(250)
    }
  }

  /** `tether agents <argv>` as the owner; resolves with the verb's data (stdout) or error (stderr). */
  async verb(...argv: string[]): Promise<Verb> {
    const id = this.nextId++
    appendFileSync(join(this.work, 'cmd.jsonl'), JSON.stringify({ id, argv }) + '\n')
    const out = await this.waitFor(`the owner's outcome of agents ${argv[0]}`, () => this.outcomes().find(o => o.id === id), 150_000)
    const parse = (s: string): Record<string, any> => { try { return JSON.parse(s) as Record<string, any> } catch { return {} } }
    return { ok: out.status === 0, data: parse(out.status === 0 ? out.stdout : out.stderr), err: out.stderr.trim() }
  }
  outcomes(): Outcome[] {
    const f = join(this.work, 'out.jsonl')
    return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Outcome) : []
  }
  told(): string { const f = join(this.work, 'told.log'); return existsSync(f) ? readFileSync(f, 'utf8').replace(/\u001b?\[20[01]~/g, '') : '' }

  async set(kind: 'desk' | 'pane', objectId: string, key: string, value: unknown): Promise<void> {
    await this.client.request({ t: 'object-set', ext: 'for-agents', kind, objectId, key, value })
  }
  async map(cena: string[], casa: string[]): Promise<void> {
    const desk = (id: string, panes: string[], kind: 'queue' | 'system' = 'queue') => ({ id, name: id, kind, panes: panes.map(p => ({ id: p, type: 'terminal' })) })
    await this.client.request({ t: 'desk-map', map: { desks: [desk('cena', cena), desk('casa', casa), desk('sistema', [], 'system')], drawer: [] } })
  }

  async teardown(): Promise<string[]> {
    try {
      for (const s of await this.states()) if (s.pid) await this.client.request({ t: 'stop', slotId: s.slotId }).catch(() => undefined)
      for (const end = Date.now() + 40_000; Date.now() < end; await sleep(250)) {
        if ((await this.states().catch(() => [])).every(s => !s.pid)) break
      }
    } catch { /* daemon gone */ }
    try { this.client.close() } catch { /* gone */ }
    const host = await HostClient.ping(this.ptydPipe).catch(() => undefined)
    if (host) this.seen.add(host.pid)
    for (const pid of [...this.seen].reverse()) {
      if (!pidAlive(pid)) continue
      const owned = await claim(pid, { what: 'c3s e2e process' }).catch(() => undefined)
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

test('send with the owner envelope, by the terminal, starts the turn of an idle Codex with no Enter by hand', { timeout: 400_000 }, async () => {
  const rig = new Rig(); rigs.push(rig)
  await rig.connect()
  const client = rig.client
  const ownerFile = join(rig.root, 'owner.cjs')
  writeFileSync(ownerFile, ownerScript(rig.work))
  const owner = (await client.request({ t: 'create', kind: 'shell', cwd: rig.work, name: 'dono', args: [process.execPath, ownerFile], start: true })).slot!.slotId
  await rig.waitFor('the owner runs', async () => { const s = await rig.state(owner); return s?.status === 'running' ? s : undefined })
  rig.seen.add((await rig.state(owner))!.pid!)
  await rig.map([], [owner])
  const since = new Date().toISOString()
  await rig.set('desk', 'cena', 'owner', { owner, since, givenBy: 'user' })
  await rig.set('pane', owner, 'owner', { owner, since, givenBy: 'user' })
  await rig.waitFor('the owner sees its desk', async () => {
    const v = await rig.verb('list')
    return v.ok && (v.data.desks as { id: string }[] | undefined)?.some(d => d.id === 'cena') ? v : undefined
  }, 60_000)

  const opened = await rig.verb('open', 'codex', rig.bench, '--model', 'gpt-5.6-luna', '--effort', 'low', '--name', 'codex-bancada', '--json', '{"args":["-a","on-request","-s","read-only"]}')
  assert.ok(opened.ok, `open: ${opened.err}`)
  const pane = String(opened.data.pane)
  rig.seen.add((await rig.waitFor('the pane has a pid', async () => (await rig.state(pane))?.pid ? await rig.state(pane) : undefined))!.pid!)
  await rig.map([pane], [owner])
  await client.request({ t: 'attach', slotId: pane, cols: 120, rows: 40 })
  await rig.waitFor('the agent at its prompt', async () => {
    const v = await rig.verb('read-screen', pane)
    return v.ok && v.data.state === 'idle' ? v : undefined
  })

  await rig.waitFor('the slot running', async () => ((await rig.state(pane))?.status === 'running' ? true : undefined), 60_000)
  // The envelope's header has the `·` separators; the line is long, as the owner's real one was.
  const sent = await rig.verb('send', pane, 'Sem usar ferramentas nem criar arquivos nesta pasta, responda só com a palavra: alfa-ok')
  assert.ok(sent.ok, `send: ${sent.err}`)
  const st = await rig.state(pane)
  assert.equal(sent.data.state, 'typed', `send: ${JSON.stringify(sent.data)} slot: ${JSON.stringify({ ...st, env: undefined })}`)
  const finished = new RegExp(`terminou · guia ${pane}`, 'g')
  const told = await rig.waitFor('the finish notice', () => ((rig.told().match(finished) ?? []).length >= 1 ? rig.told() : undefined), 90_000)
    .catch(async (e: Error) => { throw new Error(`${e.message.split('\n')[0]}\n--- screen ---\n${String((await rig.verb('read-screen', pane)).data.text)}\n--- told ---\n${rig.told().slice(-800)}\n--- conductor log ---\n${rig.daemonLog().split('\n').filter(l => /condutor /.test(l)).join('\n')}`) })
  assert.match(told.slice(told.lastIndexOf(`terminou · guia ${pane}`)), /alfa-ok/, 'the turn ran and the notice carries the answer')
  const la = await rig.verb('last-answer', pane)
  assert.match(String(la.data.text), /alfa-ok/)
  const log = rig.daemonLog().split('\n').filter(l => /condutor /.test(l)).join('\n')
  console.log(`# conductor log:\n${log}`)
  assert.deepEqual(await rig.teardown(), [], 'no process left behind')
})
