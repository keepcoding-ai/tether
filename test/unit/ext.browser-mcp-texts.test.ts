// What the agent reads about the browser (extensions/browser/mcp-texts.ts, mcp-proxy.mjs; Tether Browser V2b): WebNavigate's
// description no longer says the local network is refused, the server's instructions say whose browser this is and why
// WebEvaluate / WebSavePdf are "Tool not found", and the proxy relays the vendored server's stdio, changing only those answers.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  McpRewriter, NAVIGATE_NEW, NAVIGATE_OLD, patchInitializeResult, patchToolsListResult, serverInstructions,
} from '../../extensions/browser/mcp-texts.ts'

const BROWSER = join(import.meta.dirname, '..', '..', 'extensions', 'browser')
const SERVER = join(BROWSER, 'vendor', 'tether-browser', 'server.mjs')
const PROXY = join(BROWSER, 'mcp-proxy.mjs')

describe('browser: the texts the agent reads', () => {
  test('the vendored server still says the sentence we correct (a new bundle that moved it must move NAVIGATE_OLD)', () => {
    assert.ok(readFileSync(SERVER, 'utf8').includes(NAVIGATE_OLD))
  })

  test("instructions: the tether's tabs, not the person's Chrome; the local network asks; why the two tools are missing", () => {
    const off = serverInstructions({ evaluate: false })
    assert.match(off, /inside the tether/)
    assert.match(off, /not the person's own Chrome/)
    assert.match(off, /localhost[^.]*permission/)
    assert.match(off, /WebEvaluate[^.]*is off[^.]*extensions\.browser\.evaluate/)
    assert.match(off, /WebSavePdf is never offered/)
    assert.match(off, /Tool not found/)
    const on = serverInstructions({ evaluate: true })
    assert.ok(!/WebEvaluate/.test(on), 'evaluate on: nothing to explain about it')
    assert.match(on, /WebSavePdf is not offered/)
    assert.match(on, /Tool not found/)
  })

  test('initialize gets the instructions; any other shape comes back as given', () => {
    const r = patchInitializeResult({ protocolVersion: 'x', serverInfo: { name: 'tether-browser' } }, { evaluate: false }) as { instructions: string; serverInfo: unknown }
    assert.equal(r.instructions, serverInstructions({ evaluate: false }))
    assert.deepEqual(r.serverInfo, { name: 'tether-browser' })
    assert.equal(patchInitializeResult('nope', { evaluate: false }), 'nope')
  })

  test('tools/list: only the description with the old sentence changes, and says localhost asks', () => {
    const list = { tools: [
      { name: 'WebNavigate', description: `Open a URL. ${NAVIGATE_OLD}`, inputSchema: { type: 'object' } },
      { name: 'WebRead', description: 'Read the page.' },
    ] }
    const out = patchToolsListResult(list) as typeof list
    assert.equal(out.tools[0]!.description, `Open a URL. ${NAVIGATE_NEW}`)
    assert.ok(!out.tools[0]!.description.includes('are refused'))
    assert.match(NAVIGATE_NEW, /localhost/)
    assert.deepEqual(out.tools[1], list.tools[1])
    assert.deepEqual(out.tools[0]!.inputSchema, { type: 'object' })
    assert.equal(patchToolsListResult(undefined), undefined)
    assert.deepEqual(patchToolsListResult({ tools: 'x' }), { tools: 'x' })
  })

  test('the rewriter recognizes answers by request id and passes everything else untouched', () => {
    const rw = new McpRewriter({ evaluate: false })
    rw.fromClient(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }))
    rw.fromClient(JSON.stringify({ jsonrpc: '2.0', id: 'a', method: 'tools/list' }))
    rw.fromClient(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'WebNavigate' } }))
    rw.fromClient('not json')
    const call = JSON.stringify({ jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: NAVIGATE_OLD }] } })
    assert.equal(rw.fromServer(call), call, 'a tool call result is never rewritten, even with the sentence in it')
    const note = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
    assert.equal(rw.fromServer(note), note)
    assert.equal(rw.fromServer('garbage'), 'garbage')
    const init = JSON.parse(rw.fromServer(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } })))
    assert.equal(init.result.instructions, serverInstructions({ evaluate: false }))
    const tools = JSON.parse(rw.fromServer(JSON.stringify({ jsonrpc: '2.0', id: 'a', result: { tools: [{ name: 'WebNavigate', description: NAVIGATE_OLD }] } })))
    assert.equal(tools.result.tools[0].description, NAVIGATE_NEW)
    const again = JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })
    assert.equal(rw.fromServer(again), again, 'an id answers once')
  })
})

// The real thing: the proxy running the vendored server (it answers initialize and tools/list without the app; it reaches the
// host only on the first tool call). Child processes only, no window.
describe('browser: the proxy in front of the vendored server', () => {
  interface Reply { result: { serverInfo: { name: string }; instructions: string; tools: { name: string; description: string }[] } }
  function talk(serverArgs: string[], messages: object[]): Promise<{ replies: Record<string, Reply>; code: number | null }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [PROXY, SERVER, '--adopt-endpoint-file', 'x-endpoint.json', '--adopt-key-file', 'x.key', ...serverArgs], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
      const replies: Record<string, Reply> = {}
      const wanted = messages.filter(x => 'id' in x).length
      let out = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (c: string) => {
        out += c
        let i: number
        while ((i = out.indexOf('\n')) !== -1) {
          const line = out.slice(0, i)
          out = out.slice(i + 1)
          const m = JSON.parse(line) as { id?: number }
          if (m.id !== undefined) replies[String(m.id)] = m as unknown as Reply
          if (Object.keys(replies).length === wanted) child.stdin.end()
        }
      })
      const timer = setTimeout(() => { child.kill(); reject(new Error('proxy: no answer in 30 s')) }, 30_000)
      child.on('exit', code => { clearTimeout(timer); resolve({ replies, code }) })
      child.on('error', reject)
      for (const m of messages) child.stdin.write(`${JSON.stringify(m)}\n`)
    })
  }
  const handshake = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ]

  test("initialize carries the instructions and tools/list the corrected WebNavigate; the tool list is the server's own", async () => {
    const { replies, code } = await talk([], handshake)
    assert.equal(replies['1']!.result.serverInfo.name, 'tether-browser')
    assert.equal(replies['1']!.result.instructions, serverInstructions({ evaluate: false }))
    const tools = replies['2']!.result.tools
    const nav = tools.find(t => t.name === 'WebNavigate')!
    assert.ok(nav.description.includes(NAVIGATE_NEW) && !nav.description.includes(NAVIGATE_OLD))
    assert.ok(!tools.some(t => t.name === 'WebEvaluate' || t.name === 'WebSavePdf'), 'the proxy adds no tool')
    assert.equal(code, 0, 'the proxy ends with its stdin, taking the server down')
  })

  test('--allow-evaluate reaches the server (WebEvaluate listed) and the instructions stop explaining it', async () => {
    const { replies } = await talk(['--allow-evaluate'], handshake)
    assert.equal(replies['1']!.result.instructions, serverInstructions({ evaluate: true }))
    assert.ok(replies['2']!.result.tools.some(t => t.name === 'WebEvaluate'))
  })
})
