// Fake `claude` for the channels' end-to-end flow (test/e2e/channels.flow.test.ts): no LLM, no hook. It runs as the pane's real
// process in a real tetherd, so it has the pane's own environment (TETHER_HOME, TETHER_SLOT_ID, TETHER_CLI, TETHER_SLOT_KEY, the
// MCP key in the --mcp-config the door passes). Nothing of that environment is ever printed or logged here.
//
// Files, all under <TETHER_HOME>/bench/ and named by the slot id:
//   <slot>.ready       exists once the pane is up (and, with a stream, once the stream is open)
//   <slot>.chan.jsonl  every channel notification the stream carried (a pane whose folder starts with "sem-canal" opens no stream)
//   <slot>.cmd.jsonl   the test appends commands: { id, via: 'cli', argv } or { id, via: 'mcp', tool, arguments }
//   <slot>.out.jsonl   the outcome of each command: { id, via, status, stdout, stderr } or { id, via, result }
// A channel notification opens a "turn" the way a real Claude does: the attention file says `start`, then `done` a moment later.
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const home = process.env.TETHER_HOME
const slot = process.env.TETHER_SLOT_ID
const bench = path.join(home, 'bench')
fs.mkdirSync(bench, { recursive: true })
const file = (ext) => path.join(bench, `${slot}.${ext}`)
const append = (ext, x) => fs.appendFileSync(file(ext), JSON.stringify(x) + '\n')
const TURN_MS = 250

process.stdout.write('READY\r\n')
if (process.stdin.setRawMode) process.stdin.setRawMode(true)
process.stdin.on('data', (d) => append('stdin.jsonl', d.toString()))
setInterval(() => {}, 60000)

// ---- the turn the hook would report ----
let lastTs = 0
const attention = (kind) => {
  lastTs = Math.max(lastTs + 1, Date.now())
  fs.writeFileSync(path.join(home, 'slots', `${slot}.attention`), JSON.stringify({ ts: new Date(lastTs).toISOString(), kind }) + '\n')
}
let turnTimer
const turn = () => {
  attention('start')
  clearTimeout(turnTimer)
  turnTimer = setTimeout(() => attention('done'), TURN_MS)
}

// ---- the `tether` MCP server, as Claude Code opens it ----
const argv = process.argv
const mcpFile = argv[argv.lastIndexOf('--mcp-config') + 1]
const withStream = !path.basename(process.cwd()).startsWith('sem-canal') && mcpFile && fs.existsSync(mcpFile)
let server, auth, session
const headers = (withSession) => ({ 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: auth, ...(withSession && session ? { 'mcp-session-id': session } : {}) })
const bodyOf = (text) => {
  const t = text.trim()
  if (t.startsWith('{')) return JSON.parse(t)
  const data = t.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).pop()
  return data ? JSON.parse(data) : {}
}
const post = async (msg, withSession) => {
  const r = await fetch(server.url, { method: 'POST', headers: headers(withSession), body: JSON.stringify(msg) })
  const text = await r.text()
  return { session: r.headers.get('mcp-session-id'), body: text ? bodyOf(text) : {} }
}
let rpcId = 100

async function openStream() {
  server = JSON.parse(fs.readFileSync(mcpFile, 'utf8')).mcpServers.tether
  auth = server.headers.Authorization.replace('${TETHER_MCP_KEY}', process.env.TETHER_MCP_KEY || '')
  session = (await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fake', version: '1' } } })).session
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, true)
  const r = await fetch(server.url, { method: 'GET', headers: { accept: 'text/event-stream', authorization: auth, 'mcp-session-id': session } })
  append('chan.jsonl', { open: r.status })
  fs.writeFileSync(file('ready'), '1')
  const dec = new TextDecoder()
  let buf = ''
  for await (const part of r.body) {
    buf += dec.decode(part, { stream: true })
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line.startsWith('data: ')) continue
      const msg = JSON.parse(line.slice(6))
      append('chan.jsonl', msg)
      if (msg.method === 'notifications/claude/channel') turn()
    }
  }
}
if (withStream) openStream().catch((e) => append('chan.jsonl', { failed: e.message }))
else fs.writeFileSync(file('ready'), '1')

// ---- the commands of the test: the agent's own two exits ----
const runCli = (id, args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [process.env.TETHER_CLI, 'channels', ...args, '--json'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', (d) => { stdout += d })
  child.stderr.on('data', (d) => { stderr += d })
  child.on('close', (status) => { append('out.jsonl', { id, via: 'cli', status, stdout, stderr }); resolve() })
})
const runMcp = async (id, tool, args) => {
  try {
    const r = await post({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: tool, arguments: args } }, true)
    append('out.jsonl', { id, via: 'mcp', result: r.body.result ?? r.body })
  } catch (e) {
    append('out.jsonl', { id, via: 'mcp', failed: e.message })
  }
}
let offset = 0
let busy = false
setInterval(async () => {
  if (busy) return
  let size = 0
  try { size = fs.statSync(file('cmd.jsonl')).size } catch { return }
  if (size <= offset) return
  busy = true
  const chunk = fs.readFileSync(file('cmd.jsonl')).subarray(offset, size).toString('utf8')
  offset = size
  for (const line of chunk.split('\n').filter(Boolean)) {
    const c = JSON.parse(line)
    if (c.via === 'mcp') await runMcp(c.id, c.tool, c.arguments ?? {})
    else await runCli(c.id, c.argv)
  }
  busy = false
}, 100)
