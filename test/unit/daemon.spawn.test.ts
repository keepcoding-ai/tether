// Process management of tetherd:
//   R1 spawnDaemon puts the daemon outside the caller's tree (dead parent) and shares no handles with it;
//   R2 one daemon per pipe under a race; a pipe held by a stranger and a stale pid file are handled clearly;
//   R3 a new daemon reaps the agents a dead daemon left behind, by identity (pid + start time), never anything else;
//   R4 a PTY spawn failure of one slot leaves the daemon serving.
import assert from 'node:assert/strict'
import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { join, resolve } from 'node:path'
import { after, before, describe, test } from 'node:test'
import type { AgentAdapter } from '../../src/agents/types.ts'
import { processStartTime } from '../../src/core/liveness.ts'
import { slotRunPath } from '../../src/core/paths.ts'
import { createSlot, readRun, writeRun } from '../../src/core/store.ts'
import { DaemonClient, spawnDaemon } from '../../src/daemon/client.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { claim, identify, killOwned, type Owned } from '../kill.ts'
import { pidAlive, Recorder, removeHome, sleep, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

const MAIN = resolve(import.meta.dirname, '../../src/daemon/main.ts')
const FIXTURES = resolve(import.meta.dirname, 'fixtures')
const isWin = process.platform === 'win32'

/** A stand-in for the daemon: a node script that just lives for a while. */
function writeSleeper(home: string, ms = 30_000): string {
  const p = join(home, 'sleeper.mjs')
  writeFileSync(p, `setTimeout(() => {}, ${ms})\n`)
  return p
}

function ps(script: string): Promise<string> {
  return new Promise((res, rej) => execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }, (e, so) => (e ? rej(e) : res(so))))
}

async function parentPid(pid: number): Promise<number> {
  const out = await ps(`(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').ParentProcessId`)
  return Number.parseInt(out.trim(), 10)
}

function daemonLog(home: string): string {
  const p = join(home, 'tetherd.log')
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}

/** Pids of tetherd processes that logged `started pid` in this home. */
function startedPids(home: string): number[] {
  return [...daemonLog(home).matchAll(/started pid (\d+)/g)].map((m) => Number(m[1]))
}

async function shutdownDaemon(home: string, pipe: string, pid: number): Promise<void> {
  if (!pidAlive(pid)) return
  const owned = await claim(pid, { cmdIncludes: MAIN, what: 'tetherd' }).catch(() => undefined)
  try {
    const c = await DaemonClient.connect({ home, pipe, client: 'test', spawn: false })
    await c.request({ t: 'shutdown' })
    c.close()
    await waitUntil(() => !pidAlive(pid), 15_000, 'daemon gone')
  } catch {
    if (owned) await killOwned(owned, { tree: true })
  }
}

describe('R1 spawnDaemon: outside the caller\'s tree, nothing inherited', { skip: !isWin && 'Windows-only process model' }, () => {
  let home: string
  const spawned: Owned[] = []
  before(() => { home = tempHome() })
  after(async () => {
    for (const p of spawned) await killOwned(p, { tree: true })
    await removeHome(home)
  })

  test('the daemon\'s parent is already dead and is not this process (a kill of our tree cannot reach it)', async () => {
    const sleeper = writeSleeper(home)
    const pid = await spawnDaemon({ home, pipe: uniquePipe(home), mainPath: sleeper })
    assert.ok(pid, 'spawnDaemon reports the pid')
    const me = await claim(pid, { cmdIncludes: sleeper, what: 'sleeper' })
    spawned.push(me)
    const ppid = await parentPid(pid)
    assert.notEqual(ppid, process.pid, 'not our child')
    await waitUntil(() => !pidAlive(ppid), 5_000, 'the intermediate to exit')
    assert.ok(!pidAlive(ppid), `parent pid ${ppid} is gone`)
    // and a tree kill of this process' children leaves it alone: it is not among them
    const children = await ps(`(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${process.pid}').ProcessId`)
    assert.ok(!children.split(/\s+/).includes(String(pid)))
  })

  test('a raw inheritable handle of the caller does not reach the daemon (the pipe closes with the caller, not with the daemon)', async () => {
    const sleeper = writeSleeper(home)
    const out = await new Promise<string>((res, rej) => execFile('powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(FIXTURES, 'spawn-inherit.ps1'),
        '-node', process.execPath, '-mid', join(FIXTURES, 'spawn-mid.ts'), '-tetherHome', home, '-tetherPipe', uniquePipe(home), '-sleeper', sleeper],
      { windowsHide: true }, (e, so, se) => (e ? rej(new Error(`${e.message}\n${se}`)) : res(so))))
    const m = /midMs=(\d+) eofMs=(\d+) out=(\d+)/.exec(out)
    assert.ok(m, `probe output: ${out}`)
    const [midMs, eofMs, pid] = [Number(m[1]), Number(m[2]), Number(m[3])]
    const daemon = await identify(pid)
    assert.ok(daemon && daemon.cmd?.includes(sleeper), 'the daemon is alive after the probe (so EOF did not come from its death)')
    spawned.push(daemon)
    assert.ok(eofMs - midMs < 1500, `pipe EOF ${eofMs - midMs} ms after the intermediate exited: the daemon holds no inherited handle`)
  })
})

