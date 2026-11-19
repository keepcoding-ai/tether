// The local patches in the vendored server.mjs (they live in packages/browser now; vendor.mjs says so): a copy from a source that
// lacks them drops them, and these checks say which one went missing. They read the bundle as text: the
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

test('vendor patch: WebNavigate, WebTabs and WebRead read the page within the action timeout, failing named', () => {
  assert.match(server, /stage\("navigate"\);\s*await t\.page\.goto\(url2,/)
  assert.match(server, /return \{ url: t\.page\.url\(\), title: await titleWithin\(t\.page, timeoutNow\(\)\) \};/)
  assert.match(server, /function titleWithin\(page, ms\) \{\s*stage\("title"\);/)
  assert.match(server, /new BrowserError\(\s*"PAGE_NOT_READABLE",\s*`The page at \$\{page\.url\(\)\} loaded, but \$\{what\} was not read within \$\{ms\} ms/)
  // WebTabs (infoOf) and WebRead (readPage: the region count and the title) go through the same bounded read.
  assert.match(server, /const title = titleWithin\(t\.page, timeoutNow\(\)\);/)
  assert.match(server, /title: await titleWithin\(page, timeout\),/)
  assert.match(server, /readableWithin\(page, timeout, "its content", \(\) => page\.locator\(candidate\)\.count\(\)\)/)
  // A named code shows as `[PAGE_NOT_READABLE] ...` only when the catalog knows it (otherwise it would read as [INTERNAL]).
  const codes = /BROWSER_ERROR_CODES = \[([\s\S]*?)\];/.exec(server)?.[1] ?? ''
  assert.match(codes, /"PAGE_NOT_READABLE"/)
})

test('vendor patch: WebAskUser knows the declined outcome and the note', () => {
  assert.match(server, /declined: \(note\) => "outcome: declined\./)
  assert.match(server, /answer\.outcome === "declined" \? CONTROL_TEXTS\.declined\(answer\.note\)/)
  assert.match(server, /r\.outcome === "returned" \|\| r\.outcome === "declined"/)
  assert.match(server, /"declined" \(the person said they cannot help; the tab is back with you\)/)
})
