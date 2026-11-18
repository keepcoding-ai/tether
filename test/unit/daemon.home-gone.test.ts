// A tetherd whose home is deleted under it (tests tearing a temp home down with the daemon alive) used to spin a core
// forever: the slots watcher kept firing on the vanished folder. It must stop the watcher and take the daemon down.
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { after, test } from 'node:test'
import { slotsDir } from '../../src/core/paths.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { removeHome, sleep, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

const homes: string[] = []
const daemons: Daemon[] = []
after(async () => {
  for (const d of daemons) await d.close()
  for (const h of homes) await removeHome(h)
})

test('home deleted with the daemon alive: it shuts down and burns no CPU', async () => {
  const home = tempHome()
  homes.push(home)
  mkdirSync(slotsDir(home), { recursive: true })
  let shutdowns = 0
  const logs: string[] = []
  const daemon = await startDaemon({ home, pipe: uniquePipe(home), memoryIntervalMs: 0, onShutdown: () => { shutdowns++ }, log: (m) => logs.push(m) })
  daemons.push(daemon)
  rmSync(home, { recursive: true, force: true })
  await waitUntil(() => shutdowns > 0, 10_000, 'daemon shutdown after its home vanished')
  const before = process.cpuUsage()
  await sleep(1500)
  const used = process.cpuUsage(before)
  assert.ok((used.user + used.system) / 1000 < 600, `cpu burned after shutdown: ${(used.user + used.system) / 1000} ms in 1500 ms`)
  assert.equal(logs.filter((l) => l.includes('slots folder gone')).length, 1)
})
