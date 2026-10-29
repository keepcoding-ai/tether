// tetherd as a separate process: the client spawns it detached, one instance per pipe, pid file,
// and `shutdown` takes every PTY tree down with it.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { DaemonClient } from '../../src/daemon/client.ts'
import { pidAlive, removeHome, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

const MAIN = resolve(import.meta.dirname, '../../src/daemon/main.ts')

describe('tetherd process', () => {
  let home: string
  let pipe: string
  let cwd: string
  let daemonPid = 0
  let shellPid = 0

  before(() => {
    home = tempHome()
    pipe = uniquePipe(home)
    cwd = join(home, 'work')
    mkdirSync(cwd)
  })
  after(async () => {
    if (daemonPid && pidAlive(daemonPid)) spawnSync('taskkill', ['/PID', String(daemonPid), '/T', '/F'], { windowsHide: true })
    await removeHome(home)
  })

  test('the client spawns the daemon when nothing answers; pid file written', async () => {
    const c = await DaemonClient.connect({ home, pipe, client: 'test' })
    daemonPid = c.hello.pid
    assert.notEqual(daemonPid, process.pid)
    assert.ok(pidAlive(daemonPid))
    await waitUntil(() => existsSync(join(home, 'tetherd.pid')), 5_000, 'pid file')
    assert.equal(Number(readFileSync(join(home, 'tetherd.pid'), 'utf8').trim()), daemonPid)
    const { slot } = await c.request({ t: 'create', kind: 'shell', cwd, start: true })
    shellPid = slot!.pid!
    assert.ok(pidAlive(shellPid))
    c.close()
  })

  test('a second main.ts with the same pipe exits 0 saying it is already running', () => {
    const r = spawnSync(process.execPath, [MAIN], {
      env: { ...process.env, TETHER_HOME: home, TETHER_PIPE: pipe },
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /já está em execução/)
  })

  test('shutdown: daemon exits, the shell tree is gone, pid file removed', async () => {
    const c = await DaemonClient.connect({ home, pipe, client: 'test', spawn: false })
    assert.equal(c.hello.pid, daemonPid)
    await c.request({ t: 'shutdown' })
    await waitUntil(() => !pidAlive(daemonPid), 15_000, 'daemon gone')
    await waitUntil(() => !pidAlive(shellPid), 10_000, 'shell gone')
    await waitUntil(() => !existsSync(join(home, 'tetherd.pid')), 5_000, 'pid file removed')
    assert.match(readFileSync(join(home, 'tetherd.log'), 'utf8'), /shutdown requested/)
  })
})
