// `tether trace` (src/trace/timeline.ts + the two sources + src/cli/trace.ts), over log files built in a temp home with the
// shapes the bases write: the bridge's mcp.log / daemon.log / trace.log (`{ts, event, callId}`, the extension's lines with
// `at`) and the browser's mcp.log (`{t, ev, call}`). One timeline from many origins and rotated generations; a line that is
// not JSON skipped; an unknown id; `--last`; `--replay` with arguments, without them and with `[redacted]`; `--json`.
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import '../../extensions/index.daemon.ts'
import { bridgeTraceSource } from '../../extensions/web-bridge/trace-source.ts'
import { browserTraceSource } from '../../extensions/browser/trace-source.ts'
import { FAILED_CALL, serverInstructions } from '../../extensions/browser/mcp-texts.ts'
import { callTimeline, generationsOf, lastFailures, redactedPaths, renderTimeline, replayOf, tailLines } from '../../src/trace/timeline.ts'
import { cmdTrace } from '../../src/cli/trace.ts'
import { UsageError } from '../../src/cli/args.ts'
import { tempDirs } from './tmp.helpers.ts'

const tmp = tempDirs('tether-trace-')
after(() => tmp.cleanup())

const jl = (...rows: Array<Record<string, unknown> | string>): string => rows.map(r => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n'
const T = (s: number): string => new Date(Date.UTC(2026, 10, 14, 10, 0, 0) + s * 1000).toISOString()

/** A home with both tools' logs: call `ab12cd34` (bridge type, timed out, debug on), `ff00ee11` (browser click, debug off). */
function home(): string {
  const h = tmp.make()
  const bridge = join(h, 'bridge')
  const browser = join(h, 'browser')
  mkdirSync(bridge, { recursive: true }); mkdirSync(browser, { recursive: true })
  // The bridge's shell: its start in the rotated generation, its end in the live file.
  writeFileSync(join(bridge, 'mcp.log.1'), jl({ ts: T(0), event: 'call_started', mcp: 7, callId: 'ab12cd34', tool: 'type' }))
  writeFileSync(join(bridge, 'mcp.log'), jl('not json at all', { ts: T(60.1), event: 'call_finished', mcp: 7, callId: 'ab12cd34', tool: 'type', ok: false, code: 'CALL_TIMEOUT', durationMs: 60100 }, { ts: T(70), event: 'call_finished', mcp: 7, callId: 'cc00aa11', tool: 'snapshot', ok: true, durationMs: 80 }))
  writeFileSync(join(bridge, 'daemon.log'), jl(
    { ts: T(0.01), event: 'call_started', callId: 'ab12cd34', key: 'default', client: 'tether:s1', browser: 'b1', tool: 'type', timeoutMs: 60000 },
    { ts: T(60), event: 'call_finished', callId: 'ab12cd34', key: 'default', browser: 'b1', tool: 'type', ok: false, code: 'CALL_TIMEOUT', durationMs: 59990 },
    { ts: T(61), event: 'late_result', callId: 'ab12cd34', browser: 'b1', tool: 'type', ok: true, lateMs: 1000 },
    { ts: T(80), event: 'call_finished', callId: 'dd11', tool: 'navigate', ok: false, code: 'NAVIGATION_FAILED', durationMs: 300 },
  ))
  // trace.log (debug): the daemon's lines with args, the extension's batch stamped later by the daemon but carrying `at`.
  writeFileSync(join(bridge, 'trace.log.2'), jl({ ts: T(0.02), event: 'call_started', callId: 'ab12cd34', tool: 'type', args: { selector: '#q', text: '[redacted]' } }))
  writeFileSync(join(bridge, 'trace.log'), jl(
    { ts: T(0.03), event: 'gate', callId: 'ab12cd34', gate: 'pause', decision: 'allow' },
    { ts: T(5), event: 'stage', at: T(0.5), callId: 'ab12cd34', stage: 'typing' },
    { ts: T(5), event: 'cdp', at: T(0.6), callId: 'ab12cd34', method: 'Input.dispatchKeyEvent', durationMs: 15000, ok: false, error: 'timeout' },
    { ts: T(5), event: 'typing', at: T(0.55), callId: 'ab12cd34', into: 'input', secret: false, text: 'olá' },
  ))
  writeFileSync(join(browser, 'mcp.log'), jl(
    { t: T(30), ev: 'call_started', call: 'ff00ee11', tool: 'WebClick', pid: 9 },
    '{"t": broken',
    { t: T(45), ev: 'call_finished', call: 'ff00ee11', tool: 'WebClick', durationMs: 15000, ok: false, code: 'ACTION_TIMEOUT', stage: 'aim', cdp: { method: 'DOM.getBoxModel', inFlight: true, ageMs: 14000 }, pid: 9 },
    { t: T(90), ev: 'call_started', call: 'ee22', tool: 'WebType', debug: true, args: { ref: 'e3', text: 'oi' }, pid: 9 },
    { t: T(91), ev: 'call_finished', call: 'ee22', tool: 'WebType', durationMs: 900, ok: true, pid: 9 },
  ))
  return h
}
const sourcesOf = (h: string) => [bridgeTraceSource(h), browserTraceSource(h)]

describe('tether trace: the timeline', () => {
  test('one call from the shell, the daemon and the extension, across generations, in time order (the extension by its own time)', async () => {
    const h = home()
    const e = await callTimeline(sourcesOf(h), 'ab12cd34')
    assert.deepEqual(e.map(x => `${x.origin} ${x.event}${x.step ? ` ${x.step}` : ''}`), [
      'casca call_started',
      'daemon call_started',
      'traço call_started',
      'traço gate pause: allow',
      'extensão stage typing',
      'extensão typing input',
      'extensão cdp Input.dispatchKeyEvent',
      'daemon call_finished',
      'casca call_finished',
      'daemon late_result',
    ])
    assert.equal(e.at(-1)!.durationMs, 1000, 'late_result carries lateMs as its duration')
    const text = renderTimeline('ab12cd34', e)
    assert.match(text.split('\n')[0]!, /chamada ab12cd34 · type · tether-bridge · 2026-11-14 · falhou \(CALL_TIMEOUT\)/)
    assert.match(text, /extensão\s+cdp\s+Input\.dispatchKeyEvent\s+15\.0 s\s+erro/)
  })

  test('the browser\'s call: stage and the CDP command in flight on the failure line', async () => {
    const e = await callTimeline(sourcesOf(home()), 'ff00ee11')
    assert.equal(e.length, 2, 'the broken line is skipped')
    assert.deepEqual([e[1]!.origin, e[1]!.server, e[1]!.step, e[1]!.code], ['browser', 'tether-browser', 'aim · DOM.getBoxModel', 'ACTION_TIMEOUT'])
  })

  test('an unknown id, an empty home: nothing, no error', async () => {
    assert.deepEqual(await callTimeline(sourcesOf(home()), 'zz99'), [])
    assert.deepEqual(await callTimeline(sourcesOf(tmp.make()), 'ab12cd34'), [])
    assert.match(renderTimeline('zz99', []), /nenhuma linha cita a chamada zz99/)
  })

  test('generations: the live file last, the oldest first; missing ones skipped', () => {
    const h = home()
    assert.deepEqual(generationsOf(join(h, 'bridge', 'trace.log')).map(p => p.slice(h.length + 1).replaceAll('\\', '/')), ['bridge/trace.log.2', 'bridge/trace.log'])
    assert.deepEqual(generationsOf(join(h, 'nope.log')), [])
  })

  test('tailLines reads only the end, dropping the cut first line', () => {
    const h = tmp.make()
    const f = join(h, 'x.log')
    writeFileSync(f, 'aaaaaaaaaa\nbbb\nccc\n')
    assert.deepEqual(tailLines(f, 9), ['bbb', 'ccc'])
    assert.deepEqual(tailLines(join(h, 'missing'), 9), [])
  })
})

describe('tether trace --last', () => {
  test('the latest failed calls, newest first, one per id (the shell\'s record over the daemon\'s)', async () => {
    const list = await lastFailures(sourcesOf(home()), 10)
    assert.deepEqual(list.map(c => [c.callId, c.server, c.tool, c.code, c.durationMs, c.origin]), [
      ['dd11', 'tether-bridge', 'navigate', 'NAVIGATION_FAILED', 300, 'daemon'],
      ['ab12cd34', 'tether-bridge', 'type', 'CALL_TIMEOUT', 60100, 'casca'],
      ['ff00ee11', 'tether-browser', 'WebClick', 'ACTION_TIMEOUT', 15000, 'browser'],
    ])
    assert.deepEqual((await lastFailures(sourcesOf(home()), 1)).map(c => c.callId), ['dd11'])
  })
})

describe('tether trace --replay', () => {
  test('with arguments: server, tool and the debug trace\'s args', async () => {
    const r = replayOf(await callTimeline(sourcesOf(home()), 'ee22'))
    assert.deepEqual(r, { ok: true, server: 'tether-browser', tool: 'WebType', args: { ref: 'e3', text: 'oi' }, redacted: [], typedInTrace: false })
  })

  test('with [redacted]: named, and the typing event pointed to; nothing invented', async () => {
    const r = replayOf(await callTimeline(sourcesOf(home()), 'ab12cd34'))
    assert.ok(r.ok)
    assert.deepEqual(r.ok && [r.tool, r.redacted, r.typedInTrace], ['type', ['text'], true])
    assert.deepEqual(redactedPaths({ a: [{ b: '[redacted]' }], c: 'x' }), ['a[0].b'])
  })

  test('without recorded arguments (debug off), or without the call: said plainly', async () => {
    assert.deepEqual(replayOf(await callTimeline(sourcesOf(home()), 'ff00ee11')), { ok: false, reason: 'no-args', server: 'tether-browser', tool: 'WebClick' })
    assert.deepEqual(replayOf([]), { ok: false, reason: 'not-found' })
  })
})

describe('tether trace: the CLI', () => {
  const run = async (h: string, args: string[]): Promise<{ code: number; out: string }> => {
    let out = ''
    const code = await cmdTrace(args, { out: t => { out += t }, err: () => {}, sources: () => sourcesOf(h) })
    return { code, out }
  }

  test('a timeline; --json the raw lines merged; an unknown id exits 1', async () => {
    const h = home()
    const t = await run(h, ['ab12cd34'])
    assert.equal(t.code, 0)
    assert.match(t.out, /^chamada ab12cd34/)
    const j = await run(h, ['ab12cd34', '--json'])
    const rows = j.out.trim().split('\n').map(l => JSON.parse(l) as { event: string })
    assert.equal(rows.length, 10)
    assert.equal(rows[0]!.event, 'call_started')
    assert.equal((await run(h, ['zz99'])).code, 1)
  })

  test('--replay prints the recipe or the reason; --last [n]', async () => {
    const h = home()
    const ok = await run(h, ['ee22', '--replay'])
    assert.equal(ok.code, 0)
    assert.match(ok.out, /servidor MCP: tether-browser\ntool: WebType\nargumentos: \{/)
    const red = await run(h, ['ab12cd34', '--replay'])
    assert.match(red.out, /text foi gravado como \[redacted\]/)
    assert.match(red.out, /evento typing/)
    const none = await run(h, ['ff00ee11', '--replay'])
    assert.equal(none.code, 1)
    assert.match(none.out, /não tem argumentos gravados: o modo de depuração estava desligado/)
    const last = await run(h, ['--last', '2'])
    assert.equal(last.out.trim().split('\n').length, 2)
    assert.match(last.out, /dd11\s+tether-bridge\s+navigate\s+NAVIGATION_FAILED/)
    assert.equal((await run(tmp.make(), ['--last'])).code, 1)
  })

  test('usage errors', async () => {
    const h = home()
    await assert.rejects(run(h, []), UsageError)
    await assert.rejects(run(h, ['a', 'b']), UsageError)
    await assert.rejects(run(h, ['--last', '0']), UsageError)
    await assert.rejects(run(h, ['bad id!']), UsageError)
    await assert.rejects(run(h, ['x', '--json', '--replay']), UsageError)
    await assert.rejects(run(h, ['x', '--nope']), UsageError)
  })
})

describe('the agents\' instructions', () => {
  test('the browser\'s instructions say what to do with a failed call', () => {
    for (const evaluate of [true, false]) assert.ok(serverInstructions({ evaluate }).endsWith(FAILED_CALL))
    assert.match(FAILED_CALL, /WebDiagnose/)
    assert.match(FAILED_CALL, /trace <id>/)
    assert.match(FAILED_CALL, /Modo de depuração/)
  })
})

describe('tether trace: the browser\'s debug lines (vendored server c0fc21d9c)', () => {
  test('cdp, gate, page_events and page_events_unavailable are told; the dump folder closes the timeline', async () => {
    const h = tmp.make()
    mkdirSync(join(h, 'browser'), { recursive: true })
    const dump = join(h, 'browser', 'debug', 'aa77')
    writeFileSync(join(h, 'browser', 'mcp.log'), jl(
      { t: T(0), ev: 'call_started', call: 'aa77', tool: 'WebClick', debug: true, args: { ref: 'e9' }, pid: 3 },
      { t: T(0.1), ev: 'gate', debug: true, call: 'aa77', tool: 'WebClick', gate: 'egress', decision: 'allow' },
      { t: T(0.2), ev: 'cdp', debug: true, call: 'aa77', method: 'DOM.getBoxModel', durationMs: 4, ok: true },
      { t: T(0.3), ev: 'page_events', debug: true, call: 'aa77', tool: 'WebClick', events: [{ type: 'pointerdown' }, { type: 'mousedown' }, { type: 'pointerdown' }], dropped: 2 },
      { t: T(0.4), ev: 'page_events_unavailable', debug: true, call: 'aa77', tool: 'WebClick', reason: 'a dialog is open; the listeners are removed on the next debug gesture' },
      { t: T(1), ev: 'call_finished', call: 'aa77', tool: 'WebClick', durationMs: 1000, ok: false, code: 'TARGET_NOT_FOUND', stage: 'aim', debug: true, dump, pid: 3 },
    ))
    const e = await callTimeline([browserTraceSource(h)], 'aa77')
    assert.deepEqual(e.map(x => `${x.event} ${x.step ?? ''}`.trim()), [
      'call_started',
      'gate egress: allow',
      'cdp DOM.getBoxModel',
      'page_events 3 eventos: pointerdown, mousedown (+2 descartados)',
      'page_events_unavailable indisponível: a dialog is open; the listeners are removed on the next debug gesture',
      'call_finished aim',
    ])
    assert.equal(e.at(-1)!.dump, dump)
    assert.ok(renderTimeline('aa77', e).endsWith(`despejo da falha: ${dump}\n`))
  })
})

describe('tether trace: the bridge\'s debug lines (bundle of atrium ae9ab9d45)', () => {
  test('typing, page_events, page_events_unavailable, dropped and the dump line, as trace.log writes them', async () => {
    const h = tmp.make()
    const dir = join(h, 'bridge')
    mkdirSync(dir, { recursive: true })
    const dump = join(dir, 'debug', 'bb12')
    writeFileSync(join(dir, 'trace.log'), jl(
      { ts: T(0), event: 'call_started', callId: 'bb12', key: 'default', browser: 'b1', tool: 'type', timeoutMs: null, args: { ref: 'e4', text: '[redacted]' } },
      { ts: T(3), event: 'typing', at: T(0.2), callId: 'bb12', into: 'input[type=password]', secret: true, text: '[redacted]', browser: 'b1' },
      { ts: T(3), event: 'page_events', at: T(0.9), callId: 'bb12', tool: 'type', events: [{ type: 'focus' }, { type: 'keydown' }, { type: 'input' }], browser: 'b1' },
      { ts: T(3), event: 'page_events_unavailable', at: T(1), callId: 'bb12', tool: 'type', reason: 'the listeners could not be installed', browser: 'b1' },
      { ts: T(3), event: 'dropped', at: T(1.1), callId: 'bb12', count: 12, browser: 'b1' },
      { ts: T(2), event: 'dump', callId: 'bb12', browser: 'b1', dir: dump },
      { ts: T(2.1), event: 'call_finished', callId: 'bb12', tool: 'type', ok: false, durationMs: 2100, error: { code: 'CALL_TIMEOUT', message: 'm' } },
    ))
    const e = await callTimeline([bridgeTraceSource(h)], 'bb12')
    assert.deepEqual(e.map(x => `${x.origin} ${x.event} ${x.step ?? ''}`.trim()), [
      'traço call_started',
      'extensão typing input[type=password] (senha)',
      'extensão page_events 3 eventos: focus, keydown, input',
      'extensão page_events_unavailable indisponível: the listeners could not be installed',
      'extensão dropped 12 descartados',
      'traço dump',
      'traço call_finished',
    ])
    assert.equal(e.at(-1)!.code, 'CALL_TIMEOUT', 'the code from the trace\'s error object')
    assert.ok(renderTimeline('bb12', e).endsWith(`despejo da falha: ${dump}\n`))
    const r = replayOf(e)
    assert.ok(r.ok && r.redacted.length === 1 && r.typedInTrace === false, 'a password field: the text is nowhere, said so')
  })
})
