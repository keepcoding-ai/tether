// PRD §5 scenarios for soul-cli, proven THROUGH tetherd the way the app uses it (mirror of claude.scenarios.test.ts):
// a daemon of its own (unique TETHER_HOME + pipe), soul slots created over the protocol, keystrokes via `input`,
// the screen read from `data` with the harness's soul dialect. soul has no --session-id of ours and prints a title
// (not an id) on exit, so the id comes from the client's own report (SOUL_SESSION_REPORT, written by the soul
// process into the slot jsonl); after every step the daemon's `state.binding.sessionId` is compared with that
// jsonl and, where it can be, with soul's own registry of the profile (sessions.jsonl: id + folder). Memory across
// resumes is checked by asking the model for the one word it answered before. Cheap model, one-word prompts,
// sequential. Needs a soul that reports: TETHER_SOUL_CMD="node <soul-cli>/bin/soul" until it is installed.
// Run: node --test test/e2e/soul.scenarios.test.ts   (E2E_LOG_DIR=<dir> keeps the PTY logs)
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
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

// ---------- the agent under test ----------

/** The agent folder soul runs in (sessions are registered per folder: -c picks the last one opened here). */
const work = resolve(process.env.E2E_SOUL_DIR ?? 'C:/agentes/serpente')
const PROFILE = 'guga@codr.studio'
/** Slot args: global config, the profile, and the cheapest strategy/model. */
const SLOT_ARGS = ['-g', '-P', PROFILE, '--strategy', 'anthropic', '--model', 'cheap']
/** What soul's own recipe must carry to find the session again (PRD C17; -H is not exercised: no host at hand). */
const RECIPE_FLAGS = ['-g', '-P', PROFILE]
const registry = join(process.env.SOUL_CLI_CONFIG_DIR ?? join(homedir(), '.soul'), 'profiles', PROFILE, 'sessions.jsonl')

// ---------- suite state ----------

