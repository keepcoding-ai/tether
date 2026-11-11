// A stdio MCP server for the HTTP host's tests (src/daemon/mcp-http.ts): answers initialize, tools/list and tools/call, one
// JSON-RPC message per line. A call before `notifications/initialized` is an error (the host must replay the handshake).
// `tools/call` of `whoami` answers its pid and the env var FAKE_SLOT; with a progressToken it sends one progress first.
let initialized = false
let rest = ''
const send = m => process.stdout.write(`${JSON.stringify(m)}\n`)
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  rest += chunk
  let i
  while ((i = rest.indexOf('\n')) !== -1) {
    const line = rest.slice(0, i)
    rest = rest.slice(i + 1)
    if (!line.trim()) continue
    const m = JSON.parse(line)
    if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } })
    else if (m.method === 'notifications/initialized') initialized = true
    else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'WebNavigate', description: 'Go. Only public http(s) addresses are reachable; addresses inside the machine or its private network are refused.', inputSchema: { type: 'object' } }] } })
    else if (m.method === 'tools/call') {
      if (!initialized) { send({ jsonrpc: '2.0', id: m.id, error: { code: -32002, message: 'not initialized' } }); continue }
      const token = m.params?._meta?.progressToken
      if (token !== undefined) send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: 1 } })
      send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `pid=${process.pid} slot=${process.env.FAKE_SLOT ?? ''}` }] } })
    } else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } })
  }
})
process.stdin.on('end', () => process.exit(0))
