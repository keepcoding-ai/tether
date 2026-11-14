// E2E of the browser's debug mode end to end (tether-bridge-debug T3a): the app built with TETHER_TEST_EXTENSIONS=1, hidden
// window, private home and pipe, real tetherd; the VENDORED `tether-browser` server run by the repo's Electron as Node over
// stdio, as agent A (the gate e2e's way in). The setting `extensions.browser.debug` is on in settings.json, so the app writes
// <home>/browser/debug.json at its start (debug-file.ts) and the server reads it at every call:
//   - a call that works leaves `call_started` / `call_finished` with its id in <home>/browser/mcp.log, the debug lines
//     (`cdp`) among them, and `tether trace <id>` (the engine with the browser's source) tells them;
//   - a call that fails (a click on a ref that does not exist) ends its error with `(call <id>, …)` and `(debug dump: …)`,
//     and the dump folder <home>/browser/debug/<id>/ holds call.json; the timeline names the folder;
//   - turned off live (debug.json rewritten here as the app writes it when the setting goes off; the settings page is not
//     driven), the next call records no debug line.
// Run: node --test test/e2e/app.browser-debug.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'
import { cleanEnv, daemonMain, electronPath, launchHidden, pidAlive, root, serverMjs, sleep } from './browser-kit.ts'
import { browserTraceSource } from '../../extensions/browser/trace-source.ts'
import { debugFileOf } from '../../extensions/browser/debug-file.ts'
import { callTimeline, renderTimeline } from '../../src/trace/timeline.ts'

declare const window: { __tether: { connection(): { connected: boolean; pid?: number } | undefined } }

const pipe = `\\\\.\\pipe\\tether-brdebug-${process.pid}`
const KEY_A = 'aaaaAAAAbbbbBBBBccccCCCCddddDDDDeeee'
const PAGE = '<!doctype html><title>Debug</title><link rel="icon" href="data:,"><button>Press</button>'

function servePage(): Promise<{ server: Server; base: string }> {
  const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE) })
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, base: `http://localhost:${(server.address() as AddressInfo).port}` })))
}

