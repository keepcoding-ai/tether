// The remote web client carries the Regency's shared screen (the app's own pane and channel view) and nothing of Node, of
// Electron, of the daemon or of the app's main process; and no HTML sink, since its page enforces Trusted Types. Proven on
// the real bundles, as the build makes them (remote/web/bundle.mjs).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
// @ts-expect-error a plain .mjs module of the build, with no types
import { bundle, webDir } from '../../remote/web/bundle.mjs'

interface Bundled { js: string; inputs: string[]; refusal?: string }
const make = bundle as (entry: string) => Promise<Bundled>
const dir = webDir as string
const has = (b: Bundled, suffix: string): boolean => b.inputs.some(p => p.replaceAll('\\', '/').endsWith(suffix))

describe('the web bundle of the Regency', () => {
  test('the screen (src/regency.ts) bundles the app\'s own pane and channel view, and nothing it may not', async () => {
    const b = await make(join(dir, 'src', 'regency.ts'))
    assert.equal(b.refusal, undefined)
    // The shared screen is the app's, not a copy.
    for (const shared of [
      'extensions/regency/renderer/pane.ts', 'extensions/regency/renderer/columns.ts', 'extensions/regency/model.ts',
      'extensions/channels/renderer/channel-pane.ts', 'extensions/channels/renderer/view-model.ts',
    ]) assert.ok(has(b, shared), `the bundle holds ${shared}`)
    // What only the app's window has stays out: the hosts of the app, the dockview, the tab, the extension's entry.
    for (const local of [
      'extensions/regency/renderer.ts', 'extensions/regency/renderer/tab.ts', 'extensions/channels/renderer.ts',
      'extensions/channels/renderer/local-panes.ts', 'extensions/channels/renderer/marks.ts', 'app/renderer/ext-api.ts', 'app/renderer/main.ts',
    ]) assert.ok(!has(b, local), `the bundle does not hold ${local}`)
    for (const p of b.inputs) {
      assert.doesNotMatch(p, /(^|[\\/])node:/, p)
      assert.doesNotMatch(p, /node_modules[\\/](electron|dockview-core|monaco-editor|@xterm|node-pty|koffi)[\\/]/, p)
      assert.doesNotMatch(p, /(^|[\\/])src[\\/](daemon|remoted|ptyd|agents|core|exec)[\\/]/, p)
      assert.doesNotMatch(p, /(^|[\\/])app[\\/](main|preload)[\\/]/, p)
    }
  })

  test('the two modules of the app\'s shell with an HTML sink are swapped for the web\'s own', async () => {
    const b = await make(join(dir, 'src', 'regency.ts'))
    assert.ok(!has(b, 'app/renderer/svg-node.ts'), 'svg-node.ts (innerHTML) is not in the bundle')
    assert.ok(!has(b, 'app/renderer/tab-emblems.ts'), 'tab-emblems.ts (the sprite, the editor) is not in the bundle')
    assert.ok(has(b, 'remote/web/src/svg-lite.ts'))
    assert.ok(has(b, 'remote/web/src/ui-lite.ts'))
    // The icons themselves are the app's catalogue, read through the swapped builder.
    assert.ok(has(b, 'app/renderer/icons.ts'))
  })

  test('the guard refuses a bundle with an HTML sink', async () => {
    // The app's own builder of icons has the sink the web may not have: bundled as it is (no swap applies to an entry), it is refused.
    const sink = await make(join(dir, '..', '..', 'app', 'renderer', 'svg-node.ts'))
    assert.match(sink.refusal ?? '', /casca do app|sumidouro de HTML/)
  })

  test('the client\'s entry (src/main.ts) and the bench page pass the same guard', async () => {
    const app = await make(join(dir, 'src', 'main.ts'))
    assert.equal(app.refusal, undefined)
    // The published app.js carries the Regency's screen over the session's source, and never the bench's made-up house.
    for (const piece of ['remote/web/src/regency.ts', 'remote/web/src/source.ts', 'extensions/regency/renderer/pane.ts', 'extensions/channels/renderer/channel-pane.ts']) {
      assert.ok(has(app, piece), `app.js holds ${piece}`)
    }
    assert.ok(!has(app, 'remote/web/bench/page/fake.ts'), 'app.js does not hold the bench\'s house')
    const bench = await make(join(dir, 'bench', 'page', 'regency-bench.ts'))
    assert.equal(bench.refusal, undefined)
    assert.ok(has(bench, 'extensions/regency/renderer/pane.ts'))
  })

  test('the pages keep the strict CSP: no inline script or style, Trusted Types enforced', () => {
    for (const page of [join(dir, 'index.html'), join(dir, 'bench', 'bench.html')]) {
      const html = readFileSync(page, 'utf8')
      const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? ''
      assert.match(csp, /default-src 'none'/)
      assert.match(csp, /script-src 'self'(;|$)/)
      assert.match(csp, /style-src 'self'(;|$)/)
      assert.match(csp, /require-trusted-types-for 'script'/)
      // The client's page names one policy, the service worker's script URL (main.ts); the bench has no worker.
      assert.match(csp, page.endsWith('index.html') ? /trusted-types tether-sw(;|$)/ : /trusted-types 'none'/)
      assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|data:/)
      assert.doesNotMatch(html, /<style|style="|<script(?![^>]*\bsrc=)/)
    }
  })
})
