// E3.5: settings.json and profiles.json live in memory in tetherd. A state broadcast costs no stat or read of them; a file
// edited by someone else (the CLI) is seen by the executor's reload, and a launch-time `fresh()` closes any lag.
import assert from 'node:assert/strict'
import fs, { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { profilesPath, type Profile } from '../../src/core/profile.ts'
import { UserSettings } from '../../src/core/user-settings.ts'
import { createExecutor } from '../../src/exec/executor.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { removeHome, Recorder, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

const homes: string[] = []
const daemons: Daemon[] = []
after(async () => {
  for (const d of daemons) await d.close()
  for (const h of homes) await removeHome(h)
})

const READERS = ['statSync', 'readFileSync', 'existsSync', 'lstatSync', 'openSync'] as const

/** Counts the synchronous fs reads whose direct caller is src/core or src/daemon code (the ops of the executor are not counted). */
function spyReads(): { hits: string[]; restore: () => void } {
  const hits: string[] = []
  const f = fs as unknown as Record<string, (...a: unknown[]) => unknown>
  const saved = new Map<string, (...a: unknown[]) => unknown>()
  for (const name of READERS) {
    const orig = f[name]!
    saved.set(name, orig)
    f[name] = function (this: unknown, ...args: unknown[]) {
      const caller = (new Error().stack ?? '').split('\n')[2] ?? ''
      if (/[\/]src[\/](core|daemon|agents)[\/]/.test(caller)) hits.push(`${name}(${String(args[0])}) from ${caller.trim()}`)
      return orig.apply(this, args)
    }
  }
  syncBuiltinESMExports()
  return { hits, restore: () => { for (const [n, o] of saved) f[n] = o; syncBuiltinESMExports() } }
}

test('500 state broadcasts make no stat or synchronous read of the settings or profiles files', async () => {
  const home = tempHome()
  homes.push(home)
  mkdirSync(join(home, 'work'))
  const daemon = await startDaemon({ home, pipe: uniquePipe(home), readyFallbackMs: 60_000, minAgentAgeMs: 0, memoryIntervalMs: 0 })
  daemons.push(daemon)
  const rec = await Recorder.connect(daemon.pipe)
  const slotId = (await rec.client.request({ t: 'create', kind: 'shell', cwd: join(home, 'work'), name: 'a' })).slot!.slotId
  const spy = spyReads()
  try {
    for (let i = 0; i < 500; i++) await rec.client.request({ t: 'rename-slot', slotId, name: `n${i}` })
    for (let i = 0; i < 20; i++) await rec.client.request({ t: 'list' })
  } finally { spy.restore() }
  assert.deepEqual(spy.hits, [], 'no sync stat/read from core, daemon or agents code')
  rec.close()
})

test('profiles.json edited by the CLI is seen by the next create --profile (fresh before failing, and at launch)', async () => {
  const home = tempHome()
  homes.push(home)
  mkdirSync(join(home, 'work'))
  const daemon = await startDaemon({ home, pipe: uniquePipe(home), readyFallbackMs: 60_000, minAgentAgeMs: 0, memoryIntervalMs: 0 })
  daemons.push(daemon)
  const rec = await Recorder.connect(daemon.pipe)
  const file = JSON.parse(readFileSync(profilesPath(home), 'utf8')) as { v: 1; profiles: Profile[] }
  file.profiles.push({ id: 'edited-by-cli', name: 'Edited by CLI', agent: 'shell', args: [] } as Profile)
  writeFileSync(profilesPath(home), JSON.stringify(file, null, 2))
  const made = await rec.client.request({ t: 'create', kind: 'shell', cwd: join(home, 'work'), profileId: 'edited-by-cli' })
  assert.equal(made.slot!.profileId, 'edited-by-cli')
  await assert.rejects(rec.client.request({ t: 'create', kind: 'shell', cwd: join(home, 'work'), profileId: 'nope' }), (e: { code?: string }) => e.code === 'unknown-profile')
  // The save of tetherd itself lands on disk at the reply, and the memory already has it.
  const saved = await rec.client.request({ t: 'profile-save', profile: { name: 'Mine', agent: 'claude', args: [] } })
  const onDisk = JSON.parse(readFileSync(profilesPath(home), 'utf8')) as { profiles: Profile[] }
  assert.ok(onDisk.profiles.some((p) => p.id === saved.profile!.id))
  assert.ok(onDisk.profiles.some((p) => p.id === 'edited-by-cli'), 'the CLI edit survived the save')
  rec.close()
})

test('UserSettings on an executor: get() is memory, fresh() sees an edit and a removal', async () => {
  const home = tempHome()
  homes.push(home)
  const ex = createExecutor({ mode: 'inline' })
  const s = new UserSettings(home, ex, {})
  assert.deepEqual(s.get(), {}, 'before the first load: empty')
  writeFileSync(join(home, 'settings.json'), '{ "daemon": { "panelHost": false }, // note\n "a.b": 1 }')
  assert.deepEqual(await s.fresh(), { daemon: { panelHost: false }, a: { b: 1 } })
  writeFileSync(join(home, 'settings.json'), '{ "x": 2, "pad": "........" }')
  assert.equal((s.get() as { x?: number }).x, undefined, 'get() does not look at the disk')
  assert.equal(((await s.fresh()) as { x?: number }).x, 2)
  fs.rmSync(join(home, 'settings.json'))
  assert.deepEqual(await s.fresh(), {})
  await ex.close()
})

test('the watcher reloads settings without a fresh()', async () => {
  const home = tempHome()
  homes.push(home)
  const ex = createExecutor({ mode: 'inline' })
  const s = new UserSettings(home, ex, {})
  await s.fresh()
  s.start()
  try {
    writeFileSync(join(home, 'settings.json'), '{ "w": 1 }')
    await waitUntil(() => (s.get() as { w?: number }).w === 1, 6000, 'watcher or periodic reload')
  } finally { s.stop(); await ex.close() }
})
