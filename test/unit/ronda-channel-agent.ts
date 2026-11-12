// A fake agent for the ronda's channel tests: an MCP client over Streamable HTTP, the way Claude Code reaches `tether-ronda`
// (its `--mcp-config` file, the bearer expanded from TETHER_RONDA_MCP_KEY, initialize, then the GET stream). It prints what
// the test waits on: `AGENT-LISTENING` once its GET stream is open, `CHANNEL{{<content>}}` per channel message, and echoes
// every key typed into its terminal as `<...>` (so a test sees that nothing was typed). With FAKE_DIALOG=exact|other it
// first draws Claude's channel confirmation (option 1 or "Exit" selected) and connects only after an Enter.
import { readFileSync } from 'node:fs'
import { CHANNEL_DIALOG, CHANNEL_DIALOG_OTHER } from './ronda-dialog.fixture.ts'

const argv = process.argv.slice(2)
const cfgFile = argv[argv.lastIndexOf('--mcp-config') + 1]!
const server = JSON.parse(readFileSync(cfgFile, 'utf8')).mcpServers['tether-ronda'] as { url: string; headers: Record<string, string> }
const auth = server.headers.Authorization!.replace('${TETHER_RONDA_MCP_KEY}', process.env.TETHER_RONDA_MCP_KEY ?? '')
const out = (s: string): void => { process.stdout.write(s) }

let confirmed = false
let onConfirm: (() => void) | undefined
process.stdin.setRawMode?.(true)
process.stdin.on('data', d => {
  const text = String(d)
  out('<' + text.replace(/\r/g, '#CR#') + '>')
  if (!confirmed && text.includes('\r')) { confirmed = true; onConfirm?.() }
})

async function post(msg: unknown, session?: string): Promise<{ session?: string; body: any }> {
  const r = await fetch(server.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: auth, ...(session ? { 'mcp-session-id': session } : {}) },
    body: JSON.stringify(msg),
  })
  const text = await r.text()
  const lines = text.split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)))
  return { session: r.headers.get('mcp-session-id') ?? undefined, body: lines.at(-1) ?? (text ? JSON.parse(text) : undefined) }
}

async function connect(): Promise<void> {
  const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fake-agent', version: '1' } } })
  if (init.body?.result?.capabilities?.experimental?.['claude/channel']) out('CAP-CHANNEL ')
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, init.session)
  const r = await fetch(server.url, { headers: { accept: 'text/event-stream', authorization: auth, 'mcp-session-id': init.session! } })
  out('AGENT-LISTENING')
  const decoder = new TextDecoder()
  let buf = ''
  for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true })
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line.startsWith('data: ')) continue
      const m = JSON.parse(line.slice(6))
      if (m.method === 'notifications/claude/channel') out(`CHANNEL{{${m.params.content}}}`)
    }
  }
}

const dialog = process.env.FAKE_DIALOG
if (dialog === 'exact' || dialog === 'other') {
  // Without Claude's win32-input-mode switch (CSI ?9001h): with it ConPTY would hand keys over as win32 key events, which
  // Claude decodes and this fake does not; the dialog's text is untouched.
  out((dialog === 'exact' ? CHANNEL_DIALOG : CHANNEL_DIALOG_OTHER).replace('\u001b[?9001h', ''))
  onConfirm = () => { void connect() }
} else void connect()
setInterval(() => {}, 1 << 30)