describe('R2 one daemon per pipe', { skip: !isWin && 'Windows-only process model' }, () => {
  test('two clients spawning at once: exactly one tetherd survives and both are connected to it', async () => {
    const home = tempHome()
    const pipe = uniquePipe(home)
    let pid = 0
    try {
      const [a, b] = await Promise.all([
        DaemonClient.connect({ home, pipe, client: 'test' }),
        DaemonClient.connect({ home, pipe, client: 'test' }),
      ])
      pid = a.hello.pid
      assert.equal(b.hello.pid, pid, 'both clients talk to the same daemon')
      assert.equal(Number(readFileSync(join(home, 'tetherd.pid'), 'utf8').trim()), pid)
      await sleep(1500) // the loser's own exit
      const started = startedPids(home)
      assert.deepEqual(started, [pid], `exactly one daemon started: ${daemonLog(home)}`)
      const others = [...daemonLog(home).matchAll(/^\S+ \[(\d+)\] (.*)$/gm)].filter((m) => Number(m[1]) !== pid)
      for (const m of others) assert.match(m[2]!, /already running|taken by tetherd|exiting/, `the other process left on purpose: ${m[0]}`)
      for (const other of new Set(others.map((m) => Number(m[1])))) assert.ok(!pidAlive(other), `loser pid ${other} is gone`)
      a.close(); b.close()
    } finally {
      await shutdownDaemon(home, pipe, pid)
      await removeHome(home)
    }
  })

  test('pipe held by a stranger: the client fails fast in Portuguese without spawning; main.ts leaves with a log line (no loop)', async () => {
    const home = tempHome()
    const pipe = uniquePipe(home)
    const stranger: Server = createServer((s) => { s.on('data', () => s.destroy()) })
    await new Promise<void>((r) => stranger.listen(pipe, r))
    try {
      const t0 = Date.now()
      await assert.rejects(DaemonClient.connect({ home, pipe, client: 'test' }), /ocupado por um programa que não é o tetherd/)
      assert.ok(Date.now() - t0 < 5_000, 'gave up quickly')
      assert.equal(startedPids(home).length, 0, 'no daemon was spawned over it')
      const r = spawnSync(process.execPath, [MAIN], { env: { ...process.env, TETHER_HOME: home, TETHER_PIPE: pipe }, encoding: 'utf8', timeout: 30_000, windowsHide: true })
      assert.equal(r.status, 2, r.stderr)
      assert.match(r.stderr, /ocupado por um programa que não é o tetherd/)
      assert.match(daemonLog(home), /taken by a process that is not a tetherd/)
    } finally {
      await new Promise<void>((r) => stranger.close(() => r()))
      await removeHome(home)
    }
  })

  test('stale pid file pointing at a reused pid: logged and taken over, the other process untouched', async () => {
    const home = tempHome()
    const pipe = uniquePipe(home)
    let pid = 0
    try {
      writeFileSync(join(home, 'tetherd.pid'), `${process.pid}\n`) // alive, but it is this test, not a tetherd
      const c = await DaemonClient.connect({ home, pipe, client: 'test' })
      pid = c.hello.pid
      c.close()
      assert.match(daemonLog(home), new RegExp(`stale pid file: pid ${process.pid} exists but is not a tetherd \\(pid reused by another program\\)`))
      assert.equal(Number(readFileSync(join(home, 'tetherd.pid'), 'utf8').trim()), pid)
    } finally {
      await shutdownDaemon(home, pipe, pid)
      await removeHome(home)
    }
  })
})

