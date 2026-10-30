// `tether stop` when nothing answers on the pipe: the store fallback reads the slot's run file. A run owned by a
// tetherd that is still alive is never killed from here (its tree is every agent of every slot: the CLI reports
// it instead); a dead tetherd's agent is killed by itself; a `--here` launcher (no `by`) is killed with its tree.
// Shell slots only (a claude run would wait MIN_AGENT_AGE_MS; that wait is proved in daemon.stop-guard).
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { after, before, describe, test } from 'node:test'
import type { SlotMeta } from '../../src/core/event.ts'
import { processStartTime } from '../../src/core/liveness.ts'
import { createSlot, writeRun } from '../../src/core/store.ts'
import { pidAlive, removeHome, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

const BIN = resolve(import.meta.dirname, '../../bin/tether.mjs')

function tether(env: Record<string, string>, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [BIN, ...args], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

/** An inert process standing in for an agent (or a launcher). */
function inert(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true })
}

describe('tether stop without a daemon', () => {
  let home: string
  let env: Record<string, string>
  let cwd: string
  let n = 0
  const children: ChildProcess[] = []

  function slot(): string {
    const slotId = `cc0000${String(++n).padStart(2, '0')}`
    const meta: SlotMeta = { v: 1, slotId, agent: 'shell', cwd, args: [], createdAt: new Date().toISOString() }
    createSlot(home, meta)
    return slotId
  }

  before(() => {
    home = tempHome()
    cwd = join(home, 'work')
    mkdirSync(cwd)
    env = { TETHER_HOME: home, TETHER_PIPE: uniquePipe(home) } // nobody listens there
  })
  after(async () => {
    for (const c of children) if (c.pid && pidAlive(c.pid)) c.kill()
    await removeHome(home)
  })

  test('a run of a tetherd that is alive but does not answer: refused, nothing killed', async () => {
    const agent = inert()
    children.push(agent)
    const slotId = slot()
    // This test process plays the live tetherd (pid + real start time): the CLI must not taskkill /T it.
    writeRun(home, slotId, { pid: process.pid, startedAt: (await processStartTime(process.pid))!, agentPid: agent.pid!, by: 'tetherd' })
    const r = tether(env, 'stop', slotId)
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(r.stderr, new RegExp(`o tetherd \\(pid ${process.pid}\\) está no ar mas não respondeu`))
    assert.ok(pidAlive(agent.pid!), 'the agent was left alone')
  })

  test('a run of a dead tetherd: only its agent is killed (never the pid of the daemon)', async () => {
    const agent = inert()
    children.push(agent)
    const slotId = slot()
    // pid = this test process with a start time that is not its own: "the tetherd that wrote this is gone".
    writeRun(home, slotId, { pid: process.pid, startedAt: '2000-01-01T00:00:00.000Z', agentPid: agent.pid!, agentStartedAt: (await processStartTime(agent.pid!))!, by: 'tetherd' })
    const r = tether(env, 'stop', slotId)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, new RegExp(`processo ${agent.pid} encerrado`))
    await waitUntil(() => !pidAlive(agent.pid!), 10_000, 'agent gone')
    // and this process (the "daemon" pid) is still here to assert it
  })

  test('a dead tetherd whose agent is gone too: already stopped', async () => {
    const agent = inert()
    const pid = agent.pid!
    const startedAt = (await processStartTime(pid))!
    agent.kill()
    await waitUntil(() => !pidAlive(pid), 10_000, 'agent gone')
    const slotId = slot()
    writeRun(home, slotId, { pid: process.pid, startedAt: '2000-01-01T00:00:00.000Z', agentPid: pid, agentStartedAt: startedAt, by: 'tetherd' })
    const r = tether(env, 'stop', slotId)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, new RegExp(`slot ${slotId} já está parado`))
  })

  test('a `--here` launcher (no `by`): killed with its tree', async () => {
    const launcher = inert()
    children.push(launcher)
    const slotId = slot()
    writeRun(home, slotId, { pid: launcher.pid!, startedAt: (await processStartTime(launcher.pid!))! })
    const r = tether(env, 'stop', slotId)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, new RegExp(`processo ${launcher.pid} encerrado`))
    await waitUntil(() => !pidAlive(launcher.pid!), 10_000, 'launcher gone')
  })
})
