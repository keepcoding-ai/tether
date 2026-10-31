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

// Windows: the installed launcher lives in Git Bash's ~/bin, which the app's (Windows) PATH does not have.
describe('soulFromGitBash', { skip: process.platform !== 'win32' }, () => {
  test('a launcher in %USERPROFILE%\bin is found and read like the one on PATH', async () => {
    const { mkdirSync } = await import('node:fs')
    const { soulFromGitBash } = await import('../../src/agents/soul.ts')
    const home = dirs.make()
    mkdirSync(join(home, 'bin'))
    writeFileSync(join(home, 'bin', 'soul'), '#!/usr/bin/env bash\nCLI="D:/x/bin/soul"\nexec node "$CLI" "$@"\n')
    const cmd = soulFromGitBash({ USERPROFILE: home, PATH: '' })
    assert.deepEqual(cmd, { command: process.execPath, args: ['D:/x/bin/soul'] })
  })
  test('findGitBash never returns WSL bash from System32', async () => {
    const { findGitBash } = await import('../../src/agents/soul.ts')
    const found = findGitBash({ PATH: 'C:\Windows\System32' })
    assert.ok(found === undefined || !/system32/i.test(found))
  })
})