const root = mkdtempSync(join(tmpdir(), 'tether-soul-'))
const home = join(root, 'home')
mkdirSync(home)
const tag = randomBytes(4).toString('hex')
const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\tether-soul-${tag}` : join(home, 'd.sock')
const suite = new SuiteDaemon(home, pipe)
const terminals: Terminal[] = []
const trees: Proc[][] = []
const timings: Record<string, number> = {}

before(async () => {
  assert.ok(existsSync(work), `agent folder ${work}`)
  await suite.connect()
})

after(async () => {
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

async function createSlot(extra: string[] = []): Promise<string> {
  const { slot } = await suite.client.request({ t: 'create', kind: 'soul', cwd: work, args: [...SLOT_ARGS, ...extra] })
  return slot!.slotId
}

/** Binds a slot to a session by hand with soul's own recipe shape (what the app does when the user picks a session). */
function bind(slotId: string, sessionId: string): void {
  const ev: TetherEvent = { v: 1, ts: new Date().toISOString(), slotId, agent: 'soul', kind: 'start', source: 'startup', sessionId, cwd: work, resume: { cwd: work, args: ['-r', sessionId, ...RECIPE_FLAGS] } }
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

/** Waits for a new start event in the slot's jsonl (soul's /branch finishes asynchronously, after the prompt is back). */
async function waitStart(slotId: string, before: number, what: string, timeout = 60_000): Promise<TetherEvent> {
  const deadline = Date.now() + timeout
  while (starts(slotId).length <= before && Date.now() < deadline) await sleep(200)
  assert.ok(starts(slotId).length > before, `timeout waiting for ${what} (start event) of slot ${slotId}`)
  return lastStart(slotId)!
}

/** soul's registry says the session was opened from `work` (independent of tether's own files). */
function registered(sessionId: string): boolean {
  if (!existsSync(registry)) return false
  return readFileSync(registry, 'utf8').split('\n').some(l => {
    try { const r = JSON.parse(l) as { sessionId?: string; folder?: string }; return r.sessionId === sessionId && r.folder === work } catch { return false }
  })
}

/** The recipe soul wrote: `-r <id>` plus the flags that find the session (C17). */
function checkRecipe(start: TetherEvent): void {
  assert.equal(start.cwd, work)
  assert.deepEqual(start.resume, { cwd: work, args: ['-r', start.sessionId, ...RECIPE_FLAGS] }, 'recipe of the start event')
}

/** Opens the slot (resume by default), waits for the agent's start event of THIS run and returns both. */
async function open(slotId: string, opts: { name: string; choice?: 'resume' | 'new' }): Promise<{ term: Terminal; state: SlotState }> {
  const before = starts(slotId).length
  const term = await openSlot(suite.client, slotId, { log: logFile(opts.name), choice: opts.choice, agent: 'soul', minUptimeBeforeKill: 0 })
  terminals.push(term)
  trees.push(await term.tree())
  const state = await waitState(slotId, s => s.status === 'running' && s.pid === term.pid && starts(slotId).length > before, 'running with a start event of this run')
  assert.equal(state.binding?.sessionId, lastStart(slotId)!.sessionId, 'state binding = last start event of the jsonl')
  assert.match(state.binding!.sessionId, UUID)
  checkRecipe(lastStart(slotId)!)
  return { term, state }
}

/** The command line of the soul process of this terminal (the pty root: `node bin/soul <args>`). */
async function commandLine(term: Terminal): Promise<string> {
  const self = (await term.tree()).find(p => p.pid === term.pid)
  return self?.cmd ?? ''
}

/** Text of the last assistant answer on screen: from its " ● " line down to the " ▪ connected" line / the input box
 *  (the agent may answer in character, over several lines; the spinner line " ● Doing…" never shows when idle). */
function lastAnswer(term: Terminal): string {
  const lines = term.screen().split('\n')
  let start = -1
  for (let i = lines.length - 1; i >= 0; i--) if (/^\s*●\s*\S/.test(lines[i]!)) { start = i; break }
  if (start < 0) return ''
  const out: string[] = []
  for (let i = start; i < lines.length && !/^\s*▪ connected|^[╭─]/.test(lines[i]!); i++) out.push(lines[i]!.replace(/^\s*●\s*/, '').trim())
  return out.join(' ').replace(/\s+/g, ' ').trim()
}

async function ask(term: Terminal, prompt: string): Promise<string> {
  await term.type(prompt)
  await term.waitIdle()
  return lastAnswer(term)
}

/** Plants a fruit in the conversation (one user turn). The agent is a game master in character: it refuses
 *  "respond only with X"-style instructions (and keeps refusing in that conversation), so the fruit goes in as a
 *  story beat. The proof of memory is `recalls`: the fruit must be in the transcript the agent came back with. */
async function seed(term: Terminal, fruit: string): Promise<void> {
  const a = await ask(term, `minha personagem entra na taverna e come uma fruta: ${fruit}. descreva a cena em uma frase.`)
  assert.ok(a.length > 0, `the agent answered something\n${term.screen()}`)
}

/** Asks for the fruit planted earlier in this session: the proof that the right session came back. */
async function recalls(term: Terminal, fruit: string): Promise<void> {
  const a = await ask(term, 'que fruta minha personagem comeu na taverna nesta conversa? responda só o nome da fruta')
  assert.match(a, new RegExp(fruit, 'i'), `the model remembers "${fruit}"; answered: ${JSON.stringify(a)}\n${term.screen()}`)
}

/** /exit: slot exited, binding kept and marked ended, the farewell printed a resume hint (none for a conversation
 *  that never got a message: soul has no title to print then). */
async function exitSlot(slotId: string, term: Terminal, expectId: string, opts: { hint?: boolean } = {}): Promise<void> {
  await term.exit()
  if (opts.hint !== false) assert.ok(term.resumeHint !== undefined, `the 'soul --resume "<title>"' hint printed on exit\n${term.screen()}`)
  const s = await waitState(slotId, x => x.status === 'exited', 'exited after /exit')
  assert.equal(s.pid, undefined)
  assert.equal(s.binding?.sessionId, expectId, 'binding kept after exit')
  assert.equal(s.binding?.ended, true, 'binding marked ended (end event arrived)')
  const last = events(slotId).at(-1)!
  assert.equal(last.kind, 'end', 'last jsonl event is the end')
  assert.equal(last.source, 'exit')
  assert.equal(last.sessionId, expectId)
}

// ---------- scenarios ----------

let slot1 = ''
let S1 = '' // the session C1 created; C2/C3/C4/C9/C10/C14 resume it (never two at once)

test('C1: new session → binding = the id soul reported (source startup, recipe -r/-g/-P); registry agrees', () => timed('C1', async () => {
  slot1 = await createSlot()
  const { term, state } = await open(slot1, { name: 'c1' })
  const start = lastStart(slot1)!
  assert.equal(start.source, 'startup')
  assert.equal(state.binding!.cwd, work)
  S1 = state.binding!.sessionId
  assert.ok(!/(^|\s)-r\s/.test(await commandLine(term)), 'a new session: no -r on the command line')
  await seed(term, 'abacaxi')
  assert.ok(registered(S1), `soul's registry lists ${S1} for ${work}`)
  await exitSlot(slot1, term, S1)
}))

