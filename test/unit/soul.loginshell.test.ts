// macOS: `soul` missing from the daemon's PATH is looked up through the user's login shell.
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { soulFromLoginShell } from '../../src/agents/soul.ts'
import { tempDirs } from './tmp.helpers.ts'

const dirs = tempDirs('tether-soul-login-')
after(() => dirs.cleanup())
const skip = process.platform === 'win32'

function fakeShell(dir: string, name: string, output: string): string {
  const file = join(dir, name)
  writeFileSync(file, `#!/bin/sh\necho '${output}'\n`)
  chmodSync(file, 0o755)
  return file
}

describe('soulFromLoginShell', { skip }, () => {
  test('an executable path reported by the shell becomes the command', () => {
    const dir = dirs.make()
    const target = fakeShell(dir, 'soul-real', 'x')
    const shell = fakeShell(dir, 'sh-path', target)
    assert.deepEqual(soulFromLoginShell({ SHELL: shell }), { command: target, args: [] })
  })
  test('an alias is run through the login shell', () => {
    const dir = dirs.make()
    const shell = fakeShell(dir, 'sh-alias', "alias soul='node /x/soul'")
    assert.deepEqual(soulFromLoginShell({ SHELL: shell }), { command: shell, args: ['-lic', 'soul "$@"', 'soul'] })
  })
  test('a shell that finds nothing leaves it to the caller', () => {
    const dir = dirs.make()
    const shell = join(dir, 'sh-none')
    writeFileSync(shell, '#!/bin/sh\nexit 1\n')
    chmodSync(shell, 0o755)
    assert.equal(soulFromLoginShell({ SHELL: shell }), undefined)
  })
})
