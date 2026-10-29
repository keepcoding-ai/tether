// PRD §5 scenarios C1–C18 for Claude Code, proven THROUGH tetherd the way the app uses it: a daemon of its own
// (unique TETHER_HOME + pipe), claude slots created over the protocol, keystrokes via `input`, the screen read
// from `data`. After every step the daemon's `state.binding.sessionId` and the slot's jsonl are compared with
// an id known independently (the --session-id on the process command line, the "claude --resume <id>" hint
// printed by /exit, or the transcript file name). Memory across resumes is checked by asking the model for the
// one word it answered before. Haiku only, one-word prompts, sequential. Run: npm run test:e2e
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { findTranscript, lastCustomTitle } from '../../src/agents/claude.ts'
import type { TetherEvent } from '../../src/core/event.ts'
import { slotEventsPath } from '../../src/core/paths.ts'
import { readEvents } from '../../src/core/store.ts'
import { DaemonError } from '../../src/daemon/client.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { openSlot, pidAlive, SuiteDaemon } from './daemon-driver.ts'
import { aliveProcs, type Proc, type Terminal } from './harness.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const logDir = process.env.E2E_LOG_DIR
if (logDir) mkdirSync(logDir, { recursive: true })
const logFile = (name: string) => (logDir ? join(logDir, `${name}-${Date.now()}.jsonl`) : undefined)

// ---------- suite state ----------

const root = mkdtempSync(join(tmpdir(), 'tether-scen-'))
const home = join(root, 'home')
const work = join(root, 'work') // shared folder: sessions here are always addressed by id
mkdirSync(home); mkdirSync(work)
const tag = randomBytes(4).toString('hex')
const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\tether-scen-${tag}` : join(home, 'd.sock')
const suite = new SuiteDaemon(home, pipe)
const terminals: Terminal[] = []
const trees: Proc[][] = []
const timings: Record<string, number> = {}

before(async () => { await suite.connect() })

after(async () => {
  // never kill a young Claude; then take the daemon (and every slot with it) down and check nothing survived
  for (const t of terminals) if (t.alive) await t.ensureMinUptime()
  try { await suite.shutdown() } finally {
    for (const t of terminals) t.dispose()
    const left = await aliveProcs(trees.flat())
    for (let i = 0; i < 5; i++) { try { rmSync(root, { recursive: true, force: true }); break } catch { await sleep(300) } }
    console.log(`# timings ms: ${JSON.stringify(timings)}`)
    assert.deepEqual(left.map(p => `${p.pid} ${p.name}`), [], 'orphan processes after the suite')
  }
})

// ---------- helpers ----------

const timed = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
  const t0 = Date.now()
  try { return await fn() } finally { timings[name] = Date.now() - t0 }
}

async function createSlot(cwd: string, extra: string[] = []): Promise<string> {
  const { slot } = await suite.client.request({ t: 'create', kind: 'claude', cwd, args: ['--model', 'haiku', ...extra] })
  return slot!.slotId
}

/** Binds a slot to a session by hand (what the app does when the user picks a session to attach). */
function bind(slotId: string, sessionId: string, cwd: string): void {
  const ev: TetherEvent = { v: 1, ts: new Date().toISOString(), slotId, agent: 'claude', kind: 'start', source: 'startup', sessionId, cwd, resume: { cwd, args: ['--resume', sessionId] } }
  appendFileSync(slotEventsPath(home, slotId), JSON.stringify(ev) + '\n')
}

async function slotState(slotId: string): Promise<SlotState> {
  const { slots } = await suite.client.request({ t: 'list' })
  const s = slots!.find(x => x.slotId === slotId)
  assert.ok(s, `slot ${slotId} listed`)
  return s
}