test('C10: after /exit, start again resumes the same id (source resume) and the model remembers', () => timed('C10', async () => {
  const { term, state } = await open(slot1, { name: 'c10' })
  assert.equal(state.binding!.sessionId, S1)
  assert.equal(lastStart(slot1)!.source, 'resume')
  assert.equal(state.binding!.ended, false)
  await recalls(term, 'abacaxi')
  await exitSlot(slot1, term, S1)
}))

test('C2 + C17: a new slot bound to an existing id resumes it; the process got -r <id> -g -P <profile>', () => timed('C2', async () => {
  const slot = await createSlot()
  bind(slot, S1)
  await waitState(slot, s => s.binding?.sessionId === S1 && s.status === 'exited', 'hand binding picked up')
  const { term, state } = await open(slot, { name: 'c2' })
  assert.equal(state.binding!.sessionId, S1)
  assert.equal(lastStart(slot)!.source, 'resume')
  const cmd = await commandLine(term)
  assert.match(cmd, new RegExp(`-r ${S1} -g -P ${PROFILE.replace('.', '\\.')}`), `resume recipe on the command line: ${cmd}`)
  await recalls(term, 'abacaxi')
  await exitSlot(slot, term, S1)
}))

test('C3: -c in the slot args → binding = the session soul picked = the last one opened in this folder (S1)', () => timed('C3', async () => {
  const slot = await createSlot(['-c'])
  const { term, state } = await open(slot, { name: 'c3' })
  assert.ok(/(^|\s)-c(\s|$)/.test(await commandLine(term)), 'started with -c')
  assert.equal(state.binding!.sessionId, S1, 'soul continued the last session opened in the folder')
  assert.equal(lastStart(slot)!.source, 'continue')
  await recalls(term, 'abacaxi')
  await exitSlot(slot, term, S1)
}))

test('C4: /resume <other id> inside the session → binding switches to it (source resume, title carried)', () => timed('C4', async () => {
  const slot = await createSlot()
  const { term, state } = await open(slot, { name: 'c4' })
  const own = state.binding!.sessionId
  assert.notEqual(own, S1)
  await term.type(`/resume ${S1}`)
  const s = await waitState(slot, x => x.binding?.sessionId === S1, 'binding switched by /resume')
  assert.equal(s.status, 'running')
  const start = lastStart(slot)!
  assert.equal(start.source, 'resume')
  assert.equal(start.sessionId, S1)
  assert.ok(start.title, 'a resumed session carries its title')
  await term.waitIdle()
  await recalls(term, 'abacaxi')
  await exitSlot(slot, term, S1)
}))

