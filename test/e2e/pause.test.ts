// E2E of the polite pause (slice B8) with REAL Claude Code (haiku) in a PRIVATE tetherd (temp home, unique pipe):
// two claude slots run a long task (sequential Bash steps with a short sleep); once both report `turn: busy` the
// batch is started with `pause-start`, and the entries are followed through delivered -> preparing (the agent's ack
// phrase) -> stopped (its note), or stopped-silent when the model does not obey (the test records which one happened,
// with the real text, and does not fail on the model's manners). Then `pause-resume` types the note back through the
// PTY: the turn restarts (busy again) and the transcript carries the "[tether] Retomando a pausa" line with the note.
// Also proves the ball: `turn` is busy while the agent answers and absent after the Stop.
// Run: node --test --test-concurrency=1 test/e2e/pause.test.ts
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { findTranscript } from '../../src/agents/claude-sync.ts'
import type { PauseBatch, PauseEntry } from '../../src/daemon/pause.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { openSlot, SuiteDaemon } from './daemon-driver.ts'
import { aliveProcs, type Proc, type Terminal } from './harness.ts'

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const root = mkdtempSync(join(tmpdir(), 'tether-pause-'))
const home = join(root, 'home')
const work = join(root, 'work')
mkdirSync(home); mkdirSync(work)
const tag = randomBytes(4).toString('hex')
const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\tether-pause-${tag}` : join(home, 'd.sock')
const suite = new SuiteDaemon(home, pipe)
const terminals: Terminal[] = []
const trees: Proc[][] = []
const seen: PauseBatch[] = [] // every `pause` event the daemon broadcast, in order

before(async () => {
  await suite.connect()
  suite.client.on('pause', (b: PauseBatch) => { seen.push(structuredClone(b)) })
})

after(async () => {
  for (const t of terminals) if (t.alive) await t.ensureMinUptime()
  try { await suite.shutdown() } finally {
    for (const t of terminals) t.dispose()
    const left = await aliveProcs(trees.flat())
    for (let i = 0; i < 5; i++) { try { rmSync(root, { recursive: true, force: true }); break } catch { await sleep(300) } }
    assert.deepEqual(left.map(p => `${p.pid} ${p.name}`), [], 'orphan processes after the suite')
  }
})

async function states(): Promise<SlotState[]> { return (await suite.client.request({ t: 'list' })).slots! }
async function waitFor<T>(what: string, fn: () => Promise<T | undefined> | T | undefined, timeout = 120_000): Promise<T> {
  const deadline = Date.now() + timeout
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > deadline) throw new Error(`timeout (${timeout} ms) waiting for ${what}\n--- daemon log ---\n${suite.log().slice(-1500)}`)
    await sleep(250)
  }
}
const entryOf = (b: PauseBatch | undefined, slotId: string): PauseEntry | undefined => b?.entries.find(e => e.slotId === slotId)
const getBatch = async (): Promise<PauseBatch | null> => (await suite.client.request({ t: 'pause-get' })).pause ?? null
const turnOf = async (id: string) => (await states()).find(s => s.slotId === id)?.turn

const TASK = 'Faça este trabalho em 10 passos, UM de cada vez, cada passo numa chamada Bash separada e sequencial (nunca em paralelo, nunca junte passos): '
  + 'no passo N rode `sleep 6; echo passo-N` trocando N pelo número. Depois do passo 10 responda apenas: tudo-pronto.'

test('pause: busy ball, pause-start, delivered/preparing/stopped(-silent) with the agent\'s own words, pause-resume restarts the turn with the note', { timeout: 900_000 }, async () => {
  const slotIds: string[] = []
  for (let i = 0; i < 2; i++) {
    const { slot } = await suite.client.request({ t: 'create', kind: 'claude', cwd: work, args: ['--model', 'haiku'] })
    const id = slot!.slotId
    slotIds.push(id)
    const term = await openSlot(suite.client, id)
    terminals.push(term)
    trees.push(await term.tree())
    assert.equal(await turnOf(id), undefined, 'idle at the prompt: no turn')
  }
  const termOf = (id: string) => terminals[slotIds.indexOf(id)]!

  // ---- the ball: turn busy while the agent works ----
  for (const id of slotIds) await termOf(id).type(TASK)
  for (const id of slotIds) await waitFor(`turn busy of ${id}`, async () => (await turnOf(id)) === 'busy')
  console.log('# ball: both slots turn=busy during the answer')
  await waitFor('first tool step on screen', () => slotIds.some(id => /passo-1\b/.test(termOf(id).screen())))

  // ---- start the batch ----
  const t0 = Date.now()
  const started = (await suite.client.request({ t: 'pause-start' })).pause!
  assert.deepEqual(started.entries.map(e => e.slotId).sort(), [...slotIds].sort(), 'the batch holds both busy slots')
  console.log(`# pause-start: batch ${started.id}, initial states ${started.entries.map(e => e.state).join('/')}`)

  // ---- follow every entry to its end ----
  await waitFor('every entry stopped or stopped-silent', async () => {
    const batch = await getBatch()
    return batch && batch.entries.every(e => e.state === 'stopped' || e.state === 'stopped-silent') ? batch : undefined
  }, 300_000)
  const paused = (await getBatch())!
  assert.equal(paused.state, 'paused')
  const sessionIds = new Map<string, string>()
  const outcome: Record<string, string> = {}
  for (const id of slotIds) {
    const hist = seen.flatMap(x => x.entries.filter(e => e.slotId === id).map(e => e.state)).filter((s, i, arr) => s !== arr[i - 1])
    const e = entryOf(paused, id)!
    outcome[id] = e.state
    console.log(`# slot ${id}: ${hist.join(' > ')} | final=${e.state} | phrase=${JSON.stringify(e.phrase)} | note=${JSON.stringify(e.note)} | +${Math.round((Date.parse(e.since) - t0) / 1000)}s`)
    assert.ok(hist.includes('delivered'), `the request was delivered to ${id} (history: ${hist.join(' > ')})`)
    assert.ok(e.note, 'a stopped entry has a note (the agent\'s own, or the last message as fallback)')
    if (e.state === 'stopped') assert.ok(e.phrase === undefined || hist.includes('preparing'), 'preparing came before stopped when the ack was sent')
    sessionIds.set(id, e.sessionId ?? '')
  }
  // the ball goes out when the turn ends
  for (const id of slotIds) await waitFor(`turn idle of ${id}`, async () => (await turnOf(id)) === undefined, 60_000)
  console.log('# ball: both slots idle after stopping (turn absent)')
  const noteOf = Object.fromEntries(slotIds.map(id => [id, entryOf(paused, id)!.note!]))

  // ---- resume: the PTY gets the note, the turn restarts ----
  const resumed = (await suite.client.request({ t: 'pause-resume' })).pause!
  assert.equal(resumed.state, 'resuming')
  for (const id of slotIds) await waitFor(`turn busy again of ${id}`, async () => (await turnOf(id)) === 'busy', 90_000)
  console.log('# resume: both slots turn=busy again')
  await waitFor('batch closed', async () => { const x = await getBatch(); return x === null || x.state === 'closed' ? true : undefined }, 60_000).catch(() => undefined)
  const last = seen.at(-1)!
  console.log(`# batch final: ${last.state}; entries ${last.entries.map(e => e.state).join('/')}`)

  // the transcript carries the resume line with the note
  for (const id of slotIds) {
    const file = findTranscript({ sessionId: sessionIds.get(id)!, cwd: work })
    assert.ok(file && existsSync(file), `transcript of ${id} found`)
    // the transcript is written a moment after the prompt is accepted: poll
    let raw = readFileSync(file, 'utf8')
    for (let i = 0; i < 40 && !raw.includes('Retomando a pausa'); i++) { await sleep(500); raw = readFileSync(file, 'utf8') }
    const users = raw.split('\n').filter(l => l.includes('"type":"user"')).map(l => l.slice(0, 200)).join(' || ')
    assert.ok(raw.includes('[tether] Retomando a pausa'), `transcript of ${id} (${file}) has the resume line; user lines: ${users}`)
    const probe = JSON.stringify(noteOf[id]!.replace(/\s+/g, ' ').replaceAll('"', "'").trim().slice(0, 25)).slice(1, -1)
    assert.ok(raw.includes(probe), `transcript of ${id} contains the note (${probe})`)
  }
  console.log(`# outcome: ${JSON.stringify(outcome)}`)
})
