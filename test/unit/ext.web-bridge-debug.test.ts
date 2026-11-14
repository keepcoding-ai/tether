// The tether's part of the bridge's config.json `capabilities` (capabilities.ts), against the REAL vendored bundle in a temp
// home: the debug mode (debug, debugCallTimeoutMs), and evaluate / windowPerAgent following the settings live (before, they
// only seeded a fresh installation and a later change reached nothing). Keys that are not the tether's are kept. Also the
// icon's amber rule, the tooltip and the doctor's line.
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import '../../extensions/index.daemon.ts'
import { createBridgeHost, importBundleFromDisk, type BridgeBundle } from '../../extensions/web-bridge/bridge-home.ts'
import { applyCapabilities, bridgeDebugOn, type Capabilities, createCapabilitiesWriter, sameCapabilities, withTetherCapabilities } from '../../extensions/web-bridge/capabilities.ts'
import { bridgeDebugCheck, bridgeSettings } from '../../extensions/web-bridge/daemon.ts'
import { manifest } from '../../extensions/web-bridge/manifest.ts'
import { BridgeMcpRewriter, patchBridgeInitialize, SETTINGS_NEW, SETTINGS_OLD } from '../../extensions/web-bridge/mcp-texts.ts'
import { bridgeHomeOf } from '../../extensions/web-bridge/paths.ts'
import { EMPTY_SNAPSHOT, stateOf, titleOf, type StatusSnapshot } from '../../extensions/web-bridge/status.ts'
import { VENDOR_BUNDLE } from '../../extensions/web-bridge/vendor-rules.ts'
import { settingReaderOf } from '../../app/shared/vscode-configuration-registry.ts'
import { tempDirs } from './tmp.helpers.ts'

const vendorDir = join(fileURLToPath(new URL('../../', import.meta.url)), 'extensions', 'web-bridge', 'vendor')
const tmp = tempDirs('tether-web-bridge-debug-')
after(() => tmp.cleanup())
const reader = (values: Record<string, unknown>) => settingReaderOf(manifest.contributes!.settings!, values)
const capsOf = (home: string): Capabilities | undefined => (JSON.parse(readFileSync(join(bridgeHomeOf(home), 'config.json'), 'utf8')) as { capabilities?: Capabilities }).capabilities
const PACKAGE: Capabilities = { evaluate: 'own-tabs', download: true, upload: true, pdf: true, readNetwork: true, windowPerAgent: true }

describe('web-bridge debug: the tether part of the capabilities (pure)', () => {
  test('nothing set and debug never on: the installation\'s capabilities stay exactly as they are', () => {
    const current = { evaluate: 'off', pdf: false, custom: 'x' }
    assert.deepEqual(withTetherCapabilities(current, reader({})), current)
  })

  test('debug on: debug true; the timeout only when set (seconds → ms string, 0 = "0"); foreign keys kept', () => {
    assert.deepEqual(withTetherCapabilities(PACKAGE, reader({ debug: true })), { ...PACKAGE, debug: true })
    assert.deepEqual(withTetherCapabilities(PACKAGE, reader({ debug: true, debugCallTimeoutSec: 0 })), { ...PACKAGE, debug: true, debugCallTimeoutMs: '0' })
    assert.deepEqual(withTetherCapabilities(PACKAGE, reader({ debug: true, debugCallTimeoutSec: 180 })), { ...PACKAGE, debug: true, debugCallTimeoutMs: '180000' })
  })

  test('debug off: debug false and no timeout, even with one set; an invalid timeout counts as not set', () => {
    const on = { ...PACKAGE, debug: true, debugCallTimeoutMs: '0' }
    assert.deepEqual(withTetherCapabilities(on, reader({ debug: false, debugCallTimeoutSec: 30 })), { ...PACKAGE, debug: false })
    assert.deepEqual(withTetherCapabilities(on, reader({ debug: true, debugCallTimeoutSec: -1 })), { ...PACKAGE, debug: true })
  })

  test('evaluate and agentWindows (→ windowPerAgent) written when set, or when just changed (a reset writes the default)', () => {
    assert.deepEqual(withTetherCapabilities(PACKAGE, reader({ evaluate: 'off', agentWindows: false })), { ...PACKAGE, evaluate: 'off', windowPerAgent: false })
    const chosen = { ...PACKAGE, evaluate: 'all' }
    assert.deepEqual(withTetherCapabilities(chosen, reader({})), chosen, 'unset and unchanged: the installation keeps its own')
    assert.deepEqual(withTetherCapabilities(chosen, reader({}), ['evaluate']), PACKAGE, 'reset on the page: back to the default')
  })

  test('sameCapabilities ignores the key order', () => {
    assert.ok(sameCapabilities({ a: true, b: 'x' }, { b: 'x', a: true }))
    assert.ok(!sameCapabilities({ a: true }, { a: true, b: false }))
  })
})

