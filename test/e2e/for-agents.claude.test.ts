// C1: the Claude conductor end to end with REAL Claude Code (haiku) in a PRIVATE tetherd (own home, pipe and pane host), driven by the
// verbs of the owner through the real CLI (`node "$TETHER_CLI" agents ...`) run from a test owner: a node process in a shell slot that
// reads commands from a file and runs the CLI with the slot's own environment (the test never reads a key). No app: the test plays its
// part (the desk map and the person's gestures of giving). ONE Claude, in a bench folder new and empty outside the house, for the whole
// script, one gesture after the other:
//   1 open in a new folder (the trust dialog is the conductor's boot)   2 send, one line (raw)       3 the finish notice, with the start of the answer
//   4 send, several lines (raw, a paste)   5 last-answer (K2 file)      6 a permission card: the watch's notice, then answer yes
//   7 interrupt a running turn             8 command compact             9 a question of the agent: answer 1
// Run alone: node --test --test-concurrency=1 test/e2e/for-agents.claude.test.ts
// Env: C1_RUN_ROOT (where homes live, default os tmpdir), C1_EVIDENCE_DIR (keeps evidence without keys; default none).
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
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
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

const runRoot = process.env.C1_RUN_ROOT ?? tmpdir()
const evidenceDir = process.env.C1_EVIDENCE_DIR
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

/** The environment of the test daemon (and so of its agents): no CLAUDE* and no TETHER_* of the tether this test may run in. */
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

class Rig {
  readonly root: string
  readonly home: string
  readonly work: string
  readonly bench: string
  readonly pipe: string
  readonly ptydPipe: string
  client!: DaemonClient
  daemon: Owned | undefined
  daemonPid = 0
  readonly seen = new Set<number>()
  readonly screens = new Map<string, Screen>()
  readonly firstDialog = new Map<string, string>()
  private nextId = 1

  constructor() {
    this.root = mkdtempSync(join(runRoot, 'c1-'))
    this.home = join(this.root, 'home')
    this.work = join(this.root, 'owner')
    // The bench is new and empty, outside the house: no CLAUDE.md up the tree, and Claude meets the folder for the first time.
    this.bench = mkdtempSync(join(tmpdir(), 'tether-c1-bench-'))
    mkdirSync(this.home); mkdirSync(this.work)
    const id = randomBytes(4).toString('hex')
    const BS = String.fromCharCode(92)
    const winPipe = (n: string): string => [BS, BS, '.', BS, 'pipe', BS, n].join('')
    this.pipe = process.platform === 'win32' ? winPipe(`tether-c1-${id}`) : join(this.home, 'd.sock')
    this.ptydPipe = process.platform === 'win32' ? winPipe(`tether-c1-ptyd-${id}`) : join(this.home, 'ptyd.sock')
  }

