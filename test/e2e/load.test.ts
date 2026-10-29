// PRD §8 item 3, light load: 10 claude slots through one tetherd (own TETHER_HOME + pipe), 5 of them in the
// same folder, all started at once (the daemon must never have more than MAX_STARTING in 'starting'), then a
// few rounds of random session switches per slot (/clear, /rename, a one-word prompt), a per-slot word taught
// last, the daemon killed by pid, a new daemon on the same home, every slot started again at once. Expected:
// each slot's binding equals the id derived independently (the transcript file that holds the slot's word, and
// the "claude --resume <id>" hint printed by /exit), no two slots share an id, every model recalls its word.
// Haiku, one-word prompts. Run once: npm run test:e2e (or node --test test/e2e/load.test.ts).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { encodeProjectDir } from '../../src/agents/claude.ts'
import { readEvents } from '../../src/core/store.ts'
import { MAX_STARTING } from '../../src/daemon/server.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { killOwned } from '../kill.ts'
import { openSlot, pidAlive, SuiteDaemon } from './daemon-driver.ts'
import { aliveProcs, type Proc, type Terminal } from './harness.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const logDir = process.env.E2E_LOG_DIR
if (logDir) mkdirSync(logDir, { recursive: true })
const logFile = (name: string) => (logDir ? join(logDir, `${name}-${Date.now()}.jsonl`) : undefined)

const SLOTS = 10
const SHARED = 5
const ROUNDS = 3
const WORDS = ['abacate', 'banana', 'cereja', 'damasco', 'figo', 'goiaba', 'jaca', 'kiwi', 'laranja', 'manga']
/** Accents stripped: the model may "fix" a word's spelling (limao → limão). */
const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '')
const SEED = Number(process.env.LOAD_SEED ?? Date.now() % 100_000)

// ---------- suite state ----------

const root = mkdtempSync(join(tmpdir(), 'tether-load-'))
const home = join(root, 'home')
const shared = join(root, 'shared')
mkdirSync(home); mkdirSync(shared)
const tag = randomBytes(4).toString('hex')
const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\tether-load-${tag}` : join(home, 'd.sock')
const suite = new SuiteDaemon(home, pipe)
const slots: { id: string; cwd: string; word: string; term?: Terminal }[] = []
const trees: Proc[][] = []
const timings: Record<string, number> = {}
const t0 = Date.now()
/** Highest number of slots seen in 'starting' at the same time, per phase (from the daemon's `state` stream). */
const maxStarting: Record<string, number> = {}
const queuedSeen: Record<string, number> = {}
let orphansAfterKill: Proc[] = []

/** Follows the `state` stream of the current client and records the 'starting' high-water mark under `phase`. */
function watchStarting(phase: string): void {
  const status = new Map<string, string>()
  maxStarting[phase] = 0
  queuedSeen[phase] = 0
  suite.client.setMaxListeners(0) // one transport per slot listens too
  suite.client.on('state', (s: SlotState) => {
    status.set(s.slotId, s.status)
    if (s.status === 'queued') queuedSeen[phase] = (queuedSeen[phase] ?? 0) + 1
    let n = 0
    for (const st of status.values()) if (st === 'starting') n++
    if (n > maxStarting[phase]!) maxStarting[phase] = n
  })
}

before(async () => {
  await suite.connect()
  console.log(`# load seed ${SEED}, root ${root}`)
})

after(async () => {
  for (const s of slots) if (s.term?.alive) await s.term.ensureMinUptime()
  try { await suite.shutdown() } finally {
    for (const s of slots) s.term?.dispose()
    const left = await aliveProcs(trees.flat())
    for (let i = 0; i < 5; i++) { try { rmSync(root, { recursive: true, force: true }); break } catch { await sleep(300) } }
    timings.total = Date.now() - t0
    console.log(`# timings ms: ${JSON.stringify(timings)}`)
    console.log(`# max starting: ${JSON.stringify(maxStarting)}; queued states seen: ${JSON.stringify(queuedSeen)}`)
    assert.deepEqual(left.map(p => `${p.pid} ${p.name}`), [], 'orphan processes after the suite')
    assert.deepEqual(orphansAfterKill.map(p => `${p.pid} ${p.name}`), [], 'claude processes survived the daemon kill (killed by pid afterwards)')
  }
})

// ---------- helpers ----------

const timed = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
  const t = Date.now()
  try { return await fn() } finally { timings[name] = Date.now() - t }
}

