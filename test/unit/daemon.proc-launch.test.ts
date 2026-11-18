// Recipe → plan: the environment is tetherd's minus the panel's ties plus the recipe's; the command is resolved;
// a .cmd/.bat goes through cmd.exe as ONE raw string; a missing folder or command says what to do.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { cmdQuote, LaunchError, procEnv } from '../../src/daemon/proc-launch.ts'
import { planFor } from '../../src/daemon/proc-launch-sync.ts'
import { removeHome, tempHome } from './daemon.helpers.ts'

const isWin = process.platform === 'win32'

describe('proc-launch', () => {
  test('environment: panel and agent variables go, colour support comes, the recipe wins', () => {
    const env = procEnv({ PATH: 'p', TETHER_SLOT_ID: 's', TETHER_TAB_URL: 'u', TETHER_OPEN_CWD: 'c', TETHER_AGENT: 'a', CLAUDECODE: '1', CLAUDE_CONFIG_DIR: 'x', NO_COLOR: '1', KEEP: 'k', TETHER_HOME: 'h' }, { KEEP: 'nova', API_KEY: 'z' })
    assert.deepEqual(Object.keys(env).sort(), ['API_KEY', 'COLORTERM', 'KEEP', 'PATH', 'TERM', 'TETHER_HOME'].sort())
    assert.equal(env.KEEP, 'nova')
  })

  test('command on PATH, relative path from the folder; missing ones fail with what to do', async () => {
    const home = tempHome()
    try {
      const bin = join(home, 'bin')
      mkdirSync(bin)
      const exe = join(bin, isWin ? 'meuprog.exe' : 'meuprog')
      writeFileSync(exe, '')
      const base = { PATH: bin }
      assert.equal(planFor({ command: 'meuprog', args: ['x'], cwd: home, env: {} }, base).command, exe)
      assert.equal(planFor({ command: isWin ? 'bin\\meuprog' : 'bin/meuprog', args: [], cwd: home, env: {} }, base).command, exe)
      assert.throws(() => planFor({ command: 'nao-existe-xyz', args: [], cwd: home, env: {} }, base), (e: Error) => e instanceof LaunchError && /comando não encontrado: nao-existe-xyz/.test(e.message))
      assert.throws(() => planFor({ command: 'meuprog', args: [], cwd: join(home, 'nada'), env: {} }, base), (e: Error) => e instanceof LaunchError && /não existe/.test(e.message))
    } finally { await removeHome(home) }
  })

  test('a .cmd shortcut: cmd.exe /d /s /c with one raw string, arguments with spaces quoted', { skip: !isWin && 'Windows-only' }, async () => {
    const home = tempHome()
    try {
      const dir = join(home, 'dir com espaco')
      mkdirSync(dir)
      const cmd = join(dir, 'eco args.cmd')
      writeFileSync(cmd, '@echo %*\r\n')
      const plan = planFor({ command: cmd, args: ['a b', 'c', 'x"y'], cwd: dir, env: {} }, { PATH: '', ComSpec: 'C:\\Windows\\system32\\cmd.exe' })
      assert.equal(plan.command, 'C:\\Windows\\system32\\cmd.exe')
      assert.equal(plan.args, `/d /s /c ""${cmd}" "a b" c "x""y""`)
      assert.equal(cmdQuote(''), '""')
    } finally { await removeHome(home) }
  })
})
