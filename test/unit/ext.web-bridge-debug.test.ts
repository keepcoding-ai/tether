// The debug warning the tether shows (it reads the bridge daemon's /status; the mode itself is turned on only in the
// extension's options page, never from the tether's settings): the icon's amber rule, the tooltip, the doctor's line and
// the dump count. Also the rule that the manifest declares no setting about it.
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import '../../extensions/index.daemon.ts'
import { bridgeDebugCheck } from '../../extensions/web-bridge/daemon.ts'
import { manifest } from '../../extensions/web-bridge/manifest.ts'
import { EMPTY_SNAPSHOT, reduceStatus, stateOf, titleOf, type StatusSnapshot } from '../../extensions/web-bridge/status.ts'
import { tempDirs } from './tmp.helpers.ts'

const tmp = tempDirs('tether-web-bridge-debug-')
after(() => tmp.cleanup())

const doctor = (browsers: unknown[] | 'mute', dumpDir?: string) => {
  const home = tmp.make()
  writeFileSync(join(home, 'api.key'), 'test-key')
  const fetch = (async () => {
    if (browsers === 'mute') throw new Error('ECONNREFUSED')
    return new Response(JSON.stringify({ browsers }), { status: 200 })
  }) as unknown as typeof globalThis.fetch
  return bridgeDebugCheck({ port: 1, bridgeHome: home, displayName: 'Tether Bridge', dumpDir, fetch })
}

describe('web-bridge debug: no control from the tether', () => {
  test('the manifest declares no setting whose name contains "debug"', () => {
    const keys = Object.keys(manifest.contributes!.settings!)
    assert.deepEqual(keys.filter(k => /debug/i.test(k)), [])
  })
})

describe('web-bridge debug: the warning', () => {
  const up: StatusSnapshot = { ...EMPTY_SNAPSHOT, daemon: 'up', everUp: true, browsers: [{ id: 'b1', name: 'Chrome', tabs: 0 }] }
  const now = 1_000_000

  test('the icon goes amber while a browser reports debug on and the daemon is up; a fallen daemon stays red', () => {
    const dbg = { ...up, debug: true }
    assert.equal(stateOf(up, now), 'normal')
    assert.equal(stateOf(dbg, now), 'warn')
    assert.equal(stateOf({ ...dbg, browsers: [] }, now), 'warn', 'without a browser too')
    assert.equal(stateOf({ ...dbg, daemon: 'down' }, now), 'error')
  })

  test('the tooltip names the mode last', () => {
    assert.equal(titleOf(up, now, 'Tether Bridge'), 'Chrome conectado')
    assert.equal(titleOf({ ...up, debug: true }, now, 'Tether Bridge'), 'Chrome conectado · modo de depuração ligado')
    assert.equal(titleOf({ ...up, paused: true, debug: true }, now, 'Tether Bridge'), 'Tether Bridge pausado · modo de depuração ligado')
  })

  test('the snapshot reads debug from /status: on, off and absent (older daemon)', () => {
    const body = (debug: unknown) => ({ browsers: [{ id: 'b1', name: 'Chrome', ...(debug === undefined ? {} : { debug }) }] })
    assert.equal(reduceStatus(body({ on: true, callTimeoutMs: null, traceLog: 't', dumpsDir: 'd' })).debug, true)
    assert.equal(reduceStatus(body({ on: false, callTimeoutMs: null, traceLog: 't', dumpsDir: 'd' })).debug, false)
    assert.equal(reduceStatus(body(undefined)).debug, false)
    assert.equal(reduceStatus(undefined).debug, false)
    assert.equal(EMPTY_SNAPSHOT.debug, false)
  })

  test('tether doctor: OK while off or mute, AVISO naming the browser and the deadline while on', async () => {
    assert.deepEqual(await doctor([{ id: 'b1', name: 'Chrome' }, { id: 'b2', name: 'Edge', debug: { on: false } }]), { level: 'OK', name: 'depuração do Tether Bridge', detail: 'desligada' })
    assert.equal((await doctor('mute')).detail, 'desligada')
    const on = await doctor([{ id: 'b1', name: 'Chrome', debug: { on: true, callTimeoutMs: null } }, { id: 'b2', name: 'Edge', debug: { on: true, callTimeoutMs: 180000 } }])
    assert.equal(on.level, 'AVISO')
    assert.equal(on.detail, 'ligada em Chrome, prazo de cada chamada: sem prazo; Edge, prazo de cada chamada: 180 s')
  })
})
describe('web-bridge debug: the dumps', () => {
  test('the doctor debug line counts the dump folders of the bridge home', async () => {
    const dir = join(tmp.make(), 'debug')
    const bro = [{ id: 'b1', name: 'Chrome', debug: { on: true, callTimeoutMs: null } }]
    assert.doesNotMatch((await doctor(bro, dir)).detail, /despejo/)
    for (const id of ['a1', 'b2', 'c3']) mkdirSync(join(dir, id), { recursive: true })
    assert.equal((await doctor(bro, dir)).detail, `ligada em Chrome, prazo de cada chamada: sem prazo; 3 despejos de falha em ${dir}`)
  })
})
