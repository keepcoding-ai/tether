// The local patches in the vendored server.mjs (extensions/browser/vendor.mjs lists them): a new copy from the source drops
// them unless the source got them first, and these checks say which one went missing. They read the bundle as text: the
// server runs only against a live gatekeeper (adopt mode), out of reach of a unit test.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const server = readFileSync(join(here, '../../extensions/browser/vendor/tether-browser/server.mjs'), 'utf8')
const gate = readFileSync(join(here, '../../extensions/browser/gate.ts'), 'utf8')

test('vendor patch: the client\'s cancellation of WebAskUser reaches the host as Tether.cancelAsk', () => {
  // register-tools hands the MCP SDK's abort signal (aborted on notifications/cancelled) to the tool.
  assert.match(server, /await tool\.handler\(args, \{ \.\.\.progress \? \{ progress \} : \{\}, \.\.\.extra\?\.signal \? \{ signal: extra\.signal \} : \{\} \}\)/)
  // askUser: on abort (or already aborted when the request went out), the host is told; the listener goes with the call.
  assert.match(server, /ctx\?\.signal\?\.addEventListener\("abort", cancelled, \{ once: true \}\)/)
  assert.match(server, /if \(ctx\?\.signal\?\.aborted\) cancelled\(\);/)
  assert.match(server, /ctx\?\.signal\?\.removeEventListener\("abort", cancelled\);/)
  assert.match(server, /const cancelled = \(\) => \{\s*void control\.cancelAsk\(targetId\);/)
  // TabControl speaks the method; a host that does not know it is tolerated (call() marks it missing, nothing throws).
  assert.match(server, /CANCEL_ASK = "Tether\.cancelAsk";/)
  assert.match(server, /async cancelAsk\(targetId\) \{\s*await this\.call\(CANCEL_ASK, \{ targetId \}\)\.catch/)
  // The gatekeeper answers it.
  assert.match(gate, /case 'Tether\.cancelAsk': \{/)
})

test('vendor patch: WebNavigate names its stages and reads the title within the action timeout, failing named', () => {
  assert.match(server, /stage\("navigate"\);\s*await t\.page\.goto\(url2,/)
  assert.match(server, /return \{ url: t\.page\.url\(\), title: await titleWithin\(t, timeoutNow\(\)\) \};/)
  assert.match(server, /const titleWithin = async \(t, ms\) => \{\s*stage\("title"\);/)
  assert.match(server, /new BrowserError\("PAGE_NOT_READABLE", `The page at \$\{t\.page\.url\(\)\} loaded, but its title was not read within \$\{ms\} ms/)
  // A named code shows as `[PAGE_NOT_READABLE] ...` only when the catalog knows it (otherwise it would read as [INTERNAL]).
  const codes = /BROWSER_ERROR_CODES = \[([\s\S]*?)\];/.exec(server)?.[1] ?? ''
  assert.match(codes, /"PAGE_NOT_READABLE"/)
})
