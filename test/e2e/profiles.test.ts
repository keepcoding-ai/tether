// The launch profile on a real Claude, through tetherd: a slot created with "Claude modo dev" (profile args
// --dangerously-skip-permissions) plus TETHER_CLAUDE_ARGS=--model haiku. The claude process' command line must
// carry the profile's flag next to the --session-id tether chose; after a stop (≥ 11 s uptime) and a start, the
// resumed process carries it again with --resume <the same id>. Private TETHER_HOME + pipe; the only kill is
// the daemon's own `stop` (test/kill.ts identity rules apply through the harness). Run: npm run test:e2e
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { readEvents } from '../../src/core/store.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { DaemonSlotTransport, SuiteDaemon } from './daemon-driver.ts'
import { aliveProcs, awaitReady, Terminal, type Proc } from './harness.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

const root = mkdtempSync(join(tmpdir(), 'tether-prof-'))
const home = join(root, 'home')
const work = join(root, 'work')
mkdirSync(home); mkdirSync(work)
const tag = randomBytes(4).toString('hex')
const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\tether-prof-${tag}` : join(home, 'd.sock')
const suite = new SuiteDaemon(home, pipe)
const terminals: Terminal[] = []
const trees: Proc[][] = []

before(async () => {
  // The daemon inherits our env: this is how a dev/E2E run pins the model for every claude launch (server.ts).
  process.env.TETHER_CLAUDE_ARGS = '--model haiku'
  await suite.connect()
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

/** Claude asks once per machine to accept Bypass Permissions mode (a selectable dialog, like the trust one). */
const BYPASS = /bypass permissions mode/i
const BYPASS_YES = /^\s*❯\s*(\d+\.\s*)?Yes, I accept/m
const PROMPT = (s: string): boolean => s.split('\n').some(l => /^❯/.test(l))

/** openSlot (daemon-driver) plus the bypass dialog: accepts it when it shows up, then waits for the idle prompt. */
async function openDev(slotId: string, choice?: 'resume' | 'new'): Promise<{ term: Terminal; state: SlotState; bypassDialog: boolean }> {
  const before = readEvents(home, slotId).filter(e => e.kind === 'start').length
  const attached = await suite.client.request({ t: 'attach', slotId, cols: 120, rows: 40 })
  const transport = new DaemonSlotTransport(suite.client, slotId)
  const term = new Terminal(transport, {})
  if (attached.scrollback) term.screenBuf.write(attached.scrollback)
  terminals.push(term)
  const started = await suite.client.request({ t: 'start', slotId, choice })
  transport.observe(started.slot!)
  await term.waitFor(s => BYPASS.test(s) || /trust this folder/i.test(s) || PROMPT(s), { timeout: 60_000, what: 'bypass dialog, trust dialog or prompt' })
  let bypassDialog = false
  if (BYPASS.test(term.screen())) {
    bypassDialog = true
    term.mark('bypass dialog')
    await term.quiet(500, 10_000)
    for (let attempt = 1; !BYPASS_YES.test(term.screen()); attempt++) {
      term.write('\x1b[B')
      await term.quiet(400, 5_000)
      if (attempt === 4) throw new Error(`cannot select "Yes, I accept"\n--- screen ---\n${term.screen()}`)
    }
    term.write('\r')
    await term.waitFor(s => !BYPASS.test(s) && (/trust this folder/i.test(s) || PROMPT(s)), { timeout: 60_000, what: 'prompt after the bypass dialog' })
  }
  await awaitReady(term)
  trees.push(await term.tree())
  const state = await waitState(slotId, s => s.status === 'running' && s.pid === term.pid && readEvents(home, slotId).filter(e => e.kind === 'start').length > before, 'running with a start event of this run')
  assert.match(state.binding!.sessionId, UUID)
  return { term, state, bypassDialog }
}

async function commandLineOf(term: Terminal): Promise<string> {
  const self = (await term.tree()).find(p => p.pid === term.pid)
  assert.ok(self?.cmd, `command line of pid ${term.pid}`)
  return self.cmd
}

let slot = ''
let sessionId = ''

test('profile "Claude modo dev": the slot state names it and flags unsafe; the claude process got --dangerously-skip-permissions + --model haiku + the session id tether chose', async () => {
  const { profiles } = await suite.client.request({ t: 'profiles-list' })
  const dev = profiles!.find(p => p.id === 'claude-dev')!
  assert.deepEqual([dev.name, dev.agent, dev.args], ['Claude modo dev', 'claude', ['--dangerously-skip-permissions']])
  const created = await suite.client.request({ t: 'create', kind: 'claude', cwd: work, profileId: 'claude-dev' })
  slot = created.slot!.slotId
  assert.equal(created.slot!.profileName, 'Claude modo dev')
  assert.equal(created.slot!.unsafe, true)

  const { term, state, bypassDialog } = await openDev(slot)
  console.log(`# bypass dialog shown: ${bypassDialog}`)
  const cmd = await commandLineOf(term)
  assert.match(cmd, /--dangerously-skip-permissions/, cmd)
  assert.match(cmd, /--model haiku/, cmd)
  const passed = /--session-id ([0-9a-f-]{36})/.exec(cmd)?.[1]
  assert.ok(passed, `--session-id on the command line (cmd: ${cmd})`)
  sessionId = state.binding!.sessionId
  assert.equal(sessionId, passed, 'binding = the id tether passed')
  assert.ok(!/--resume/.test(cmd), 'a new session, not a resume')
  // still unsafe while running; the profile name travels with every state
  const running = await slotState(slot)
  assert.equal(running.unsafe, true)
  assert.equal(running.profileName, 'Claude modo dev')
  // One turn, so Claude writes the transcript (a session killed before any message has none: C15 would refuse the resume).
  await term.type('responda apenas: perfil')
  await term.waitIdle()
  assert.match(term.screen(), /perfil/i)
  await term.kill() // ≥ 11 s uptime, then the daemon's `stop`; the tree is verified gone
  const stopped = await waitState(slot, s => s.status === 'exited' || s.status === 'unconfirmed', 'stopped')
  assert.equal(stopped.status, 'exited', 'this run reported its session: a plain exited')
  assert.equal(stopped.binding?.sessionId, sessionId, 'binding kept after the stop')
})

test('start again: the resumed process carries the profile flag and --resume <the same id>; binding unchanged', async () => {
  const { term, state } = await openDev(slot)
  const cmd = await commandLineOf(term)
  assert.match(cmd, /--dangerously-skip-permissions/, cmd)
  assert.match(cmd, /--model haiku/, cmd)
  assert.ok(cmd.includes(`--resume ${sessionId}`), `resumed with the same id (cmd: ${cmd})`)
  assert.equal(state.binding!.sessionId, sessionId)
  const starts = readEvents(home, slot).filter(e => e.kind === 'start')
  assert.equal(starts.at(-1)!.source, 'resume')
  assert.equal(starts.at(-1)!.sessionId, sessionId)
  await term.exit()
  const s = await waitState(slot, x => x.status === 'exited', 'exited after /exit')
  assert.equal(s.binding?.sessionId, sessionId)
})