/** Deterministic PRNG (mulberry32) so a failing run can be replayed with LOAD_SEED. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

async function slotState(slotId: string): Promise<SlotState> {
  const { slots: list } = await suite.client.request({ t: 'list' })
  const s = list!.find(x => x.slotId === slotId)
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

const starts = (slotId: string) => readEvents(home, slotId).filter(e => e.kind === 'start')

/** Opens every slot at once (the daemon queues them) and waits until each is running with a start event of this run. */
async function openAll(phase: string, choice?: 'resume' | 'new'): Promise<void> {
  watchStarting(phase)
  const before = slots.map(s => starts(s.id).length)
  const terms = await Promise.all(slots.map((s, i) => openSlot(suite.client, s.id, { log: logFile(`${phase}-${i}`), choice, startupTimeout: 240_000 })))
  for (const [i, term] of terms.entries()) {
    slots[i]!.term = term
    trees.push(await term.tree())
    const state = await waitState(slots[i]!.id, s => s.status === 'running' && s.pid === term.pid && starts(slots[i]!.id).length > before[i]!, 'running with a start event of this run')
    assert.match(state.binding!.sessionId, UUID)
    assert.equal(state.binding!.sessionId, starts(slots[i]!.id).at(-1)!.sessionId, 'state binding = last start event')
  }
  assert.ok(maxStarting[phase]! <= MAX_STARTING, `${phase}: at most ${MAX_STARTING} slots in 'starting' at once (saw ${maxStarting[phase]})`)
  assert.ok(queuedSeen[phase]! > 0, `${phase}: the queue engaged (${SLOTS} starts at once)`)
}

function lastAnswer(term: Terminal): string {
  const lines = term.screen().split('\n').filter(l => /^●\s*\S/.test(l))
  return lines.at(-1)?.replace(/^●\s*/, '') ?? ''
}

async function ask(term: Terminal, prompt: string): Promise<string> {
  await term.type(prompt)
  await term.waitIdle()
  return lastAnswer(term)
}

/** Teaches the slot its word. The rounds before it answered "responda apenas: ok" several times, so the word is
 *  framed as a secret to keep, not as one more echo; the literal `${SEED_NEEDLE}${word}` is what names the
 *  transcript afterwards (expectedIds). */
const SEED_NEEDLE = 'fruta secreta deste terminal: ' // ASCII only: it is matched against the raw transcript JSON
const seedPrompt = (word: string) => `${SEED_NEEDLE}${word}. Guarde-a para quando eu perguntar. Agora responda apenas: ${word}`
const RECALL_PROMPTS = [
  'qual é a fruta secreta deste terminal? responda só com o nome da fruta',
  'não quero "ok": o nome da fruta secreta que pedi para guardar, só ele, uma palavra',
]

/** Asks for the slot's word; one re-ask with a sharper prompt (logged) if the first answer misses it. Returns the
 *  last answer, so a second miss still fails the assertion. */
async function recall(term: Terminal, slotId: string, word: string): Promise<string> {
  let answer = ''
  for (const [i, prompt] of RECALL_PROMPTS.entries()) {
    answer = await ask(term, prompt)
    if (new RegExp(word, 'i').test(plain(answer))) return answer
    if (i === 0) console.log(`# slot ${slotId}: first recall answered ${JSON.stringify(answer)} instead of "${word}"; asking again`)
  }
  return answer
}

/** Transcripts of a folder (Claude's projects dir) whose text contains `needle`. */
function transcriptsWith(cwd: string, needle: string): string[] {
  const dir = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects', encodeProjectDir(cwd))
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(f => f.endsWith('.jsonl') && readFileSync(join(dir, f), 'utf8').includes(needle)).map(f => f.slice(0, -'.jsonl'.length))
}

/** The id each slot should be bound to, derived from Claude's files alone: the one transcript holding the slot's word. */
function expectedIds(): string[] {
  return slots.map(s => {
    const found = transcriptsWith(s.cwd, `${SEED_NEEDLE}${s.word}`)
    assert.equal(found.length, 1, `exactly one transcript in ${s.cwd} holds "${s.word}": ${JSON.stringify(found)}`)
    return found[0]!
  })
}

// ---------- the run ----------

test('load: 10 slots start at once, never more than MAX_STARTING starting', () => timed('start-all', async () => {
  for (let i = 0; i < SLOTS; i++) {
    const cwd = i < SHARED ? shared : join(root, `own-${i}`)
    if (i >= SHARED) mkdirSync(cwd)
    const { slot } = await suite.client.request({ t: 'create', kind: 'claude', cwd, name: `load-${i}`, args: ['--model', 'haiku'] })
    slots.push({ id: slot!.slotId, cwd, word: WORDS[i]! })
  }
  await openAll('first')
  const ids = slots.map(s => starts(s.id).at(-1)!.sessionId)
  assert.equal(new Set(ids).size, SLOTS, 'all ids distinct')
}))

