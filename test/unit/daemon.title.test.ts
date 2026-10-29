// Live title of a running Claude slot: a /rename lands in the transcript, not in the slot jsonl, so the daemon
// polls the transcript while the slot runs and broadcasts `state` when the title changes; the poll stops with
// the slot. Claude itself is never launched: a fake adapter spawns an inert node process, the transcript is a
// fixture under a temp CLAUDE_CONFIG_DIR, and the title reading is the real claude adapter's.
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { claudeAdapter, encodeProjectDir } from '../../src/agents/claude.ts'
import type { AgentAdapter, LaunchPlan } from '../../src/agents/types.ts'
import type { TetherEvent } from '../../src/core/event.ts'
import { slotEventsPath } from '../../src/core/paths.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { Recorder, removeHome, sleep, tempHome, uniquePipe } from './daemon.helpers.ts'

const POLL_MS = 100
const SESSION = '0b6f1111-2222-4333-8444-555555555555'

let home: string
let daemon: Daemon
let cwd: string
let configDir: string
let transcript: string
const savedConfigDir = process.env.CLAUDE_CONFIG_DIR

function inertPlan(cwd: string): LaunchPlan {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  return { command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd, env }
}

const fakeClaude: AgentAdapter = {
  ...claudeAdapter,
  plan: (input) => inertPlan(input.resume?.cwd ?? input.slot.cwd),
}

const line = (obj: object): string => JSON.stringify(obj) + '\n'

before(async () => {
  home = tempHome()
  cwd = join(home, 'work')
  mkdirSync(cwd)
  configDir = join(home, 'claude-config')
  transcript = join(configDir, 'projects', encodeProjectDir(cwd), `${SESSION}.jsonl`)
  mkdirSync(join(configDir, 'projects', encodeProjectDir(cwd)), { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = configDir
  daemon = await startDaemon({ home, pipe: uniquePipe(home), adapters: { claude: fakeClaude }, titlePollMs: POLL_MS })
})
after(async () => {
  await daemon.close()
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  await removeHome(home)
})

describe('live title of a running claude slot', () => {
  test('title follows the transcript while running; stops following once stopped', async () => {
    const c = await Recorder.connect(daemon.pipe)
    const { slot } = await c.client.request({ t: 'create', kind: 'claude', cwd, start: true })
    const slotId = slot!.slotId
    assert.equal(slot!.status, 'starting')

    // the agent reports its session: binding without title (no transcript yet)
    const ev: TetherEvent = { v: 1, ts: new Date().toISOString(), slotId, agent: 'claude', kind: 'start', source: 'startup', sessionId: SESSION, cwd, resume: { cwd, args: ['--resume', SESSION] } }
    appendFileSync(slotEventsPath(home, slotId), line(ev))
    const running = await c.state(slotId, (s) => s.status === 'running')
    assert.equal(running.title, undefined)

    // the transcript appears with a /rename: the title shows up without any new slot event
    writeFileSync(transcript, line({ type: 'user', message: 'oi' }) + line({ type: 'custom-title', customTitle: 'primeiro nome', sessionId: SESSION }))
    await c.state(slotId, (s) => s.title === 'primeiro nome', 5_000, 'first title')

    // a second /rename
    appendFileSync(transcript, line({ type: 'assistant', message: 'ok' }) + line({ type: 'custom-title', customTitle: 'segundo nome', sessionId: SESSION }))
    await c.state(slotId, (s) => s.title === 'segundo nome', 5_000, 'second title')

    // stopped: the transcript is no longer followed
    await c.client.request({ t: 'stop', slotId })
    await c.state(slotId, (s) => s.status === 'exited')
    appendFileSync(transcript, line({ type: 'custom-title', customTitle: 'depois de parar', sessionId: SESSION }))
    await sleep(POLL_MS * 5)
    assert.ok(!c.states.some((s) => s.slotId === slotId && s.title === 'depois de parar'), 'no title update after stop')

    await c.client.request({ t: 'forget', slotId })
    c.close()
  })
})
