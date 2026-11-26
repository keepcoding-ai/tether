// The pipe key must never sit where another account can read it. When the key file cannot be made private (the ACL call
// fails: simulated here with TETHER_TEST_KEY_ACL_FAIL=1), tetherd writes the key only into a folder that is private to the
// user already, and otherwise refuses to start with a message saying what to do.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, readdirSync } from 'node:fs'
import { connect } from 'node:net'
import { afterEach, describe, test } from 'node:test'
import { DaemonClient } from '../../src/daemon/client.ts'
import { folderIsPrivate, KeyNotPrivateError, PIPE_KEY_FILE, pipeKeyPath } from '../../src/daemon/pipe-key.ts'
import { startDaemon } from '../../src/daemon/server.ts'
import { removeHome, tempHome, uniquePipe } from './daemon.helpers.ts'

/** A temp folder that other accounts can read: Windows, an extra Allow for BUILTIN\Users; elsewhere 0755. */
function openHome(): string {
  const home = tempHome()
  if (process.platform === 'win32') execFileSync('icacls.exe', [home, '/grant', '*S-1-5-32-545:(OI)(CI)(R)'], { windowsHide: true })
  else chmodSync(home, 0o755)
  return home
}

/** A temp folder only the user (and SYSTEM) can read: Windows, inheritance removed (a temp folder may carry other accounts). */
function privateHome(): string {
  const home = tempHome()
  if (process.platform === 'win32') {
    const sid = /"(S-1-[0-9-]+)"/.exec(execFileSync(`${process.env.SystemRoot}\\System32\\whoami.exe`, ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }))![1]!
    execFileSync('icacls.exe', [home, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)(F)`, '*S-1-5-18:(OI)(CI)(F)'], { windowsHide: true })
  } else chmodSync(home, 0o700)
  return home
}

const answers =(pipe: string): Promise<boolean> => new Promise((resolve) => {
  const s = connect(pipe)
  s.once('connect', () => { s.destroy(); resolve(true) })
  s.once('error', () => resolve(false))
})

describe('key file that cannot be made private', () => {
  const homes: string[] = []
  afterEach(async () => {
    delete process.env.TETHER_TEST_KEY_ACL_FAIL
    for (const h of homes.splice(0)) await removeHome(h)
  })

  test('folderIsPrivate: a folder of the user and SYSTEM only is private; one opened to Users is not', async () => {
    const priv = privateHome()
    const open = openHome()
    homes.push(priv, open)
    assert.equal(await folderIsPrivate(priv), true)
    assert.equal(await folderIsPrivate(open), false)
  })

  test('the ACL fails and the folder is not private: tetherd refuses to start, says why, serves nothing, writes no key', async () => {
    const home = openHome()
    homes.push(home)
    const pipe = uniquePipe(home)
    process.env.TETHER_TEST_KEY_ACL_FAIL = '1'
    await assert.rejects(startDaemon({ home, pipe, memoryIntervalMs: 0 }), (e: Error) => e instanceof KeyNotPrivateError
      && /recusei subir/.test(e.message) && /TETHER_HOME/.test(e.message) && e.message.includes(home))
    assert.equal(await answers(pipe), false, 'nothing listens on the pipe')
    assert.equal(existsSync(pipeKeyPath(home)), false, 'no key was written')
    assert.deepEqual(readdirSync(home).filter((n) => n.startsWith(PIPE_KEY_FILE)), [], 'no staged key file is left behind')
  })

  test('the ACL fails but the folder is private to the user: the key is written there, tetherd serves, and it is logged', async () => {
    const home = privateHome()
    homes.push(home)
    process.env.TETHER_TEST_KEY_ACL_FAIL = '1'
    const logs: string[] = []
    const daemon = await startDaemon({ home, pipe: uniquePipe(home), memoryIntervalMs: 0, log: (m) => logs.push(m) })
    try {
      assert.ok(logs.some((l) => /could not restrict .* the folder .* is private to the user/.test(l)), logs.join('\n'))
      const c = await DaemonClient.open(daemon.pipe, 'test', { home })
      c.close()
    } finally {
      await daemon.close()
    }
  })
})
