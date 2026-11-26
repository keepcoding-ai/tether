// `tether new --desk` (R4b): the help names it, and it needs the tetherd (no --here, no stopped daemon). Test home and pipe only.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { USAGE } from '../../src/cli/main.ts'
import { removeHome, tempHome, uniquePipe } from './daemon.basics.ts'

const BIN = resolve(import.meta.dirname, '../../bin/tether.mjs')

describe('tether new --desk', () => {
  let home: string
  let env: Record<string, string>
  before(() => {
    home = tempHome()
    env = { TETHER_HOME: home, TETHER_PIPE: uniquePipe(home) }
  })
  after(async () => { await removeHome(home) })

  const tether = (...args: string[]) => spawnSync(process.execPath, [BIN, ...args], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })

  test('the help documents --desk', () => {
    assert.match(USAGE, /\[--desk d\]/)
    assert.match(USAGE, /--desk: a\s+mesa/)
  })

  test('--desk with --here is a usage error (exit 2)', () => {
    const r = tether('new', 'shell', '--desk', 'Mesa 1', '--here')
    assert.equal(r.status, 2, r.stderr)
    assert.match(r.stderr, /--desk pede o tetherd/)
  })

  test('--desk with the tetherd stopped fails without creating a slot (exit 1)', () => {
    const r = tether('new', 'shell', '--desk', 'Mesa 1', '--cwd', home)
    assert.equal(r.status, 1, r.stderr)
    assert.match(r.stderr, /--desk precisa do tetherd/)
  })
})
