// E2E of the faults feature reaching an agent, with REAL Claude Code (haiku) in a PRIVATE tetherd (temp TETHER_HOME and
// TETHER_USER_DIR, a seeded fault registry). A Claude profile with `features: { faults: true }` launches a slot with
// `--plugin-dir <share>/faults/claude-plugin`, whose skills/ holds the five skills the person types plus the hidden agent
// skill (fault-context). The person's `/tether:fault-list` shows the seeded fault; `/tether:fault-investigate <id>` makes the
// agent run `tether faults investigate` and `note` through $TETHER_CLI, so the fault becomes `investigating` and the note's
// author is the pane's name. What the MODEL is offered is read from the session transcript (the skill listing Claude Code
// hands the model): the person-skills (disable-model-invocation) are absent, fault-context is there. Kills go through
// test/kill.ts (pid + identity). Run: node --test test/e2e/faults-agent.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { findTranscript } from '../../src/agents/claude.ts'
import { CLAUDE_PLUGIN_DIR } from '../../src/agents/claude-plugin.ts'
import { readState, record } from '../../src/core/faults.ts'
import { cleanShares, shareRootOf } from '../../src/daemon/share.ts'
import { DaemonClient } from '../../src/daemon/client.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { openSlot, pidAlive } from './daemon-driver.ts'
import { aliveProcs, type Proc, type Terminal } from './harness.ts'

