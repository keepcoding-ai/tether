// How an agent's call wakes the browser process, which is not running while no tab is open. The app listens on a local pipe whose
// name follows from the endpoint file's path (both sides know it: the agent's MCP command carries it); an agent's tool call
// connects, says `wake`, and gets `ok` once the process is up and its gatekeeper has written the endpoint, or `fail`. The pipe
// carries no data and takes no argument: whoever connects can only ask for the browser to be up. No app listening (not open, or
// the browser runs inside it): the connection fails at once and the call goes on to the tool, which says the app is not running.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { createServer, connect, type Server } from 'node:net'
import { dirname, join, resolve } from 'node:path'

/** How long an agent's call waits for the process to come up (CHILD_START_MS plus the gatekeeper opening). */
export const WAKE_WAIT_MS = 30_000
/** How long the app waits for the gatekeeper's endpoint after the process said it is ready. */
export const ENDPOINT_WAIT_MS = 10_000

/** The wake pipe of the app that owns this endpoint file. */
export function wakePipeOf(endpointFile: string): string {
  if (process.platform !== 'win32') return join(dirname(resolve(endpointFile)), 'wake.sock')
  const id = createHash('sha256').update(resolve(endpointFile).toLowerCase()).digest('hex').slice(0, 16)
  return `\\\\.\\pipe\\tether-browser-wake-${id}`
}

/** A JSON-RPC message that needs the browser: a tool call (listing the tools or the handshake does not). */
export function isToolCall(message: unknown): boolean {
  return !!message && typeof message === 'object' && (message as { method?: unknown }).method === 'tools/call'
}

/** The stdio line of a message, parsed; anything that is not JSON is not a tool call. */
export function isToolCallLine(line: string): boolean {
  if (!line.includes('tools/call')) return false
  try { return isToolCall(JSON.parse(line)) } catch { return false }
}

/** Asks the app to have the browser up; true when it says so. Never throws: no app, no answer or a refusal is false. */
export function requestWake(endpointFile: string, waitMs = WAKE_WAIT_MS): Promise<boolean> {
  return new Promise(resolveWake => {
    let done = false
    const socket = connect(wakePipeOf(endpointFile))
    const finish = (ok: boolean): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.destroy()
      resolveWake(ok)
    }
    const timer = setTimeout(() => finish(false), waitMs)
    let said = ''
    socket.setEncoding('utf8')
    socket.once('connect', () => socket.write('wake\n'))
    socket.on('data', chunk => { said += chunk; if (said.includes('\n')) finish(said.trim() === 'ok') })
    socket.on('error', () => finish(false))
    socket.on('close', () => finish(said.trim() === 'ok'))
  })
}

/** Whether an app listens on the wake pipe of this endpoint file (it only connects: nothing is asked). */
export function wakePipeUp(endpointFile: string): Promise<boolean> {
  return new Promise(res => {
    const socket = connect(wakePipeOf(endpointFile))
    const timer = setTimeout(() => { socket.destroy(); res(false) }, 1000)
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); res(true) })
    socket.once('error', () => { clearTimeout(timer); res(false) })
  })
}

/** The endpoint file's content when the gatekeeper of process `pid` wrote it. */
export function endpointUp(endpointFile: string, pid: number | undefined): boolean {
  if (pid === undefined || !existsSync(endpointFile)) return false
  try { return (JSON.parse(readFileSync(endpointFile, 'utf8')) as { pid?: unknown }).pid === pid } catch { return false }
}

export interface WakeServer { close(): void }

/**
 * The app's side: `bring` has the browser up and returns its pid (undefined: it did not come up). The answer waits for the
 * endpoint of that pid too, so the tool the agent calls next finds the gatekeeper.
 */
export function serveWake(endpointFile: string, bring: () => Promise<number | undefined>, o: { log(msg: string): void; endpointWaitMs?: number; pollMs?: number }): WakeServer {
  const path = wakePipeOf(endpointFile)
  if (process.platform !== 'win32') rmSync(path, { force: true })
  const waitEndpoint = async (pid: number): Promise<boolean> => {
    const end = Date.now() + (o.endpointWaitMs ?? ENDPOINT_WAIT_MS)
    while (!endpointUp(endpointFile, pid)) {
      if (Date.now() > end) return false
      await new Promise(r => setTimeout(r, o.pollMs ?? 50))
    }
    return true
  }
  const server: Server = createServer(socket => {
    socket.setEncoding('utf8')
    let asked = false
    socket.on('error', () => {})
    socket.on('data', chunk => {
      if (asked || !String(chunk).includes('wake')) return
      asked = true
      void (async () => {
        const pid = await bring().catch(() => undefined)
        const ok = pid !== undefined && await waitEndpoint(pid)
        if (!socket.destroyed) socket.end(ok ? 'ok\n' : 'fail\n')
      })()
    })
  })
  server.on('error', e => o.log(`porta de acordar o navegador não abriu (${(e as Error).message})`))
  server.listen(path)
  return { close: () => { server.close() } }
}

export interface ToolCallGate {
  /** Delivers `message` to `deliver` once the browser is up when it is a tool call; the order of messages is kept. */
  push(message: unknown, extra: unknown, deliver: (message: unknown, extra: unknown) => void): void
}

/** Holds each tool call until `wake` is done (it never throws); other messages pass at once unless a call is waiting before them. */
export function toolCallGate(wake: () => Promise<unknown>): ToolCallGate {
  let tail: Promise<void> = Promise.resolve()
  let waiting = 0
  return {
    push(message, extra, deliver) {
      if (!isToolCall(message) && waiting === 0) { deliver(message, extra); return }
      waiting++
      tail = tail.then(async () => { if (isToolCall(message)) await wake().catch(() => {}); deliver(message, extra) }).catch(() => {}).finally(() => { waiting-- })
    },
  }
}
