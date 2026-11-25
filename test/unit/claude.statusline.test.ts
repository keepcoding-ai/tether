// The status line script tether injects into Claude: pure formatting, and the script as Claude runs it (stdin JSON).
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tempDirs } from './tmp.helpers.ts'
// @ts-expect-error plain .mjs without types
import { formatStatusLine } from '../../src/report/claude-statusline.mjs'

const SCRIPT = resolve(import.meta.dirname, '../../src/report/claude-statusline.mjs')
const fmt = formatStatusLine as (payload: unknown) => string
const ws = { workspace: { current_dir: 'D:\proj' } }

describe('formatStatusLine', () => {
  test('Fable: red-background alert with the name in upper case', () => {
    const out = fmt({ model: { id: 'claude-fable-5-2', display_name: 'Fable 5.2' }, effort: { level: 'low' }, ...ws })
    assert.equal(out, '\x1b[1;97;41m  ⚠ FABLE ATIVO: FABLE 5.2 ⚠  \x1b[0m  \x1b[37meffort: low\x1b[0m  \x1b[2mD:\proj\x1b[0m')
  })

  test('Fable matched by id alone', () => {
    assert.match(fmt({ model: { id: 'claude-fable-5-2', display_name: 'Something' } }), /FABLE ATIVO: SOMETHING/)
  })

  test('Opus: bold green foreground, no background', () => {
    const out = fmt({ model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' }, effort: { level: 'high' }, ...ws })
    assert.equal(out, '\x1b[1;92mOpus 5.5\x1b[0m  \x1b[37meffort: high\x1b[0m  \x1b[2mD:\proj\x1b[0m')
  })

  test('other models: bold yellow; no effort segment when absent', () => {
    assert.equal(fmt({ model: { id: 'claude-haiku-4-5', display_name: 'Haiku 4.5' }, ...ws }), '\x1b[1;93mHaiku 4.5\x1b[0m  \x1b[2mD:\proj\x1b[0m')
  })

  test('garbage never throws', () => {
    for (const p of [undefined, null, 42, 'x', [], { model: 7, effort: 'x', workspace: null }]) {
      assert.equal(fmt(p), '\x1b[1;93m?\x1b[0m')
    }
  })
})

describe('claude-statusline.mjs as Claude runs it', () => {
  test('stdin JSON → one line on stdout, exit 0', () => {
    const r = spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify({ model: { id: 'claude-fable-5-2', display_name: 'Fable 5.2' } }), encoding: 'utf8' })
    assert.equal(r.status, 0)
    assert.match(r.stdout, /FABLE ATIVO: FABLE 5\.2/)
  })

  test('empty or bad stdin: exit 0', () => {
    for (const input of ['', '{oops']) {
      const r = spawnSync(process.execPath, [SCRIPT], { input, encoding: 'utf8' })
      assert.equal(r.status, 0, input)
      assert.equal(r.stderr, '', input)
    }
  })
})

describe('chaining the user status line', () => {
  const dirs = tempDirs('tether-chain-')
  after(() => dirs.cleanup())
  const payload = (cwd: string) => ({ model: { id: 'claude-fable-5-2', display_name: 'Fable 5.2' }, workspace: { current_dir: cwd } })
  const run = (cwd: string, config: string, extra: Record<string, unknown> = {}) =>
    spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify({ ...payload(cwd), ...extra }), encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: config, TETHER_SLOT_ID: '' }, timeout: 8000 })
  const withUser = (command: string, where: 'user' | 'project' | 'local' = 'project') => {
    const config = dirs.make(), cwd = dirs.make()
    const body = JSON.stringify({ statusLine: { type: 'command', command } })
    if (where === 'user') writeFileSync(join(config, 'settings.json'), body)
    else {
      mkdirSync(join(cwd, '.claude'), { recursive: true })
      writeFileSync(join(cwd, '.claude', where === 'project' ? 'settings.json' : 'settings.local.json'), body)
    }
    return { config, cwd }
  }

  test('(a) no user status line: only our ribbon', () => {
    const r = run(dirs.make(), dirs.make())
    assert.equal(r.status, 0)
    assert.ok(!r.stdout.includes('\n'))
    assert.match(r.stdout, /FABLE ATIVO/)
  })

  test('(b) user echo follows our ribbon on the same line, in user, project and local settings', () => {
    for (const where of ['user', 'project', 'local'] as const) {
      const { config, cwd } = withUser('echo USERLINE', where)
      const out = run(cwd, config).stdout
      assert.ok(!out.includes('\n'), where)
      assert.match(out, /FABLE ATIVO.*USERLINE/, where)
    }
  })

  test('the user command gets the same stdin; the last file wins', () => {
    const { config, cwd } = withUser('echo LOCAL', 'local')
    writeFileSync(join(config, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'echo USER' } }))
    const out = run(cwd, config).stdout
    assert.match(out, /LOCAL/)
    assert.ok(!out.includes('USER'))
    const echoStdin = `node -e "process.stdin.on('data',d=>process.stdout.write(JSON.parse(d).marker))"`
    const w = withUser(echoStdin)
    assert.match(run(w.cwd, w.config, { marker: 'SAME' }).stdout, /SAME$/)
  })

  test('(c) failing, empty or hanging user command: only our ribbon, within the timeout', () => {
    for (const cmd of ['exit 3', 'node -e "process.exit(0)"', `node -e "setTimeout(()=>{},30000)"`]) {
      const { config, cwd } = withUser(cmd)
      const t0 = Date.now()
      const r = run(cwd, config)
      assert.equal(r.status, 0, cmd)
      assert.ok(!r.stdout.includes('\n'), cmd)
      assert.match(r.stdout, /FABLE ATIVO/, cmd)
      assert.ok(Date.now() - t0 < 5000, cmd)
    }
  })

  test('a user command that is this very script is not run', () => {
    const { config, cwd } = withUser(`node "${SCRIPT.split(String.fromCharCode(92)).join('/')}"`)
    assert.ok(!run(cwd, config).stdout.includes('\n'))
  })
})
