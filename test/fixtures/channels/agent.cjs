// Fake agent for the channels' fan-out tests: no LLM. It logs every stdin chunk it gets (one JSON string per line, ECHO_LOG)
// and, when OPEN_STREAM is 1, opens the `tether` MCP server's session and GET stream as Claude Code does and logs each
// message of the stream (CHAN_LOG). The test plays the turn and the attention through the hook's attention file.
const fs = require('node:fs')
const log = (file, x) => fs.appendFileSync(file, JSON.stringify(x) + '\n')
process.stdout.write('READY\r\n')
if (process.stdin.setRawMode) process.stdin.setRawMode(true)
process.stdin.on('data', (d) => log(process.env.ECHO_LOG, d.toString()))
setInterval(() => {}, 60000)
const argv = process.argv
const file = argv[argv.lastIndexOf('--mcp-config') + 1]
if (process.env.OPEN_STREAM === '1' && file && fs.existsSync(file)) {
  const server = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.tether
  const auth = server.headers.Authorization.replace('${TETHER_MCP_KEY}', process.env.TETHER_MCP_KEY || '')
  const headers = (session) => ({ 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: auth, ...(session ? { 'mcp-session-id': session } : {}) })
  const post = async (msg, session) => {
    const r = await fetch(server.url, { method: 'POST', headers: headers(session), body: JSON.stringify(msg) })
    await r.text()
    return r.headers.get('mcp-session-id')
  }
  ;(async () => {
    const session = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fake', version: '1' } } })
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, session)
    const r = await fetch(server.url, { method: 'GET', headers: { accept: 'text/event-stream', authorization: auth, 'mcp-session-id': session } })
    log(process.env.CHAN_LOG, { open: r.status })
    const dec = new TextDecoder()
    let buf = ''
    for await (const part of r.body) {
      buf += dec.decode(part, { stream: true })
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (line.startsWith('data: ')) log(process.env.CHAN_LOG, JSON.parse(line.slice(6)))
      }
    }
  })().catch((e) => log(process.env.CHAN_LOG, { failed: e.message }))
}
