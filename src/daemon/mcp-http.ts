// MCP servers of the daemon extensions served to the agents over Streamable HTTP (MCP 2025-06-18 transport), so an agent
// whose CLI loads `{ "type": "http" }` servers (AgentMcp.http) spawns NO process of its own for them. One host per extension,
// bound to 127.0.0.1 on a port of the system's choosing, one route per slot: `/mcp/<slotId>`.
//
// The servers themselves are vendored stdio bundles (sealed by their manifests, no library entry), so behind each route the
// host runs the UNCHANGED stdio server as its own child, and only while it is needed:
//   - started on the session's `initialize` (or on the first request after it was stopped, replaying the client's handshake);
//   - stopped after `idleMs` with no request in flight (the open GET stream does not count). The next request starts a fresh
//     one, and the first `tools/call` answer after such a restart carries `restartNotice` (state the old process kept, such as
//     tab ids or upload grants, is gone);
//   - stopped at once when the slot's key is revoked (the agent exited) or the session is deleted.
// So an idle agent costs no process; an agent using the tool costs one (the stdio path costs two for the browser: proxy + server).
//
// Security: 127.0.0.1 only; every request carries `Authorization: Bearer <key>` and the key is the slot's own (granted by the
// launch middleware, compared in constant time over sha256 digests, revoked when the agent exits). A request with an Origin
// header is refused (no browser page may drive it, whatever it guesses). The host keeps only the digest; no log line carries
// a key or a message body.
import { spawn as spawnChild, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

/** Rewrites the JSON-RPC lines between the client and the server (extensions/browser/mcp-texts.ts McpRewriter). */
export interface LineRewriter {
  fromClient(line: string): string
  fromServer(line: string): string
}

/** How to run the stdio server of one slot. */
export interface McpBackendSpec {
  command: string
  args: string[]
  env: Record<string, string>
  /** A new rewriter for each child (it follows one connection). */
  rewriter?: () => LineRewriter
}

/** What the host needs of a child process (node's ChildProcess; a fake in tests). */
export type McpChild = Pick<ChildProcess, 'stdin' | 'stdout' | 'kill' | 'on' | 'pid'>

export interface McpHttpHostOptions {
  /** For log lines ("tether-browser"). */
  name: string
  log(msg: string): void
  /** A child with no request in flight for this long is stopped. Default 15 minutes. */
  idleMs?: number
  /** Text put before the content of the first `tools/call` answer after a child was restarted. */
  restartNotice?: string
  /** Injected in tests. */
  spawn?(spec: McpBackendSpec): McpChild
  maxBodyBytes?: number
}

type Json = Record<string, unknown>
type Id = string | number
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const isId = (v: unknown): v is Id => typeof v === 'string' || typeof v === 'number'
const digest = (key: string): Buffer => createHash('sha256').update(key, 'utf8').digest()
const REPLAY_ID = 'tether-mcp-http-replay'

interface Pending { res: ServerResponse; sse: boolean; method: string; sessionId: string }

interface Slot {
  keyHash: Buffer
  spec: McpBackendSpec
  sessionId?: string
  /** The client's `initialize` request and whether it sent `notifications/initialized` (replayed into a restarted child). */
  init?: Json
  initialized: boolean
  child?: McpChild
  rewriter?: LineRewriter
  /** Resolves when the child answered the replayed handshake. */
  ready?: Promise<void>
  /** Settles `ready` when the replayed initialize is answered. */
  replay?: { resolve(): void; reject(e: Error): void }
  pending: Map<Id, Pending>
  stream?: ServerResponse
  idle?: NodeJS.Timeout
  /** The child was stopped since the session began: the next tools/call answer carries the notice. */
  notice: boolean
  starts: number
}

export function defaultSpawn(spec: McpBackendSpec): McpChild {
  return spawnChild(spec.command, spec.args, { env: spec.env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
}

function sseWrite(res: ServerResponse, msg: string): void {
  res.write(`event: message\ndata: ${msg}\n\n`)
}

export class McpHttpHost {
  private readonly slots = new Map<string, Slot>()
  private readonly opts: McpHttpHostOptions
  private server: Server | undefined
  private portNo: number | undefined

  constructor(opts: McpHttpHostOptions) { this.opts = opts }

  /** The port once listening (undefined before `listen` and after `close`). */
  get port(): number | undefined { return this.portNo }

  urlOf(slotId: string): string | undefined {
    return this.portNo === undefined ? undefined : `http://127.0.0.1:${this.portNo}/mcp/${encodeURIComponent(slotId)}`
  }

  listen(port = 0): Promise<number> {
    if (this.portNo !== undefined) return Promise.resolve(this.portNo)
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => { void this.handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end() }) })
      server.on('error', reject)
      server.listen(port, '127.0.0.1', () => {
        const addr = server.address()
        this.server = server
        this.portNo = typeof addr === 'object' && addr ? addr.port : port
        resolve(this.portNo)
      })
    })
  }

  async close(): Promise<void> {
    for (const id of [...this.slots.keys()]) this.revoke(id)
    const s = this.server
    this.server = undefined
    this.portNo = undefined
    if (s) await new Promise<void>(r => { s.closeAllConnections?.(); s.close(() => r()) })
  }

  /** The slot's key from now on (a previous grant, its session and its child are dropped). */
  grant(slotId: string, key: string, spec: McpBackendSpec): void {
    this.revoke(slotId)
    this.slots.set(slotId, { keyHash: digest(key), spec, initialized: false, pending: new Map(), notice: false, starts: 0 })
  }

  /** The key stops working, the session ends and the child is stopped. Never throws. */
  revoke(slotId: string): void {
    const s = this.slots.get(slotId)
    if (!s) return
    this.slots.delete(slotId)
    this.endSession(s)
  }

  /** How many children run now (doctor, tests). */
  running(): number {
    let n = 0
    for (const s of this.slots.values()) if (s.child) n++
    return n
  }

  /** Child starts of a slot so far (tests). */
  startsOf(slotId: string): number { return this.slots.get(slotId)?.starts ?? 0 }

  // ---- HTTP --------------------------------------------------------------------------------------------------------

  private authorize(req: IncomingMessage): Slot | undefined {
    const m = /^\/mcp\/([^/?#]+)(?:[?#].*)?$/.exec(req.url ?? '')
    if (!m) return undefined
    let slotId: string
    try { slotId = decodeURIComponent(m[1]!) } catch { return undefined }
    const auth = req.headers.authorization
    const given = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
    // Digest first, so the comparison is constant-time whatever the length; an unknown slot still costs a digest.
    const hash = digest(given)
    const s = this.slots.get(slotId)
    if (!s || !given) return undefined
    return timingSafeEqual(hash, s.keyHash) ? s : undefined
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers.origin !== undefined) { res.writeHead(403).end(); return }
    const slot = this.authorize(req)
    // One answer for "no such slot" and "wrong key": a caller learns nothing about which slots exist.
    if (!slot) { res.writeHead(401, { 'www-authenticate': 'Bearer' }).end(); return }
    const sid = req.headers['mcp-session-id']
    if (req.method === 'GET') {
      if (!String(req.headers.accept ?? '').includes('text/event-stream')) { res.writeHead(405).end(); return }
      if (!slot.sessionId || sid !== slot.sessionId) { res.writeHead(slot.sessionId && sid ? 404 : 400).end(); return }
      slot.stream?.end()
      slot.stream = res
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'mcp-session-id': slot.sessionId })
      res.on('close', () => { if (slot.stream === res) slot.stream = undefined })
      return
    }
    if (req.method === 'DELETE') {
      if (!slot.sessionId || sid !== slot.sessionId) { res.writeHead(404).end(); return }
      this.endSession(slot)
      res.writeHead(200).end()
      return
    }
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'GET, POST, DELETE' }).end(); return }

    let msg: unknown
    try { msg = JSON.parse(await this.body(req)) } catch { res.writeHead(400).end(); return }
    if (!isObject(msg)) { res.writeHead(400).end(); return } // batches left the protocol in 2025-06-18
    const isRequest = typeof msg.method === 'string' && isId(msg.id)
    const accept = String(req.headers.accept ?? '')
    const sse = accept.includes('text/event-stream')

    if (isRequest && msg.method === 'initialize') {
      this.endSession(slot)
      slot.sessionId = randomUUID()
      slot.init = msg
      slot.initialized = false
      slot.notice = false
      this.answerLater(slot, msg.id as Id, 'initialize', res, sse)
      this.startChild(slot, true)
      this.toChild(slot, JSON.stringify(msg))
      return
    }
    // A session id that is not the live one (ended, or never ours) is 404: the client starts a new session.
    if (!slot.sessionId || sid !== slot.sessionId) { res.writeHead(sid ? 404 : 400).end(); return }

    if (!isRequest) {
      // A notification or the client's answer to a server request: to the child when it runs, else nothing to tell.
      if (msg.method === 'notifications/initialized') slot.initialized = true
      if (slot.child) { await slot.ready?.catch(() => undefined); this.toChild(slot, JSON.stringify(msg)) }
      res.writeHead(202, { 'mcp-session-id': slot.sessionId }).end()
      return
    }
    this.answerLater(slot, msg.id as Id, msg.method as string, res, sse)
    if (!slot.child) this.startChild(slot, false)
    try { await slot.ready } catch { return } // the child died during the replay: the pending answer was already failed
    this.toChild(slot, JSON.stringify(msg))
  }

  private body(req: IncomingMessage): Promise<string> {
    const max = this.opts.maxBodyBytes ?? 32 * 1024 * 1024
    return new Promise((resolve, reject) => {
      const parts: Buffer[] = []
      let n = 0
      req.on('data', (c: Buffer) => { n += c.length; if (n > max) { reject(new Error('body too large')); req.destroy() } else parts.push(c) })
      req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
      req.on('error', reject)
    })
  }

  private answerLater(slot: Slot, id: Id, method: string, res: ServerResponse, sse: boolean): void {
    this.clearIdle(slot)
    slot.pending.set(id, { res, sse, method, sessionId: slot.sessionId! })
    if (sse) res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'mcp-session-id': slot.sessionId! })
    res.on('close', () => {
      if (slot.pending.get(id)?.res === res) { slot.pending.delete(id); this.armIdle(slot) }
    })
  }

  // ---- the child ---------------------------------------------------------------------------------------------------

  private startChild(slot: Slot, fresh: boolean): void {
    const child = (this.opts.spawn ?? defaultSpawn)(slot.spec)
    slot.child = child
    slot.rewriter = slot.spec.rewriter?.()
    slot.starts++
    let buf = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).replace(/\r$/, '')
        buf = buf.slice(i + 1)
        if (line !== '' && slot.child === child) this.fromChild(slot, line)
      }
    })
    child.stdin?.on('error', () => {})
    child.on('error', e => { this.opts.log(`${this.opts.name}: servidor MCP não iniciou (${e.message})`); this.childGone(slot, child) })
    child.on('exit', () => this.childGone(slot, child))
    slot.replay = undefined
    if (fresh) { slot.ready = undefined; return }
    // A restart inside a live session: the client's handshake again, its answer swallowed.
    slot.notice = true
    const init = slot.init
    if (!init) return
    slot.ready = new Promise<void>((resolve, reject) => { slot.replay = { resolve, reject } })
    slot.ready.catch(() => undefined)
    this.toChild(slot, JSON.stringify({ ...init, id: REPLAY_ID }))
  }

  private childGone(slot: Slot, child: McpChild): void {
    if (slot.child !== child) return
    slot.child = undefined
    slot.replay?.reject(new Error('exited'))
    slot.replay = undefined
    slot.ready = undefined
    for (const [id, p] of slot.pending) this.deliver(p, JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: `${this.opts.name}: o servidor MCP encerrou` } }), true)
    slot.pending.clear()
  }

  private stopChild(slot: Slot): void {
    const child = slot.child
    if (!child) return
    this.childGone(slot, child)
    try { child.stdin?.end() } catch { /* gone */ }
    // stdin closed is the server's own cue to leave; a kill if it lingers.
    setTimeout(() => { try { child.kill() } catch { /* gone */ } }, 3000).unref()
  }

  private endSession(slot: Slot): void {
    this.clearIdle(slot)
    this.stopChild(slot)
    slot.stream?.end()
    slot.stream = undefined
    slot.sessionId = undefined
    slot.init = undefined
    slot.initialized = false
  }

  private toChild(slot: Slot, line: string): void {
    const out = slot.rewriter ? slot.rewriter.fromClient(line) : line
    slot.child?.stdin?.write(`${out}\n`)
  }

  private fromChild(slot: Slot, raw: string): void {
    const line = slot.rewriter ? slot.rewriter.fromServer(raw) : raw
    let m: unknown
    try { m = JSON.parse(line) } catch { return }
    if (!isObject(m)) return
    if (m.id === REPLAY_ID && typeof m.method !== 'string') {
      const replay = slot.replay
      slot.replay = undefined
      if (slot.initialized) this.toChild(slot, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))
      replay?.resolve()
      return
    }
    if (isId(m.id) && typeof m.method !== 'string' && ('result' in m || 'error' in m)) {
      const p = slot.pending.get(m.id)
      if (!p) return
      slot.pending.delete(m.id)
      let text = line
      if (p.method === 'tools/call' && slot.notice && this.opts.restartNotice && isObject(m.result) && Array.isArray(m.result.content)) {
        slot.notice = false
        text = JSON.stringify({ ...m, result: { ...m.result, content: [{ type: 'text', text: this.opts.restartNotice }, ...m.result.content] } })
      }
      this.deliver(p, text, true)
      this.armIdle(slot)
      return
    }
    // A notification or a server request (progress, elicitation): on the stream of a request in flight, else the GET stream.
    const target = [...slot.pending.values()].reverse().find(p => p.sse)
    if (target) sseWrite(target.res, line)
    else if (slot.stream) sseWrite(slot.stream, line)
  }

  private deliver(p: Pending, text: string, last: boolean): void {
    if (p.res.writableEnded) return
    if (p.sse) { sseWrite(p.res, text); if (last) p.res.end(); return }
    p.res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': p.sessionId }).end(text)
  }

  private clearIdle(slot: Slot): void {
    if (slot.idle) { clearTimeout(slot.idle); slot.idle = undefined }
  }

  private armIdle(slot: Slot): void {
    this.clearIdle(slot)
    if (!slot.child || slot.pending.size > 0) return
    slot.idle = setTimeout(() => {
      slot.idle = undefined
      if (slot.child && slot.pending.size === 0) this.stopChild(slot)
    }, this.opts.idleMs ?? 15 * 60_000)
    slot.idle.unref()
  }
}
