// The status line script tether injects into Claude: pure formatting, and the script as Claude runs it (stdin JSON).
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
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
