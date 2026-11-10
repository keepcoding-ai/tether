// The tabs' network filter rules (extensions/browser/net-rules.ts, Tether Browser E3): which hosts are local (every form of
// IP, the local names), which origins are, which schemes pass, the decision for a request and a redirect hop (the S4 cases),
// and the tickets.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { decide, isLocalHost, isLocalOrigin, originOnly, parseIp, parseV4, type RequestFacts, sameOrigin, Tickets, ticketUrl } from '../../extensions/browser/net-rules.ts'

const PUB = 'http://pub.example:8080'
const LOCAL = 'http://127.0.0.1:5173'
const req = (f: Partial<RequestFacts> & { url: string }): RequestFacts => ({ resourceType: 'xhr', method: 'GET', ticket: false, ...f })

describe('browser: network filter rules', () => {
  test('IPv4 in every WHATWG form', () => {
    const lo = 0x7f000001n
    for (const h of ['127.0.0.1', '2130706433', '0x7f000001', '0x7f.1', '0x7F.0.0.1', '017700000001', '0177.0.0.1', '127.1', '127.0.1', '0x7f.0x0.0x0.0x1', '127.0.0.1.']) {
      assert.equal(parseV4(h), lo, h)
    }
    assert.equal(parseV4('example.com'), undefined)
    assert.equal(parseV4('1.2.3.4.5'), null)
    assert.equal(parseV4('256.1.1.1'), null)
    assert.equal(parseV4('1.2.3.09'), null, 'invalid octal')
    assert.equal(parseV4('4294967296'), null)
    assert.equal(parseV4('0x'), 0n)
  })

  test('local IPs: loopback, private, link-local and cloud metadata, CGNAT, 0.0.0.0, multicast', () => {
    for (const h of ['127.0.0.1', '127.255.255.254', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.0.17', '169.254.169.254', '169.254.1.1', '100.64.0.1', '0.0.0.0', '0', '224.0.0.1', '255.255.255.255', '192.0.0.1', '198.18.0.1']) {
      assert.equal(isLocalHost(h), true, h)
    }
    for (const h of ['2852039166', '0xa9fea9fe', '0251.0376.0251.0376', '0300.0250.0.1', '10.1']) assert.equal(isLocalHost(h), true, `alt form ${h}`)
    for (const h of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '100.128.0.1', '172.15.255.255', '134744072']) assert.equal(isLocalHost(h), false, h)
  })

  test('local IPv6: loopback, unspecified, ULA, link-local, site-local, mapped/compatible/NAT64/6to4/Teredo forms', () => {
    for (const h of ['[::1]', '::1', '[::]', '[fc00::1]', '[fd12:3456::1]', '[fe80::1%25eth0]', '[fe80::1]', '[fec0::1]', '[ff02::1]',
      '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[::ffff:a9fe:a9fe]', '[::127.0.0.1]', '[64:ff9b::7f00:1]', '[64:ff9b::10.0.0.1]', '[64:ff9b:1::1]', '[2002:7f00:1::]', '[2001::1]', '[::ffff:0:7f00:1]', '[fe80::5efe:7f00:1]']) {
      assert.equal(isLocalHost(h), true, h)
    }
    for (const h of ['[2606:4700:4700::1111]', '[2001:4860:4860::8888]', '[64:ff9b::808:808]', '[::ffff:8.8.8.8]']) assert.equal(isLocalHost(h), false, h)
    assert.equal(parseIp('[::1'), null)
    assert.equal(isLocalHost('[::1::2]'), true, 'a broken IPv6 is closed')
  })

  test('local names: localhost, .local and the private suffixes, single-label names; public names are not', () => {
    for (const h of ['localhost', 'LOCALHOST', 'localhost.', 'app.localhost', 'printer.local', 'nas.lan', 'db.internal', 'router.home.arpa', 'wiki.intranet', 'x.corp', 'box.localdomain', 'router', 'intranet', '']) {
      assert.equal(isLocalHost(h), true, h)
    }
    for (const h of ['example.com', 'localhost.example.com', 'local.example.com', 'my-local.dev', 'nip.io']) assert.equal(isLocalHost(h), false, h)
    // A public name that resolves to a local address is not seen by name (the E4 proxy pins the address).
    assert.equal(isLocalHost('127.0.0.1.nip.io'), false)
  })

  test('the public stand-in (the E2E) is public only when listed', () => {
    assert.equal(isLocalHost('127.0.0.2'), true)
    assert.equal(isLocalHost('127.0.0.2', { publicStandIns: new Set(['127.0.0.2']) }), false)
  })

  test('origins: a network origin with a local host; opaque and other schemes are not local', () => {
    assert.ok(isLocalOrigin('http://localhost:3000'))
    assert.ok(isLocalOrigin('http://[::1]:3000'))
    assert.ok(isLocalOrigin('ws://192.168.0.2'))
    for (const o of ['null', '', 'https://example.com', 'file://', 'data:text/html,x', 'chrome://gpu']) assert.equal(isLocalOrigin(o), false, o)
  })

  test('originOnly and sameOrigin', () => {
    assert.equal(originOnly('http://127.0.0.1:5173/secret?token=1#x'), 'http://127.0.0.1:5173')
    assert.equal(originOnly('file:///C:/Windows/win.ini'), 'file:')
    assert.equal(originOnly('nonsense'), '')
    assert.ok(sameOrigin('http://localhost:3000/login', 'http://localhost:3000/dash'))
    assert.ok(sameOrigin('http://localhost/a', 'http://localhost:80/b'))
    assert.equal(sameOrigin('http://localhost:3000/', 'http://localhost:3001/'), false)
    assert.equal(sameOrigin('http://localhost:3000/', 'https://localhost:3000/'), false)
    assert.equal(sameOrigin('http://localhost:3000/', 'http://127.0.0.1:3000/'), false)
  })

  test('schemes: main frame http(s) only; sub-resources http(s), ws(s), data:, blob:', () => {
    for (const url of ['file:///C:/Windows/win.ini', 'chrome://gpu', 'devtools://devtools/bundled/inspector.html', 'chrome-extension://x/y', 'ftp://x/y', 'javascript:1', 'nonsense']) {
      assert.deepEqual(decide(req({ url, initiator: LOCAL })), { allow: false, reason: 'scheme' }, url)
      assert.deepEqual(decide(req({ url, resourceType: 'mainFrame' })), { allow: false, reason: 'scheme' }, `main ${url}`)
    }
    for (const url of ['data:text/plain,x', 'blob:http://pub.example/uuid']) {
      assert.equal(decide(req({ url, initiator: PUB })).allow, true, url)
      assert.equal(decide(req({ url, resourceType: 'mainFrame' })).allow, false, `main ${url}`)
    }
    assert.equal(decide(req({ url: 'wss://pub.example/s', resourceType: 'webSocket', initiator: PUB })).allow, true)
  })

  test('S4 case 2/5/9: a public page reaching the local network is refused (fetch, img, iframe, script, ws, worker, beacon)', () => {
    const targets = ['http://127.0.0.1:2375/', 'http://localhost:5173/', 'http://[::1]:5173/', 'http://192.168.0.17/', 'http://169.254.169.254/latest/meta-data/', 'http://0.0.0.0:80/', 'http://2130706433/', 'http://printer.local/', 'ws://127.0.0.1:9229/']
    for (const resourceType of ['xhr', 'image', 'subFrame', 'script', 'webSocket', 'ping', 'other', 'media', 'stylesheet', 'font']) {
      for (const url of targets) assert.deepEqual(decide(req({ url, resourceType, initiator: PUB })), { allow: false, reason: 'local-from-public' }, `${resourceType} ${url}`)
    }
    assert.deepEqual(decide(req({ url: 'http://127.0.0.1/', initiator: 'null' })), { allow: false, reason: 'local-from-public' }, 'opaque origin (data: iframe, sandbox)')
  })

  test('S4 case 10/10b: a local app reaches itself and the local network; a public page navigating to the same address is refused', () => {
    for (const resourceType of ['xhr', 'script', 'webSocket', 'subFrame', 'mainFrame']) {
      assert.deepEqual(decide(req({ url: `${LOCAL}/api`, resourceType, initiator: LOCAL })), { allow: true, grant: 'origin', useTicket: false }, resourceType)
    }
    assert.equal(decide(req({ url: 'http://127.0.0.1:8000/', initiator: 'http://localhost:3000' })).allow, true, 'local origin to another local port')
    assert.deepEqual(decide(req({ url: `${LOCAL}/`, resourceType: 'mainFrame', initiator: PUB, ticket: true })), { allow: false, reason: 'local-from-public' }, 'a page-started navigation never uses the ticket')
  })

  test('public destinations always pass (ports and the resolved address are the proxy\'s)', () => {
    assert.deepEqual(decide(req({ url: 'https://example.com/', initiator: PUB })), { allow: true, grant: 'public', useTicket: false })
    assert.deepEqual(decide(req({ url: 'https://example.com/', resourceType: 'mainFrame' })), { allow: true, grant: 'public', useTicket: false })
  })

  test('S4 case 1: the agent\'s navigation to the local network passes only with a ticket (browser-started main frame, GET)', () => {
    const nav = { url: `${LOCAL}/`, resourceType: 'mainFrame' }
    assert.deepEqual(decide(req(nav)), { allow: false, reason: 'local-without-ticket' })
    assert.deepEqual(decide(req({ ...nav, ticket: true })), { allow: true, grant: 'ticket', useTicket: true })
    assert.deepEqual(decide(req({ ...nav, ticket: true, method: 'POST' })), { allow: false, reason: 'local-without-ticket' })
    assert.deepEqual(decide(req({ ...nav, resourceType: 'subFrame', ticket: true })), { allow: false, reason: 'local-without-ticket' })
  })

  test('S4 case 3: redirect hops', () => {
    const hop = (url: string, prevUrl: string, grant: 'public' | 'origin' | 'ticket', extra: Partial<RequestFacts> = {}) => decide(req({ url, resourceType: 'mainFrame', hop: { prevUrl, grant }, ...extra }))
    // 3a: public → local navigation (the agent opened a public page that 302s to localhost).
    assert.deepEqual(hop(`${LOCAL}/`, 'https://pub.example/r', 'public'), { allow: false, reason: 'local-redirect' })
    // A ticket to a public address that redirects to local does not carry over either.
    assert.deepEqual(hop(`${LOCAL}/`, 'https://pub.example/r', 'ticket'), { allow: false, reason: 'local-redirect' })
    // 3c: login → dashboard, same local origin, from the ticket: kept.
    assert.deepEqual(hop(`${LOCAL}/dash`, `${LOCAL}/login`, 'ticket'), { allow: true, grant: 'ticket', useTicket: false })
    // From the ticket to ANOTHER local destination: refused (other port, other host, other scheme).
    for (const to of ['http://127.0.0.1:2375/', 'http://localhost:5173/', 'https://127.0.0.1:5173/', 'http://192.168.0.1/']) assert.deepEqual(hop(to, `${LOCAL}/login`, 'ticket'), { allow: false, reason: 'local-redirect' }, to)
    // A hop never spends a fresh ticket, even one for the hop's exact address.
    assert.deepEqual(hop('http://127.0.0.1:2375/', `${LOCAL}/login`, 'ticket', { ticket: true }), { allow: false, reason: 'local-redirect' })
    // 3b: a public page's sub-resource 307 → local (the hop keeps the public initiator).
    assert.deepEqual(decide(req({ url: `${LOCAL}/x`, initiator: PUB, hop: { prevUrl: 'https://pub.example/r', grant: 'public' } })), { allow: false, reason: 'local-redirect' })
    // A local app's own redirect to another local port: its origin is local.
    assert.deepEqual(decide(req({ url: 'http://127.0.0.1:8000/', initiator: LOCAL, hop: { prevUrl: `${LOCAL}/r`, grant: 'origin' } })), { allow: true, grant: 'origin', useTicket: false })
    // Redirect to public: always passes.
    assert.equal(hop('https://example.com/', `${LOCAL}/r`, 'ticket').allow, true)
    // Redirect to file: refused by scheme.
    assert.deepEqual(hop('file:///C:/Windows/win.ini', `${LOCAL}/r`, 'ticket'), { allow: false, reason: 'scheme' })
  })

  test('tickets: exact address, one tab, one use, expire', () => {
    const t = new Tickets(5_000)
    assert.ok(t.grant(7, 'http://LOCALHOST:5173/a#frag', 1_000))
    assert.equal(ticketUrl('http://LOCALHOST:5173/a#frag'), 'http://localhost:5173/a')
    assert.equal(t.has(7, 'http://localhost:5173/a', 1_001), true, 'normalized, fragment dropped')
    assert.equal(t.has(8, 'http://localhost:5173/a', 1_001), false, 'other tab')
    assert.equal(t.has(7, 'http://localhost:5173/a?x=1', 1_001), false, 'other address')
    assert.equal(t.has(7, 'http://localhost:5173/', 1_001), false, 'other path')
    assert.equal(t.take(7, 'http://localhost:5173/a', 1_002), true)
    assert.equal(t.take(7, 'http://localhost:5173/a', 1_003), false, 'one use')
    t.grant(7, 'http://localhost:5173/b', 2_000)
    assert.equal(t.take(7, 'http://localhost:5173/b', 7_000), false, 'expired')
    assert.equal(t.grant(7, 'file:///C:/x'), false)
    t.grant(9, 'http://localhost/', 0); t.grant(10, 'http://localhost/', 0)
    t.dropTab(9)
    assert.equal(t.has(9, 'http://localhost/', 1), false)
    assert.equal(t.has(10, 'http://localhost/', 1), true)
  })
})