const root = resolve(import.meta.dirname, '..', '..')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const logDir = process.env.E2E_LOG_DIR
if (logDir) mkdirSync(logDir, { recursive: true })

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
async function waitUntil(cond: () => boolean, timeoutMs: number, what: string, diag?: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timeout (${timeoutMs} ms) waiting for ${what}${diag ? `\n${diag()}` : ''}`)
    await sleep(250)
  }
}

const PERSON_SKILLS = ['fault-list', 'fault-investigate', 'fault-done', 'fault-tag', 'fault-note']
const PANE_NAME = 'Painel das falhas'

test('a claude slot with the faults feature gets the skills: /tether:fault-list shows the seeded fault, /tether:fault-investigate marks it and notes it as the pane', { timeout: 480_000 }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'tether-faults-agent-'))
  const home = join(base, 'home'); mkdirSync(home)
  const userDir = join(base, 'user'); mkdirSync(userDir)
  const work = join(base, 'work'); mkdirSync(work)
  const pipe = `\\\\.\\pipe\\tether-faults-agent-${process.pid}`
  // Launched from inside a Claude session: every CLAUDE* variable goes (the child would skip its transcript otherwise).
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^CLAUDE/i.test(k)) env[k] = v
  env.TETHER_USER_DIR = userDir
  // The seeded registry (the daemon, the slot and the CLI all read this TETHER_USER_DIR).
  const dir = join(userDir, 'faults')
  const seeded = record({ proc: 'main', kind: 'uncaught', message: "Cannot find module './impl/format'", stack: "Error: Cannot find module './impl/format'\n    at load (D:\\x\\app\\main\\settings.ts:41:5)", context: { slot: 's-1' } },
    { dir, now: () => Date.now() - 600_000, version: '0.9.3', commit: 'abc1234def', mapper: null })!
  const id = seeded.shortId
  const owned: Owned[] = []
  const trees: Proc[][] = []
  let client: DaemonClient | undefined
  let tetherd: Owned | undefined
  let term: Terminal | undefined
  try {
    client = await DaemonClient.connect({ home, pipe, client: 'test', env, startTimeoutMs: 30_000 })
    tetherd = await claim(client.hello.pid, { cmdIncludes: daemonMain, what: 'tetherd' })

    const { profile } = await client.request({ t: 'profile-save', profile: { name: 'Claude com falhas', agent: 'claude', args: ['--model', 'haiku'], features: { faults: true, bridge: false } } })
    const created = await client.request({ t: 'create', kind: 'claude', cwd: work, name: PANE_NAME, profileId: profile!.id })
    const slotId = created.slot!.slotId
    term = await openSlot(client, slotId, { log: logDir ? join(logDir, `faults-agent-${Date.now()}.jsonl`) : undefined })
    trees.push(await term.tree())
    const self = trees[0]!.find(p => p.pid === term!.pid)
    assert.ok(self?.cmd, 'the claude process has a command line')

    // 1. The command line: --plugin-dir <share>/faults/claude-plugin, with the five skills and the hidden one in skills/.
    const composed = join(shareRootOf(home), 'faults')
    const plugin = join(composed, CLAUDE_PLUGIN_DIR)
    assert.ok(self!.cmd!.includes(`--plugin-dir ${plugin}`) || self!.cmd!.includes(`--plugin-dir "${plugin}"`), `--plugin-dir ${plugin} on the command line: ${self!.cmd}`)
    assert.deepEqual(readdirSync(join(plugin, 'skills')).sort(), [...PERSON_SKILLS, 'fault-context'].sort())
    const sessionId = /--session-id ([0-9a-f-]{36})/.exec(self!.cmd!)?.[1]
    assert.ok(sessionId, 'the session id')
    const state = (await client.request({ t: 'list' })).slots!.find(s => s.slotId === slotId)!
    assert.deepEqual(state.features, ['faults'], 'the daemon says what the agent launched with')

    // 2. The person types /tether:fault-list: the answer carries the seeded fault's id.
    await term.type('/tether:fault-list')
    await term.waitIdle({ timeout: 180_000 })
    const listScreen = term.screen()
    assert.ok(listScreen.includes(id), `the list shows the fault ${id}\n--- screen ---\n${listScreen}`)
    assert.equal(readState(dir).state.faults[seeded.sig]!.status, 'open', 'listing changes nothing')

    // 3. What the model is offered (the skill listing in the transcript): fault-context yes, the person-skills no.
    const transcript = findTranscript({ sessionId: sessionId!, cwd: work })
    assert.ok(transcript, `the session's transcript (${sessionId})`)
    const text = readFileSync(transcript!, 'utf8')
    const offered = skillListings(text)
    console.log(`skills offered to the model: ${JSON.stringify(offered)}`)
    assert.ok(offered.length > 0, 'the transcript carries a skill listing')
    assert.ok(offered.some(n => n.endsWith('fault-context')), `the model is offered fault-context (${offered.join(', ')})`)
    for (const s of PERSON_SKILLS) assert.ok(!offered.some(n => n.endsWith(s)), `the model is not offered ${s} (${offered.join(', ')})`)

    // 4. /tether:fault-investigate <id>: the fault becomes investigating, authored by the pane, and a note exists.
    await term.type(`/tether:fault-investigate ${id}`)
    const get = () => readState(dir).state.faults[seeded.sig]
    await waitUntil(() => get()?.status === 'investigating', 240_000, 'status investigating', () => term!.screen())
    await waitUntil(() => (get()?.notes ?? []).length > 0, 240_000, 'a note', () => term!.screen())
    await term.waitIdle({ timeout: 120_000 })
    const after = get()!
    assert.equal(after.investigating?.by, PANE_NAME, 'the author is the pane name (TETHER_SLOT_ID), without --by')
    assert.equal(after.notes[0]!.author, PANE_NAME)
    assert.ok(after.notes[0]!.text.trim().length > 0)
    assert.notEqual(after.status, 'done', 'no fix applied, nothing closed')
    console.log(`note by ${after.notes[0]!.author}: ${after.notes[0]!.text.slice(0, 200)}`)

    await term.exit(); term.dispose(); term = undefined
  } finally {
    if (term) { try { if (term.alive) await term.kill() } catch { /* already gone */ } term.dispose() }
    for (const p of owned) await killOwned(p)
    if (client && tetherd) {
      try { await client.request({ t: 'shutdown' }) } catch { /* already gone */ }
      const deadline = Date.now() + 20_000
      while (pidAlive(tetherd.pid) && Date.now() < deadline) await sleep(100)
      if (pidAlive(tetherd.pid)) await killOwned(tetherd, { tree: true })
      client.close()
    }
    const left = await aliveProcs(trees.flat())
    cleanShares(home) // the composed folders' links go first, one by one, never followed
    for (let i = 0; i < 10; i++) { try { rmSync(base, { recursive: true, force: true }); break } catch { await sleep(500) } }
    assert.deepEqual(left.map(p => `${p.pid} ${p.name}`), [], 'orphan processes after the test')
  }
})

/** The skill names in the listings Claude Code put in front of the model (`- name: description` lines of any record that mentions them). */
function skillListings(transcript: string): string[] {
  const names = new Set<string>()
  for (const line of transcript.split('\n')) {
    if (!line.includes('fault-')) continue
    const decoded = (() => { try { return JSON.stringify(JSON.parse(line)) } catch { return line } })().replace(/\\n/g, '\n')
    for (const m of decoded.matchAll(/^- ([\w:.-]*fault-[\w-]*)\b/gm)) names.add(m[1]!)
  }
  return [...names]
}
