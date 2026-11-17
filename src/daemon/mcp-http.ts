// MCP servers of the daemon extensions served to the agents over Streamable HTTP (MCP 2025-06-18 transport), so an agent
// whose CLI loads `{ "type": "http" }` servers (AgentMcp.http) spawns NO process of its own for them. One host per extension,
// bound to 127.0.0.1 on a port of the system's choosing, one route per slot: `/mcp/<slotId>`.
//
// The servers run INSIDE the daemon: behind each route there is one server instance of the slot (a library object the
// extension creates, McpBackend), bound to an in-memory transport. No child process, whether the agent uses the tool or not:
//   - the instance is created at the slot's first `initialize` and lives until the slot's key is revoked (the agent exited)
//     or the host closes. It is never stopped for being idle: what it holds (a connection, the tabs it follows) is there when
//     the agent comes back from a pause;
//   - a client that initializes again (a reconnect) gets a new MCP session on the SAME instance (McpBackend.connect again);
//   - messages the server sends on its own (progress, a request to the client such as an elicitation, a notification) go to
//     the stream of the request they belong to, else to the client's GET stream, else they wait (bounded) for that stream.
//
// Security: 127.0.0.1 only; every request carries `Authorization: Bearer <key>` and the key is the slot's own (granted by the
// launch middleware, compared in constant time over sha256 digests, revoked when the agent exits). A request with an Origin
// header is refused (no browser page may drive it, whatever it guesses). The host keeps only the digest; no log line carries
// a key or a message body.
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

/** Rewrites the JSON-RPC lines between the client and the server (extensions/browser/mcp-texts.ts McpRewriter). */
export interface LineRewriter {
  fromClient(line: string): string
  fromServer(line: string): string
}

/**
 * The transport a server instance is bound to: the MCP SDK's `Transport`, by shape (the daemon does not depend on the SDK;
 * the vendored servers carry their own). The server sets the three callbacks in `connect` and calls `send` with its messages.
 */
export interface McpTransport {
  start(): Promise<void>
  send(message: unknown, options?: { relatedRequestId?: string | number }): Promise<void>
  close(): Promise<void>
  onmessage?: (message: unknown, extra?: unknown) => void
  onclose?: () => void
  onerror?: (error: Error) => void
  sessionId?: string
}

/** One slot's server, inside this process (the vendored bundles' `createTetherBrowserServer` / `createBridgeMcp`). */
export interface McpBackend {
  /** Binds a new MCP server to `transport`; called again when the client initializes again (the previous one is closed first). */
  connect(transport: McpTransport): Promise<void>
  /** The slot is over. Never throws. */
  close(): Promise<void>
}

/** How to make the server of one slot. */
export interface McpBackendSpec {
  /** Called once per grant, at the slot's first `initialize`. */
  create(): McpBackend | Promise<McpBackend>
  /** A new rewriter for each MCP session (it follows one connection). */
  rewriter?: () => LineRewriter
}

/** The host as a launch middleware uses it (McpHttpHost; a fake in tests). */
export interface McpSlotRoutes {
  /** The slot's route, or undefined while the host is not listening (then the stdio path applies). */
  urlOf(slotId: string): string | undefined
  grant(slotId: string, key: string, spec: McpBackendSpec): void
  revoke(slotId: string): void
}

export interface McpHttpHostOptions {
  /** For log lines ("tether-browser"). */
  name: string
  log(msg: string): void
  /** How often an open stream gets a comment line, so no client or proxy drops it for silence. Default 20 s. */
  keepAliveMs?: number
  /** Server messages kept while the client has no stream to take them. Default 64 (the oldest goes first). */
  maxQueued?: number
  maxBodyBytes?: number
  /**
   * The client's GET stream of a slot opened (`true`) or closed (`false`: the client dropped it, the session ended, the slot
   * was revoked). Edges only: a reconnect that replaces an open stream says nothing. What reaches the agent unasked (the
   * ronda's channel) is only delivered at once while this stream is open. A throwing listener never breaks the host.
   */
  onStream?: (slotId: string, open: boolean) => void
}

type Json = Record<string, unknown>
type Id = string | number
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const isId = (v: unknown): v is Id => typeof v === 'string' || typeof v === 'number'
const digest = (key: string): Buffer => createHash('sha256').update(key, 'utf8').digest()

interface Pending { res: ServerResponse; sse: boolean; sessionId: string }

/** One MCP session of a slot: the in-memory transport its server is bound to and the HTTP answers waiting on it. */
interface Session {
  id: string
  transport: McpTransport
  rewriter: LineRewriter | undefined
  pending: Map<Id, Pending>
  /** The client's GET stream. */
  stream: ServerResponse | undefined
  /** Server messages waiting for a stream. */
  queued: string[]
  closed: boolean
}

