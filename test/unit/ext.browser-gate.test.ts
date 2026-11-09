// Pure rules of the CDP gatekeeper (Tether Browser E5): refusal by header, Host, key shape and constant-time owner lookup, the
// key store (deleted key stops working), the session table (ids of another connection are unknown), event scrubbing, mouse
// scale, and the WebSocket frames. E6: refusals named by domain, every network event scrubbed (a sweep over every event shape),
// touch and drag scale, a hidden tab's capture plan, the dialog's Electron pin.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KeyStore } from '../../extensions/browser/gate-keys.ts'
import {
  BROWSER_ALLOWED, cropRect, dragCarriesFiles, fromBrowser, hiddenCapture, inputScale, keyOf, keysEqual, loopbackHost, navigable,
  ownerOfKey, PAGE_ALLOWED, parseKeyFile, refusal, refusalReason, scaleInput, scaleMouse, scrubEvent, SessionTable, slotOfKeyFile,
  validKeyShape,
} from '../../extensions/browser/gate-rules.ts'
import { dialogsProven } from '../../extensions/browser/tabs.ts'
import { acceptOf, frame, FrameParser } from '../../extensions/browser/ws-frames.ts'

const KEY = 'abcdefghABCDEFGH01234567_-xyz'

test('gate: a browser engine is refused (Origin, Referer, Sec-Fetch-Site/Dest/User); Node fetch is not', () => {
  assert.equal(fromBrowser({ host: 'x' }), false)
  assert.equal(fromBrowser({ 'sec-fetch-mode': 'cors' }), false, 'undici adds only this one')
  for (const h of ['origin', 'referer', 'sec-fetch-site', 'sec-fetch-dest', 'sec-fetch-user', 'Sec-Fetch-Site']) assert.equal(fromBrowser({ [h]: 'x' }), true, h)
  assert.equal(fromBrowser({ origin: '' }), true, 'even empty')
})

test('gate: only a loopback Host with the gate\'s port', () => {
  assert.ok(loopbackHost('127.0.0.1:5000', 5000))
  assert.ok(loopbackHost('localhost:5000', 5000))
  assert.ok(loopbackHost('[::1]:5000', 5000))
  for (const h of ['127.0.0.1:5001', 'evil.test:5000', '127.0.0.1', undefined, 'localhost.evil:5000']) assert.equal(loopbackHost(h, 5000), false, String(h))
})

test('gate: key shape, header, file and owner lookup', () => {
  assert.ok(validKeyShape(KEY))
  for (const k of ['short', 'x'.repeat(257), 'has space in it 1234', 'ünïcode-ünïcode-ünï', 42]) assert.equal(validKeyShape(k), false, String(k))
  assert.equal(keyOf({ 'x-tether-key': KEY }), KEY)
  assert.equal(keyOf({ 'x-tether-key': [KEY, KEY] }), undefined, 'repeated header')
  assert.equal(keyOf({}), undefined)
  assert.equal(parseKeyFile(`  ${KEY}\r\n`), KEY)
  assert.equal(parseKeyFile('not a key!'), undefined)
  assert.equal(slotOfKeyFile('slot-1.key'), 'slot-1')
  for (const n of ['slot-1.key.tmp', '.key', '..key', 'a/b.key', 'slot.txt']) assert.equal(slotOfKeyFile(n), undefined, n)
  assert.ok(keysEqual(KEY, KEY))
  assert.equal(keysEqual(KEY, KEY + 'a'), false)
  const keys = new Map([['a', KEY], ['b', 'zzzzzzzzzzzzzzzzzzzzzzzz']])
  assert.equal(ownerOfKey(KEY, keys), 'a')
  assert.equal(ownerOfKey('zzzzzzzzzzzzzzzzzzzzzzzz', keys), 'b')
  assert.equal(ownerOfKey('yyyyyyyyyyyyyyyyyyyyyyyy', keys), undefined)
})

