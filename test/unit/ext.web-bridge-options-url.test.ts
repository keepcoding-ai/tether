import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectedFor, isScriptExe, launchUrl, optionsUrl } from '../../extensions/web-bridge/browsers.ts'
import { linkBrowser } from '../../extensions/web-bridge/status.ts'

// The link menu's "Abrir no <nome> pelo Bridge": which browser, and what address reaches its command line.
test('linkBrowser: the active connected browser, else the first; none while the daemon is not up or nobody is connected', () => {
  const a = { id: 'b1', name: 'Chrome', tabs: 0 }
  const b = { id: 'b2', name: 'Edge', tabs: 0, active: true }
  assert.deepEqual(linkBrowser({ daemon: 'up', browsers: [a, b] }), { id: 'b2', name: 'Edge' })
  assert.deepEqual(linkBrowser({ daemon: 'up', browsers: [a] }), { id: 'b1', name: 'Chrome' })
  assert.equal(linkBrowser({ daemon: 'up', browsers: [] }), undefined)
  assert.equal(linkBrowser({ daemon: 'down', browsers: [a] }), undefined)
  assert.equal(linkBrowser({ daemon: 'refused', browsers: [b] }), undefined)
})

test('detectedFor: the detected browser behind a connected name; no fallback to another browser', () => {
  const list = [{ id: 'edge', name: 'Microsoft Edge', exe: 'C:/e/msedge.exe' }, { id: 'chrome', name: 'Google Chrome', exe: 'C:/c/chrome.exe' }]
  assert.equal(detectedFor(list, 'Chrome')?.id, 'chrome')
  assert.equal(detectedFor(list, 'edge')?.id, 'edge')
  assert.equal(detectedFor(list, 'Brave'), undefined)
  assert.equal(detectedFor(list, ''), undefined)
})

test('launchUrl: absolute http(s) only, normalized; through a shell launcher, nothing cmd reads', () => {
  assert.equal(launchUrl('https://a.b/c?d=1', false), 'https://a.b/c?d=1')
  assert.equal(launchUrl('  http://localhost:8080/x  ', false), 'http://localhost:8080/x')
  assert.equal(launchUrl('https://a.b/x y"z', false), 'https://a.b/x%20y%22z')
  assert.equal(launchUrl('https://a.b/?q=1&calc', false), 'https://a.b/?q=1&calc', 'no shell: & is just a query separator')
  for (const bad of ['file:///C:/x', 'javascript:alert(1)', '--disable-web-security', 'chrome://settings', 'notaurl', 42, undefined]) {
    assert.equal(launchUrl(bad, false), undefined, String(bad))
  }
  assert.equal(launchUrl('http://localhost:9/plain/path?a=1', true), 'http://localhost:9/plain/path?a=1')
  for (const bad of ['https://a.b/?q=1&calc', 'https://a.b/|x', 'https://a.b/%41', 'https://a.b/^x', 'https://a.b/(x)', 'https://a.b/!x']) {
    assert.equal(launchUrl(bad, true), undefined, bad)
  }
  assert.ok(isScriptExe('C:/x/fake.cmd') && isScriptExe('C:/x/FAKE.BAT') && !isScriptExe('C:/x/chrome.exe'))
})

// Chrome opens a blank New Tab for chrome://extensions/?id=... given on the command line;
// only chrome-extension:// reaches the extension's options page.
test('optionsUrl targets the extension options page, never a browser-internal scheme', () => {
  const url = optionsUrl('injmgjkjjfjeamlnnpacjcfnfkjgpmnk')
  assert.equal(url, 'chrome-extension://injmgjkjjfjeamlnnpacjcfnfkjgpmnk/options.html')
  assert.ok(!/^(chrome|edge|brave):/.test(url))
})