describe('R3 orphan reaping by identity', () => {
  let home: string
  let cwd: string
  const sleepers: ChildProcess[] = []
  const startSleeper = (): ChildProcess => {
    const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true })
    sleepers.push(c)
    return c
  }
  before(() => {
    home = tempHome()
    cwd = join(home, 'work')
    mkdirSync(cwd)
  })
  after(async () => {
    for (const c of sleepers) c.kill() // by handle, never by pid
    await removeHome(home)
  })

  test('a new daemon kills only the process that matches pid AND start time; a reused pid and a live owner\'s run are left alone', async () => {
    const [ours, stranger, alive, owner] = [startSleeper(), startSleeper(), startSleeper(), startSleeper()]
    const ids = ['orphan01', 'reused01', 'liveown1']
    for (const id of ids) createSlot(home, { v: 1, slotId: id, agent: 'shell', cwd, args: [], createdAt: new Date().toISOString() })
    const deadDaemon = { pid: 4_000_000, startedAt: '2000-01-01T00:00:00.000Z' } // no such process
    writeRun(home, ids[0]!, { ...deadDaemon, by: 'tetherd', agentPid: ours.pid!, agentStartedAt: (await processStartTime(ours.pid!))! })
    writeRun(home, ids[1]!, { ...deadDaemon, by: 'tetherd', agentPid: stranger.pid!, agentStartedAt: '2000-01-01T00:00:00.000Z' })
    // `owner` stands for another tetherd that is still alive (same pid and start time as its run says)
    writeRun(home, ids[2]!, { pid: owner.pid!, startedAt: (await processStartTime(owner.pid!))!, by: 'tetherd', agentPid: alive.pid!, agentStartedAt: (await processStartTime(alive.pid!))! })

    const log: string[] = []
    const daemon = await startDaemon({ home, pipe: uniquePipe(home), log: (m) => log.push(m) })
    try {
      await waitUntil(() => ours.exitCode !== null || ours.signalCode !== null, 10_000, 'the orphan to be reaped')
      assert.ok(pidAlive(stranger.pid!), 'the process whose start time differs is untouched')
      assert.ok(pidAlive(alive.pid!), 'the run of a live tetherd is untouched')
      assert.ok(log.some((l) => l.includes(`slot orphan01: reaped orphan pid ${ours.pid}`)), log.join('\n'))
      assert.ok(log.some((l) => l.includes(`slot reused01: pid ${stranger.pid} is not the agent tetherd pid ${deadDaemon.pid} launched`)), log.join('\n'))
      assert.ok(log.some((l) => l.includes(`slot liveown1: run owned by live tetherd pid ${owner.pid}; leaving it`)), log.join('\n'))
      assert.equal(readRun(home, ids[0]!), undefined, 'reaped run file removed')
      assert.equal(readRun(home, ids[1]!), undefined, 'stale run file removed')
      assert.ok(readRun(home, ids[2]!), 'the live owner\'s run file stays')
    } finally {
      await daemon.close()
    }
  })

  test('the daemon records its agents in <home>/slots/<id>.run.json (pid + start time, by tetherd) and clears it on exit', async () => {
    const daemon = await startDaemon({ home, pipe: uniquePipe(home) })
    try {
      const c = await Recorder.connect(daemon.pipe)
      const { slot } = await c.client.request({ t: 'create', kind: 'shell', cwd, start: true })
      const id = slot!.slotId
      await waitUntil(() => existsSync(slotRunPath(home, id)), 15_000, 'run file')
      const run = readRun(home, id)!
      assert.equal(run.by, 'tetherd')
      assert.equal(run.pid, process.pid)
      assert.equal(run.agentPid, slot!.pid)
      assert.equal(run.agentStartedAt, await processStartTime(slot!.pid!))
      assert.equal(run.startedAt, await processStartTime(process.pid))
      await c.client.request({ t: 'stop', slotId: id })
      await waitUntil(() => !existsSync(slotRunPath(home, id)), 5_000, 'run file removed')
      c.close()
    } finally {
      await daemon.close()
    }
  })
})

describe('R4 a spawn failure never takes the daemon down', () => {
  let home: string
  let cwd: string
  let daemon: Daemon
  const broken: AgentAdapter = {
    name: 'claude',
    plan: ({ slot }) => ({ command: join(slot.cwd, 'nao-existe', 'agente.exe'), args: [], cwd: slot.cwd, env: {} }),
    sessionExists: async () => 'unknown',
    title: async () => undefined,
  }
  before(async () => {
    home = tempHome()
    cwd = join(home, 'work')
    mkdirSync(cwd)
    daemon = await startDaemon({ home, pipe: uniquePipe(home), adapters: { claude: broken } })
  })
  after(async () => {
    await daemon.close()
    await removeHome(home)
  })

  test('the slot goes to error spawn-failed; the daemon keeps answering and other slots keep working', async () => {
    const c = await Recorder.connect(daemon.pipe)
    const { slot } = await c.client.request({ t: 'create', kind: 'claude', cwd })
    await assert.rejects(c.client.request({ t: 'start', slotId: slot!.slotId }), (e: Error & { code?: string }) => e.code === 'spawn-failed')
    const errored = await c.state(slot!.slotId, (s) => s.status === 'error')
    assert.equal(errored.error?.code, 'spawn-failed')
    assert.ok(daemon.listening())
    const shell = await c.client.request({ t: 'create', kind: 'shell', cwd, start: true })
    assert.equal(shell.slot!.status, 'running')
    assert.ok(pidAlive(shell.slot!.pid!))
    await c.client.request({ t: 'stop', slotId: shell.slot!.slotId })
    c.close()
  })
})
