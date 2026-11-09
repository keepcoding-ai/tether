// Pure rules of the CDP gatekeeper (Tether Browser E5): refusal by header, Host, key shape and constant-time owner lookup, the
// key store (deleted key stops working), the session table (ids of another connection are unknown), event scrubbing, mouse
// scale, and the WebSocket frames.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KeyStore } from '../../extensions/browser/gate-keys.ts'
import {
  BROWSER_ALLOWED, fromBrowser, keyOf, keysEqual, loopbackHost, navigable, ownerOfKey, PAGE_ALLOWED, parseKeyFile, refusal,
  scaleMouse, scrubEvent, SessionTable, slotOfKeyFile, validKeyShape,
} from '../../extensions/browser/gate-rules.ts'
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
  assert.equal(PAGE_ALLOWED.size, 31)
  for (const m of ['Page.setFontFamilies', 'Page.removeScriptToEvaluateOnNewDocument', 'Runtime.evaluate']) assert.ok(PAGE_ALLOWED.has(m), m)
  for (const m of ['Network.getAllCookies', 'Network.getCookies', 'Storage.getCookies', 'DOM.setFileInputFiles', 'Fetch.enable', 'Network.setExtraHTTPHeaders', 'Page.close', 'Page.crash', 'Browser.close', 'Target.createTarget', 'Page.printToPDF']) assert.equal(PAGE_ALLOWED.has(m), false, m)
  for (const m of ['Browser.close', 'Target.disposeBrowserContext', 'Storage.getCookies', 'Target.exposeDevToolsProtocol']) assert.equal(BROWSER_ALLOWED.has(m), false, m)
  for (const u of ['https://x.test/', 'http://localhost:1/', 'about:blank', 'data:text/html,hi', 'blob:https://x/1']) assert.ok(navigable(u), u)
  for (const u of ['file:///C:/x', 'javascript:alert(1)', 'chrome://gpu', 'devtools://x', 'view-source:https://x', 42]) assert.equal(navigable(u), false, String(u))
  assert.match(refusal('Tether.askUser', 'x').message, /wasn't found/)
  assert.deepEqual(scaleMouse({ type: 'mousePressed', x: 100, y: 50 }, 0.5), { type: 'mousePressed', x: 50, y: 25 })
  const p = { type: 'mouseWheel', x: 1, y: 1, deltaY: 100 }
  assert.equal(scaleMouse(p, 1), p)
  assert.equal(scaleMouse({ type: 'mouseWheel', x: 10, y: 10, deltaY: 100 }, 0.5).deltaY, 100, 'wheel delta stays')
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
