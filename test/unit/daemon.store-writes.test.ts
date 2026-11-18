// The daemon's own files go through the slot store: no synchronous fs write from server.ts in the loop, barriers before the
// replies that promise a file, and a hard death in the middle of a burst of writes loses at most the queue (C4).
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs, { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { after, test } from 'node:test'
import { pausePath, slotMetaPath, slotPauseRequestPath, slotsDir } from '../../src/core/paths.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { pidAlive, Recorder, removeHome, sleep, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

const homes: string[] = []
const daemons: Daemon[] = []
const children: number[] = []
after(async () => {
  for (const pid of children) if (pidAlive(pid)) try { process.kill(pid) } catch { /* gone */ }
  for (const d of daemons) await d.close()
  for (const h of homes) await removeHome(h)
})

const WRITERS = ['writeFileSync', 'renameSync', 'rmSync', 'unlinkSync', 'mkdirSync', 'appendFileSync', 'copyFileSync', 'rmdirSync'] as const

/** Counts the synchronous fs writes whose caller is server.ts (the builtin's ESM exports are re-synced, so named imports see the spy). */
function countServerSyncWrites(): { count: () => string[]; restore: () => void } {
  const hits: string[] = []
  const f = fs as unknown as Record<string, (...a: unknown[]) => unknown>
  const saved = new Map<string, (...a: unknown[]) => unknown>()
  for (const name of WRITERS) {
    const orig = f[name]!
    saved.set(name, orig)
    f[name] = function (this: unknown, ...args: unknown[]) {
      // Frame 0 is "Error", 1 this spy, 2 the direct caller: only a call written in server.ts counts (the modules it calls
      // into, like the profile store or the ronda channel, belong to later slices).
      const caller = (new Error().stack ?? '').split('\n')[2] ?? ''
      if (/[\\/]src[\\/]daemon[\\/]server\.ts/.test(caller)) hits.push(`${name}(${String(args[0])})`)
      return orig.apply(this, args)
    }
  }
  syncBuiltinESMExports()
  return {
    count: () => hits,
    restore: () => { for (const [name, orig] of saved) f[name] = orig; syncBuiltinESMExports() },
  }
}

test('requests that write files make no synchronous fs write from server.ts, and the barriers hold before the reply', async () => {
  const home = tempHome()
  homes.push(home)
  mkdirSync(join(home, 'work'))
  const probe = countServerSyncWrites()
  try {
    const daemon = await startDaemon({ home, pipe: uniquePipe(home), readyFallbackMs: 60_000, minAgentAgeMs: 0, memoryIntervalMs: 0 })
    daemons.push(daemon)
    const rec = await Recorder.connect(daemon.pipe)
    const create = async (name: string, start = false): Promise<string> =>
      (await rec.client.request({ t: 'create', kind: 'shell', cwd: join(home, 'work'), name, ...(start ? { start: true } : {}) })).slot!.slotId
    const a = await create('a')
    assert.ok(existsSync(slotMetaPath(home, a)), 'create: the meta is on disk at the reply')
    const b = await create('b', true)
    await rec.state(b, (s) => s.status === 'running', 15_000)

    await rec.client.request({ t: 'rename-slot', slotId: a, name: 'renamed' })
    assert.equal((JSON.parse(readFileSync(slotMetaPath(home, a), 'utf8')) as { name?: string }).name, 'renamed', 'rename: on disk at the reply')

    const batch = (await rec.client.request({ t: 'pause-start', slotIds: [a, b] })).pause!
    assert.equal((JSON.parse(readFileSync(pausePath(home), 'utf8')) as { id: string }).id, batch.id, 'pause-start: pause.json at the reply')
    assert.ok(existsSync(slotPauseRequestPath(home, a)), 'pause-start: request file at the reply')
    await rec.client.request({ t: 'pause-cancel' })
    assert.ok(!existsSync(slotPauseRequestPath(home, a)), 'pause-cancel: request file gone at the reply')

    await rec.client.request({ t: 'stop', slotId: b })
    await rec.client.request({ t: 'forget', slotId: a })
    assert.ok(!existsSync(slotMetaPath(home, a)), 'forget: the meta is gone at the reply')
    // The removal's own watcher event must not bring the forgotten slot back.
    await sleep(400)
    assert.ok(!daemon.slots().some((s) => s.slotId === a), 'a forgotten slot is not adopted back')
    rec.close()
    await daemon.close()
    const meta = JSON.parse(readFileSync(slotMetaPath(home, b), 'utf8')) as { endedAt?: string }
    assert.ok(meta.endedAt, 'close drained the store: endedAt of the stopped slot is on disk')
    assert.deepEqual(probe.count(), [], 'no synchronous fs write from server.ts')
  } finally {
    probe.restore()
  }
})

const CHILD = join(import.meta.dirname, 'daemon.store-writes.child.ts')

test('C4: a daemon killed in the middle of a burst of writes boots with every slot, no torn file, and only the queue lost', async () => {
  const home = tempHome()
  homes.push(home)
  const N = 10
  const child = spawn(process.execPath, [CHILD, home, uniquePipe(home), String(N)], { stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child.pid!)
  let stderr = ''
  child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
  const acked = new Map<string, number>()
  let ids: string[] | undefined
  let burst = false
  let lines = 0
  createInterface({ input: child.stdout }).on('line', (line) => {
    lines++
    if (line.startsWith('ready ')) ids = JSON.parse(line.slice(6)) as string[]
    else if (line === 'burst') burst = true
    else if (line.startsWith('ack ')) {
      const [, id, r] = line.split(' ')
      acked.set(id!, Math.max(acked.get(id!) ?? 0, Number(r)))
    }
  })
  await waitUntil(() => burst || child.exitCode !== null, 60_000, `the child's burst (stderr: ${stderr})`)
  assert.ok(ids && burst, `child failed: ${stderr}`)
  await sleep(700) // well inside the burst: renames queued and in flight in the io worker
  child.kill() // TerminateProcess on Windows / SIGTERM elsewhere with no handler: no drain, no teardown
  await new Promise<void>((r) => child.exitCode !== null ? r() : child.once('exit', () => r()))
  assert.ok(acked.size > 0, `some renames were acknowledged before the kill (lines ${lines}, stderr: ${stderr})`)

  // No torn file: every meta parses.
  const names = readdirSync(slotsDir(home))
  for (const id of ids) {
    const text = readFileSync(slotMetaPath(home, id), 'utf8')
    assert.doesNotThrow(() => JSON.parse(text), `meta of ${id} is whole`)
  }

  const daemon = await startDaemon({ home, pipe: uniquePipe(home), memoryIntervalMs: 0 })
  daemons.push(daemon)
  const loaded = new Map(daemon.slots().map((s) => [s.slotId, s]))
  for (const id of ids) {
    const s = loaded.get(id)
    assert.ok(s, `slot ${id} loaded after the kill`)
    const round = Number(/^r-(\d+)$/.exec(s.name ?? '')?.[1])
    assert.ok(Number.isInteger(round), `slot ${id} has a name the child wrote (${s.name})`)
    assert.ok(round >= (acked.get(id) ?? 0), `slot ${id}: an acknowledged rename is never lost (disk r-${round}, acked r-${acked.get(id)})`)
  }
  await daemon.close()
  const temps = readdirSync(slotsDir(home)).filter((n) => n.endsWith('.tmp'))
  assert.deepEqual(temps, [], `the boot removed the dead writer's temp files (before: ${names.filter((n) => n.endsWith('.tmp')).length})`)
})
