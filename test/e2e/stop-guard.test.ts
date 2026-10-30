// A `stop` sent right after the spawn must not kill a young Claude: tetherd waits until the process is at least
// MIN_AGENT_AGE_MS old AND its SessionStart report landed, then kills the tree. Claude Code counts a session that
// dies before it finished starting as a boot strike (three of them turn fullscreen off for the whole machine,
// `fullscreenAutoDisabled` in ~/.claude.json). Real Claude (haiku), through a tetherd of its own.
// Run: node --test --test-concurrency=1 test/e2e/stop-guard.test.ts
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { readEvents } from '../../src/core/store.ts'
import { MIN_AGENT_AGE_MS, type SlotState } from '../../src/daemon/protocol.ts'
import { openSlot, pidAlive, SuiteDaemon } from './daemon-driver.ts'
import { aliveProcs, processTree, type Proc } from './harness.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const logDir = process.env.E2E_LOG_DIR
if (logDir) mkdirSync(logDir, { recursive: true })
const logFile = (name: string) => (logDir ? join(logDir, `${name}-${Date.now()}.jsonl`) : undefined)

const root = mkdtempSync(join(tmpdir(), 'tether-stopguard-'))
const home = join(root, 'home')
const work = join(root, 'work')
mkdirSync(home); mkdirSync(work)
const tag = randomBytes(4).toString('hex')
const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\tether-stopguard-${tag}` : join(home, 'd.sock')
const suite = new SuiteDaemon(home, pipe)
const trees: Proc[][] = []

before(async () => { await suite.connect() })

after(async () => {
  try { await suite.shutdown() } finally {
    const left = await aliveProcs(trees.flat())
    for (let i = 0; i < 5; i++) { try { rmSync(root, { recursive: true, force: true }); break } catch { await sleep(300) } }
    assert.deepEqual(left.map(p => `${p.pid} ${p.name}`), [], 'orphan processes after the suite')
  }
})

test('stop right after the spawn: the Claude lives until it is 12 s old and has reported; then exits confirmed', async (t) => {
  const states: SlotState[] = []
  suite.client.on('state', (s) => { states.push(s) })
  const { slot } = await suite.client.request({ t: 'create', kind: 'claude', cwd: work, args: ['--model', 'haiku'] })
  const slotId = slot!.slotId
  // The harness attaches, starts and drives the TUI (a fresh folder asks for trust; the SessionStart hook
  // reports only after it): the proof below is read from the daemon's state, not from the screen.
  const ready = openSlot(suite.client, slotId, { log: logFile('stop-guard'), startupTimeout: 40_000 }).catch((e: Error) => { t.diagnostic(`harness: ${e.message.split('\n')[0]}`); return undefined })
  const spawnDeadline = Date.now() + 20_000
  while (!states.some(s => s.slotId === slotId && s.pid) && Date.now() < spawnDeadline) await sleep(20)
  const started = states.find(s => s.slotId === slotId && s.pid)
  assert.ok(started, 'the slot spawned')
  const t0 = Date.now()
  const pid = started.pid!
  assert.equal(started.status, 'starting')

  const stopping = suite.client.request({ t: 'stop', slotId }) // sent within milliseconds of the spawn
  await sleep(3_000)
  assert.ok(pidAlive(pid), 'alive 3 s in: not killed young')
  trees.push(await processTree(pid))
  assert.ok(states.some(s => s.slotId === slotId && s.stopping === true && s.pid === pid), 'the client saw `stopping` on the live process')
  const stopped = await stopping
  const elapsed = Date.now() - t0
  t.diagnostic(`stop answered after ${elapsed} ms`)
  const term = await ready
  term?.dispose()

  assert.ok(elapsed >= MIN_AGENT_AGE_MS - 500, `killed only after the minimum age (${elapsed} ms)`)
  assert.equal(stopped.slot!.status, 'exited', 'the run reported its session: exited, not unconfirmed')
  assert.equal(stopped.slot!.pid, undefined)
  assert.equal(stopped.slot!.stopping, undefined)
  assert.match(stopped.slot!.binding?.sessionId ?? '', UUID, 'binding carries the reported session')
  const start = readEvents(home, slotId).find(e => e.kind === 'start')
  assert.ok(start, 'the SessionStart hook wrote the start event before the kill')
  assert.equal(start.sessionId, stopped.slot!.binding?.sessionId, 'the binding is the session this run reported')
  assert.ok(states.some(s => s.slotId === slotId && s.status === 'running' && s.pid === pid), 'the slot was seen running (report landed) before the kill')

  const deadline = Date.now() + 15_000
  while (pidAlive(pid) && Date.now() < deadline) await sleep(100)
  assert.ok(!pidAlive(pid), 'process gone after the stop')
  assert.deepEqual(await aliveProcs(trees[0]!), [], 'the whole tree is gone')
})

test('fullscreen canary: ~/.claude.json has no fullscreenAutoDisabled after the suite', () => {
  const p = join(homedir(), '.claude.json')
  if (!existsSync(p)) return
  const cfg = JSON.parse(readFileSync(p, 'utf8')) as { fullscreenAutoDisabled?: boolean }
  assert.ok(!cfg.fullscreenAutoDisabled, 'fullscreenAutoDisabled is set: a Claude session died before it finished starting; run /tui fullscreen')
})