test('gate: the key store sees a deleted or replaced key after its clock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-keys-'))
  try {
    let now = 0
    const store = new KeyStore(dir, 1000, () => now)
    writeFileSync(join(dir, 'slot-a.key'), KEY)
    assert.equal(store.owner(KEY), 'slot-a')
    assert.ok(store.valid('slot-a', KEY))
    unlinkSync(join(dir, 'slot-a.key'))
    assert.ok(store.valid('slot-a', KEY), 'cached within the clock')
    now = 1000
    assert.equal(store.valid('slot-a', KEY), false, 'deleted')
    assert.equal(store.owner(KEY), undefined)
    writeFileSync(join(dir, 'slot-a.key'), 'zzzzzzzzzzzzzzzzzzzzzzzz')
    now = 2000
    assert.equal(store.valid('slot-a', KEY), false, 'a new launch replaced the key')
    assert.equal(store.owner('zzzzzzzzzzzzzzzzzzzzzzzz'), 'slot-a')
  } finally { rmSync(dir, { recursive: true, force: true }) }
  assert.equal(new KeyStore(join(tmpdir(), 'no-such-gate-dir-x')).owner(KEY), undefined, 'no folder: no keys')
})

test('gate: session table — ids are the gate\'s, another connection\'s id is unknown', () => {
  let n = 0
  const table = new SessionTable<string>(() => `S${++n}`)
  const a = table.add('connA', 'tab1', 'inner-1', 'page')
  const b = table.add('connB', 'tab2', 'inner-1', 'page')
  assert.notEqual(a.outer, b.outer)
  assert.equal(table.get('connA', a.outer), a)
  assert.equal(table.get('connA', b.outer), undefined, 'B\'s session unknown to A')
  assert.equal(table.get('connA', 'inner-1'), undefined, 'an internal id is not a session')
  assert.equal(table.ofInner('tab1', 'inner-1'), a, 'events route by tab and internal id')
  assert.equal(table.ofInner('tab2', 'inner-1'), b)
  const child = table.add('connA', 'tab1', 'inner-c', 'child')
  assert.deepEqual(table.of('connA').map(s => s.outer).sort(), [a.outer, child.outer].sort())
  table.remove(a)
  assert.equal(table.get('connA', a.outer), undefined)
  assert.equal(table.ofInner('tab1', 'inner-1'), undefined)
  assert.equal(table.ofTab('tab1').length, 1)
})

