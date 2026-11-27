// The remote's bench variables (TETHER_TEST_REMOTE*) count only with an explicit bench home, and a started tetherd never inherits them.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultTetherHome, remoteBenchOn, withoutRemoteBench } from '../../src/core/paths.ts'
import { daemonEnv } from '../../src/daemon/client.ts'
import { cmdRemote } from '../../src/cli/remote.ts'
import { portalEnv } from '../../extensions/remote/daemon/portal.ts'
import { regencyBenchOn } from '../../extensions/regency/daemon.ts'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const os = { platform: 'win32' as const, homedir: 'C:\\Users\\p' }
const env = { LOCALAPPDATA: 'C:\\Users\\p\\AppData\\Local', TETHER_TEST_REMOTE: '1', TETHER_TEST_REMOTE_NOTICE: 'f', TETHER_TEST_REMOTE_TICK_MS: '200', PATH: 'p' }
const dflt = defaultTetherHome(env, os)

test('remoteBenchOn: default home ignores the flag, a bench home honours it', () => {
  assert.equal(remoteBenchOn(env, dflt, os), false)
  assert.equal(remoteBenchOn(env, dflt.toUpperCase() + '\\', os), false, 'same folder by another spelling')
  assert.equal(remoteBenchOn(env, undefined, os), false)
  assert.equal(remoteBenchOn(env, '', os), false)
  assert.equal(remoteBenchOn(env, 'C:\\atrium\\.tmp\\bench-home', os), true)
  assert.equal(remoteBenchOn({ ...env, TETHER_TEST_REMOTE: '0' }, 'C:\\atrium\\.tmp\\bench-home', os), false)
  assert.equal(remoteBenchOn({ ...env, TETHER_TEST_REMOTE: undefined }, 'C:\\atrium\\.tmp\\bench-home', os), false)
})

test('withoutRemoteBench and the daemon environment carry no bench variable', () => {
  const clean = withoutRemoteBench(env)
  assert.deepEqual(Object.keys(clean).sort(), ['LOCALAPPDATA', 'PATH'])
  const d = daemonEnv(env, 'C:\\h', 'pipe')
  assert.equal(d.PATH, 'p')
  assert.equal(d.TETHER_HOME, 'C:\\h')
  assert.equal(d.TETHER_PIPE, 'pipe')
  assert.equal(Object.keys(d).some((k) => k.startsWith('TETHER_TEST_REMOTE')), false)
})

test('portalEnv: the bench variables reach the portal only under a bench home', () => {
  assert.equal(portalEnv(env, 'C:\\atrium\\.tmp\\bench-home', 'P').TETHER_TEST_REMOTE_NOTICE, 'f')
  const real = portalEnv(env, defaultTetherHome(env), 'P')
  assert.equal(Object.keys(real).some((k) => k.startsWith('TETHER_TEST_REMOTE')), false)
})

// RR3 gate B-2: TETHER_TEST_REGENCY was read straight from process.env in the Regency's daemon half: inherited by a tetherd
// a CLI started, and honoured under the person's default home.
test('the Regency bench: only TETHER_TEST_REMOTE_REGENCY, only where remoteBenchOn counts, never inherited', () => {
  const bench = 'C:\\atrium\\.tmp\\bench-home'
  const on = { ...env, TETHER_TEST_REMOTE_REGENCY: '1' }
  assert.equal(regencyBenchOn(on, bench), true)
  assert.equal(regencyBenchOn(on, defaultTetherHome(on)), false, 'the default home ignores it')
  assert.equal(regencyBenchOn({ ...on, TETHER_TEST_REMOTE: undefined }, bench), false, 'without the remote bench flag')
  assert.equal(regencyBenchOn({ ...env, TETHER_TEST_REGENCY: '1' }, bench), false, 'the old name opens nothing')
  assert.equal(Object.hasOwn(daemonEnv(on, 'C:\\h', 'pipe'), 'TETHER_TEST_REMOTE_REGENCY'), false, 'a started tetherd does not inherit it')
})

test('ratchet: no TETHER_TEST_* in a daemon half of an extension outside remoteBenchOn', () => {
  const root = join(import.meta.dirname, '..', '..', 'extensions')
  const files: string[] = []
  for (const ext of readdirSync(root, { withFileTypes: true })) {
    if (!ext.isDirectory()) continue
    const dir = join(root, ext.name)
    for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      const rel = relative(dir, join(e.parentPath, e.name)).replaceAll('\\', '/')
      if (e.isFile() && /^daemon(\.ts|\/.*\.ts)$/.test(rel)) files.push(join(dir, rel))
    }
  }
  assert.ok(files.length > 5, 'the daemon halves were found')
  const bad: string[] = []
  for (const f of files) {
    const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    for (const l of src.split('\n')) {
      if (!l.includes('TETHER_TEST_')) continue
      if (/process\.env\.TETHER_TEST_/.test(l) || !/TETHER_TEST_REMOTE/.test(l) || !/remoteBenchOn\(/.test(l)) bad.push(`${relative(root, f)}: ${l.trim()}`)
    }
  }
  assert.deepEqual(bad, [], 'a bench variable of a daemon half is of the TETHER_TEST_REMOTE* family and read on the line of remoteBenchOn')
})

test('cmdRemote: `pair` and `on` stay refused under the default home even with the flag', async () => {
  const errs: string[] = []
  const io = { out: () => {}, err: (t: string) => { errs.push(t) }, env: { ...process.env, TETHER_TEST_REMOTE: '1' }, home: defaultTetherHome(process.env), connect: async () => undefined }
  assert.equal(await cmdRemote(['pair'], io), 2)
  assert.equal(await cmdRemote(['on', 'ws://localhost:1'], io), 2)
})
