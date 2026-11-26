// C3: the Codex conductor end to end with REAL Codex (gpt-5.6-luna, low effort) in a PRIVATE tetherd (own home, pipe and pane host), driven by the
// verbs of the owner through the real CLI (`node "$TETHER_CLI" agents ...`) run from a test owner: a node process in a shell slot that reads
// commands from a file and runs the CLI with the slot's own environment (the test never reads a key). No app: the test plays its part (the
// desk map and the person's gestures of giving). ONE Codex, in a bench folder new and empty in the tmp dir, for the whole script:
//   1 open: no update dialog, no trust dialog (the conductor's launchArgs)     2 send, one line (Enter 300 ms after the text), the finish notice
//   3 last-answer (K2 file) in the first turn, which also fires the title notice    4 send, several lines (a paste)
//   5 an approval card: the watch's notice (`Opções: yes · always · no`), read-screen, answer yes     6 command compact, idle
//   7 command compact with the agent busy: `busy`, nothing typed        8 interrupt a running turn
// Run alone: node --test --test-concurrency=1 test/e2e/for-agents.codex.test.ts
// Env: C3_RUN_ROOT (where homes live, default os tmpdir), C3_EVIDENCE_DIR (keeps evidence without keys; default none).
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

const runRoot = process.env.C3_RUN_ROOT ?? tmpdir()
const evidenceDir = process.env.C3_EVIDENCE_DIR
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

