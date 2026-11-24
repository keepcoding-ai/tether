// Guard: no E2E launches the Electron app with an environment that bypasses the single point (test/e2e/app-env.ts, applied by
// test/e2e/electron.ts to every `_electron.launch`). A tether pane exports TETHER_USER_DIR (the person's real settings folder).
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, test } from 'node:test'
import { guardAppEnv } from '../e2e/app-env.ts'

const e2e = resolve(import.meta.dirname, '..', 'e2e')

/** Names of the files (of `{ name, text }`) that launch Electron without passing through the single point. */
export function launcherViolations(files: { name: string; text: string }[]): string[] {
  const bad: string[] = []
  for (const { name, text } of files) {
    if (name === 'electron.ts') { if (!/guardAppEnv/.test(text) || !/launchable\.launch\s*=/.test(text)) bad.push(`${name}: the point itself lost its guard`); continue }
    const imports = /import\s*\{[^}]*\b_electron\b[^}]*\}\s*from\s*'playwright-core'/.test(text)
    const viaPoint = /from\s*'\.\/(electron|browser-kit)\.ts'/.test(text)
    if (imports && !viaPoint) bad.push(`${name}: launches with _electron but never imports ./electron.ts`)
    // Electron as plain Node (the browser MCP server, the preview renderer) is not the app: no preferences to read.
    const notTheApp = /ELECTRON_RUN_AS_NODE/.test(text) || /preview-main\.cjs/.test(text)
    for (const line of text.split('\n')) {
      if (/\bspawn(?:Sync)?\(\s*electronPath\b/.test(line) && !notTheApp && !/guardAppEnv\(/.test(line)) bad.push(`${name}: spawns the app without guardAppEnv`)
    }
  }
  return bad
}

describe('app launchers go through the single environment point', () => {
  test('every E2E file that launches the app', () => {
    const files = readdirSync(e2e).filter(f => f.endsWith('.ts')).map(name => ({ name, text: readFileSync(join(e2e, name), 'utf8') }))
    assert.ok(files.length > 100)
    assert.deepEqual(launcherViolations(files), [])
  })
  test('the guard turns red on a launcher that bypasses the point (fixtures)', () => {
    const direct = `import { _electron, type Page } from 'playwright-core'\nimport { join } from 'node:path'\n_electron.launch({ env: { ...process.env } })`
    const spawned = `import { spawn } from 'node:child_process'\nspawn(electronPath, [mainPath], { env: process.env })`
    const good = `import { _electron } from 'playwright-core'\nimport { killElectron } from './electron.ts'`
    assert.equal(launcherViolations([{ name: 'app.x.test.ts', text: direct }]).length, 1)
    assert.equal(launcherViolations([{ name: 'app.y.test.ts', text: spawned }]).length, 1)
    assert.deepEqual(launcherViolations([{ name: 'app.z.test.ts', text: good }]), [])
    assert.deepEqual(launcherViolations([{ name: 'app.w.test.ts', text: `spawn(electronPath, [mainPath], { env: guardAppEnv(appEnv(h)) })` }]), [])
    assert.equal(launcherViolations([{ name: 'electron.ts', text: 'nothing' }]).length, 1)
  })
})

describe('guardAppEnv', () => {
  const tmp = tmpdir()
  const parent = { TETHER_USER_DIR: 'C:\\real\\.tether', TETHER_HOME: 'C:\\real\\home', TETHER_PIPE: '\\\\.\\pipe\\real', TETHER_SLOT_KEY: 'k', TETHER_SLOT_ID: 's', PATH: 'p' }
  const priv = { TETHER_HOME: join(tmp, 'tether-a'), TETHER_PIPE: '\\\\.\\pipe\\tether-test-a' }

  test('drops the inherited pane variables and resolves the preferences inside the private home', () => {
    const out = guardAppEnv({ ...parent, ...priv }, parent)
    assert.equal(out.TETHER_USER_DIR, undefined)
    assert.equal(out.TETHER_SLOT_KEY, undefined)
    assert.equal(out.TETHER_SLOT_ID, undefined)
    assert.equal(out.PATH, 'p')
  })
  test('keeps a TETHER_USER_DIR the test set itself, inside the temp folder', () => {
    const own = join(tmp, 'tether-own')
    assert.equal(guardAppEnv({ ...parent, ...priv, TETHER_USER_DIR: own }, parent).TETHER_USER_DIR, own)
  })
  test('refuses a preferences folder outside the test temp folders, and an inherited home or pipe', () => {
    assert.throws(() => guardAppEnv({ ...parent, ...priv, TETHER_USER_DIR: 'C:\\real\\other' }, parent), /preferences folder/)
    assert.throws(() => guardAppEnv({ ...parent, TETHER_PIPE: priv.TETHER_PIPE }, parent), /TETHER_HOME/)
    assert.throws(() => guardAppEnv({ ...parent, TETHER_HOME: priv.TETHER_HOME }, parent), /TETHER_PIPE/)
  })
})
