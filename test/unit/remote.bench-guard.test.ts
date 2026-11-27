// The remote's bench variables (TETHER_TEST_REMOTE*) count only with an explicit bench home, and a started tetherd never inherits them.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultTetherHome, remoteBenchOn, withoutRemoteBench } from '../../src/core/paths.ts'
import { daemonEnv } from '../../src/daemon/client.ts'
import { cmdRemote } from '../../src/cli/remote.ts'
import { portalEnv } from '../../extensions/remote/daemon/portal.ts'

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

test('cmdRemote: `pair` and `on` stay refused under the default home even with the flag', async () => {
  const errs: string[] = []
  const io = { out: () => {}, err: (t: string) => { errs.push(t) }, env: { ...process.env, TETHER_TEST_REMOTE: '1' }, home: defaultTetherHome(process.env), connect: async () => undefined }
  assert.equal(await cmdRemote(['pair'], io), 2)
  assert.equal(await cmdRemote(['on', 'ws://localhost:1'], io), 2)
})
