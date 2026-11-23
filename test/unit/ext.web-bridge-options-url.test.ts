import { test } from 'node:test'
import assert from 'node:assert/strict'
import { optionsUrl } from '../../extensions/web-bridge/browsers.ts'

// Chrome opens a blank New Tab for chrome://extensions/?id=... given on the command line;
// only chrome-extension:// reaches the extension's options page.
test('optionsUrl targets the extension options page, never a browser-internal scheme', () => {
  const url = optionsUrl('injmgjkjjfjeamlnnpacjcfnfkjgpmnk')
  assert.equal(url, 'chrome-extension://injmgjkjjfjeamlnnpacjcfnfkjgpmnk/options.html')
  assert.ok(!/^(chrome|edge|brave):/.test(url))
})