  async connect(): Promise<void> {
    const env = cleanDaemonEnv({ TETHER_PANEL_HOST: '1', TETHER_PTYD_PIPE: this.ptydPipe })
    this.client = await DaemonClient.connect({ home: this.home, pipe: this.pipe, client: 'test', mainPath: MAIN, env })
    this.daemonPid = this.client.hello.pid
    this.seen.add(this.daemonPid)
    this.daemon = await claim(this.daemonPid, { cmdIncludes: MAIN, what: 'tetherd (c1)' })
    this.client.on('data', (slotId: string, data: string) => {
      const screen = this.screens.get(slotId) ?? new Screen(120, 40)
      this.screens.set(slotId, screen)
      screen.write(data)
      if (!this.firstDialog.has(slotId)) {
        const text = screen.text()
        if (text.includes('Quick safety check')) this.firstDialog.set(slotId, text)
      }
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
      const owned = await claim(pid, { what: 'c1 e2e process' }).catch(() => undefined)
      if (owned) await killOwned(owned, { tree: true })
    }
    for (const end = Date.now() + 8_000; [...this.seen].some(pidAlive) && Date.now() < end; await sleep(150));
    const left = [...this.seen].filter(pidAlive).map(String)
    for (const dir of [this.bench, this.root]) {
      if (!dir) continue
      for (let i = 0; i < 5; i++) { try { rmSync(dir, { recursive: true, force: true }); break } catch { await sleep(300) } }
    }
    return left
  }
}

const rigs: Rig[] = []
after(async () => { for (const r of rigs) await r.teardown().catch(() => undefined) })

const count = (text: string, re: RegExp): number => (text.match(re) ?? []).length

test('C1: the Claude conductor, driven by the verbs of an owner (open, send, cards, interrupt, compact, last-answer, notices)', { timeout: 1_200_000 }, async () => {
  const rig = new Rig(); rigs.push(rig)
  await rig.connect()
  const client = rig.client
  const unproven: string[] = []
  const log: string[] = []
  const note = (s: string): void => { log.push(s); console.log(`# ${s}`) }
  const mark = (what: string, v: Verb): void => { if (v.data.proven === false) unproven.push(what) }

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

  // ---- 1. open in a new folder: the conductor's launchArgs (--model haiku) and boot (the trust dialog) ----
  assert.equal(readdirSync(rig.bench).length, 0, 'the bench is empty')
  const opened = await rig.verb('open', 'claude', rig.bench, '--model', 'haiku', '--name', 'bancada', '--json', '{"args":["--permission-mode","default"]}')
  assert.ok(opened.ok, `open: ${opened.err}`)
  const pane = String(opened.data.pane)
  mark('open', opened)
  note(`1. open: ${JSON.stringify(opened.data)}`)
  rig.seen.add((await rig.waitFor('the pane has a pid', async () => (await rig.state(pane))?.pid ? await rig.state(pane) : undefined))!.pid!)
  // The app would add the pane to the desk and size it: the test does the same.
  await rig.map([pane], [owner])
  await client.request({ t: 'attach', slotId: pane, cols: 120, rows: 40 })

  const idleSeen = async (): Promise<Verb> => rig.waitFor('the agent at its prompt', async () => {
    const v = await rig.verb('read-screen', pane)
    return v.ok && v.data.state === 'idle' ? v : undefined
  }, 90_000)
  const booted = await idleSeen().catch((e: Error) => { throw new Error(`${e.message}
--- the pane's screen ---
${rig.screens.get(pane)?.text() ?? '(none)'}`) })
  const trustLog = rig.daemonLog().split('\n').filter(l => l.includes('boot: diálogo de confiança respondido'))
  assert.equal(trustLog.length, 1, 'the conductor answered the trust dialog once')
  assert.ok(rig.firstDialog.get(pane), 'the trust dialog was on the screen')
  note(`1. trust dialog answered once; the agent is at its prompt (read-screen state ${booted.data.state})`)
  evidence('1-trust-dialog.txt', `${rig.firstDialog.get(pane)}\n--- daemon log ---\n${trustLog.map(l => l.replace(/^\S+ \[\d+\] /, '')).join('\n')}\n`)
  evidence('1-prompt-screen.txt', `${booted.data.text ?? JSON.stringify(booted.data)}\n`)

  // Waits for the n-th notice of a kind for this pane at the owner; returns its text.
  const waitNotice = async (label: string, re: RegExp, n: number, timeout = 120_000): Promise<string> => rig.waitFor(`notice ${label} #${n}`, () => {
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
  const s1 = await rig.verb('send', pane, 'Reply only with: alfa-ok', '--raw')
  assert.ok(s1.ok, `send: ${s1.err}`); mark('send one line', s1)
  assert.deepEqual([s1.data.state, s1.data.raw], ['typed', true])
  const told1 = await waitNotice('finished', finished, 1)
  const n1 = noticeFrom(told1, `terminou · guia ${pane}`)
  assert.match(n1, /alfa-ok/, 'the finish notice carries the start of the answer')
  assert.match(n1, new RegExp(`agents last-answer ${pane}`))
  note(`2/3. send one line, finish notice:\n${n1}`)
  evidence('2-3-notice-finished.txt', `${n1}\n`)

  // ---- 5. last-answer from the K2 file ----
  const la1 = await rig.verb('last-answer', pane)
  assert.ok(la1.ok, `last-answer: ${la1.err}`); mark('last-answer', la1)
  assert.match(String(la1.data.text), /alfa-ok/)
  assert.equal(la1.data.source, 'claude-stop')
  assert.equal(la1.data.stale, false)
  note(`5. last-answer: ${JSON.stringify(la1.data)}`)
  evidence('5-last-answer.json', JSON.stringify(la1.data, null, 2) + '\n')

  // ---- 4. several lines (a bracketed paste) ----
  const s2 = await rig.verb('send', pane, 'Join the two words below with a dash and reply only with the result:\nbeta\ngama', '--raw')
  assert.ok(s2.ok, `send multi: ${s2.err}`); mark('send several lines', s2)
  const told2 = await waitNotice('finished', finished, 2)
  const n2 = noticeFrom(told2, `terminou · guia ${pane}`)
  assert.match(n2, /beta-gama/i, 'the model got both lines')
  note(`4. send several lines, finish notice:\n${n2}`)
  evidence('4-notice-finished-multiline.txt', `${n2}\n`)
  const la2 = await rig.verb('last-answer', pane)
  assert.match(String(la2.data.text), /beta-gama/i)

  // ---- 6. a permission card: the notice of the watch, the card as the owner is told, answer yes ----
  const s3 = await rig.verb('send', pane, 'Use the Bash tool to run exactly: mkdir probe-dir-c1   Then reply only: pronto', '--raw')
  assert.ok(s3.ok, `send card: ${s3.err}`)
  const toldCard = await waitNotice('permission', asking, 1, 90_000)
  const nCard = noticeFrom(toldCard, `pede permissão · guia ${pane}`)
  assert.match(nCard, /mkdir probe-dir-c1/, 'the notice carries the card as it is on the screen')
  assert.match(nCard, /Opções: yes · always · no/)
  note(`6. permission notice:\n${nCard}`)
  evidence('6-notice-permission.txt', `${nCard}\n`)
  const card = await rig.verb('read-screen', pane)
  assert.equal(card.data.state, 'permission')
  evidence('6-card-screen.txt', `${card.data.text ?? JSON.stringify(card.data)}\n`)
  const yes = await rig.verb('answer', pane, 'yes')
  assert.ok(yes.ok, `answer: ${yes.err}`); mark('answer yes', yes)
  note(`6. answer yes: ${JSON.stringify(yes.data)}`)
  evidence('6-answer-yes.json', JSON.stringify(yes.data, null, 2) + '\n')
  await waitNotice('finished', finished, 3)
  assert.ok(existsSync(join(rig.bench, 'probe-dir-c1')), 'the digit 1 approved: the command ran')

  // ---- 7. interrupt a running turn ----
  const s4 = await rig.verb('send', pane, 'Use the Bash tool to run exactly: node -e "setTimeout(()=>{},45000)"   Then reply only: dormi', '--raw')
  assert.ok(s4.ok, `send sleep: ${s4.err}`)
  // The sleep may ask first (a card) or run at once: answer a card, then wait for the running turn.
  await rig.waitFor('the sleep running', async () => {
    const v = await rig.verb('read-screen', pane)
    if (v.data.state === 'permission') { const a = await rig.verb('answer', pane, 'yes'); assert.ok(a.ok, a.err); note('7. a second card: answered yes') }
    return v.data.state === 'busy' && /setTimeout/.test(String(v.data.text ?? '')) ? v : undefined
  }, 90_000)
  const stop = await rig.verb('interrupt', pane)
  assert.ok(stop.ok, `interrupt: ${stop.err}`); mark('interrupt', stop)
  assert.equal(stop.data.state, 'stopped')
  const after = await rig.verb('read-screen', pane)
  assert.equal(after.data.state, 'idle')
  assert.match(String(after.data.text), /Interrupted/)
  note(`7. interrupt: ${JSON.stringify(stop.data)}; screen state ${after.data.state}`)
  evidence('7-interrupt.json', JSON.stringify(stop.data, null, 2) + '\n')
  evidence('7-interrupted-screen.txt', `${after.data.text}\n`)
  const slotAfter = await rig.waitFor('the slot out of its turn', async () => { const s = await rig.state(pane); return s && !s.turn ? s : undefined }, 20_000)
  note(`7. the door was told the turn is done: slot has no turn (${JSON.stringify({ turn: slotAfter.turn })})`)
  const la3 = await rig.verb('last-answer', pane)
  assert.equal(la3.data.stale, true, 'after an interrupt the last answer is marked stale')
  note(`7. last-answer after the interrupt: stale=${la3.data.stale}`)

  // ---- 8. command compact (idle) ----
  const cmd = await rig.verb('command', pane, 'compact')
  assert.ok(cmd.ok, `command: ${cmd.err}`); mark('command compact', cmd)
  note(`8. command compact: ${JSON.stringify(cmd.data)}`)
  const compacted = await rig.waitFor('compacted', async () => {
    const v = await rig.verb('read-screen', pane)
    return /Compacted/.test(String(v.data.text ?? '')) && v.data.state === 'idle' ? v : undefined
  }, 120_000)
  evidence('8-command-compact.txt', `${JSON.stringify(cmd.data)}\n---\n${compacted.data.text}\n`)

  // ---- 9. a question of the agent: the card is a question, answered by its number ----
  const s5 = await rig.verb('send', pane, 'Use the AskUserQuestion tool to ask me whether I prefer red or blue. Do nothing else.', '--raw')
  assert.ok(s5.ok, `send question: ${s5.err}`)
  const q = await rig.waitFor('the question on the screen', async () => {
    const v = await rig.verb('read-screen', pane)
    return v.data.state === 'question' ? v : undefined
  }, 90_000)
  evidence('9-question-screen.txt', `${q.data.text}\n`)
  const a1 = await rig.verb('answer', pane, '1')
  assert.ok(a1.ok, `answer 1: ${a1.err}`); mark('answer question', a1)
  note(`9. question answered: ${JSON.stringify(a1.data)}`)
  await rig.waitFor('the agent past the question', async () => {
    const v = await rig.verb('read-screen', pane)
    return v.data.state !== 'question' ? v : undefined
  }, 60_000)
  // Leave the agent quiet before the end: Esc if it started another turn.
  const rest = await rig.verb('read-screen', pane)
  if (rest.data.state === 'busy') await rig.verb('interrupt', pane)

  // ---- evidence and end ----
  evidence('verbs-outcomes.jsonl', rig.outcomes().map(o => JSON.stringify({ argv: o.argv.filter(a => !a.startsWith('{')), status: o.status, data: o.status === 0 ? safeJson(o.stdout) : safeJson(o.stderr) })).join('\n') + '\n')
  evidence('owner-told.log', rig.told())
  note(`proven: false on: ${unproven.join(', ') || '(none)'}`)
  if (redactions.length) note(`redacted in the evidence (${redactions.length}): ${redactions.join('; ')}`)
  evidence('summary.txt', `${log.join('\n')}\n`)
  const left = await rig.teardown()
  assert.deepEqual(left, [], 'no process left behind')
})

function safeJson(s: string): unknown { try { return JSON.parse(s) } catch { return s.trim() } }