/** The environment of the test daemon (and so of its agents): no CLAUDE*, no CODEX_HOME and no TETHER_* of the tether this test may run in. */
function cleanDaemonEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^CLAUDE/i.test(k) && !/^TETHER_/i.test(k) && k !== 'CODEX_HOME') env[k] = v
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
    this.root = mkdtempSync(join(runRoot, 'c3-'))
    this.home = join(this.root, 'home')
    this.work = join(this.root, 'owner')
    // The bench is new and empty, outside the house, in the tmp dir: Codex meets the folder for the first time.
    this.bench = mkdtempSync(join(tmpdir(), 'tether-c3-bench-'))
    mkdirSync(this.home); mkdirSync(this.work)
    const id = randomBytes(4).toString('hex')
    const BS = String.fromCharCode(92)
    const winPipe = (n: string): string => [BS, BS, '.', BS, 'pipe', BS, n].join('')
    this.pipe = process.platform === 'win32' ? winPipe(`tether-c3-${id}`) : join(this.home, 'd.sock')
    this.ptydPipe = process.platform === 'win32' ? winPipe(`tether-c3-ptyd-${id}`) : join(this.home, 'ptyd.sock')
  }

  async connect(): Promise<void> {
    const env = cleanDaemonEnv({ TETHER_PANEL_HOST: '1', TETHER_PTYD_PIPE: this.ptydPipe })
    this.client = await DaemonClient.connect({ home: this.home, pipe: this.pipe, client: 'test', mainPath: MAIN, env })
    this.daemonPid = this.client.hello.pid
    this.seen.add(this.daemonPid)
    this.daemon = await claim(this.daemonPid, { cmdIncludes: MAIN, what: 'tetherd (c3)' })
    this.client.on('data', (slotId: string, data: string) => {
      const screen = this.screens.get(slotId) ?? new Screen(120, 40)
      this.screens.set(slotId, screen)
      screen.write(data)
      // Any first-open dialog of Codex (update, trust) is recorded: the launch flags must have made them not appear.
      const text = screen.text()
      if (/Update available|Do you trust|trust the contents|Skip until next version/i.test(text) && !this.firstDialog.has(slotId)) this.firstDialog.set(slotId, text)
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
    const host = await HostClient.ping(this.ptydPipe, this.home).catch(() => undefined)
    if (host) this.seen.add(host.pid)
    for (const pid of [...this.seen].reverse()) {
      if (!pidAlive(pid)) continue
      const owned = await claim(pid, { what: 'c3 e2e process' }).catch(() => undefined)
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


test('C3: the Codex conductor, driven by the verbs of an owner (open, send, cards, compact, interrupt, last-answer, notices)', { timeout: 1_200_000 }, async () => {
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

  // ---- 1. open: the launch flags (no update dialog, no trust dialog); `-a on-request -s read-only` is what makes the approval card appear ----
  assert.equal(readdirSync(rig.bench).length, 0, 'the bench is empty')
  const opened = await rig.verb('open', 'codex', rig.bench, '--model', 'gpt-5.6-luna', '--effort', 'low', '--name', 'codex-bancada', '--json', '{"args":["-a","on-request","-s","read-only"]}')
  assert.ok(opened.ok, `open: ${opened.err}`)
  const pane = String(opened.data.pane)
  mark('open', opened)
  note(`1. open: ${JSON.stringify(opened.data)}`)
  rig.seen.add((await rig.waitFor('the pane has a pid', async () => (await rig.state(pane))?.pid ? await rig.state(pane) : undefined))!.pid!)
  // The app would add the pane to the desk and size it: the test does the same.
  await rig.map([pane], [owner])
  await client.request({ t: 'attach', slotId: pane, cols: 120, rows: 40 })

  const idleSeen = async (timeout = 90_000): Promise<Verb> => rig.waitFor('the agent at its prompt', async () => {
    const v = await rig.verb('read-screen', pane)
    return v.ok && v.data.state === 'idle' ? v : undefined
  }, timeout)
  const booted = await idleSeen().catch((e: Error) => { throw new Error(`${e.message}\n--- the pane's screen ---\n${rig.screens.get(pane)?.text() ?? '(none)'}`) })
  assert.equal(rig.firstDialog.get(pane), undefined, `a first-open dialog appeared:\n${rig.firstDialog.get(pane)}`)
  const bootLog = rig.daemonLog().split('\n').filter(l => /boot: /.test(l))
  assert.deepEqual(bootLog, [], 'the conductor had no dialog to answer')
  note(`1. the agent is at its prompt with no dialog (read-screen state ${booted.data.state})`)
  evidence('1-prompt-screen.txt', `${booted.data.text ?? JSON.stringify(booted.data)}\n`)

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

  // ---- 2. send, one line (raw: through the conductor, Enter 300 ms after the text), and the finish notice with the start of the answer ----
  const s1 = await rig.verb('send', pane, 'Reply only with: alfa-ok', '--raw')
  assert.ok(s1.ok, `send: ${s1.err}`); mark('send one line', s1)
  assert.deepEqual([s1.data.state, s1.data.raw], ['typed', true])
  const told1 = await waitNotice('finished', finished, 1)
  const n1 = noticeFrom(told1, `terminou · guia ${pane}`)
  assert.match(n1, /alfa-ok/, 'the finish notice carries the start of the answer')
  assert.match(n1, new RegExp(`agents last-answer ${pane}`))
  note(`2. send one line (Enter 300 ms after the text), finish notice:\n${n1}`)
  evidence('2-notice-finished.txt', `${n1}\n`)

  // ---- 3. last-answer from the K2 file: the first turn also fires the title notice, which must not be what it reads (read now, and again later) ----
  const la1 = await rig.verb('last-answer', pane)
  assert.ok(la1.ok, `last-answer: ${la1.err}`); mark('last-answer', la1)
  assert.match(String(la1.data.text), /alfa-ok/)
  assert.doesNotMatch(String(la1.data.text), /"title"/)
  assert.equal(la1.data.source, 'codex-notify')
  assert.equal(la1.data.stale, false)
  await sleep(8000)
  const la1b = await rig.verb('last-answer', pane)
  assert.match(String(la1b.data.text), /alfa-ok/, 'the title notice (it may come after the real one) did not replace the answer')
  assert.doesNotMatch(String(la1b.data.text), /"title"/)
  note(`3. last-answer: ${JSON.stringify(la1.data)}; 8 s later: ${JSON.stringify(la1b.data)}`)
  evidence('3-last-answer.json', JSON.stringify({ right_after: la1.data, eight_seconds_later: la1b.data }, null, 2) + '\n')
  const answerFile = join(rig.home, 'slots', `${pane}.answer.json`)
  if (existsSync(answerFile)) {
    const f = JSON.parse(readFileSync(answerFile, 'utf8')) as Record<string, unknown>
    evidence('3-answer-file-shape.json', JSON.stringify({ keys: Object.keys(f), from: f.from, hasTurnId: typeof f.turnId === 'string' }, null, 2) + '\n')
  }

  // ---- 4. several lines (a bracketed paste, 400 ms, Enter) ----
  const s2 = await rig.verb('send', pane, 'Join the two words below with a dash and reply only with the result:\nbeta\ngama', '--raw')
  assert.ok(s2.ok, `send multi: ${s2.err}`); mark('send several lines', s2)
  const told2 = await waitNotice('finished', finished, 2)
  const n2 = noticeFrom(told2, `terminou · guia ${pane}`)
  assert.match(n2, /beta-gama/i, 'the model got both lines')
  note(`4. send several lines, finish notice:\n${n2}`)
  evidence('4-notice-finished-multiline.txt', `${n2}\n`)
  const la2 = await rig.verb('last-answer', pane)
  assert.match(String(la2.data.text), /beta-gama/i)

  // ---- 5. an approval card: the notice of the watch, the card as the owner is told, answer yes ----
  const s3 = await rig.verb('send', pane, 'Use the shell to create the file probe-c3.txt containing the word x (for example with: cmd /c echo x> probe-c3.txt). Then reply only: pronto', '--raw')
  assert.ok(s3.ok, `send card: ${s3.err}`)
  const toldCard = await waitNotice('permission', asking, 1, 120_000).catch(async (e: Error) => {
    const rs = await rig.verb('read-screen', pane)
    const st = await rig.state(pane)
    const head = e.message.split(String.fromCharCode(10))[0]
    throw new Error([head, `--- read-screen state ${rs.data.state}; slot turn=${st?.turn} attention=${st?.attention} ---`, String(rs.data.text), '--- told ---', rig.told().slice(-1500)].join(String.fromCharCode(10)))
  })
  const nCard = noticeFrom(toldCard, `pede permissão · guia ${pane}`)
  assert.match(nCard, /probe-c3\.txt/, 'the notice carries the card as it is on the screen')
  assert.match(nCard, /Opções: yes · always · no/)
  note(`5. permission notice:\n${nCard}`)
  evidence('5-notice-permission.txt', `${nCard}\n`)
  const card = await rig.verb('read-screen', pane)
  assert.equal(card.data.state, 'permission')
  evidence('5-card-screen.txt', `${card.data.text ?? JSON.stringify(card.data)}\n`)
  const yes = await rig.verb('answer', pane, 'yes')
  assert.ok(yes.ok, `answer: ${yes.err}`); mark('answer yes', yes)
  note(`5. answer yes: ${JSON.stringify(yes.data)}`)
  evidence('5-answer-yes.json', JSON.stringify(yes.data, null, 2) + '\n')
  await waitNotice('finished', finished, 3)
  assert.ok(existsSync(join(rig.bench, 'probe-c3.txt')), 'y approved: the command ran')
  const afterCard = await rig.verb('last-answer', pane)
  assert.match(String(afterCard.data.text), /pronto/i)

  // ---- 6. command compact, idle ----
  await idleSeen(60_000)
  const cmd = await rig.verb('command', pane, 'compact')
  assert.ok(cmd.ok, `command: ${cmd.err}`); mark('command compact', cmd)
  note(`6. command compact: ${JSON.stringify(cmd.data)}`)
  const compacted = await rig.waitFor('compacted', async () => {
    const v = await rig.verb('read-screen', pane)
    return /Context compacted/.test(String(v.data.text ?? '')) && v.data.state === 'idle' ? v : undefined
  }, 120_000)
  evidence('6-command-compact.txt', `${JSON.stringify(cmd.data)}\n---\n${compacted.data.text}\n`)

  // ---- 7. command compact with the agent busy: `busy`, and nothing typed ----
  const s4 = await rig.verb('send', pane, 'Write a text of 600 words about the sea, with no tools.', '--raw')
  assert.ok(s4.ok, `send long: ${s4.err}`)
  await rig.waitFor('the agent busy', async () => {
    const v = await rig.verb('read-screen', pane)
    return v.data.state === 'busy' ? v : undefined
  }, 60_000)
  const refused = await rig.verb('command', pane, 'compact')
  assert.equal(refused.ok, false, 'compact is refused while the agent works')
  assert.match(`${refused.err} ${JSON.stringify(refused.data)}`, /busy/)
  const screenBusy = await rig.verb('read-screen', pane)
  assert.doesNotMatch(String(screenBusy.data.text), /\/compact/, 'nothing was typed')
  note(`7. command compact while busy: refused: ${refused.err.slice(0, 200)}; screen state ${screenBusy.data.state}`)
  evidence('7-command-busy.txt', `${refused.err}\n---\n${screenBusy.data.text}\n`)

  // ---- 8. interrupt the running turn ----
  const stop = await rig.verb('interrupt', pane)
  assert.ok(stop.ok, `interrupt: ${stop.err}`); mark('interrupt', stop)
  assert.equal(stop.data.state, 'stopped')
  const after = await rig.verb('read-screen', pane)
  assert.equal(after.data.state, 'idle')
  assert.match(String(after.data.text), /Conversation interrupted/)
  note(`8. interrupt: ${JSON.stringify(stop.data)}; screen state ${after.data.state}`)
  evidence('8-interrupt.json', JSON.stringify(stop.data, null, 2) + '\n')
  evidence('8-interrupted-screen.txt', `${after.data.text}\n`)
  await rig.waitFor('the slot out of its turn', async () => { const s = await rig.state(pane); return s && !s.turn ? s : undefined }, 20_000)
  const la3 = await rig.verb('last-answer', pane)
  assert.equal(la3.data.stale, true, 'after an interrupt the last answer is marked stale')

  // ---- evidence and end ----
  evidence('verbs-outcomes.jsonl', rig.outcomes().map(o => JSON.stringify({ argv: o.argv.filter(a => !a.startsWith('{')), status: o.status, data: o.status === 0 ? safeJson(o.stdout) : safeJson(o.stderr) })).join('\n') + '\n')
  evidence('owner-told.log', rig.told())
  evidence('daemon-log-conductor.txt', rig.daemonLog().split('\n').filter(l => /condutor |boot: |vigia/.test(l)).map(l => l.replace(/^\S+ \[\d+\] /, '')).join('\n') + '\n')
  note(`proven: false on: ${unproven.join(', ') || '(none)'}`)
  if (redactions.length) note(`redacted in the evidence (${redactions.length}): ${redactions.join('; ')}`)
  evidence('summary.txt', `${log.join('\n')}\n`)
  const left = await rig.teardown()
  assert.deepEqual(left, [], 'no process left behind')
})

function safeJson(s: string): unknown { try { return JSON.parse(s) } catch { return s.trim() } }