test(`load: ${ROUNDS} rounds of random switches (/clear, /rename, prompt) per slot; binding follows every /clear`, () => timed('rounds', async () => {
  const random = rng(SEED)
  for (let round = 0; round < ROUNDS; round++) {
    const actions = slots.map(() => ['clear', 'rename', 'prompt'][Math.floor(random() * 3)]!)
    console.log(`# round ${round}: ${actions.join(' ')}`)
    await Promise.all(slots.map(async (s, i) => {
      const term = s.term!
      const old = (await slotState(s.id)).binding!.sessionId
      switch (actions[i]) {
        case 'clear': {
          await term.type('/clear')
          const st = await waitState(s.id, x => x.binding !== undefined && x.binding.sessionId !== old, 'new binding after /clear')
          assert.match(st.binding!.sessionId, UUID)
          assert.equal(starts(s.id).at(-1)!.source, 'clear')
          await term.waitIdle()
          break
        }
        case 'rename':
          await term.type(`/rename r${round}-${i}`)
          await term.waitIdle()
          assert.equal((await slotState(s.id)).binding!.sessionId, old, 'rename keeps the id')
          break
        default:
          assert.match(await ask(term, 'responda apenas: ok'), /ok/i)
          assert.equal((await slotState(s.id)).binding!.sessionId, old, 'a prompt keeps the id')
      }
    }))
  }
  // the word each slot must remember across the daemon kill; it also names the expected transcript (SEED_NEEDLE)
  await Promise.all(slots.map(async s => assert.match(plain(await ask(s.term!, seedPrompt(s.word))), new RegExp(s.word, 'i'))))
  const ids = slots.map(s => starts(s.id).at(-1)!.sessionId)
  assert.equal(new Set(ids).size, SLOTS, 'all ids distinct after the rounds')
  assert.deepEqual((await Promise.all(slots.map(s => slotState(s.id)))).map(s => s.binding!.sessionId), expectedIds(), 'daemon bindings = transcripts holding each word')
}))

test('load: daemon killed by pid → new daemon, all slots resumed at once, zero wrong bindings, words recalled', () => timed('kill-restart', async () => {
  const expected = expectedIds()
  for (const s of slots) await s.term!.ensureMinUptime() // never kill a Claude younger than 11 s (fullscreen canary)
  const treesBefore = await Promise.all(slots.map(s => s.term!.tree()))
  const oldPid = suite.pid
  assert.equal(await killOwned(suite.owned!), 'killed', 'daemon killed by identity (pid + creation time)')
  const gone = Date.now() + 15_000
  while (pidAlive(oldPid) && Date.now() < gone) await sleep(100)
  assert.ok(!pidAlive(oldPid), 'daemon pid gone')
  await Promise.all(slots.map(s => s.term!.exited))
  const deadline = Date.now() + 20_000
  while ((await aliveProcs(treesBefore.flat())).length && Date.now() < deadline) await sleep(300)
  orphansAfterKill = await aliveProcs(treesBefore.flat())
  for (const p of orphansAfterKill) await killOwned(p, { tree: true })
  for (const s of slots) s.term!.dispose()
  suite.pid = 0

  await suite.connect()
  assert.notEqual(suite.pid, oldPid)
  for (const [i, s] of slots.entries()) {
    const st = await slotState(s.id)
    assert.equal(st.status, 'exited', `slot ${i} loaded as exited by the new daemon`)
    assert.equal(st.binding?.sessionId, expected[i], `slot ${i} binding survived the daemon`)
  }
  await openAll('resume')
  const bound = await Promise.all(slots.map(s => slotState(s.id)))
  assert.deepEqual(bound.map(s => s.binding!.sessionId), expected, 'every slot resumed exactly its own session')
  assert.equal(new Set(expected).size, SLOTS, 'no two slots share an id')
  for (const s of slots) assert.equal(starts(s.id).at(-1)!.source, 'resume')
  await Promise.all(slots.map(async s => {
    const a = await recall(s.term!, s.id, s.word)
    assert.match(plain(a), new RegExp(s.word, 'i'), `slot ${s.id} remembers "${s.word}"; answered: ${JSON.stringify(a)}`)
  }))
  await Promise.all(slots.map(async (s, i) => {
    await s.term!.exit()
    assert.equal(s.term!.resumeId, expected[i], 'the "claude --resume <id>" hint printed on exit')
    const st = await waitState(s.id, x => x.status === 'exited', 'exited after /exit')
    assert.equal(st.binding?.sessionId, expected[i])
    assert.equal(st.binding?.ended, true)
  }))
}))

test('fullscreen canary: ~/.claude.json has no fullscreenAutoDisabled after the load', () => {
  const p = join(homedir(), '.claude.json')
  const cfg = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown> : {}
  assert.ok(!cfg.fullscreenAutoDisabled, 'fullscreenAutoDisabled is set: a Claude session died before 10 s of life; run /tui fullscreen')
})
