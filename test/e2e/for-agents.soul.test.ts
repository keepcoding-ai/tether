// C2: the Soul conductor end to end with the REAL Soul (cheap model, in process, pool `-g`) in a PRIVATE tetherd (own home, pipe and pane
// host), driven by the verbs of the owner through the real CLI (`node "$TETHER_CLI" agents ...`) run from a test owner: a node process in a
// shell slot that reads commands from a file and runs the CLI with the slot's own environment (the test never reads a key or a credential).
// No app: the test plays its part (the desk map and the person's gestures of giving).
// The being is a BENCH being, born new and empty by the engine's own verbs (`soul init -f <source> --replace`, `soul profiles create`),
// in a folder of the tmp dir outside the house: nothing under `.soul/` is written by hand, and no existing being is opened or read.
// ONE Soul for the whole script, one gesture after the other:
//   1 open (the trust dialog and the profile dialog are the conductor's boot)   2 send, one line (raw)   3 the finish notice, the start of the answer
//   4 last-answer (the local session)   5 send, several lines (a paste), the second turn on the same pane   6 a permission card: the watch's notice
//   (`Opções: yes · no`), answer always (unsupported, nothing typed), answer yes   7 interrupt a running turn   8 command compact
//   9 read-screen   10 a second open of the same being with `-P` (no profile dialog)
// Run alone: node --test --test-concurrency=1 test/e2e/for-agents.soul.test.ts
// Env: C2_RUN_ROOT (where homes live, default os tmpdir), C2_EVIDENCE_DIR (keeps evidence without keys; default none), C2_SOUL_BIN (the soul-cli bin).
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DaemonClient } from '../../src/daemon/client.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { HostClient } from '../../src/procd/client.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { Screen } from './harness.ts'
import { pidAlive } from './daemon-driver.ts'

const MAIN = resolve(import.meta.dirname, '../../src/daemon/main.ts')
const SOUL_BIN = process.env.C2_SOUL_BIN ?? 'C:/atrium/workspace/soul-cli/bin/soul'
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

const runRoot = process.env.C2_RUN_ROOT ?? tmpdir()
const evidenceDir = process.env.C2_EVIDENCE_DIR
if (evidenceDir) mkdirSync(evidenceDir, { recursive: true })

const redactions: string[] = []
/** Evidence never carries a key: anything that looks like a secret token (32+ url-safe characters mixing letters and digits, once uuids and paths are set aside) is replaced and the replacement is reported. */
function sanitized(name: string, text: string): string {
  assert.ok(!/TETHER_(SLOT|MCP)_KEY/.test(text), 'evidence names a key variable')
  return text.replace(/([A-Za-z]:[\\/][^\s"']+)|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9_-]{32,}/g, (m, path: string | undefined, off: number) => {
    if (path || !/^(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}$/.test(m)) return m
    redactions.push(`${name}: ${m.length} chars after "${text.slice(Math.max(0, off - 24), off).replace(/\s+/g, ' ')}"`)
    return `<redacted ${m.length} chars>`
  })
}
const evidence = (name: string, text: string): void => { if (evidenceDir) writeFileSync(join(evidenceDir, name), sanitized(name, text)) }

/** The environment of the test daemon (and so of its agents): no CLAUDE* and no TETHER_* of the tether this test may run in; the soul command is the bin the sonda used. */
function cleanDaemonEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^CLAUDE/i.test(k) && !/^TETHER_/i.test(k)) env[k] = v
  return Object.assign(env, extra)
}

// The owner: a process in a shell slot. It runs each command of `cmd.jsonl` as `tether agents ...` (the slot's own environment is
// the proof of who calls) and appends the outcome to `out.jsonl`; what the delivery types into it (the notices) goes to `told.log`.
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

interface Outcome { id: number; argv: string[]; status: number | null; stdout: string; stderr: string }
interface Verb { ok: boolean; data: Record<string, any>; err: string }