async function waitState(slotId: string, pred: (s: SlotState) => boolean, what: string, timeout = 30_000): Promise<SlotState> {
  const deadline = Date.now() + timeout
  for (;;) {
    const s = await slotState(slotId)
    if (pred(s)) return s
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what} of slot ${slotId}; state: ${JSON.stringify(s)}\n--- daemon log ---\n${suite.log().slice(-1500)}`)
    await sleep(200)
  }
}

const events = (slotId: string) => readEvents(home, slotId)
const starts = (slotId: string) => events(slotId).filter(e => e.kind === 'start')
const lastStart = (slotId: string) => starts(slotId).at(-1)

/** Opens the slot (resume by default), waits for the agent's start event of THIS run and returns both. */
async function open(slotId: string, opts: { name: string; choice?: 'resume' | 'new' }): Promise<{ term: Terminal; state: SlotState }> {
  const before = starts(slotId).length
  const term = await openSlot(suite.client, slotId, { log: logFile(opts.name), choice: opts.choice })
  terminals.push(term)
  trees.push(await term.tree())
  const state = await waitState(slotId, s => s.status === 'running' && s.pid === term.pid && starts(slotId).length > before, 'running with a start event of this run')
  assert.equal(state.binding?.sessionId, lastStart(slotId)!.sessionId, 'state binding = last start event of the jsonl')
  assert.match(state.binding!.sessionId, UUID)
  return { term, state }
}

/** Text of the last assistant line on screen (the newest answer; on resume older ones are re-rendered above it). */
function lastAnswer(term: Terminal): string {
  const lines = term.screen().split('\n').filter(l => /^●\s*\S/.test(l))
  return lines.at(-1)?.replace(/^●\s*/, '') ?? ''
}

async function ask(term: Terminal, prompt: string): Promise<string> {
  await term.type(prompt)
  await term.waitIdle()
  return lastAnswer(term)
}

/** Asks the model for the word it answered earlier in this session: the proof that the right session came back. */
async function recalls(term: Terminal, word: string): Promise<void> {
  const a = await ask(term, 'qual palavra você respondeu antes? só ela')
  assert.match(a, new RegExp(word, 'i'), `the model remembers "${word}"; answered: ${JSON.stringify(a)}\n${term.screen()}`)
}

/** /exit: slot exited, binding kept and marked ended, the farewell id equals the binding. */
async function exitSlot(slotId: string, term: Terminal, expectId: string): Promise<void> {
  await term.exit()
  assert.equal(term.resumeId, expectId, 'the "claude --resume <id>" hint printed on exit')
  const s = await waitState(slotId, x => x.status === 'exited', 'exited after /exit')
  assert.equal(s.pid, undefined)
  assert.equal(s.binding?.sessionId, expectId, 'binding kept after exit')
  assert.equal(s.binding?.ended, true, 'binding marked ended (SessionEnd arrived)')
  assert.equal(events(slotId).at(-1)?.kind, 'end', 'last jsonl event is the end')
}

const transcript = (sessionId: string, cwd: string) => findTranscript({ sessionId, cwd })

// ---------- scenarios ----------

let slot1 = ''
let S1 = '' // the session C1 created; C2/C4/C9/C10/C14 resume it (never two at once)

test('C1: new session → binding = the --session-id tether passed; transcript and /exit hint agree', () => timed('C1', async () => {
  slot1 = await createSlot(work)
  const { term, state } = await open(slot1, { name: 'c1' })
  const start = lastStart(slot1)!
  assert.equal(start.source, 'startup')
  assert.equal(start.cwd, work)
  const self = (await term.tree()).find(p => p.pid === term.pid)
  const passed = /--session-id ([0-9a-f-]{36})/.exec(self?.cmd ?? '')?.[1]
  assert.ok(passed, `the claude process got --session-id (cmd: ${self?.cmd})`)
  assert.equal(state.binding!.sessionId, passed)
  assert.equal(state.binding!.cwd, work)
  S1 = passed
  const a = await ask(term, 'responda apenas: abacaxi')
  assert.match(a, /abacaxi/i, `answered: ${a}`)
  assert.ok(transcript(S1, work), 'transcript file named after the binding exists')
  await exitSlot(slot1, term, S1)
}))

test('C10: after /exit, start again resumes the same id and the model remembers', () => timed('C10', async () => {
  const { state } = await open(slot1, { name: 'c10' })
  assert.equal(state.binding!.sessionId, S1)
  assert.equal(lastStart(slot1)!.source, 'resume')
  assert.equal(state.binding!.ended, false)
  await recalls(terminals.at(-1)!, 'abacaxi')
  await exitSlot(slot1, terminals.at(-1)!, S1)
}))

test('C2: a new slot bound to an existing id resumes it', () => timed('C2', async () => {
  const slot = await createSlot(work)
  bind(slot, S1, work)
  await waitState(slot, s => s.binding?.sessionId === S1 && s.status === 'exited', 'hand binding picked up')
  const { term, state } = await open(slot, { name: 'c2' })
  assert.equal(state.binding!.sessionId, S1)
  assert.equal(lastStart(slot)!.source, 'resume')
  await recalls(term, 'abacaxi')
  await exitSlot(slot, term, S1)
}))

test('C3: -c in the slot args → binding = the id Claude picked = the latest transcript of that folder', () => timed('C3', async () => {
  const dir = join(root, 'c3'); mkdirSync(dir)
  const a = await createSlot(dir)
  const first = await open(a, { name: 'c3-first' })
  const prev = first.state.binding!.sessionId
  assert.match(await ask(first.term, 'responda apenas: manga'), /manga/i)
  await exitSlot(a, first.term, prev)
  assert.ok(transcript(prev, dir), 'transcript of the first session exists')

  const b = await createSlot(dir, ['-c'])
  const { term, state } = await open(b, { name: 'c3-continue' })
  const self = (await term.tree()).find(p => p.pid === term.pid)
  assert.ok(!/--session-id/.test(self?.cmd ?? ''), `no --session-id next to -c (cmd: ${self?.cmd})`)
  assert.equal(state.binding!.sessionId, prev, 'Claude continued the latest session of the folder')
  assert.equal(lastStart(b)!.source, 'resume')
  await recalls(term, 'manga')
  await exitSlot(b, term, prev)
}))

test('C4: /resume <other id> inside the session → binding switches to it', () => timed('C4', async () => {
  const slot = await createSlot(work)
  const { term, state } = await open(slot, { name: 'c4' })
  const own = state.binding!.sessionId
  assert.notEqual(own, S1)
  await term.type(`/resume ${S1}`)
  const s = await waitState(slot, x => x.binding?.sessionId === S1, 'binding switched by /resume')
  assert.equal(s.status, 'running')
  const evs = events(slot)
  const end = evs.find(e => e.kind === 'end' && e.sessionId === own)
  assert.equal(end?.source, 'resume', 'old session ended with reason resume')
  assert.equal(lastStart(slot)!.source, 'resume')
  await term.waitIdle()
  await recalls(term, 'abacaxi')
  await exitSlot(slot, term, S1)
}))

test('C5: /clear → binding = the new id (old ended with reason clear)', () => timed('C5', async () => {
  const slot = await createSlot(work)
  const { term, state } = await open(slot, { name: 'c5' })
  const old = state.binding!.sessionId
  assert.match(await ask(term, 'responda apenas: uva'), /uva/i)
  await term.type('/clear')
  const s = await waitState(slot, x => x.binding !== undefined && x.binding.sessionId !== old, 'new binding after /clear')
  const fresh = s.binding!.sessionId
  assert.match(fresh, UUID)
  assert.equal(lastStart(slot)!.source, 'clear')
  assert.equal(events(slot).find(e => e.kind === 'end' && e.sessionId === old)?.source, 'clear')
  await term.waitIdle()
  assert.match(await ask(term, 'responda apenas: ok'), /ok/i)
  assert.ok(transcript(fresh, work), 'transcript of the new session exists')
  await exitSlot(slot, term, fresh)
}))

test('C7: /compact → same id, start event source=compact', () => timed('C7', async () => {
  const slot = await createSlot(work)
  const { term, state } = await open(slot, { name: 'c7' })
  const id = state.binding!.sessionId
  assert.match(await ask(term, 'responda apenas: pera'), /pera/i)
  const n = starts(slot).length
  await term.type('/compact')
  const deadline = Date.now() + 60_000
  while (starts(slot).length === n && Date.now() < deadline) await sleep(200)
  const start = lastStart(slot)!
  assert.equal(start.source, 'compact', `start event after /compact\n${term.screen()}`)
  assert.equal(start.sessionId, id)
  await term.waitIdle()
  assert.equal((await slotState(slot)).binding!.sessionId, id)
  await exitSlot(slot, term, id)
}))

test('C8: /rename x → same id; title reaches the state within the poll window', () => timed('C8', async () => {
  const slot = await createSlot(work)
  const { term, state } = await open(slot, { name: 'c8' })
  const id = state.binding!.sessionId
  assert.match(await ask(term, 'responda apenas: kiwi'), /kiwi/i)
  await term.type('/rename titulo-c8')
  await term.waitIdle()
  const s = await waitState(slot, x => x.title === 'titulo-c8', 'title in state', 15_000)
  assert.equal(s.binding!.sessionId, id)
  assert.equal(lastCustomTitle(transcript(id, work)!), 'titulo-c8')
  assert.equal(starts(slot).length, 1, 'no new start event for a rename')
  await exitSlot(slot, term, id)
}))

test('C9: --fork-session on a bound slot → new id, source fork, context of the source', () => timed('C9', async () => {
  const slot = await createSlot(work, ['--fork-session'])
  bind(slot, S1, work)
  await waitState(slot, s => s.binding?.sessionId === S1, 'hand binding picked up')
  const { term, state } = await open(slot, { name: 'c9' })
  const fork = state.binding!.sessionId
  assert.notEqual(fork, S1)
  assert.equal(lastStart(slot)!.source, 'fork')
  await recalls(term, 'abacaxi')
  assert.ok(transcript(fork, work), 'transcript of the fork exists')
  assert.ok(transcript(S1, work), 'source transcript still exists')
  await exitSlot(slot, term, fork)
}))

let killedId = '' // C11's session; C15 deletes its transcript afterwards

test('C11: killed mid-conversation (stop after ≥ 11 s) → start resumes the same id with memory', () => timed('C11', async () => {
  const slot = await createSlot(work)
  const { term, state } = await open(slot, { name: 'c11' })
  killedId = state.binding!.sessionId
  assert.match(await ask(term, 'responda apenas: banana'), /banana/i)
  await term.kill() // waits for the min uptime, then the daemon's `stop`; verifies the tree is gone
  const s = await waitState(slot, x => x.status === 'exited' || x.status === 'unconfirmed', 'stopped')
  assert.equal(s.status, 'exited', 'this run had reported its session: a plain exited, not unconfirmed')
  assert.equal(s.binding?.sessionId, killedId, 'binding kept after kill')
  const again = await open(slot, { name: 'c11-resume' })
  assert.equal(again.state.binding!.sessionId, killedId)
  assert.equal(lastStart(slot)!.source, 'resume')
  await recalls(again.term, 'banana')
  await exitSlot(slot, again.term, killedId)
}))

test('C12: daemon shutdown with a running slot → new daemon on the same home resumes the same id with memory', () => timed('C12', async () => {
  const slot = await createSlot(work)
  const { term, state } = await open(slot, { name: 'c12' })
  const id = state.binding!.sessionId
  assert.match(await ask(term, 'responda apenas: cereja'), /cereja/i)
  await term.ensureMinUptime()
  const tree = await term.tree()
  const oldPid = suite.pid
  await suite.shutdown()
  assert.ok(!pidAlive(oldPid))
  await term.exited // the transport reports the exit when the connection drops
  const deadline = Date.now() + 15_000
  while ((await aliveProcs(tree)).length && Date.now() < deadline) await sleep(200)
  assert.deepEqual(await aliveProcs(tree), [], 'the daemon took the claude tree with it')

  await suite.connect()
  assert.notEqual(suite.pid, oldPid)
  const s = await slotState(slot)
  assert.equal(s.status, 'exited')
  assert.equal(s.binding?.sessionId, id, 'binding survived the daemon')
  const again = await open(slot, { name: 'c12-resume' })
  assert.equal(again.state.binding!.sessionId, id)
  await recalls(again.term, 'cereja')
  await exitSlot(slot, again.term, id)
}))

test('C13: two claude slots in the same folder at once → distinct ids, each jsonl only its own', () => timed('C13', async () => {
  const a = await createSlot(work)
  const b = await createSlot(work)
  const A = await open(a, { name: 'c13-a' })
  const B = await open(b, { name: 'c13-b' })
  const ida = A.state.binding!.sessionId, idb = B.state.binding!.sessionId
  assert.notEqual(ida, idb)
  assert.match(await ask(A.term, 'responda apenas: figo'), /figo/i)
  assert.match(await ask(B.term, 'responda apenas: lima'), /lima/i)
  for (const [slot, id] of [[a, ida], [b, idb]] as const) {
    assert.ok(events(slot).every(e => e.sessionId === id), `slot ${slot} saw only its own session`)
    assert.ok(transcript(id, work), `transcript of ${id}`)
  }
  const sa = await slotState(a), sb = await slotState(b)
  assert.equal(sa.binding!.sessionId, ida); assert.equal(sb.binding!.sessionId, idb)
  assert.notEqual(sa.pid, sb.pid)
  await exitSlot(a, A.term, ida)
  await recalls(B.term, 'lima') // b is unaffected by a's exit
  await exitSlot(b, B.term, idb)
}))

test('C14: the same session started in a second slot while the first runs → already-open', () => timed('C14', async () => {
  const p = await createSlot(work)
  bind(p, S1, work)
  await waitState(p, s => s.binding?.sessionId === S1, 'hand binding picked up')
  const { term } = await open(p, { name: 'c14' })
  const q = await createSlot(work)
  bind(q, S1, work)
  await waitState(q, s => s.binding?.sessionId === S1, 'hand binding picked up')
  await assert.rejects(openSlot(suite.client, q, {}), (e: DaemonError) => e.code === 'already-open' && e.message.includes(p))
  const sq = await slotState(q)
  assert.equal(sq.status, 'exited'); assert.equal(sq.pid, undefined)
  assert.equal((await slotState(p)).status, 'running', 'the first slot is untouched')
  await exitSlot(p, term, S1)
}))

test('C15: binding to a session whose transcript was deleted → session-missing', () => timed('C15', async () => {
  const file = transcript(killedId, work)
  assert.ok(file, 'C11 left a transcript')
  rmSync(file)
  const slot = await createSlot(work)
  bind(slot, killedId, work)
  await waitState(slot, s => s.binding?.sessionId === killedId, 'hand binding picked up')
  await assert.rejects(openSlot(suite.client, slot, {}), (e: DaemonError) => e.code === 'session-missing' && e.message.includes(killedId))
  const s = await waitState(slot, x => x.status === 'error', 'error state')
  assert.equal(s.error?.code, 'session-missing')
  assert.equal(s.pid, undefined)
  assert.equal(s.binding?.sessionId, killedId, 'binding kept so the user can pick another or a new one')
  // a brand-new id without a transcript is the same case
  const other = await createSlot(work)
  bind(other, randomUUID(), work)
  await waitState(other, x => x.binding !== undefined, 'hand binding picked up')
  await assert.rejects(suite.client.request({ t: 'start', slotId: other }), (e: DaemonError) => e.code === 'session-missing')
}))

test('C16: slot folder deleted → cwd-missing', () => timed('C16', async () => {
  const dir = join(root, 'c16'); mkdirSync(dir)
  const slot = await createSlot(dir)
  rmSync(dir, { recursive: true })
  await assert.rejects(suite.client.request({ t: 'start', slotId: slot }), (e: DaemonError) => e.code === 'cwd-missing' && e.message.includes(dir))
  const s = await waitState(slot, x => x.status === 'error', 'error state')
  assert.equal(s.error?.code, 'cwd-missing')
  assert.equal(s.pid, undefined)
}))

test('C18: the process ran but never reported (no start event) → unconfirmed, start refused without a choice', () => timed('C18', async () => {
  const slot = await createSlot(work, ['--version']) // claude exits before any hook fires: a run without a report
  const started = await suite.client.request({ t: 'start', slotId: slot })
  assert.equal(started.slot!.status, 'starting')
  assert.ok(started.slot!.pid! > 0)
  const s = await waitState(slot, x => x.pid === undefined, 'process gone')
  assert.equal(s.status, 'unconfirmed', `status after an unreported run: ${JSON.stringify(s)}`)
  assert.equal(s.binding, undefined)
  assert.deepEqual(events(slot), [], 'jsonl empty: the agent never reported')
  await assert.rejects(suite.client.request({ t: 'start', slotId: slot }), (e: DaemonError) => e.code === 'unconfirmed')
  assert.equal((await slotState(slot)).status, 'unconfirmed', 'still unconfirmed: nothing was guessed')
}))

test('fullscreen canary: ~/.claude.json has no fullscreenAutoDisabled after the suite', () => {
  const p = join(homedir(), '.claude.json')
  const cfg = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown> : {}
  assert.ok(!cfg.fullscreenAutoDisabled, 'fullscreenAutoDisabled is set: a Claude session died before 10 s of life; run /tui fullscreen')
})
