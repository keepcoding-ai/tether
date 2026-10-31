// Default shell per platform: macOS opens the user's login shell, Windows PowerShell, elsewhere $SHELL.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultShell } from '../../src/agents/shell.ts'
import { defaultProfiles } from '../../src/core/profile.ts'

describe('defaultShell by platform', () => {
  test('darwin: $SHELL as a login shell', () => assert.deepEqual(defaultShell({ SHELL: '/opt/homebrew/bin/fish' }, 'darwin'), { command: '/opt/homebrew/bin/fish', args: ['-l'] }))
  test('darwin without $SHELL: /bin/zsh -l', () => assert.deepEqual(defaultShell({}, 'darwin'), { command: '/bin/zsh', args: ['-l'] }))
  test('linux: $SHELL, no login flag; fallback /bin/sh', () => {
    assert.deepEqual(defaultShell({ SHELL: '/bin/bash' }, 'linux'), { command: '/bin/bash', args: [] })
    assert.deepEqual(defaultShell({}, 'linux'), { command: '/bin/sh', args: [] })
  })
  test('win32 never picks $SHELL', () => assert.match(defaultShell({ SHELL: '/bin/zsh', PATH: '' }, 'win32').command, /powershell/i))
  test('default profiles on darwin: a Shell profile with the login shell, no PowerShell', () => {
    const ps = defaultProfiles({ SHELL: '/bin/zsh' }, 'darwin')
    assert.ok(!ps.some((p) => p.id === 'powershell'))
    assert.deepEqual(ps.find((p) => p.id === 'shell')?.shell, { command: '/bin/zsh', args: ['-l'] })
  })
})
