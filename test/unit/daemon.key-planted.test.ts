// A key file planted before tetherd starts (Temper r7, M-1). In a home other accounts can write, someone may leave a file at
// the key's path with an explicit "Everyone: read" entry and themselves as owner. `icacls /grant:r` replaces only the entries
// of the SIDs it names, so restricting that file in place kept Everyone. The key now goes into a NEW file (`wx`), restricted,
// read back and checked, and renamed over whatever sat at the path; a process that loses the pipe's race touches nothing.
// Without a second account, the plant is simulated by the same user: a pre-existing file with an explicit Everyone entry.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { afterEach, describe, test } from 'node:test'
import { keyDaclProblem } from '../../extensions/browser/private-dir-core.ts'
import { DaemonClient } from '../../src/daemon/client.ts'
import { hostKeyPath, PIPE_KEY_FILE, pipeKeyPath, readKeyFile, readPipeKey } from '../../src/daemon/pipe-key.ts'
import { startDaemon } from '../../src/daemon/server.ts'
import { ProcHost } from '../../src/procd/host.ts'
import { removeHome, tempHome, uniquePipe } from './daemon.helpers.ts'

const win = process.platform === 'win32'
const ME = win ? /"(S-1-[0-9-]+)"/.exec(execFileSync(`${process.env.SystemRoot}\\System32\\whoami.exe`, ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }))![1]! : ''

/** A home other accounts can read (Windows: an extra inheritable Allow for BUILTIN\Users; elsewhere 0755). */
function openHome(): string {
  const home = tempHome()
  if (win) execFileSync('icacls.exe', [home, '/grant', '*S-1-5-32-545:(OI)(CI)(R)'], { windowsHide: true })
  else chmodSync(home, 0o755)
  return home
}

/** A file at `path` as another account would leave it: empty, with an explicit Allow for Everyone (elsewhere 0644). */
function plant(path: string): void {
  writeFileSync(path, '')
  if (win) execFileSync('icacls.exe', [path, '/grant', '*S-1-1-0:(R)', '/q'], { windowsHide: true })
  else chmodSync(path, 0o644)
}

/** The file's DACL as SDDL (icacls /save), and its owner's SID (Get-Acl). */
function aclOf(path: string): { sddl: string; owner: string } {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$a = Get-Acl -LiteralPath '${path}'; $a.Sddl; $a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value`], { encoding: 'utf8', windowsHide: true })
  const [sddl, owner] = out.trim().split(/\r?\n/)
  return { sddl: /D:.*$/.exec(sddl!)![0], owner: owner!.trim() }
}

function assertPrivate(path: string): void {
  if (!win) { assert.equal(statSync(path).mode & 0o077, 0, 'mode 0600'); return }
  const { sddl, owner } = aclOf(path)
  assert.equal(owner, ME, 'the user owns the key file')
  assert.doesNotMatch(sddl, /;WD\)|;S-1-1-0\)|;BU\)|;AU\)/, `no entry for Everyone, Users or Authenticated Users: ${sddl.split(ME).join('<me>')}`)
  assert.equal(keyDaclProblem(sddl, ME), undefined)
}

const staged = (home: string): string[] => readdirSync(home).filter((n) => n.startsWith(PIPE_KEY_FILE) || n.startsWith('host-')).filter((n) => n.endsWith('.new'))

describe('a key file planted in an open home', () => {
  const homes: string[] = []
  afterEach(async () => { for (const h of homes.splice(0)) await removeHome(h) })

  test('keyDaclProblem: protected with the user, SYSTEM and Administrators is private; inherited or with anyone else is not', () => {
    assert.equal(keyDaclProblem(`D:P(A;;FA;;;${ME || 'S-1-5-21-1'})(A;;FA;;;SY)(A;;FA;;;BA)`, ME || 'S-1-5-21-1'), undefined)
    assert.match(keyDaclProblem(`D:AI(A;;FA;;;${ME || 'S-1-5-21-1'})(A;;FA;;;SY)`, ME || 'S-1-5-21-1')!, /herda/)
    assert.match(keyDaclProblem(`D:P(A;;FA;;;${ME || 'S-1-5-21-1'})(A;;FR;;;WD)`, ME || 'S-1-5-21-1')!, /WD/)
    assert.match(keyDaclProblem(`D:P(A;;FA;;;${ME || 'S-1-5-21-1'})(A;;0x1200a9;;;S-1-5-21-9-9-9-1002)`, ME || 'S-1-5-21-1')!, /S-1-5-21-9-9-9-1002/)
  })

  test('tetherd: the planted file is replaced, Everyone does not survive, the user owns the key, and the key works', async () => {
    const home = openHome()
    homes.push(home)
    plant(pipeKeyPath(home))
    const daemon = await startDaemon({ home, pipe: uniquePipe(home), memoryIntervalMs: 0 })
    try {
      assertPrivate(pipeKeyPath(home))
      assert.ok(await readPipeKey(home), 'a key is there')
      assert.deepEqual(staged(home), [], 'no staged file left')
      const c = await DaemonClient.open(daemon.pipe, 'test', { home })
      c.close()
    } finally {
      await daemon.close()
    }
  })

  test('host (tether-procd): the planted file is replaced the same way', async () => {
    const home = openHome()
    homes.push(home)
    const pipe = uniquePipe(home)
    plant(hostKeyPath(home, pipe))
    const host = new ProcHost({ home, pipe, idleMs: 600_000 })
    await host.listen()
    try {
      assertPrivate(hostKeyPath(home, pipe))
      assert.ok(await readKeyFile(hostKeyPath(home, pipe)), 'a key is there')
      assert.deepEqual(staged(home), [], 'no staged file left')
    } finally {
      await host.close()
    }
  })

  test('a tetherd that loses the pipe leaves the winner\'s key as it is and no staged file', async () => {
    const home = openHome()
    homes.push(home)
    const pipe = uniquePipe(home)
    const winner = await startDaemon({ home, pipe, memoryIntervalMs: 0 })
    try {
      const key = readFileSync(pipeKeyPath(home), 'utf8')
      await assert.rejects(startDaemon({ home, pipe, memoryIntervalMs: 0 }))
      assert.equal(readFileSync(pipeKeyPath(home), 'utf8'), key, 'the winner\'s key is untouched')
      assert.deepEqual(staged(home), [], 'the loser left no staged file')
      const c = await DaemonClient.open(winner.pipe, 'test', { home })
      c.close()
    } finally {
      await winner.close()
    }
  })
})
