// The doctor's new lines (tether-bridge-debug T2): the browser's, without opening a tab (extensions/browser/doctor.ts:
// endpoint.json and its pid, the gatekeeper's identity, mcp.log writable and its last call, the calls in flight by the file),
// and the bridge's calls in flight (GET /status `pending`, extensions/web-bridge/status-poll.ts), with temp files and fakes.
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import '../../extensions/index.daemon.ts'
import { browserChecks, callsOfTail, dumpCount, dumpDirOf } from '../../extensions/browser/doctor.ts'
import { bridgeInFlightCheck } from '../../extensions/web-bridge/status-poll.ts'
import { pendingOf } from '../../extensions/web-bridge/status.ts'
import { tempDirs } from './tmp.helpers.ts'

const tmp = tempDirs('tether-browser-doctor-')
after(() => tmp.cleanup())
const NOW = Date.UTC(2026, 10, 14, 12, 0, 0)
const iso = (agoMs: number): string => new Date(NOW - agoMs).toISOString()
const jl = (...rows: unknown[]): string => rows.map(r => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n'

function homeWith(endpoint?: unknown, trace?: string): string {
  const h = tmp.make()
  mkdirSync(join(h, 'browser'), { recursive: true })
  if (endpoint !== undefined) writeFileSync(join(h, 'browser', 'endpoint.json'), JSON.stringify(endpoint))
  if (trace !== undefined) writeFileSync(join(h, 'browser', 'mcp.log'), trace)
  return h
}
const run = async (h: string, o: { alive?: boolean; fetch?: typeof fetch } = {}) =>
  Promise.all(browserChecks({ home: h, now: () => NOW, alive: () => o.alive ?? true, fetch: o.fetch ?? (async () => { throw new Error('ECONNREFUSED') }) }).map(c => c()))
const EP = { v: 1, port: 51234, pid: 4321, instance: 'abc' }

describe('tether doctor: the browser', () => {
  test('no endpoint.json: the process and the gate say why; an empty trace is fine', async () => {
    const [proc, gate, trace, flight] = await run(homeWith())
    assert.equal(proc!.level, 'AVISO')
    assert.match(proc!.detail, /endpoint\.json ausente/)
    assert.equal(gate!.level, 'OK', 'the process line already says it')
    assert.equal(trace!.level, 'OK')
    assert.match(trace!.detail, /nenhuma chamada registrada/)
    assert.deepEqual([flight!.level, flight!.detail], ['OK', 'nenhuma (pelo mcp.log)'])
  })

  test('a live pid and a gate that answers with the same instance: OK; the gate is asked at its port, with no key', async () => {
    const asked: string[] = []
    const fake: typeof fetch = async (url, init) => {
      asked.push(String(url))
      assert.equal((init?.headers as Record<string, string>).authorization, undefined)
      return new Response(JSON.stringify({ instance: 'abc' }), { status: 200 })
    }
    const [proc, gate] = await run(homeWith(EP), { fetch: fake })
    assert.equal(proc!.level, 'OK')
    assert.match(proc!.detail, /pid 4321 de pé/)
    assert.equal(gate!.level, 'OK')
    assert.deepEqual(asked, ['http://127.0.0.1:51234/tether/identity'])
  })

  test('a dead pid (stale file), another instance, a gate that does not answer: AVISO each', async () => {
    const [proc] = await run(homeWith(EP), { alive: false })
    assert.equal(proc!.level, 'AVISO')
    assert.match(proc!.detail, /pid 4321, que não está rodando/)
    const [, other] = await run(homeWith(EP), { fetch: async () => new Response(JSON.stringify({ instance: 'zzz' })) })
    assert.match(other!.detail, /não é o porteiro deste endpoint\.json/)
    const [, mute] = await run(homeWith(EP))
    assert.match(mute!.detail, /não responde/)
  })

  test('mcp.log: the last call\'s time, and the open calls of the newest writer only', async () => {
    const trace = jl(
      { t: iso(600_000), ev: 'call_started', call: 'old1', tool: 'WebClick', pid: 1 }, // a previous tetherd: died with it
      { t: iso(120_000), ev: 'call_started', call: 'a1', tool: 'WebSnapshot', pid: 2 },
      'garbage',
      { t: iso(110_000), ev: 'call_finished', call: 'a1', tool: 'WebSnapshot', ok: true, durationMs: 10, pid: 2 },
      { t: iso(40_000), ev: 'call_started', call: 'b2', tool: 'WebType', pid: 2 },
      { t: iso(5_000), ev: 'cdp', call: 'b2', method: 'Input.insertText', pid: 2 },
    )
    const [, , last, flight] = await run(homeWith(EP, trace))
    assert.match(last!.detail, /gravável; última chamada há 40 s/)
    assert.equal(flight!.level, 'OK')
    assert.match(flight!.detail, /^1 pelo mcp\.log, sem fim registrado: b2 WebType há 40 s/)
    assert.match(flight!.hint!, /tether trace b2/)
    assert.deepEqual(callsOfTail([]).open, [])
  })
})

describe('tether doctor: the bridge\'s calls in flight', () => {
  test('pendingOf reads every browser\'s pending, oldest first; an older daemon without it is empty', () => {
    assert.deepEqual(pendingOf({ browsers: [{ id: 'b1', name: 'Chrome', pending: [{ callId: 'x1', tool: 'type', ageMs: 100 }] }, { id: 'b2', pending: [{ callId: 'x2', tool: 'snapshot', ageMs: 4000 }, { tool: 'no id' }] }] }), [
      { callId: 'x2', tool: 'snapshot', ageMs: 4000, browser: 'b2' },
      { callId: 'x1', tool: 'type', ageMs: 100, browser: 'Chrome' },
    ])
    assert.deepEqual(pendingOf({ browsers: [{ id: 'b1' }] }), [])
    assert.deepEqual(pendingOf(undefined), [])
  })

  test('the check asks /status with the bearer and lists the calls; no key, a mute daemon: said, never an error', async () => {
    const home = tmp.make()
    assert.match((await bridgeInFlightCheck({ port: 47999, bridgeHome: home })).detail, /sem api\.key/)
    writeFileSync(join(home, 'api.key'), 'k'.repeat(43))
    let auth: string | undefined
    const fake: typeof fetch = async (url, init) => {
      auth = (init?.headers as Record<string, string>).authorization
      assert.equal(String(url), 'http://127.0.0.1:47999/status')
      return new Response(JSON.stringify({ ok: true, browsers: [{ id: 'b1', name: 'Chrome', pending: [{ callId: '3f9a1c0e', tool: 'type', ageMs: 41250 }] }] }))
    }
    const r = await bridgeInFlightCheck({ port: 47999, bridgeHome: home, fetch: fake })
    assert.equal(auth, `Bearer ${'k'.repeat(43)}`)
    assert.deepEqual([r.level, r.detail, r.hint], ['OK', '1: 3f9a1c0e type há 41 s (Chrome)', 'veja tether trace 3f9a1c0e'])
    assert.ok(!JSON.stringify(r).includes('kkkk'), 'the key never reaches the report')
    const idle = await bridgeInFlightCheck({ port: 47999, bridgeHome: home, fetch: async () => new Response(JSON.stringify({ browsers: [] })) })
    assert.equal(idle.detail, 'nenhuma')
    const mute = await bridgeInFlightCheck({ port: 47999, bridgeHome: home, fetch: async () => { throw new Error('ECONNREFUSED') } })
    assert.equal(mute.level, 'OK')
  })
})

describe('tether doctor: the browser\'s debug dumps', () => {
  test('the trace line counts the dump folders, and says nothing without them', async () => {
    const h = homeWith(EP, jl({ t: iso(1000), ev: 'call_finished', call: 'c1', tool: 'WebClick', ok: false, pid: 2 }))
    assert.equal(dumpCount(h), 0)
    assert.doesNotMatch((await run(h))[2]!.detail, /despejo/)
    for (const id of ['c1', 'c2']) mkdirSync(join(dumpDirOf(h), id), { recursive: true })
    writeFileSync(join(dumpDirOf(h), 'stray.txt'), 'x')
    assert.equal(dumpCount(h), 2)
    assert.match((await run(h))[2]!.detail, /; 2 despejos de falha em .*debug$/)
  })
})