interface Slot {
  id: string
  keyHash: Buffer
  spec: McpBackendSpec
  /** The slot's server, once asked for. */
  backend: Promise<McpBackend> | undefined
  session: Session | undefined
  creates: number
}

function sseWrite(res: ServerResponse, msg: string): void {
  if (!res.writableEnded && !res.destroyed) res.write(`event: message\ndata: ${msg}\n\n`)
}

export class McpHttpHost {
  private readonly slots = new Map<string, Slot>()
  private readonly opts: McpHttpHostOptions
  private server: Server | undefined
  private portNo: number | undefined
  private beat: NodeJS.Timeout | undefined

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
        this.beat = setInterval(() => this.keepAlive(), this.opts.keepAliveMs ?? 20_000)
        this.beat.unref()
        resolve(this.portNo)
      })
    })
  }

  async close(): Promise<void> {
    if (this.beat) { clearInterval(this.beat); this.beat = undefined }
    for (const id of [...this.slots.keys()]) this.revoke(id)
    const s = this.server
    this.server = undefined
    this.portNo = undefined
    if (s) await new Promise<void>(r => { s.closeAllConnections?.(); s.close(() => r()) })
  }

  /** The slot's key from now on (a previous grant, its session and its server are dropped). */
  grant(slotId: string, key: string, spec: McpBackendSpec): void {
    this.revoke(slotId)
    this.slots.set(slotId, { id: slotId, keyHash: digest(key), spec, backend: undefined, session: undefined, creates: 0 })
  }

  /** The key stops working, the session ends and the slot's server is closed. Never throws. */
  revoke(slotId: string): void {
    const s = this.slots.get(slotId)
    if (!s) return
    this.slots.delete(slotId)
    this.endSession(s)
    const backend = s.backend
    s.backend = undefined
    void backend?.then(b => b.close()).catch(() => undefined)
  }

  /** How many slots have a live server instance now (doctor, tests). */
  running(): number {
    let n = 0
    for (const s of this.slots.values()) if (s.backend) n++
    return n
  }

  /** The slot's client has its GET stream open now (what the server says unasked reaches it at once). */
  streamOpen(slotId: string): boolean {
    const s = this.slots.get(slotId)?.session
    return !!s && !s.closed && !!s.stream && !s.stream.writableEnded && !s.stream.destroyed
  }

  /** How many times a slot's server was created under the current grant (tests): 1 however many sessions it served. */
  createsOf(slotId: string): number { return this.slots.get(slotId)?.creates ?? 0 }

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
    const live = slot.session
    if (req.method === 'GET') {
      if (!String(req.headers.accept ?? '').includes('text/event-stream')) { res.writeHead(405).end(); return }
      if (!live || sid !== live.id) { res.writeHead(live && sid ? 404 : 400).end(); return }
      const had = !!live.stream
      live.stream?.end()
      live.stream = res
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'mcp-session-id': live.id })
      res.flushHeaders()
      res.on('close', () => { if (live.stream === res) { live.stream = undefined; this.streamEdge(slot, false) } })
      if (!had) this.streamEdge(slot, true)
      // What the server said while the client had no stream.
      for (const line of live.queued.splice(0)) sseWrite(res, line)
      return
    }
    if (req.method === 'DELETE') {
      if (!live || sid !== live.id) { res.writeHead(404).end(); return }
      // The session ends; the slot's server stays (it lives as long as the slot).
      this.endSession(slot)
      res.writeHead(200).end()
      return
    }
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'GET, POST, DELETE' }).end(); return }

    let text: string
    let msg: unknown
    try { text = await this.body(req); msg = JSON.parse(text) } catch { res.writeHead(400).end(); return }
    if (!isObject(msg)) { res.writeHead(400).end(); return } // batches left the protocol in 2025-06-18
    const isRequest = typeof msg.method === 'string' && isId(msg.id)
    const sse = String(req.headers.accept ?? '').includes('text/event-stream')

    if (isRequest && msg.method === 'initialize') {
      this.endSession(slot)
      const session: Session = { id: randomUUID(), transport: undefined as unknown as McpTransport, rewriter: slot.spec.rewriter?.(), pending: new Map(), stream: undefined, queued: [], closed: false }
      session.transport = this.transportOf(slot, session)
      slot.session = session
      this.answerLater(session, msg.id as Id, res, sse)
      try {
        if (!slot.backend) { slot.creates++; slot.backend = Promise.resolve().then(() => slot.spec.create()) }
        const backend = await slot.backend
        if (slot.session !== session) return // revoked or initialized again meanwhile
        await backend.connect(session.transport)
      } catch (e) {
        this.opts.log(`${this.opts.name}: servidor MCP não iniciou (${e instanceof Error ? e.message : String(e)})`)
        // A server that could not be made is asked for again at the next initialize.
        if (slot.session === session) { slot.backend = undefined; slot.session = undefined }
        this.failSession(session, 'o servidor MCP não iniciou', slot)
        return
      }
      if (slot.session !== session) return
      this.toServer(session, text, msg)
      return
    }
    // A session id that is not the live one (ended, or never ours) is 404: the client starts a new session.
    if (!live || sid !== live.id) { res.writeHead(sid ? 404 : 400).end(); return }

    if (!isRequest) {
      // A notification, or the client's answer to a request of the server (an elicitation's result).
      this.toServer(live, text, msg)
      res.writeHead(202, { 'mcp-session-id': live.id }).end()
      return
    }
    this.answerLater(live, msg.id as Id, res, sse)
    this.toServer(live, text, msg)
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

  private answerLater(session: Session, id: Id, res: ServerResponse, sse: boolean): void {
    session.pending.set(id, { res, sse, sessionId: session.id })
    if (sse) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'mcp-session-id': session.id })
      res.flushHeaders()
    }
    res.on('close', () => { if (session.pending.get(id)?.res === res) session.pending.delete(id) })
  }

  // ---- the session's transport -------------------------------------------------------------------------------------

  /** The in-memory transport of one session: `send` is the server talking, `onmessage` (set by the server) is the client. */
  private transportOf(slot: Slot, session: Session): McpTransport {
    const transport: McpTransport = {
      sessionId: session.id,
      start: async () => undefined,
      send: async (message, options) => { if (!session.closed) this.fromServer(session, message, options?.relatedRequestId) },
      // The server closed its side (McpBackend.connect again, or its own shutdown): the session is over.
      close: async () => { if (slot.session === session) slot.session = undefined; this.failSession(session, 'o servidor MCP encerrou', slot) },
    }
    return transport
  }

  private toServer(session: Session, text: string, msg: Json): void {
    if (session.closed) return
    // The rewriter only notes what was asked (it never changes a client line).
    session.rewriter?.fromClient(text)
    try { session.transport.onmessage?.(msg) } catch (e) {
      this.opts.log(`${this.opts.name}: o servidor MCP recusou uma mensagem (${e instanceof Error ? e.message : String(e)})`)
    }
  }

  private fromServer(session: Session, message: unknown, related: Id | undefined): void {
    if (!isObject(message)) return
    let line: string
    try {
      const raw = JSON.stringify(message)
      line = session.rewriter ? session.rewriter.fromServer(raw) : raw
    } catch { return }
    if (isId(message.id) && typeof message.method !== 'string' && ('result' in message || 'error' in message)) {
      const p = session.pending.get(message.id)
      if (!p) return
      session.pending.delete(message.id)
      this.deliver(p, line)
      return
    }
    // A notification or a request of the server (progress, an elicitation): on the stream of the request it belongs to, else
    // the client's GET stream, else any request's stream still open; with none, it waits for the GET stream.
    const own = related !== undefined ? session.pending.get(related) : undefined
    const target = own?.sse ? own.res : session.stream ?? [...session.pending.values()].reverse().find(p => p.sse)?.res
    if (target) { sseWrite(target, line); return }
    session.queued.push(line)
    const max = this.opts.maxQueued ?? 64
    if (session.queued.length > max) session.queued.splice(0, session.queued.length - max)
  }

  private deliver(p: Pending, text: string): void {
    if (p.res.writableEnded || p.res.destroyed) return
    if (p.sse) { sseWrite(p.res, text); p.res.end(); return }
    p.res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': p.sessionId }).end(text)
  }

  /** Every answer still waited for gets an error, the streams end, and the server learns its transport is closed. Once. */
  private failSession(session: Session, why: string, slot?: Slot): void {
    if (session.closed) return
    session.closed = true
    const hadStream = !!session.stream
    for (const [id, p] of session.pending) this.deliver(p, JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: `${this.opts.name}: ${why}` } }))
    session.pending.clear()
    session.stream?.end()
    session.stream = undefined
    session.queued.length = 0
    if (hadStream && slot) this.streamEdge(slot, false)
    try { session.transport.onclose?.() } catch { /* the server's own cleanup */ }
  }

  private streamEdge(slot: Slot, open: boolean): void {
    try { this.opts.onStream?.(slot.id, open) } catch { /* the listener's own problem */ }
  }

  private endSession(slot: Slot): void {
    const session = slot.session
    slot.session = undefined
    if (session) this.failSession(session, 'a sessão MCP terminou', slot)
  }

  /** A comment line on every open stream (an SSE comment is ignored by the client; it only keeps the connection used). */
  private keepAlive(): void {
    for (const slot of this.slots.values()) {
      const s = slot.session
      if (!s) continue
      for (const res of [s.stream, ...[...s.pending.values()].filter(p => p.sse).map(p => p.res)]) {
        if (res && !res.writableEnded && !res.destroyed) res.write(': keepalive\n\n')
      }
    }
  }
}
