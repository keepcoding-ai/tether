#!/usr/bin/env node
// The MCP command an agent gets for the tether's browser (agents.ts): `node mcp-proxy.mjs <server.mjs> <server arguments...>`.
// It starts the vendored server (sealed by its manifests, so its texts cannot be edited) with the same arguments and relays
// the stdio between the agent's CLI and it, line by line, rewriting only the answers `mcp-texts.ts` names. Stderr is the
// server's own. The proxy ends when the CLI closes its stdin or the server ends (and takes the server down with it).
import { spawn } from 'node:child_process'
import { McpRewriter } from './mcp-texts.ts'
import { isToolCallLine, requestWake, toolCallGate } from './wake.ts'

const [server, ...serverArgs] = process.argv.slice(2)
if (!server) { process.stderr.write('[tether-browser proxy] usage: mcp-proxy.mjs <server.mjs> [server arguments]\n'); process.exit(1) }

const rewriter = new McpRewriter({ evaluate: serverArgs.includes('--allow-evaluate') })
const child = spawn(process.execPath, [server, ...serverArgs], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })

/** Calls `onLine` for each complete line of the stream (the MCP stdio framing); the rest waits for its newline. */
function lines(stream, onLine) {
  let rest = ''
  stream.setEncoding('utf8')
  stream.on('data', chunk => {
    rest += chunk
    let i
    while ((i = rest.indexOf('\n')) !== -1) {
      const line = rest.slice(0, i).replace(/\r$/, '')
      rest = rest.slice(i + 1)
      if (line !== '') onLine(line)
    }
  })
}

// The browser process runs only while something needs it: a tool call first asks the app to have it up (wake.ts), the other
// lines pass at once (in order). Without the app's answer the call goes on and the server says the app is not running.
const flagAt = serverArgs.indexOf('--adopt-endpoint-file')
const endpointFile = flagAt >= 0 ? serverArgs[flagAt + 1] : undefined
const toolCalls = toolCallGate(() => (endpointFile ? requestWake(endpointFile) : Promise.resolve(false)))
lines(process.stdin, line => {
  const message = isToolCallLine(line) ? { method: 'tools/call' } : {}
  toolCalls.push(message, undefined, () => { child.stdin.write(`${rewriter.fromClient(line)}\n`) })
})
lines(child.stdout, line => { process.stdout.write(`${rewriter.fromServer(line)}\n`) })
process.stdin.on('end', () => child.stdin.end())
process.stdin.on('close', () => child.stdin.end())
child.stdin.on('error', () => {})
child.on('error', e => { process.stderr.write(`[tether-browser proxy] could not start the server: ${e.message}\n`); process.exit(1) })
child.on('exit', code => process.exit(code ?? 1))
for (const sig of ['SIGTERM', 'SIGINT', 'SIGBREAK']) process.on(sig, () => { child.kill(); setTimeout(() => process.exit(0), 2000).unref() })