test('C5: /clear → binding = the new id (source clear)', () => timed('C5', async () => {
  const slot = await createSlot()
  const { term, state } = await open(slot, { name: 'c5' })
  const old = state.binding!.sessionId
  await seed(term, 'uva')
  await term.type('/clear')
  const s = await waitState(slot, x => x.binding !== undefined && x.binding.sessionId !== old, 'new binding after /clear')
  const fresh = s.binding!.sessionId
  assert.match(fresh, UUID)
  assert.equal(lastStart(slot)!.source, 'clear')
  checkRecipe(lastStart(slot)!)
  await term.waitIdle()
  await seed(term, 'melancia') // the new conversation answers
  await exitSlot(slot, term, fresh)
}))

test('C6: /new → binding = the new id (source new); the old one stays open in a tab but is not the binding', () => timed('C6', async () => {
  const slot = await createSlot()
  const { term, state } = await open(slot, { name: 'c6' })
  const old = state.binding!.sessionId
  await term.type('/new')
  const s = await waitState(slot, x => x.binding !== undefined && x.binding.sessionId !== old, 'new binding after /new')
  const fresh = s.binding!.sessionId
  assert.match(fresh, UUID)
  assert.equal(lastStart(slot)!.source, 'new')
  checkRecipe(lastStart(slot)!)
  await term.waitIdle()
  await exitSlot(slot, term, fresh, { hint: false }) // no message in the new conversation: no title to print
}))

// C7 (/compact): soul sends it to the engine and keeps the same conversation; the client reports nothing for it,
// so there is no start event to check and the binding simply stays: covered by the "same id" assertions elsewhere.

test('C8: /rename x → same id; rename event; title in the state', () => timed('C8', async () => {
  const slot = await createSlot()
  const { term, state } = await open(slot, { name: 'c8' })
  const id = state.binding!.sessionId
  await seed(term, 'kiwi')
  await term.type('/rename titulo-c8')
  const s = await waitState(slot, x => x.title === 'titulo-c8', 'title in state', 15_000)
  assert.equal(s.binding!.sessionId, id)
  const ren = events(slot).find(e => e.kind === 'rename')
  assert.equal(ren?.title, 'titulo-c8'); assert.equal(ren?.sessionId, id)
  assert.equal(starts(slot).length, 1, 'no new start event for a rename')
  await term.waitIdle()
  await exitSlot(slot, term, id)
}))

test('C9a: /branch → binding = the copy (source branch, new id), finished asynchronously', () => timed('C9a', async () => {
  const slot = await createSlot()
  const { term, state } = await open(slot, { name: 'c9-branch' })
  const old = state.binding!.sessionId
  await seed(term, 'pera')
  const n = starts(slot).length
  await term.type('/branch')
  const start = await waitStart(slot, n, 'the branch')
  assert.equal(start.source, 'branch')
  assert.notEqual(start.sessionId, old)
  checkRecipe(start)
  const s = await waitState(slot, x => x.binding?.sessionId === start.sessionId, 'binding = the branch')
  assert.equal(s.status, 'running')
  await term.waitIdle()
  await recalls(term, 'pera') // the branch has the conversation up to the branch point
  await exitSlot(slot, term, start.sessionId)
}))

test('C9b: --fork-session on a bound slot → new id, source fork, memory of the source', () => timed('C9b', async () => {
  const slot = await createSlot(['--fork-session'])
  bind(slot, S1)
  await waitState(slot, s => s.binding?.sessionId === S1, 'hand binding picked up')
  const { term, state } = await open(slot, { name: 'c9-fork' })
  const fork = state.binding!.sessionId
  assert.notEqual(fork, S1)
  assert.equal(lastStart(slot)!.source, 'fork')
  assert.match(await commandLine(term), /--fork-session/, 'the slot arg reached the resumed process')
  await recalls(term, 'abacaxi')
  await exitSlot(slot, term, fork)
}))

