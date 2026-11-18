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

test('vendor patch: WebNavigate names its stages and reads the title within the action timeout, failing named', () => {
  assert.match(server, /stage\("navigate"\);\s*await t\.page\.goto\(url2,/)
  assert.match(server, /return \{ url: t\.page\.url\(\), title: await titleWithin\(t, timeoutNow\(\)\) \};/)
  assert.match(server, /const titleWithin = async \(t, ms\) => \{\s*stage\("title"\);/)
  assert.match(server, /new BrowserError\("PAGE_NOT_READABLE", `The page at \$\{t\.page\.url\(\)\} loaded, but its title was not read within \$\{ms\} ms/)
  // A named code shows as `[PAGE_NOT_READABLE] ...` only when the catalog knows it (otherwise it would read as [INTERNAL]).
  const codes = /BROWSER_ERROR_CODES = \[([\s\S]*?)\];/.exec(server)?.[1] ?? ''
  assert.match(codes, /"PAGE_NOT_READABLE"/)
})