/** The vendored MCP server over stdio (newline-delimited JSON-RPC), as app.browser-gate.test.ts drives it. */
function mcp(endpointFile: string, keyFile: string): { child: ChildProcessWithoutNullStreams; tool(name: string, args?: object): Promise<{ text: string; isError: boolean }> } {
  const env = cleanEnv()
  env.ELECTRON_RUN_AS_NODE = '1'
  const child = spawn(electronPath, [serverMjs, '--adopt-endpoint-file', endpointFile, '--adopt-key-file', keyFile], { env, stdio: 'pipe', windowsHide: true })
  const pending = new Map<number, (m: any) => void>()
  let buf = ''
  let next = 10
  child.stdout.on('data', (d: Buffer) => {
    buf += d.toString('utf8')
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      try { const m = JSON.parse(line); if (m.id !== undefined) pending.get(m.id)?.(m) } catch { /* not ours */ }
    }
  })
  child.stderr.on('data', () => {})
  const rpc = (method: string, params: object): Promise<any> => new Promise(r => {
    const id = ++next
    pending.set(id, r)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  const ready = rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'debug-e2e', version: '1' } })
    .then(() => { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n') })
  return {
    child,
    tool: async (name, args = {}) => {
      await ready
      const m = await Promise.race([rpc('tools/call', { name, arguments: args }), sleep(60_000).then(() => ({ error: { message: `${name}: no answer in 60 s` } }))])
      if (m.error) return { text: String(m.error.message), isError: true }
      const text = (m.result.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
      return { text, isError: m.result.isError === true }
    },
  }
}

const callIdOf = (text: string): string | undefined => /\(call ([A-Za-z0-9._:-]+)/.exec(text)?.[1]

test('browser debug mode: debug.json from the setting, mcp.log with the call id, tether trace, the failure dump', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, TETHER_TEST_EXTENSIONS: '1' } })
  assert.equal(build.status, 0, 'app build failed')
  const page = await servePage()
  const home = mkdtempSync(join(tmpdir(), 'tether-brdebug-'))
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ extensions: { browser: { localNetwork: 'allow', debug: true, debugActionTimeoutSec: 20 } } }))
  const keysDir = join(home, 'browser', 'keys')
  mkdirSync(keysDir, { recursive: true })
  writeFileSync(join(keysDir, 'agent-a.key'), KEY_A)
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  let server: ReturnType<typeof mcp> | undefined
  try {
    let win: Page
    ;({ app, page: win } = await launchHidden(home, pipe))
    daemons.push(await claim((await win.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    // The app wrote the contract from the setting at its start (T1).
    for (let i = 0; i < 50 && !existsSync(debugFileOf(home)); i++) await sleep(100)
    assert.deepEqual(JSON.parse(readFileSync(debugFileOf(home), 'utf8')), { enabled: true, actionTimeoutMs: 20_000 })
    server = mcp(join(home, 'browser', 'endpoint.json'), join(keysDir, 'agent-a.key'))
    const sources = [browserTraceSource(home)]

    // A call that works: its lines (debug included) are in mcp.log and the timeline tells them.
    const nav = await server.tool('WebNavigate', { url: `${page.base}/` })
    assert.equal(nav.isError, false, nav.text)
    const log = (): Array<Record<string, unknown>> => readFileSync(join(home, 'browser', 'mcp.log'), 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)] } catch { return [] } })
    const navId = log().filter(l => l.ev === 'call_started' && l.tool === 'WebNavigate').at(-1)?.call as string
    assert.ok(navId, 'call_started of WebNavigate with its id in <home>/browser/mcp.log')
    const navLines = await callTimeline(sources, navId)
    assert.ok(navLines.some(e => e.event === 'call_finished' && e.ok === true), renderTimeline(navId, navLines))
    assert.ok(navLines.some(e => e.event === 'call_started' && e.args !== undefined), 'debug: the arguments are recorded')

    // A click in debug: the page's events are recorded through the gate (Runtime.* of the listeners), not "unavailable".
    const tree = await server.tool('WebSnapshot')
    const ref = /button "Press"[^\n]*\[ref=(\w+)\]/.exec(tree.text)?.[1]
    assert.ok(ref, tree.text.slice(0, 300))
    const click = await server.tool('WebClick', { ref })
    assert.equal(click.isError, false, click.text)
    const clickId = log().filter(l => l.ev === 'call_started' && l.tool === 'WebClick').at(-1)?.call as string
    const clickLines = await callTimeline(sources, clickId)
    assert.ok(clickLines.some(e => e.event === 'cdp'), 'cdp lines in debug')
    assert.ok(clickLines.some(e => e.event === 'page_events'), `page_events recorded:\n${renderTimeline(clickId, clickLines)}`)

    // A call that fails: the id and the dump in the error, the folder on disk, the timeline names it.
    const bad = await server.tool('WebClick', { ref: 'e999' })
    assert.equal(bad.isError, true)
    const id = callIdOf(bad.text)
    assert.ok(id, bad.text)
    const dump = /\(debug dump: ([^)]+)\)/.exec(bad.text)?.[1]
    assert.ok(dump, bad.text)
    assert.ok(existsSync(join(home, 'browser', 'debug', id!, 'call.json')), `dump folder of ${id}`)
    const failLines = await callTimeline(sources, id!)
    const text = renderTimeline(id!, failLines)
    console.log(text)
    for (const f of ['call.json', 'screenshot.png', 'console.json', 'target.json']) console.log(`despejo ${f}: ${existsSync(join(home, 'browser', 'debug', id!, f)) ? 'sim' : 'não'}`)
    console.log(`call.json dump: ${JSON.stringify((JSON.parse(readFileSync(join(home, 'browser', 'debug', id!, 'call.json'), 'utf8')) as { dump?: unknown }).dump)}`)
    assert.match(text, /falhou/)
    assert.match(text, /despejo da falha: /)

    // Off (debug.json as the app writes it when the setting goes off): the next call has no debug line.
    writeFileSync(debugFileOf(home), JSON.stringify({ enabled: false }) + '\n')
    await sleep(50)
    const snap = await server.tool('WebSnapshot')
    assert.equal(snap.isError, false, snap.text)
    const snapId = log().filter(l => l.ev === 'call_started' && l.tool === 'WebSnapshot').at(-1)?.call as string
    assert.ok(!log().some(l => l.call === snapId && l.debug === true), 'no debug line once off')
  } finally {
    if (server) {
      server.child.stdin.end()
      for (let i = 0; i < 20 && server.child.exitCode === null; i++) await sleep(150)
      if (server.child.exitCode === null && server.child.pid) try { process.kill(server.child.pid) } catch { /* gone */ }
    }
    if (app) await killElectron(app, root).catch(() => {})
    for (const d of daemons) await killOwned(d, { tree: true })
    for (let i = 0; i < 20 && daemons.some(d => pidAlive(d.pid)); i++) await sleep(500)
    page.server.close()
    for (let i = 0; i < 5; i++) {
      try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
