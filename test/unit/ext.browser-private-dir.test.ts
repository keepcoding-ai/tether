// `<home>/browser` and `keys/` are the owner's alone (Tether Browser E7c, review M4). The home is a temporary folder; set
// TETHER_ACL_TEST_ROOT to put it outside the profile (a drive whose root grants Users read and Authenticated Users write), which
// is the case the fix is for. Windows: the DACL read back as SDDL is protected and allows only the current user's SID.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkDacl, currentUserSid, daclOf, ensurePrivateDir } from '../../extensions/browser/private-dir.ts'

test('private dir: the SDDL check (pure)', () => {
  const me = 'S-1-5-21-1-2-3-1001'
  assert.deepEqual(checkDacl(`D:PAI(A;OICI;FA;;;${me})`, me), { protected: true, others: [] })
  assert.deepEqual(checkDacl(`D:AI(A;OICI;FA;;;${me})(A;OICIID;0x1200a9;;;BU)(A;ID;0x1301bf;;;AU)`, me), { protected: false, others: ['BU', 'AU'] })
  assert.deepEqual(checkDacl(`D:P(D;;FA;;;WD)(A;OICI;FA;;;${me})`, me), { protected: true, others: [] }, 'a deny entry takes nothing from the owner')
})

test('private dir: <home>/browser and keys/ end protected, owner only, outside the profile too', { skip: process.platform !== 'win32' }, () => {
  const root = process.env.TETHER_ACL_TEST_ROOT ?? tmpdir()
  mkdirSync(root, { recursive: true })
  const home = mkdtempSync(join(root, 'tether-acl-'))
  try {
    const me = currentUserSid()
    const browser = join(home, 'browser')
    const before = daclOf(home)
    ensurePrivateDir(browser)
    ensurePrivateDir(join(browser, 'keys'))
    const dacl = daclOf(browser)
    assert.deepEqual(checkDacl(dacl, me), { protected: true, others: [] }, `browser/: ${dacl} (the home had ${before})`)
    // A key written afterwards inherits the owner-only entry.
    writeFileSync(join(browser, 'keys', 'slot.key'), 'x')
    const key = daclOf(join(browser, 'keys', 'slot.key'))
    assert.deepEqual(checkDacl(key, me).others, [], `the key file: ${key}`)
    // A grant someone added to an existing folder is taken away at the next start.
    const keys2 = join(home, 'other', 'browser')
    mkdirSync(keys2, { recursive: true })
    execFileSync(join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'icacls.exe'), [keys2, '/grant', '*S-1-5-32-545:(OI)(CI)M', '/q'], { windowsHide: true })
    assert.ok(checkDacl(daclOf(keys2), me).others.includes('BU'), 'the planted grant is there')
    ensurePrivateDir(keys2)
    assert.deepEqual(checkDacl(daclOf(keys2), me), { protected: true, others: [] })
    console.log(`ACL resultante de ${browser}: ${dacl}`)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('private dir: the async warm-up reaches the same state and the launch-time check then spawns nothing', async () => {
  const { ensurePrivateDirAsync, resetPrivateDirMemory, warmPrivateDirs } = await import('../../extensions/browser/private-dir.ts')
  resetPrivateDirMemory()
  const home = mkdtempSync(join(tmpdir(), 'tether-warm-'))
  try {
    const browser = join(home, 'browser')
    const keys = join(browser, 'keys')
    const logs: string[] = []
    await warmPrivateDirs([browser, keys], m => logs.push(m))
    assert.deepEqual(logs, [])
    if (process.platform === 'win32') {
      const me = currentUserSid()
      assert.deepEqual(checkDacl(daclOf(browser), me), { protected: true, others: [] })
    }
    const t0 = performance.now()
    ensurePrivateDir(browser)
    ensurePrivateDir(keys)
    assert.ok(performance.now() - t0 < 50, 'a warmed folder is a set lookup, not a spawn')
    await ensurePrivateDirAsync(browser) // idempotent
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
