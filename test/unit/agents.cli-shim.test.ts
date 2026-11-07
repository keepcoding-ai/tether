// The `tether` shim the skills call (src/agents/cli-shim.ts): two scripts with the absolute path written in, a folder
// put at the front of the pane's PATH by both adapters, and skills that never name a variable or a path.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { after, before, describe, test } from 'node:test'
import '../../extensions/index.daemon.ts'
import { withClaudePlugin } from '../../src/agents/claude-plugin.ts'
import { ensureCliShim, shimScripts, SHIM_DIR, withPathFront } from '../../src/agents/cli-shim.ts'
import { withSoulShare } from '../../src/agents/soul-share.ts'
import { TETHER_CLI_PATH, type LaunchPlan } from '../../src/agents/types.ts'
import { cleanShares, composeShare } from '../../src/daemon/share.ts'
import { removeHome, tempHome } from './daemon.helpers.ts'

let root: string
let home: string
let shareDir: string
const plan = (env: Record<string, string>): LaunchPlan => ({ command: 'x', args: ['--settings', 's.json'], cwd: process.cwd(), env })

before(() => {
  root = tempHome()
  home = join(root, 'home')
  const feat = join(root, 'feat')
  mkdirSync(join(feat, 'skills', 's1'), { recursive: true })
  writeFileSync(join(feat, 'skills', 's1', 'SKILL.md'), '---\nname: s1\n---\n')
  shareDir = composeShare(home, [{ id: 'f', dir: feat }]).dir
})
after(async () => { cleanShares(home); await removeHome(root) })

describe('the shim scripts', () => {
  test('sh: exec node on the absolute path, forward slashes, single-quoted; cmd: node on the Windows path, %* passed on', () => {
    const { sh, cmd } = shimScripts('D:\\code\\my app\\bin\\tether.mjs')
    assert.equal(sh, `#!/bin/sh\nexec node 'D:/code/my app/bin/tether.mjs' "$@"\n`)
    assert.equal(cmd, '@echo off\r\nnode "D:\\code\\my app\\bin\\tether.mjs" %*\r\n')
  })

  test('a quote or a percent in the path is escaped for each shell', () => {
    const { sh, cmd } = shimScripts("D:\\it's 100%\\bin\\tether.mjs")
    assert.ok(sh.includes(`'D:/it'\\''s 100%/bin/tether.mjs'`), sh)
    assert.ok(cmd.includes('100%%'), cmd)
  })

  test('ensureCliShim writes bin/tether and bin/tether.cmd with the real CLI path, and is idempotent', () => {
    const dir = ensureCliShim(shareDir)
    assert.equal(dir, join(shareDir, SHIM_DIR))
    assert.deepEqual(readdirSync(dir).sort(), ['tether', 'tether.cmd'])
    const sh = readFileSync(join(dir, 'tether'), 'utf8')
    assert.ok(sh.includes(TETHER_CLI_PATH.replace(/\\/g, '/')), sh)
    assert.ok(!sh.includes('\r'), 'LF only in the sh script')
    assert.equal(ensureCliShim(shareDir), dir)
    assert.equal(readFileSync(join(dir, 'tether'), 'utf8'), sh)
  })

  test('the shim really runs the CLI: `tether faults list --json` on an empty registry answers []', { skip: process.platform !== 'win32' && 'tether.cmd is the Windows shim' }, () => {
    const dir = ensureCliShim(shareDir)
    const userDir = join(root, 'user')
    mkdirSync(userDir, { recursive: true })
    const out = execFileSync(join(dir, 'tether.cmd'), ['faults', 'list', '--json'], { encoding: 'utf8', shell: true, env: { ...process.env, TETHER_USER_DIR: userDir } })
    assert.deepEqual(JSON.parse(out), [])
  })
})

describe('PATH', () => {
  test('withPathFront puts the folder first, once, under the key the env already has', () => {
    const key = process.platform === 'win32' ? 'Path' : 'PATH'
    const out = withPathFront({ [key]: ['a', 'b'].join(delimiter), X: '1' }, 'S')
    assert.equal(out[key], ['S', 'a', 'b'].join(delimiter))
    assert.equal(out.X, '1')
    assert.deepEqual(Object.keys(out).filter(k => k.toUpperCase() === 'PATH'), [key], 'no second PATH key')
    assert.equal(withPathFront(out, 'S')[key], out[key], 'not repeated')
    assert.equal(withPathFront({}, 'S').PATH, 'S')
  })

  test('both adapters put <share>/bin at the front of the PATH and keep TETHER_CLI untouched', () => {
    const bin = join(shareDir, SHIM_DIR)
    const claude = withClaudePlugin(plan({ PATH: 'p', TETHER_CLI: 'c' }), shareDir)
    assert.equal(claude.env.TETHER_CLI, 'c')
    assert.equal(claude.env.PATH ?? claude.env.Path, `${bin}${delimiter}p`)
    const soul = withSoulShare(plan({ PATH: 'p' }), shareDir)
    assert.equal(soul.env.PATH ?? soul.env.Path, `${bin}${delimiter}p`)
  })
})

describe('the faults skills', () => {
  test('call `tether faults`, authorize `Bash(tether faults *)` and never name a variable or node', () => {
    const dir = resolve(import.meta.dirname, '..', '..', 'extensions', 'faults', 'share', 'skills')
    const names = readdirSync(dir)
    assert.equal(names.length, 6)
    for (const n of names) {
      const text = readFileSync(join(dir, n, 'SKILL.md'), 'utf8')
      assert.ok(text.includes('allowed-tools: Bash(tether faults *)'), `${n}: allowed-tools`)
      assert.ok(!text.includes('TETHER_CLI') && !text.includes('node "'), `${n}: no variable and no node`)
    }
  })
})