describe('web-bridge debug: config.json through the real bundle', () => {
  const brand = { name: 'Tether', color: '#6aa6ff', hostId: 'studio.codr.tether' }
  const setupHome = async (settings?: Record<string, unknown>): Promise<{ home: string; log: string[] }> => {
    const home = tmp.make()
    const log: string[] = []
    let healthy = false
    const host = createBridgeHost({
      home, vendorDir, port: 48177, brand, nodeExe: () => 'C:\\fake\\node.exe', log: m => log.push(m),
      fetch: async () => new Response(healthy ? '{"ok":true}' : '', { status: healthy ? 200 : 503 }),
      spawnDaemon: () => { healthy = true; return 4343 }, sleep: async () => {},
      ...(settings ? { settings: () => reader(settings) } : {}),
    })
    const r = await host.setup()
    assert.equal(r.ok, true, r.problem)
    return { home, log }
  }
  const bundle = (): Promise<BridgeBundle> => importBundleFromDisk(join(vendorDir, VENDOR_BUNDLE))

  test('the tetherd start seeds the package, then applies the person\'s settings over it', async () => {
    const { home, log } = await setupHome({ debug: true, debugCallTimeoutSec: 0, agentWindows: false })
    assert.deepEqual(capsOf(home), { ...PACKAGE, windowPerAgent: false, debug: true, debugCallTimeoutMs: '0' })
    assert.ok(log.some(l => l.includes('capabilities do tether')), log.join('\n'))
  })

  test('the start with nothing set leaves the seeded package capabilities untouched', async () => {
    const { home, log } = await setupHome({})
    assert.deepEqual(capsOf(home), PACKAGE)
    assert.ok(!log.some(l => l.includes('capabilities do tether')))
  })

  test('live: on, timeout, off, through the writer; foreign keys kept; same state is not rewritten', async () => {
    const { home } = await setupHome()
    const b = await bundle()
    b.setCapabilities(bridgeHomeOf(home), { ...PACKAGE, pdf: false, futureKey: 'kept' })
    const values: Record<string, unknown> = {}
    const log: string[] = []
    const w = createCapabilitiesWriter({ bridgeHome: bridgeHomeOf(home), settings: reader(values), load: bundle, log: m => log.push(m) })
    await w.sync()
    assert.deepEqual(capsOf(home), { ...PACKAGE, pdf: false, futureKey: 'kept' }, 'the start with nothing set writes nothing')
    values.debug = true
    await w.sync(['debug'])
    assert.deepEqual(capsOf(home), { ...PACKAGE, pdf: false, futureKey: 'kept', debug: true })
    values.debugCallTimeoutSec = 0
    await w.sync(['debugCallTimeoutSec'])
    assert.equal(capsOf(home)?.debugCallTimeoutMs, '0')
    assert.equal(applyCapabilities(b, bridgeHomeOf(home), reader(values)), 'unchanged')
    delete values.debugCallTimeoutSec
    await w.sync(['debugCallTimeoutSec'])
    assert.ok(!('debugCallTimeoutMs' in capsOf(home)!), 'reset: the daemon\'s default again')
    values.debug = false
    await w.sync(['debug'])
    assert.deepEqual(capsOf(home), { ...PACKAGE, pdf: false, futureKey: 'kept', debug: false })
    values.evaluate = 'off'
    await w.sync(['evaluate'])
    assert.equal(capsOf(home)?.evaluate, 'off', 'evaluate now reaches the bridge live')
    assert.deepEqual(log, ['modo de depuração ligado (capabilities do bridge gravadas)', 'modo de depuração desligado (capabilities do bridge gravadas)'])
  })

  test('no config yet, or capabilities never seeded: nothing is written (the start seeds first)', async () => {
    const home = tmp.make()
    const b = await bundle()
    assert.equal(applyCapabilities(b, bridgeHomeOf(home), reader({ debug: true })), 'skipped')
    assert.ok(!existsSync(join(bridgeHomeOf(home), 'config.json')), 'no config created by the writer')
    const seeded = await setupHome()
    b.setCapabilities(bridgeHomeOf(seeded.home), null)
    assert.equal(applyCapabilities(b, bridgeHomeOf(seeded.home), reader({ debug: true })), 'skipped')
    assert.equal(capsOf(seeded.home), undefined)
  })

  test('the bundle is imported only when a write is due (a start with nothing to apply loads nothing)', async () => {
    const { home } = await setupHome()
    let loads = 0
    const values: Record<string, unknown> = {}
    const w = createCapabilitiesWriter({ bridgeHome: bridgeHomeOf(home), settings: reader(values), load: () => { loads++; return bundle() }, log: () => {} })
    await w.sync()
    await w.sync(['agentWindows'])
    assert.equal(loads, 0, 'the state on disk already matches: no import')
    values.debug = true
    await w.sync(['debug'])
    assert.equal(loads, 1)
    assert.equal(capsOf(home)?.debug, true)
    await w.sync(['debug'])
    assert.equal(loads, 1, 'unchanged again: no import')
    const none = createCapabilitiesWriter({ bridgeHome: bridgeHomeOf(tmp.make()), settings: reader({ debug: true }), load: () => { loads++; return bundle() }, log: () => {} })
    await none.sync()
    assert.equal(loads, 1, 'no config yet: no import')
  })

  test('a failing bundle is logged, not thrown', async () => {
    const log: string[] = []
    const w = createCapabilitiesWriter({ bridgeHome: 'x', settings: reader({ debug: true }), peek: () => ({ evaluate: 'own-tabs' }), load: async () => { throw Object.assign(new Error('boom'), { code: 'NOPE' }) }, log: m => log.push(m) })
    await w.sync()
    assert.deepEqual(log, ['capabilities do bridge não gravadas: NOPE'])
  })
})