test('gate: strict lists, schemes, refusal text, mouse scale', () => {
  assert.equal(PAGE_ALLOWED.size, 33)
  for (const m of ['Page.setFontFamilies', 'Page.removeScriptToEvaluateOnNewDocument', 'Runtime.evaluate']) assert.ok(PAGE_ALLOWED.has(m), m)
  for (const m of ['Network.getAllCookies', 'Network.getCookies', 'Storage.getCookies', 'DOM.setFileInputFiles', 'Fetch.enable', 'Network.setExtraHTTPHeaders', 'Page.close', 'Page.crash', 'Browser.close', 'Target.createTarget', 'Page.printToPDF']) assert.equal(PAGE_ALLOWED.has(m), false, m)
  for (const m of ['Browser.close', 'Target.disposeBrowserContext', 'Storage.getCookies', 'Target.exposeDevToolsProtocol']) assert.equal(BROWSER_ALLOWED.has(m), false, m)
  for (const u of ['https://x.test/', 'http://localhost:1/', 'about:blank']) assert.ok(navigable(u), u)
  for (const u of ['file:///C:/x', 'javascript:alert(1)', 'chrome://gpu', 'devtools://x', 'view-source:https://x', 'data:text/html,hi', 'blob:https://x/1', 'about:srcdoc', ' https://x/', 42]) assert.equal(navigable(u), false, String(u))
  assert.match(refusal('Tether.askUser', 'x').message, /wasn't found/)
  assert.deepEqual(scaleMouse({ type: 'mousePressed', x: 100, y: 50 }, 0.5), { type: 'mousePressed', x: 50, y: 25 })
  const p = { type: 'mouseWheel', x: 1, y: 1, deltaY: 100 }
  assert.equal(scaleMouse(p, 1), p)
  assert.equal(scaleMouse({ type: 'mouseWheel', x: 10, y: 10, deltaY: 100 }, 0.5).deltaY, 100, 'wheel delta stays')
})

test('gate (E6): refusals are named by method and by whole domain', () => {
  assert.match(refusalReason('Network.getAllCookies'), /cookies/)
  assert.match(refusalReason('Network.getResponseBody'), /body/)
  assert.match(refusalReason('DOM.setFileInputFiles'), /disk/)
  for (const d of ['Storage', 'Fetch', 'IO', 'Tracing', 'HeapProfiler', 'Memory', 'SystemInfo', 'Audits', 'Browser', 'Target']) {
    assert.match(refusalReason(`${d}.anything`), new RegExp(`^the ${d} domain: `), d)
  }
  assert.equal(refusalReason('Accessibility.getFullAXTree'), 'not on the list')
  assert.equal(refusalReason('constructor.x'), 'not on the list')
  for (const m of ['Storage.getCookies', 'Fetch.enable', 'IO.read', 'Tracing.start', 'Memory.getDOMCounters', 'Network.getResponseBody', 'Network.setCookies', 'Emulation.clearDeviceMetricsOverride']) assert.equal(PAGE_ALLOWED.has(m), false, m)
})

test('gate (E6): input scale — mouse x/y (not the wheel delta), touch points, drag; hidden draws at 1; a drag with files', () => {
  assert.equal(inputScale({ visibility: 'hidden', scale: 0.5 }), 1)
  assert.equal(inputScale({ visibility: 'shown', scale: 0.5 }), 0.5)
  assert.equal(inputScale({ visibility: 'parked', scale: 0.5 }), 0.5)
  assert.deepEqual(scaleInput('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 10, y: 20, deltaX: 5, deltaY: 100 }, 0.5), { type: 'mouseWheel', x: 5, y: 10, deltaX: 5, deltaY: 100 })
  assert.deepEqual(scaleInput('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 100, y: 40, radiusX: 2, id: 1 }] }, 0.5), { type: 'touchStart', touchPoints: [{ x: 50, y: 20, radiusX: 1, id: 1 }] })
  assert.deepEqual(scaleInput('Input.dispatchDragEvent', { type: 'drop', x: 8, y: 4, data: { items: [] } }, 0.25), { type: 'drop', x: 2, y: 1, data: { items: [] } })
  const touchEnd = { type: 'touchEnd', touchPoints: [] }
  assert.deepEqual(scaleInput('Input.dispatchTouchEvent', touchEnd, 0.5), touchEnd)
  assert.equal(dragCarriesFiles({ data: { items: [], files: ['C:/x'] } }), true)
  assert.equal(dragCarriesFiles({ data: { items: [], files: [] } }), false)
  assert.equal(dragCarriesFiles({}), false)
})

test('gate (E6): a hidden tab\'s capture is asked at least viewport-sized, beyond the viewport, and cropped back', () => {
  const vp = { x: 0, y: 300, width: 1280, height: 800 }
  const el = hiddenCapture({ format: 'png', clip: { x: 10, y: 320, width: 100, height: 50, scale: 1 } }, vp)
  assert.deepEqual(el.request, { format: 'png', clip: { x: 10, y: 320, width: 1280, height: 800, scale: 1 }, captureBeyondViewport: true })
  assert.deepEqual(cropRect(el.want, el.got, 1600), { x: 0, y: 0, width: 125, height: 63, outWidth: 125, outHeight: 63 })
  const view = hiddenCapture({}, vp)
  assert.deepEqual(view.want, { ...vp, scale: 1 })
  assert.deepEqual(view.got, { ...vp, scale: 1 })
  const full = hiddenCapture({ clip: { x: 0, y: 0, width: 1280, height: 3000, scale: 1 }, captureBeyondViewport: true }, vp)
  assert.deepEqual(full.got, { x: 0, y: 0, width: 1280, height: 3000, scale: 1 })
  const half = hiddenCapture({ clip: { x: 0, y: 0, width: 200, height: 100, scale: 0.5 } }, vp)
  assert.deepEqual(cropRect(half.want, half.got, 1280), { x: 0, y: 0, width: 200, height: 100, outWidth: 100, outHeight: 50 })
})

test('gate (E6): the dialog replacement is pinned to the Electron major it was proven on', () => {
  assert.equal(dialogsProven('45.1.0'), true)
  assert.equal(dialogsProven('46.0.0'), false)
  assert.equal(dialogsProven(undefined), false)
})

test('gate (E6): a sweep over every network event shape — no cookie, credential or raw header text survives', () => {
  const BAIT = 'BAIT-SECRET-77'
  const h = { Cookie: `sid=${BAIT}`, 'set-cookie': `a=${BAIT}`, Authorization: `Bearer ${BAIT}`, 'Proxy-Authorization': BAIT, Accept: 'text/html' }
  const cookieArr = [{ cookie: { name: 'sid', value: BAIT }, blockedReasons: [] }]
  const res = { url: 'u', status: 302, headers: h, requestHeaders: h, headersText: `HTTP/1.1 302\r\nSet-Cookie: ${BAIT}`, requestHeadersText: `Cookie: ${BAIT}` }
  const events: [string, unknown][] = [
    ['Network.requestWillBeSent', { requestId: '1', request: { url: 'u', headers: h }, redirectResponse: res }],
    ['Network.requestWillBeSentExtraInfo', { requestId: '1', headers: h, associatedCookies: cookieArr, connectTiming: {} }],
    ['Network.responseReceived', { requestId: '1', response: res }],
    ['Network.responseReceivedExtraInfo', { requestId: '1', headers: h, headersText: `set-cookie: ${BAIT}`, blockedCookies: cookieArr, exemptedCookies: cookieArr, cookiePartitionKey: { topLevelSite: BAIT } }],
    ['Network.responseReceivedEarlyHints', { requestId: '1', headers: h }],
    ['Network.webSocketWillSendHandshakeRequest', { requestId: '2', request: { headers: h } }],
    ['Network.webSocketHandshakeResponseReceived', { requestId: '2', response: res }],
    ['Network.signedExchangeReceived', { requestId: '3', info: { outerResponse: res, header: { responseHeaders: h } } }],
    ['Network.requestIntercepted', { interceptionId: '4', request: { headers: h }, responseHeaders: h }],
    ['Fetch.requestPaused', { requestId: '5', request: { headers: h }, responseHeaders: [{ name: 'Set-Cookie', value: BAIT }, { name: 'X-Ok', value: '1' }] }],
    ['Fetch.authRequired', { requestId: '6', request: { headers: h } }],
    ['Audits.issueAdded', { issue: { details: { cookieIssueDetails: { cookie: { name: 'sid', domain: 'x' }, rawCookieLine: `sid=${BAIT}` } } } }],
    ['Network.loadingFinished', { requestId: '1' }],
    ['Page.frameNavigated', { frame: { id: 'f', url: 'u' } }],
  ]
  for (const [method, params] of events) {
    const out = JSON.stringify(scrubEvent(method, params))
    assert.ok(!out.includes(BAIT), `${method}: ${out}`)
    assert.ok(!/headersText/i.test(out), `${method} keeps raw header text`)
  }
  const kept = scrubEvent('Network.requestWillBeSent', events[0]![1]) as any
  assert.deepEqual(kept.request.headers, { Accept: 'text/html' }, 'other headers stay')
  assert.deepEqual(kept.redirectResponse.headers, { Accept: 'text/html' })
  const paused = scrubEvent('Fetch.requestPaused', events[9]![1]) as any
  assert.deepEqual(paused.responseHeaders, [{ name: 'X-Ok', value: '1' }])
  const raw = events[1]![1]
  scrubEvent('Network.requestWillBeSentExtraInfo', raw)
  assert.ok(JSON.stringify(raw).includes(BAIT), 'the original params are not mutated (copies only)')
})

test('gate: cookies and credentials leave network events', () => {
  const extra = scrubEvent('Network.requestWillBeSentExtraInfo', { headers: { Cookie: 'sid=1', Accept: '*/*' }, associatedCookies: [{ cookie: { value: 'x' } }] }) as any
  assert.deepEqual(extra.headers, { Accept: '*/*' })
  assert.deepEqual(extra.associatedCookies, [])
  const resp = scrubEvent('Network.responseReceivedExtraInfo', { headers: { 'set-cookie': 'a=b' }, headersText: 'HTTP/1.1 200\r\nset-cookie: a=b' }) as any
  assert.deepEqual(resp.headers, {})
  assert.equal(resp.headersText, undefined)
  const req = scrubEvent('Network.requestWillBeSent', { request: { url: 'u', headers: { Authorization: 'Bearer x', 'Proxy-Authorization': 'y' } } }) as any
  assert.deepEqual(req.request.headers, {})
  const r2 = scrubEvent('Network.responseReceived', { response: { headers: { 'Set-Cookie': 'q' }, requestHeaders: { cookie: 'z' } } }) as any
  assert.deepEqual(r2.response, { headers: {}, requestHeaders: {} })
  const other = { a: 1 }
  assert.equal(scrubEvent('Runtime.consoleAPICalled', other), other)
})

test('gate: WebSocket handshake and frames', () => {
  assert.equal(acceptOf('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=', 'RFC 6455 example')
  assert.equal(acceptOf('nope'), undefined)
  const mask = (opcode: number, payload: Buffer, fin = true): Buffer => {
    const key = Buffer.from([1, 2, 3, 4])
    const body = Buffer.from(payload.map((b, i) => b ^ key[i % 4]!))
    const n = payload.length
    const head = n < 126 ? Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | n]) : Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | 126, n >> 8, n & 255])
    return Buffer.concat([head, key, body])
  }
  const got: string[] = []
  const errors: string[] = []
  let closed = 0
  const p = new FrameParser({ text: t => got.push(t), ping: () => got.push('ping'), close: () => closed++, error: e => errors.push(e) }, 1000)
  const big = 'x'.repeat(300)
  const bytes = Buffer.concat([mask(1, Buffer.from('hel'), false), mask(0, Buffer.from('lo')), mask(9, Buffer.from('')), mask(1, Buffer.from(big))])
  for (let i = 0; i < bytes.length; i += 7) p.push(bytes.subarray(i, i + 7))
  assert.deepEqual(got, ['hello', 'ping', big], 'split across chunks, fragmented, ping between')
  p.push(mask(8, Buffer.from([3, 232])))
  assert.equal(closed, 1)
  const q = new FrameParser({ text: () => {}, ping: () => {}, close: () => {}, error: e => errors.push(e) }, 1000)
  q.push(Buffer.from([0x81, 0x02, 0x68, 0x69]))
  assert.deepEqual(errors, ['unmasked client frame'])
  const r = new FrameParser({ text: () => {}, ping: () => {}, close: () => {}, error: e => errors.push(e) }, 100)
  r.push(mask(1, Buffer.from('y'.repeat(200))))
  assert.equal(errors.at(-1), 'message too large')
  assert.deepEqual([...frame(1, Buffer.from('hi'))], [0x81, 2, 0x68, 0x69])
  assert.equal(frame(1, Buffer.alloc(70000)).subarray(0, 2)[1], 127)
})
