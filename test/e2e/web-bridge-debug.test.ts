// E2E of the bridge's debug mode end to end (tether-bridge-debug T3b), with the REAL vendored bridge daemon in a temp home
// and a FAKE extension that speaks its WebSocket protocol (hello with the home's pairing token, results by rid), as the
// bridge's own tests do: no real browser. The tether side is the real one: the settings reader, capabilities.ts writing
// config.json through the bundle, and `tether trace` (the bridge's TraceSource).
//   - debug on by the settings (with a 1 s call deadline): the daemon reads it live (diagnose's `daemon.mode` says debug and
//     1000 ms); a call that works leaves its call_started (with the arguments) and call_finished in trace.log under its id,
//     and the timeline tells them; a call the extension never answers ends in CALL_TIMEOUT after ~1 s (the debug deadline,
//     not the 60 s default), its error carries data.dump, the dump folder exists and the timeline names it;
//   - debug off by the settings, live: diagnose says so and the next call writes nothing to trace.log.
// Kills go through test/kill.ts (pid + identity). The person's tether home, ~/.atrium-bridge and port 47831 are never touched.
// Run: node --test test/e2e/web-bridge-debug.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { importBundleFromDisk } from '../../extensions/web-bridge/bridge-home.ts'
import { applyCapabilities } from '../../extensions/web-bridge/capabilities.ts'
import { manifest } from '../../extensions/web-bridge/manifest.ts'
import { bridgeHomeOf } from '../../extensions/web-bridge/paths.ts'
import { bridgeTraceSource } from '../../extensions/web-bridge/trace-source.ts'
import { VENDOR_BUNDLE } from '../../extensions/web-bridge/vendor-rules.ts'
import { settingReaderOf } from '../../app/shared/vscode-configuration-registry.ts'
import { callTimeline, renderTimeline } from '../../src/trace/timeline.ts'
import { claim, killOwned, type Owned } from '../kill.ts'

