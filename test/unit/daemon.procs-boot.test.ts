// Boot of the background-process manager: 48 cards with long histories are read through the executor, never by a
// synchronous fs call from procs.ts, proc-manager.ts or the run-file helpers; acts leave their files on disk at the reply.
import assert from 'node:assert/strict'
import fs, { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { after, test } from 'node:test'
import { procAdoptPath, procCardPath, procEventsPath, procsDir } from '../../src/core/paths.ts'
import { HostClient } from '../../src/procd/client.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { normalizeRecipe, type ProcCard, type ProcEvent } from '../../src/daemon/procs.ts'
import { Recorder, removeHome, tempHome, uniquePipe } from './daemon.helpers.ts'

const homes: string[] = []
const daemons: Daemon[] = []
after(async () => {
  for (const d of daemons) await d.close()
  for (const h of homes) await removeHome(h)
})

const READERS = ['readFileSync', 'readdirSync', 'existsSync', 'statSync', 'lstatSync', 'openSync', 'readSync'] as const

/** Sync fs calls whose direct caller is one of the process model's files (named imports see the spy after the re-sync). */
function spyModelReads(): { hits: string[]; restore: () => void } {
  const hits: string[] = []
  const f = fs as unknown as Record<string, (...a: unknown[]) => unknown>
  const saved = new Map<string, (...a: unknown[]) => unknown>()
  for (const name of READERS) {
    const orig = f[name]!
    saved.set(name, orig)
    f[name] = function (this: unknown, ...args: unknown[]) {
      const caller = (new Error().stack ?? '').split('\n')[2] ?? ''
      if (/[\/]src[\/](daemon[\/](procs|proc-manager)|procd[\/]protocol)\.ts/.test(caller)) hits.push(`${name}(${String(args[0])})`)
      return orig.apply(this, args)
    }
  }
  syncBuiltinESMExports()
  return { hits, restore: () => { for (const [name, orig] of saved) f[name] = orig; syncBuiltinESMExports() } }
}

test('boot with 48 cards and long histories reads nothing synchronously and keeps every card', async () => {
  const home = tempHome()
  homes.push(home)
  const cwd = home
  mkdirSync(procsDir(home), { recursive: true })
  const card = (name: string): ProcCard => ({ v: 1, name, ...normalizeRecipe({ command: 'node', args: ['x.mjs'], cwd }), registeredBy: { kind: 'external', user: 'u' }, createdAt: '2026-11-11T10:00:00.000Z' })
  const ts = (i: number): string => new Date(Date.parse('2026-11-11T10:00:00.000Z') + i * 1000).toISOString()
  let big = 0
  for (let n = 0; n < 48; n++) {
    const name = `proc-${String(n).padStart(2, '0')}`
    writeFileSync(procCardPath(home, name), JSON.stringify(card(name), null, 2))
    const events: ProcEvent[] = [{ v: 1, ts: ts(0), kind: 'registered' }]
    const runs = n === 0 ? 520 : 2 // one long history (~100 KB)
    for (let r = 1; r <= runs; r++) {
      events.push({ v: 1, ts: ts(r * 3), kind: 'started', run: r, pid: 1000 + r }, { v: 1, ts: ts(r * 3 + 1), kind: 'ended', run: r, code: 0, at: ts(r * 3 + 1), cause: 'own' })
    }
    if (n === 1) events.push({ v: 1, ts: ts(9000), kind: 'started', run: 3, pid: 999_999 }) // lost with a host that is not there
    if (n === 2) { events.push({ v: 1, ts: ts(9000), kind: 'adopted', run: 1, pid: 999_998 }); writeFileSync(procAdoptPath(home, name), JSON.stringify({ v: 1, pid: 999_998, startedAt: 'gone', adoptedAt: ts(8999) })) }
    const text = events.map((e) => JSON.stringify(e)).join('\n') + '\n'
    big = Math.max(big, text.length)
    writeFileSync(procEventsPath(home, name), text)
  }
  assert.ok(big > 90_000, `a long history (${big} bytes)`)

  const probe = spyModelReads()
  let daemon: Daemon
  try {
    daemon = await startDaemon({ home, pipe: uniquePipe(home), memoryIntervalMs: 0, connectProcHost: () => HostClient.open(uniquePipe(home)), procHostReconnectMs: 100 })
    daemons.push(daemon)
  } finally { probe.restore() }
  assert.deepEqual(probe.hits, [], 'no synchronous read from the process model during boot')

  const rec = await Recorder.connect(daemon.pipe)
  const list = (await rec.client.request({ t: 'proc-list' })).procs!
  assert.equal(list.length, 48)
  assert.equal(list.find((p) => p.name === 'proc-01')!.status, 'host-lost', 'a live run with no host ended with it')
  assert.equal(list.find((p) => p.name === 'proc-02')!.status, 'exited', 'an adopted process that is gone ended as external')
  assert.equal(list.find((p) => p.name === 'proc-00')!.status, 'exited')
  const info = await rec.client.request({ t: 'proc-info', name: 'proc-00' })
  assert.equal(info.events!.length, 20)

  // The act leaves its files on disk at the reply (barrier), and the history grows by appends.
  const r = await rec.client.request({ t: 'proc-use', name: 'proc-03', duration: '10m', purpose: 'prova', by: { as: 'kai', user: 'guga' } })
  assert.equal(r.proc!.uses?.length, 1)
  assert.match(readFileSync(procEventsPath(home, 'proc-03'), 'utf8'), /use-declared/)
  await rec.client.request({ t: 'proc-release', name: 'proc-03', by: { as: 'kai', user: 'guga' } })
  assert.match(readFileSync(procEventsPath(home, 'proc-03'), 'utf8'), /use-released/)
  await rec.client.request({ t: 'proc-forget', name: 'proc-04' })
  assert.equal(existsSync(procCardPath(home, 'proc-04')), false)
  assert.equal(existsSync(procEventsPath(home, 'proc-04')), false)
  rec.close()
})
