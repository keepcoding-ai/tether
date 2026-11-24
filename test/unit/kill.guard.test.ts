// The guard of the test-only kill of a tether-ptyd: only a `tether-*` home directly inside a test temp base.
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, test } from 'node:test'
import { testHomeOfDaemon, testTmpBases } from '../kill.ts'

const daemonIn = (home: string) => ({ pid: 1, created: 1, cmd: `"${join(home, 'bin', 'tetherd.exe')}" serve` })

describe('testHomeOfDaemon guard', () => {
  test('accepts tether-* directly in the OS temp dir and in the repo scratch dir', () => {
    for (const base of testTmpBases()) {
      const home = join(base, 'tether-x')
      assert.equal(testHomeOfDaemon(daemonIn(home)), resolve(home))
    }
  })
  test('refuses the real home, a nested home, a non tether-* name and a foreign base', () => {
    assert.equal(testHomeOfDaemon(daemonIn(join(process.env.LOCALAPPDATA ?? 'C:/Users/x/AppData/Local', 'tether'))), undefined)
    assert.equal(testHomeOfDaemon(daemonIn(join(tmpdir(), 'a', 'tether-x'))), undefined)
    assert.equal(testHomeOfDaemon(daemonIn(join(tmpdir(), 'other'))), undefined)
    assert.equal(testHomeOfDaemon(daemonIn(join(resolve(tmpdir(), '..'), 'tether-x'))), undefined)
  })
})