const root = resolve(import.meta.dirname, '..', '..')
const bundlePath = join(root, 'extensions', 'web-bridge', 'vendor', VENDOR_BUNDLE)
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer()
    s.on('error', rej)
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)) })
  })
}
async function waitUntil(cond: () => Promise<boolean> | boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`)
    await sleep(100)
  }
}

test('bridge debug mode: the setting reaches the real daemon live, trace.log by call id, the timeout dump, tether trace', { timeout: 120_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'tether-wbdebug-'))
  const bridgeHome = bridgeHomeOf(home)
  mkdirSync(bridgeHome, { recursive: true })
  const port = await freePort()
  const b = await importBundleFromDisk(bundlePath)
  const { pairingToken: token } = b.ensureConfig(bridgeHome, port)
  b.seedCapabilities(bridgeHome, { evaluate: 'own-tabs' })
  const values: Record<string, unknown> = { debug: true, debugCallTimeoutSec: 1 }
  const settings = settingReaderOf(manifest.contributes!.settings!, values)
  assert.equal(applyCapabilities(b, bridgeHome, settings), 'written')
  // The test home's own api key (made just now in a temp folder, with the pairing token above), as the bridge's tests use them.
  const key = readFileSync(b.localKeyPath(bridgeHome), 'utf8').trim()

  const owned: Owned[] = []
  let ws: WebSocket | undefined
  const logFd = openSync(join(bridgeHome, 'daemon.log'), 'a')
  try {
    const child = spawn(process.execPath, [bundlePath, 'start', '--port', String(port)], { env: { ...process.env, ATRIUM_BRIDGE_HOME: bridgeHome }, stdio: ['ignore', logFd, logFd], windowsHide: true })
    owned.push(await claim(child.pid!, { cmdIncludes: 'atrium-bridge.mjs', what: 'bridge daemon' }))
    const api = async (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; body: any }> => {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: init.method ?? 'GET', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...init.headers }, ...(init.body ? { body: JSON.stringify(init.body) } : {}) })
      return { status: r.status, body: await r.json().catch(() => null) }
    }
    await waitUntil(async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok } catch { return false } }, 15_000, 'the daemon\'s /health')

    // The fake extension: answers every call at once with {tool, args}, except `type`, which it never answers.
    ws = new WebSocket(`ws://127.0.0.1:${port}/ext`, { headers: { origin: 'chrome-extension://fake' } } as never)
    const socket = ws
    socket.addEventListener('open', () => socket.send(JSON.stringify({ t: 'hello', v: 1, id: 'fake-1', name: 'fake-1', userAgent: 'test', token })))
    socket.addEventListener('message', ev => {
      const m = JSON.parse(String(ev.data)) as { t: string; rid?: string; tool?: string; args?: unknown }
      if (m.t === 'call' && m.tool !== 'type') socket.send(JSON.stringify({ t: 'result', rid: m.rid, ok: true, value: { tool: m.tool, args: m.args } }))
    })
    await waitUntil(async () => ((await api('/browsers')).body?.browsers ?? (await api('/browsers')).body ?? []).some?.((x: { id: string }) => x.id === 'fake-1') ?? false, 10_000, 'the fake extension connected')
    const call = (tool: string, args: object, callId: string) => api('/browsers/fake-1/call', { method: 'POST', body: { tool, args }, headers: { 'x-bridge-call': callId } })
    const sources = [bridgeTraceSource(home)]

    // On: the daemon read the capabilities (diagnose's mode), a call that works is in trace.log with its arguments.
    const diag = await call('diagnose', {}, 'diag0001')
    assert.equal(diag.status, 200, JSON.stringify(diag.body))
    assert.deepEqual([diag.body.result.daemon.mode.debug, diag.body.result.daemon.mode.callTimeoutMs], [true, 1000])
    const okCall = await call('snapshot', { tab: '1' }, 'okcall01')
    assert.equal(okCall.status, 200, JSON.stringify(okCall.body))
    const okLines = await callTimeline(sources, 'okcall01')
    const text = renderTimeline('okcall01', okLines)
    assert.ok(okLines.some(e => e.event === 'call_started' && e.origin === 'traço' && JSON.stringify(e.args) === '{"tab":"1"}'), text)
    assert.ok(okLines.some(e => e.event === 'call_finished' && e.ok === true), text)

    // A call the extension never answers: CALL_TIMEOUT after the 1 s debug deadline, with its dump.
    const t0 = Date.now()
    const stuck = await call('type', { ref: 'e1', text: 'olá' }, 'stuck001')
    const took = Date.now() - t0
    assert.equal(stuck.body?.error?.code, 'CALL_TIMEOUT', JSON.stringify(stuck.body))
    assert.ok(took < 20_000, `the debug deadline, not the 60 s default (${took} ms)`)
    const dump = stuck.body.error.data?.dump as string | undefined
    assert.ok(dump && existsSync(dump), `dump folder: ${JSON.stringify(stuck.body.error.data)}`)
    const stuckLines = await callTimeline(sources, 'stuck001')
    const stuckText = renderTimeline('stuck001', stuckLines)
    console.log(stuckText)
    assert.match(stuckText, /falhou \(CALL_TIMEOUT\)/)
    assert.ok(stuckText.includes(`despejo da falha: ${dump}`), stuckText)

    // Off, live, by the settings: diagnose says so and the next call writes nothing to trace.log.
    values.debug = false
    assert.equal(applyCapabilities(b, bridgeHome, settings, ['debug']), 'written')
    const off = await call('diagnose', {}, 'diag0002')
    assert.equal(off.body.result.daemon.mode.debug, false)
    assert.equal(off.body.result.daemon.mode.callTimeoutMs, 60_000, 'back to the default deadline')
    assert.equal((await call('snapshot', {}, 'offcall1')).status, 200)
    const traced = readFileSync(join(bridgeHome, 'trace.log'), 'utf8')
    assert.ok(!traced.includes('offcall1'), 'no trace.log line once off')
    assert.ok(readFileSync(join(bridgeHome, 'daemon.log'), 'utf8').includes('offcall1'), 'the daemon.log (layer 0) still has it')
  } finally {
    try { ws?.close() } catch { /* closed */ }
    for (const p of owned) await killOwned(p)
    closeSync(logFd)
    for (let i = 0; i < 10; i++) {
      try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