test('C11: killed mid-conversation (daemon stop) → exited, binding kept; start resumes the same id with memory', () => timed('C11', async () => {
  const slot = await createSlot()
  const { term, state } = await open(slot, { name: 'c11' })
  const id = state.binding!.sessionId
  await seed(term, 'banana')
  await term.kill() // the daemon's `stop`; verifies the tree is gone
  const s = await waitState(slot, x => x.status === 'exited' || x.status === 'unconfirmed', 'stopped')
  assert.equal(s.status, 'exited', 'this run had reported its session: a plain exited, not unconfirmed')
  assert.equal(s.binding?.sessionId, id, 'binding kept after kill')
  assert.equal(s.binding?.ended, false, 'a kill writes no end event')
  const again = await open(slot, { name: 'c11-resume' })
  assert.equal(again.state.binding!.sessionId, id)
  assert.equal(lastStart(slot)!.source, 'resume')
  await recalls(again.term, 'banana')
  await exitSlot(slot, again.term, id)
}))

test('C12: daemon shutdown with a running slot → new daemon on the same home resumes the same id with memory', () => timed('C12', async () => {
  const slot = await createSlot()
  const { term, state } = await open(slot, { name: 'c12' })
  const id = state.binding!.sessionId
  await seed(term, 'cereja')
  const tree = await term.tree()
  const oldPid = suite.pid
  await suite.shutdown()
  assert.ok(!pidAlive(oldPid))
  await term.exited // the transport reports the exit when the connection drops
  const deadline = Date.now() + 15_000
  while ((await aliveProcs(tree)).length && Date.now() < deadline) await sleep(200)
  assert.deepEqual(await aliveProcs(tree), [], 'the daemon took the soul tree with it')

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

test('C13: two soul slots in the same folder at once → distinct ids, each jsonl only its own', () => timed('C13', async () => {
  const a = await createSlot()
  const b = await createSlot()
  const A = await open(a, { name: 'c13-a' })
  const B = await open(b, { name: 'c13-b' })
  const ida = A.state.binding!.sessionId, idb = B.state.binding!.sessionId
  assert.notEqual(ida, idb)
  await seed(A.term, 'figo')
  await seed(B.term, 'lima')
  for (const [slot, id] of [[a, ida], [b, idb]] as const) {
    assert.ok(events(slot).every(e => e.sessionId === id), `slot ${slot} saw only its own session`)
    assert.ok(registered(id), `registry lists ${id}`)
  }
  const sa = await slotState(a), sb = await slotState(b)
  assert.equal(sa.binding!.sessionId, ida); assert.equal(sb.binding!.sessionId, idb)
  assert.notEqual(sa.pid, sb.pid)
  await exitSlot(a, A.term, ida)
  await recalls(B.term, 'lima') // b is unaffected by a's exit
  await exitSlot(b, B.term, idb)
}))

test('C14: the same session started in a second slot while the first runs → already-open', () => timed('C14', async () => {
  const p = await createSlot()
  bind(p, S1)
  await waitState(p, s => s.binding?.sessionId === S1, 'hand binding picked up')
  const { term } = await open(p, { name: 'c14' })
  const q = await createSlot()
  bind(q, S1)
  await waitState(q, s => s.binding?.sessionId === S1, 'hand binding picked up')
  await assert.rejects(openSlot(suite.client, q, { agent: 'soul' }), (e: DaemonError) => e.code === 'already-open' && e.message.includes(p))
  const sq = await slotState(q)
  assert.equal(sq.status, 'exited'); assert.equal(sq.pid, undefined)
  assert.equal((await slotState(p)).status, 'running', 'the first slot is untouched')
  await exitSlot(p, term, S1)
}))