/** The persona source of the bench being (the sonda's own text; no secret in it). */
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
  /** The bench being's folder: new, outside the house, made by the engine's verbs. */
  readonly ser: string
  readonly pipe: string
  readonly ptydPipe: string
  client!: DaemonClient
  daemon: Owned | undefined
  daemonPid = 0
  readonly seen = new Set<number>()
  readonly screens = new Map<string, Screen>()
  /** The first screen with each first-open dialog, by pane. */
  readonly dialogs = new Map<string, string>()
  private nextId = 1

  constructor() {
    this.root = mkdtempSync(join(runRoot, 'c2-'))
    this.home = join(this.root, 'home')
    this.work = join(this.root, 'owner')
    this.ser = join(mkdtempSync(join(tmpdir(), 'tether-c2-bench-')), 'ser')
    mkdirSync(this.home); mkdirSync(this.work); mkdirSync(this.ser)
    const id = randomBytes(4).toString('hex')
    const BS = String.fromCharCode(92)
    const winPipe = (n: string): string => [BS, BS, '.', BS, 'pipe', BS, n].join('')
    this.pipe = process.platform === 'win32' ? winPipe(`tether-c2-${id}`) : join(this.home, 'd.sock')
    this.ptydPipe = process.platform === 'win32' ? winPipe(`tether-c2-ptyd-${id}`) : join(this.home, 'ptyd.sock')
  }

  /** The engine's own verbs, run in the bench folder with no CLAUDE* and no TETHER_* in the environment. Returns what they printed. */
  soul(...args: string[]): string {
    const r = spawnSync(process.execPath, [SOUL_BIN, ...args], { cwd: this.ser, encoding: 'utf8', env: cleanDaemonEnv({}), timeout: 120_000 })
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
    assert.equal(r.status, 0, `soul ${args.join(' ')} failed (${r.status}):\n${out.slice(-1500)}`)
    return out
  }

  /** `.soul/` as a list of paths (names only), to show what the engine's verbs left and that no session exists yet. */
  soulTree(): string[] {
    const out: string[] = []
    const walk = (dir: string, depth: number): void => {
      if (depth > 4 || !existsSync(dir)) return
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        out.push(p.slice(this.ser.length + 1).replace(/\\/g, '/') + (e.isDirectory() ? '/' : ''))
        if (e.isDirectory()) walk(p, depth + 1)
      }
    }
    walk(join(this.ser, '.soul'), 0)
    return out
  }

  async connect(): Promise<void> {
    const env = cleanDaemonEnv({ TETHER_PANEL_HOST: '1', TETHER_PTYD_PIPE: this.ptydPipe, TETHER_SOUL_CMD: `node ${SOUL_BIN}` })
    this.client = await DaemonClient.connect({ home: this.home, pipe: this.pipe, client: 'test', mainPath: MAIN, env })
    this.daemonPid = this.client.hello.pid
    this.seen.add(this.daemonPid)
    this.daemon = await claim(this.daemonPid, { cmdIncludes: MAIN, what: 'tetherd (c2)' })
    this.client.on('data', (slotId: string, data: string) => {
      const screen = this.screens.get(slotId) ?? new Screen(120, 40)
      this.screens.set(slotId, screen)
      screen.write(data)
      const text = screen.text()
      if (!this.dialogs.has(`${slotId}:trust`) && text.includes('Quick safety check')) this.dialogs.set(`${slotId}:trust`, text)
      if (!this.dialogs.has(`${slotId}:profile`) && text.includes('how do you want to enter?')) this.dialogs.set(`${slotId}:profile`, text)
    })
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
  /** What the delivery typed into the owner (the paste markers of a terminal delivery are dropped). */
  told(): string { const f = join(this.work, 'told.log'); return existsSync(f) ? readFileSync(f, 'utf8').replace(/\u001b?\[20[01]~/g, '') : '' }

  /** The person's gesture, as the app writes it. */
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
      const owned = await claim(pid, { what: 'c2 e2e process' }).catch(() => undefined)
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

const count = (text: string, re: RegExp): number => (text.match(re) ?? []).length

test('C2: the Soul conductor, driven by the verbs of an owner (open, send, turns, card, interrupt, compact, last-answer, notices)', { timeout: 1_500_000 }, async () => {
  const rig = new Rig(); rigs.push(rig)
  const unproven: string[] = []
  const log: string[] = []
  const note = (s: string): void => { log.push(s); console.log(`# ${s}`) }
  const mark = (what: string, v: Verb): void => { if (v.data.proven === false) unproven.push(what) }
  let launches = 0

  // ---- 0. the bench being, born new and empty by the engine's verbs ----
  assert.equal(readdirSync(rig.ser).length, 0, 'the bench folder is new and empty')
  const source = join(rig.root, 'soul.md')
  writeFileSync(source, BEING_SOURCE)
  const initOut = rig.soul('init', '-f', source, '--replace')
  const createOut = rig.soul('profiles', 'create', 'ana-teste', '--name', 'Ana Teste')
  const listOut = rig.soul('profiles', 'list')
  const tree = rig.soulTree()
  assert.ok(tree.length > 0, 'the engine made .soul/')
  const sessions = tree.filter(p => /\/sessions\/.+/.test(p) && !p.endsWith('/.keep'))
  assert.deepEqual(sessions, [], 'no session exists before the first launch (only the .keep of the empty folders)')
  assert.match(listOut, /ana-teste/)
  note(`0. the being was born by the engine's verbs: ${tree.length} paths under .soul/, no session yet; profiles list shows ana-teste`)
  evidence('0-born-by-the-verbs.txt', `$ soul init -f <source> --replace\n${initOut}\n$ soul profiles create ana-teste --name "Ana Teste"\n${createOut}\n$ soul profiles list\n${listOut}\n--- .soul/ right after (names only; nothing written by hand) ---\n${tree.join('\n')}\n`)

  await rig.connect()
  const client = rig.client

  // ---- the owner: a shell slot running the script, with its own pane given to itself ("de si") so the notices reach it by the terminal ----
  const ownerFile = join(rig.root, 'owner.cjs')
  writeFileSync(ownerFile, ownerScript(rig.work))
  const owner = (await client.request({ t: 'create', kind: 'shell', cwd: rig.work, name: 'dono', args: [process.execPath, ownerFile], start: true })).slot!.slotId
  await rig.waitFor('the owner runs', async () => { const s = await rig.state(owner); return s?.status === 'running' ? s : undefined })
  rig.seen.add((await rig.state(owner))!.pid!)
  await rig.map([], [owner])
  const since = new Date().toISOString()
  await rig.set('desk', 'cena', 'owner', { owner, since, givenBy: 'user' })
  await rig.set('pane', owner, 'owner', { owner, since, givenBy: 'user' })
  const listed = await rig.waitFor('the owner sees its desk', async () => {
    const v = await rig.verb('list')
    return v.ok && (v.data.desks as { id: string }[] | undefined)?.some(d => d.id === 'cena') ? v : undefined
  }, 60_000)
  note(`owner ${owner} owns desk cena; list: ${JSON.stringify(listed.data.desks)}`)

  // ---- 1. open: launchArgs (--model cheap --effort low) and boot (trust dialog, profile dialog) ----
  const opened = await rig.verb('open', 'soul', rig.ser, '--profile', 'soul', '--model', 'cheap', '--effort', 'low', '--name', 'soul · bancada', '--json', '{"args":["--strategy","economy"]}')
  assert.ok(opened.ok, `open: ${opened.err}`)
  launches++
  const pane = String(opened.data.pane)
  mark('open', opened)
  note(`1. open: ${JSON.stringify(opened.data)}`)
  rig.seen.add((await rig.waitFor('the pane has a pid', async () => (await rig.state(pane))?.pid ? await rig.state(pane) : undefined))!.pid!)
  // The app would add the pane to the desk and size it: the test does the same.
  await rig.map([pane], [owner])
  await client.request({ t: 'attach', slotId: pane, cols: 120, rows: 40 })

  const idleSeen = async (p: string): Promise<Verb> => rig.waitFor('the agent at its prompt', async () => {
    const v = await rig.verb('read-screen', p)
    return v.ok && v.data.state === 'idle' ? v : undefined
  }, 120_000)
  const booted = await idleSeen(pane).catch((e: Error) => { throw new Error(`${e.message}\n--- the pane's screen ---\n${rig.screens.get(pane)?.text() ?? '(none)'}`) })
  const bootLog = rig.daemonLog().split('\n').filter(l => l.includes('boot: diálogo'))
  const trustAnswered = bootLog.filter(l => l.includes('de confiança')).length
  const profileAnswered = bootLog.filter(l => l.includes('de perfil')).length
  note(`1. boot answered: trust ${trustAnswered}x (screen seen: ${rig.dialogs.has(`${pane}:trust`)}), profile ${profileAnswered}x (screen seen: ${rig.dialogs.has(`${pane}:profile`)}); the agent is at its prompt`)
  assert.ok(trustAnswered <= 1 && profileAnswered <= 1, 'each dialog answered at most once')
  assert.ok(trustAnswered + profileAnswered >= 1, 'the conductor answered a first-open dialog')
  evidence('1-trust-dialog.txt', `${rig.dialogs.get(`${pane}:trust`) ?? '(the trust dialog did not appear)'}\n--- daemon log ---\n${bootLog.map(l => l.replace(/^\S+ \[\d+\] /, '')).join('\n')}\n`)
  evidence('1-profile-dialog.txt', `${rig.dialogs.get(`${pane}:profile`) ?? '(the profile dialog did not appear)'}\n`)
  evidence('1-prompt-screen.txt', `${booted.data.text ?? JSON.stringify(booted.data)}\n`)
  const meta = join(rig.home, 'slots', `${pane}.json`)
  if (existsSync(meta)) {
    const m = JSON.parse(readFileSync(meta, 'utf8')) as Record<string, unknown>
    note(`1. launch arguments of the slot: ${JSON.stringify(m.args)}; tether profile: ${JSON.stringify(m.profileId)}`)
  }

  // Waits for the n-th notice of a kind for this pane at the owner; returns its text.
  const waitNotice = async (label: string, re: RegExp, n: number, timeout = 150_000): Promise<string> => rig.waitFor(`notice ${label} #${n}`, () => {
    const t = rig.told()
    return count(t, re) >= n ? t : undefined
  }, timeout)
  const noticeFrom = (told: string, first: string): string => {
    const i = told.lastIndexOf(first)
    return i < 0 ? '' : told.slice(i).split('\n').slice(0, 30).join('\n')
  }
  const finished = new RegExp(`terminou · guia ${pane}`, 'g')
  const asking = new RegExp(`pede permissão · guia ${pane}`, 'g')

  // ---- 2 and 3. send, one line (raw: through the conductor), and the finish notice with the start of the answer ----
  const s1 = await rig.verb('send', pane, 'Responda apenas com a palavra: alfa-ok', '--raw')
  assert.ok(s1.ok, `send: ${s1.err}`); mark('send one line', s1)
  assert.deepEqual([s1.data.state, s1.data.raw], ['typed', true])
  const told1 = await waitNotice('finished', finished, 1)
  const n1 = noticeFrom(told1, `terminou · guia ${pane}`)
  assert.match(n1, /alfa-ok/i, 'the finish notice carries the start of the answer')
  assert.match(n1, new RegExp(`agents last-answer ${pane}`))
  note(`2/3. send one line, finish notice:\n${n1}`)
  evidence('2-3-notice-finished.txt', `${n1}\n`)

  // ---- 4. last-answer from the local session ----
  const la1 = await rig.verb('last-answer', pane)
  assert.ok(la1.ok, `last-answer: ${la1.err}`); mark('last-answer', la1)
  assert.match(String(la1.data.text), /alfa-ok/i)
  assert.equal(la1.data.source, 'session')
  assert.equal(la1.data.stale, false)
  note(`4. last-answer: ${JSON.stringify(la1.data)}`)
  evidence('4-last-answer.json', JSON.stringify(la1.data, null, 2) + '\n')

  // ---- 5. several lines (a paste), the second turn on the same pane ----
  const s2 = await rig.verb('send', pane, 'Una as duas palavras abaixo com um traco e responda apenas com o resultado:\nbeta\ngama', '--raw')
  assert.ok(s2.ok, `send multi: ${s2.err}`); mark('send several lines', s2)
  const told2 = await waitNotice('finished', finished, 2)
  const n2 = noticeFrom(told2, `terminou · guia ${pane}`)
  assert.match(n2, /beta-gama/i, 'the model got both lines')
  note(`5. send several lines (turn 2 on the same pane), finish notice:\n${n2}`)
  evidence('5-notice-finished-multiline.txt', `${n2}\n`)
  const la2 = await rig.verb('last-answer', pane)
  assert.match(String(la2.data.text), /beta-gama/i)
  assert.ok(Date.parse(String(la2.data.at)) > Date.parse(String(la1.data.at)), 'the second turn has its own answer, later than the first')
  evidence('5-last-answer-turn2.json', JSON.stringify(la2.data, null, 2) + '\n')

  // ---- 6. a permission card: the notice of the watch, the card as the owner is told, `always` refused, answer yes ----
  const s3 = await rig.verb('send', pane, 'Use a ferramenta Bash para rodar exatamente: node -e "setTimeout(()=>{},4000)" e depois responda apenas: pronto', '--raw')
  assert.ok(s3.ok, `send card: ${s3.err}`)
  const toldCard = await waitNotice('permission', asking, 1, 120_000)
  const nCard = noticeFrom(toldCard, `pede permissão · guia ${pane}`)
  assert.match(nCard, /setTimeout/, 'the notice carries the card as it is on the screen')
  assert.match(nCard, /Opções: yes · no\b/)
  assert.doesNotMatch(nCard, /always/)
  note(`6. permission notice:\n${nCard}`)
  evidence('6-notice-permission.txt', `${nCard}\n`)
  const card = await rig.verb('read-screen', pane)
  assert.equal(card.data.state, 'permission')
  evidence('6-card-screen.txt', `${card.data.text ?? JSON.stringify(card.data)}\n`)
  const always = await rig.verb('answer', pane, 'always')
  assert.equal(always.ok, false, 'always does not exist on the Soul')
  assert.equal(always.data.error, 'unsupported')
  const stillCard = await rig.verb('read-screen', pane)
  assert.equal(stillCard.data.state, 'permission', 'nothing was typed: the card is still there')
  note(`6. answer always: ${JSON.stringify(always.data)}; the card is still on the screen`)
  evidence('6-answer-always.json', JSON.stringify(always.data, null, 2) + '\n')
  const yes = await rig.verb('answer', pane, 'yes')
  assert.ok(yes.ok, `answer: ${yes.err}`); mark('answer yes', yes)
  note(`6. answer yes: ${JSON.stringify(yes.data)}`)
  evidence('6-answer-yes.json', JSON.stringify(yes.data, null, 2) + '\n')
  const told3 = await waitNotice('finished', finished, 3)
  const n3 = noticeFrom(told3, `terminou · guia ${pane}`)
  assert.match(n3, /pronto/i, 'the command ran after the yes and the turn went on')
  evidence('6-notice-finished-after-yes.txt', `${n3}\n`)

  // ---- 7. interrupt a running turn ----
  const s4 = await rig.verb('send', pane, 'Escreva uma historia muito longa, de 1500 palavras, sobre um farol.', '--raw')
  assert.ok(s4.ok, `send long: ${s4.err}`)
  await rig.waitFor('the long turn running', async () => {
    const v = await rig.verb('read-screen', pane)
    return v.data.state === 'busy' ? v : undefined
  }, 60_000)
  const stop = await rig.verb('interrupt', pane)
  assert.ok(stop.ok, `interrupt: ${stop.err}`); mark('interrupt', stop)
  assert.equal(stop.data.state, 'stopped')
  const after = await rig.verb('read-screen', pane)
  assert.equal(after.data.state, 'idle')
  assert.match(String(after.data.text), /Interrupted/)
  note(`7. interrupt: ${JSON.stringify(stop.data)}; screen state ${after.data.state}`)
  evidence('7-interrupt.json', JSON.stringify(stop.data, null, 2) + '\n')
  evidence('7-interrupted-screen.txt', `${after.data.text}\n`)
  await rig.waitFor('the slot out of its turn', async () => { const s = await rig.state(pane); return s && !s.turn ? s : undefined }, 20_000)
  const la3 = await rig.verb('last-answer', pane)
  note(`7. last-answer after the interrupt: ${JSON.stringify({ ok: la3.ok, stale: la3.data.stale, source: la3.data.source })}`)
  assert.equal(la3.data.stale, true, 'after an interrupt the last answer is marked stale')

  // ---- 8. command compact (idle) ----
  const cmd = await rig.verb('command', pane, 'compact')
  assert.ok(cmd.ok, `command: ${cmd.err}`); mark('command compact', cmd)
  note(`8. command compact: ${JSON.stringify(cmd.data)}`)
  const compacted = await rig.waitFor('compacted', async () => {
    const v = await rig.verb('read-screen', pane)
    return /Compacted|Summarized/.test(String(v.data.text ?? '')) && v.data.state === 'idle' ? v : undefined
  }, 150_000)
  evidence('8-command-compact.txt', `${JSON.stringify(cmd.data)}\n---\n${compacted.data.text}\n`)
  const la4 = await rig.verb('last-answer', pane)
  note(`9. after compact, last-answer: ${JSON.stringify({ ok: la4.ok, source: la4.data.source, stale: la4.data.stale })}`)

  // ---- 10. the same being opened again with `-P`: no profile dialog ----
  const closed = await rig.verb('close', pane, '--mode', 'forget')
  assert.ok(closed.ok, `close: ${closed.err}`)
  await rig.waitFor('the first soul gone', async () => (await rig.state(pane)) === undefined || !(await rig.state(pane))?.pid ? true : undefined, 60_000)
  const opened2 = await rig.verb('open', 'soul', rig.ser, '--profile', 'soul', '--model', 'cheap', '--effort', 'low', '--name', 'soul · com -P', '--json', '{"args":["-P","ana-teste","--strategy","economy"]}')
  assert.ok(opened2.ok, `open -P: ${opened2.err}`)
  launches++
  const pane2 = String(opened2.data.pane)
  rig.seen.add((await rig.waitFor('the second pane has a pid', async () => (await rig.state(pane2))?.pid ? await rig.state(pane2) : undefined))!.pid!)
  await rig.map([pane2], [owner])
  await client.request({ t: 'attach', slotId: pane2, cols: 120, rows: 40 })
  const booted2 = await idleSeen(pane2).catch((e: Error) => { throw new Error(`${e.message}\n--- the pane's screen ---\n${rig.screens.get(pane2)?.text() ?? '(none)'}`) })
  const noProfile = !rig.dialogs.has(`${pane2}:profile`)
  note(`10. open with -P: profile dialog on the screen: ${!noProfile}; trust dialog on the screen: ${rig.dialogs.has(`${pane2}:trust`)}; at the prompt: ${booted2.data.state}`)
  assert.ok(noProfile, 'with -P no profile dialog appears')
  evidence('10-open-with-P.txt', `${booted2.data.text ?? JSON.stringify(booted2.data)}\n`)

  // ---- evidence and end ----
  evidence('verbs-outcomes.jsonl', rig.outcomes().map(o => JSON.stringify({ argv: o.argv.filter(a => !a.startsWith('{')), status: o.status, data: o.status === 0 ? safeJson(o.stdout) : safeJson(o.stderr) })).join('\n') + '\n')
  evidence('owner-told.log', rig.told())
  note(`soul launches: ${launches}; proven: false on: ${unproven.join(', ') || '(none)'}`)
  if (redactions.length) note(`redacted in the evidence (${redactions.length}): ${redactions.join('; ')}`)
  evidence('summary.txt', `${log.join('\n')}\n`)
  const left = await rig.teardown()
  assert.deepEqual(left, [], 'no process left behind')
})

function safeJson(s: string): unknown { try { return JSON.parse(s) } catch { return s.trim() } }