describe('web-bridge debug: the warning', () => {
  const up: StatusSnapshot = { ...EMPTY_SNAPSHOT, daemon: 'up', everUp: true, browsers: [{ id: 'b1', name: 'Chrome', tabs: 0 }] }
  const now = 1_000_000

  test('the icon goes amber while debug is on and the daemon is up; a fallen daemon stays red', () => {
    assert.equal(stateOf(up, now), 'normal')
    assert.equal(stateOf(up, now, true), 'warn')
    assert.equal(stateOf({ ...up, browsers: [] }, now, true), 'warn', 'without a browser too')
    assert.equal(stateOf({ ...up, daemon: 'down' }, now, true), 'error')
  })

  test('the tooltip names the mode last', () => {
    assert.equal(titleOf(up, now, 'Tether Bridge'), 'Chrome conectado')
    assert.equal(titleOf(up, now, 'Tether Bridge', true), 'Chrome conectado · modo de depuração ligado')
    assert.equal(titleOf({ ...up, paused: true }, now, 'Tether Bridge', true), 'Tether Bridge pausado · modo de depuração ligado')
  })

  test('the setting alone decides', () => {
    assert.equal(bridgeDebugOn({ get: () => true }), true)
    assert.equal(bridgeDebugOn({ get: () => 'true' }), false)
  })

  test('tether doctor: OK while off, AVISO with the deadline while on', () => {
    const api = (b: Record<string, unknown> | undefined) => ({ settings: { get: <T,>(key: string) => (key === 'extensions' && b ? ({ 'web-bridge': b } as T) : undefined) } })
    assert.deepEqual(bridgeDebugCheck(bridgeSettings(api(undefined))), { level: 'OK', name: 'depuração do Tether Bridge', detail: 'desligada' })
    const on = bridgeDebugCheck(bridgeSettings(api({ debug: true, debugCallTimeoutSec: 0 })))
    assert.equal(on.level, 'AVISO')
    assert.equal(on.detail, 'ligada (prazo de cada chamada: sem prazo)')
    assert.equal(bridgeDebugCheck(bridgeSettings(api({ debug: true }))).detail, 'ligada (prazo de cada chamada: o normal)')
  })
})

describe('web-bridge debug: the agent\'s instructions and the dumps', () => {
  test('initialize: the server\'s "Settings → Debugging" becomes the screen\'s labels; other answers pass untouched', () => {
    const r = new BridgeMcpRewriter()
    r.fromClient(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }))
    r.fromClient(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))
    const init = JSON.parse(r.fromServer(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { instructions: 'ask the user to turn it on (in the tether: Settings → Debugging) and repeat', serverInfo: { name: 'tether-bridge' } } })))
    assert.equal(init.result.instructions, `ask the user to turn it on (in the tether: ${SETTINGS_NEW}) and repeat`)
    assert.match(SETTINGS_NEW, /"Configurações" → "Tether Bridge" → "Depuração"/)
    const list = JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'x', description: 'Settings → Debugging' }] } })
    assert.equal(r.fromServer(list), list, 'only initialize is touched')
    assert.equal(r.fromServer('not json'), 'not json')
    assert.deepEqual(patchBridgeInitialize({ instructions: 'nothing to change' }), { instructions: 'nothing to change' })
  })

  test('the vendored server\'s instructions still carry the sentence the rewriter looks for', () => {
    // The bundle writes the arrow as \u2192 in its source: the text the agent gets has the character.
    const bundle = readFileSync(join(vendorDir, VENDOR_BUNDLE), 'utf8')
    assert.ok(bundle.includes(String.raw`in the tether: Settings \u2192 Debugging`) || bundle.includes(`in the tether: ${SETTINGS_OLD}`))
  })

  test('the doctor\'s debug line counts the dump folders of the bridge home', () => {
    const home = tmp.make()
    const dir = join(home, 'debug')
    const s = reader({ debug: true })
    assert.doesNotMatch(bridgeDebugCheck(s, dir).detail, /despejo/)
    for (const id of ['a1', 'b2', 'c3']) mkdirSync(join(dir, id), { recursive: true })
    assert.equal(bridgeDebugCheck(s, dir).detail, `ligada (prazo de cada chamada: o normal); 3 despejos de falha em ${dir}`)
  })
})
