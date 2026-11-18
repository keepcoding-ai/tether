// The browser's debug mode, the tether's side (debug-file.ts): the settings become <home>/browser/debug.json, the contract
// the vendored server re-reads by mtime ({ enabled, actionTimeoutMs?, snapshotTimeoutMs? }; 0 = no deadline; a field left
// out = the server's default; off = { enabled: false }); the doctor's line and the bar pill's rule.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// The daemon entry is reached through the index first (the indexes and the entries import each other).
import '../../extensions/index.daemon.ts'
import { createDebugWriter, debugFileOf, debugStateOf, debugSummary, writeDebugFile } from '../../extensions/browser/debug-file.ts'
import { browserSettings, debugCheck } from '../../extensions/browser/daemon.ts'
import { manifest } from '../../extensions/browser/manifest.ts'
import { debugOn } from '../../extensions/browser/rules.ts'
import { settingReaderOf } from '../../app/shared/vscode-configuration-registry.ts'

const reader = (values: Record<string, unknown>) => settingReaderOf(manifest.contributes!.settings!, values)
const tempHome = (): string => mkdtempSync(join(tmpdir(), 'tether-browser-debug-'))
const fileOf = (home: string): unknown => JSON.parse(readFileSync(debugFileOf(home), 'utf8'))

describe('browser debug: the settings → debug.json', () => {
  test('off (by default, or turned off) carries no timeout', () => {
    assert.deepEqual(debugStateOf(reader({})), { enabled: false })
    assert.deepEqual(debugStateOf(reader({ debug: false, debugActionTimeoutSec: 0, debugSnapshotTimeoutSec: 90 })), { enabled: false })
  })

  test('on, timeouts never set: both left out (the server keeps its own)', () => {
    assert.deepEqual(debugStateOf(reader({ debug: true })), { enabled: true })
  })

  test('on with timeouts: seconds become whole milliseconds; 0 stays 0 (no deadline)', () => {
    assert.deepEqual(debugStateOf(reader({ debug: true, debugActionTimeoutSec: 0, debugSnapshotTimeoutSec: 90 })), { enabled: true, actionTimeoutMs: 0, snapshotTimeoutMs: 90_000 })
    assert.deepEqual(debugStateOf(reader({ debug: true, debugActionTimeoutSec: 2.5 })), { enabled: true, actionTimeoutMs: 2500 })
  })

  test('an invalid stored timeout counts as not set (left out), not as the shown default', () => {
    assert.deepEqual(debugStateOf(reader({ debug: true, debugActionTimeoutSec: -3, debugSnapshotTimeoutSec: 'x' })), { enabled: true })
  })

  test('a stored non-boolean debug reads as off', () => {
    assert.deepEqual(debugStateOf(reader({ debug: 'yes' })), { enabled: false })
  })
})

describe('browser debug: the file', () => {
  test('written atomically next to endpoint.json, only when its text changed; no temp file left', async () => {
    const home = tempHome()
    try {
      assert.equal(await writeDebugFile(home, { enabled: true, actionTimeoutMs: 0 }), true)
      assert.equal(debugFileOf(home), join(home, 'browser', 'debug.json'))
      assert.deepEqual(fileOf(home), { enabled: true, actionTimeoutMs: 0 })
      const mtime = statSync(debugFileOf(home)).mtimeMs
      assert.equal(await writeDebugFile(home, { enabled: true, actionTimeoutMs: 0 }), false, 'same text: not rewritten (the mtime the server watches stays)')
      assert.equal(statSync(debugFileOf(home)).mtimeMs, mtime)
      assert.equal(await writeDebugFile(home, { enabled: false }), true)
      assert.deepEqual(fileOf(home), { enabled: false })
      assert.deepEqual(readdirSync(join(home, 'browser')), ['debug.json'])
    } finally { rmSync(home, { recursive: true, force: true }) }
  })

  test('the live writer follows the settings: on, timeout changed, reset, off; the log says only on/off', async () => {
    const home = tempHome()
    try {
      const values: Record<string, unknown> = {}
      const log: string[] = []
      const w = createDebugWriter({ home, settings: reader(values), log: m => log.push(m) })
      await w.sync()
      assert.deepEqual(fileOf(home), { enabled: false }, 'the start writes the state in force')
      values.debug = true
      await w.sync()
      assert.deepEqual(fileOf(home), { enabled: true })
      values.debugActionTimeoutSec = 0
      values.debugSnapshotTimeoutSec = 120
      // A burst of changes ends with the last state on disk.
      void w.sync(); await w.sync()
      assert.deepEqual(fileOf(home), { enabled: true, actionTimeoutMs: 0, snapshotTimeoutMs: 120_000 })
      delete values.debugSnapshotTimeoutSec
      await w.sync()
      assert.deepEqual(fileOf(home), { enabled: true, actionTimeoutMs: 0 }, 'reset: the field goes, the server default comes back')
      values.debug = false
      await w.sync()
      assert.deepEqual(fileOf(home), { enabled: false })
      assert.deepEqual(log, ['modo de depuração ligado (debug.json gravado)', 'modo de depuração desligado (debug.json gravado)'])
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
})

describe('browser debug: the warning', () => {
  test('the bar pill shows only with the setting on', () => {
    assert.equal(debugOn({ get: () => true }), true)
    assert.equal(debugOn({ get: () => false }), false)
    assert.equal(debugOn({ get: () => undefined }), false)
    assert.equal(debugOn({ get: () => 'true' }), false)
  })

  test('tether doctor: OK while off, AVISO with the deadlines while on, read from settings.json', () => {
    const api = (browser: Record<string, unknown> | undefined) => ({ settings: { get: <T,>(key: string) => (key === 'extensions' && browser ? ({ browser } as T) : undefined) } })
    const off = debugCheck(browserSettings(api(undefined)))
    assert.equal(off.level, 'OK')
    assert.equal(off.detail, 'desligada')
    const on = debugCheck(browserSettings(api({ debug: true, debugActionTimeoutSec: 0 })))
    assert.equal(on.level, 'AVISO')
    assert.equal(on.detail, 'ligada (prazo de cada ação: sem prazo; para ler a página: o normal)')
    assert.ok(on.hint?.includes('Configurações'))
    assert.equal(debugSummary({ enabled: true, actionTimeoutMs: 30_000, snapshotTimeoutMs: 90_000 }), 'ligada (prazo de cada ação: 30 s; para ler a página: 90 s)')
  })
})
