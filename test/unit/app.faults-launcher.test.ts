// The launcher (app/main/launcher.cjs): its copy of the redaction patterns, and what it writes when the app fails to load.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_MESSAGE, readOccurrences, REDACTION_PATTERNS } from '../../src/core/faults.ts'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'tether-launcher-'))
const launcherPath = join(import.meta.dirname, '..', '..', 'app', 'main', 'launcher.cjs')

test('launcher: its pattern list equals REDACTION_PATTERNS of the core', () => {
  const text = readFileSync(launcherPath, 'utf8')
  const block = /\/\/ REDACTION-PATTERNS-BEGIN\r?\n([\s\S]*?)\/\/ REDACTION-PATTERNS-END/.exec(text)
  assert.ok(block, 'marker block missing')
  const copy = new Function(`${block![1]}; return REDACTION_PATTERNS`)() as [string, string, string][]
  assert.deepEqual(copy, REDACTION_PATTERNS.map(p => [...p]))
})

function runLauncher(userDir: string, message: string): void {
  const work = tmp()
  copyFileSync(launcherPath, join(work, 'main.cjs'))
  writeFileSync(join(work, 'main-app.cjs'), `throw new Error(${JSON.stringify(message)})`)
  const r = spawnSync(process.execPath, [join(work, 'main.cjs')], { env: { ...process.env, TETHER_USER_DIR: userDir }, encoding: 'utf8' })
  assert.notEqual(r.status, 0)
  rmSync(work, { recursive: true })
}

test('launcher: redacts and caps what it writes, and skips a repeat of the same sig within 60 s', () => {
  const user = tmp()
  runLauncher(user, 'cannot load sk-ant-api03-LAUNCHSECRET token=abc123 ' + 'x'.repeat(5000))
  runLauncher(user, 'cannot load sk-ant-api03-LAUNCHSECRET token=abc123 ' + 'x'.repeat(5000)) // same defect, seconds later
  const { items } = readOccurrences(join(user, 'faults'))
  assert.equal(items.length, 1)
  assert.equal(items[0]!.kind, 'load')
  assert.ok(!items[0]!.message.includes('LAUNCHSECRET') && !items[0]!.message.includes('abc123'))
  assert.ok(items[0]!.message.length <= MAX_MESSAGE)
  runLauncher(user, 'a different failure') // another sig is written
  assert.equal(readOccurrences(join(user, 'faults')).items.length, 2)
  rmSync(user, { recursive: true })
})
