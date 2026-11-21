// `forget` removes the slot's last-answer file along with the rest of tether's files for it.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { slotAnswerPath } from '../../src/core/paths.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { Recorder, removeHome, tempHome, uniquePipe } from './daemon.helpers.ts'

let home: string
let daemon: Daemon
let cwd: string

before(async () => {
  home = tempHome()
  cwd = join(home, 'work')
  mkdirSync(cwd)
  daemon = await startDaemon({ home, pipe: uniquePipe(home), readyFallbackMs: 60_000, minAgentAgeMs: 0 })
})
after(async () => {
  await daemon.close()
  await removeHome(home)
})

test('forget of a slot with an answer file removes it', async () => {
  const c = await Recorder.connect(daemon.pipe)
  const { slot } = await c.client.request({ t: 'create', kind: 'claude', cwd })
  const slotId = slot!.slotId
  writeFileSync(slotAnswerPath(home, slotId), JSON.stringify({ ts: new Date().toISOString(), text: 'x', from: 'claude-stop' }))
  assert.ok(existsSync(slotAnswerPath(home, slotId)))
  await c.client.request({ t: 'forget', slotId })
  assert.equal(existsSync(slotAnswerPath(home, slotId)), false)
  c.close()
})
