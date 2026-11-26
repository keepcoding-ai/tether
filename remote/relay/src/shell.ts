// The relay shell: an HTTP server whose only WebSocket routes are /v1/house and /v1/device, around the pure core.
// What lives here is what needs a socket: the upgrade (path, subprotocol, Origin, per-IP limits), `permessage-deflate`
// off, `maxPayload`, and the mapping of `ws` events to the core. TLS is not here: in production `wss://` ends at the
// proxy in front; `ws://` is for localhost only (fio-spec 0.3 rule 4).
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { WS_SUBPROTOCOL, type Leg } from '../../../src/remote/index.ts'
import { RelayCore, type Clock, type Conn, type RelayLog, type RelayStats, type Timers } from './core.ts'
import { RELAY_LIMITS, type RelayLimits } from './limits.ts'

export interface RelayServerOptions {
  /** Port to listen on; 0 picks a free one. */
  port: number
  /** Interface to bind; `localhost` by default. */
  host?: string
  /** The relay's identity (11 Q6). Defaults to `localhost:<port>` once the port is known. */
  aud?: string
  /**
   * Origins allowed on the device leg (5.7). Undefined: no Origin check, for the bench and for tests only; a
   * production relay always passes the PWA list.
   */
  origins?: readonly string[]
  limits?: Partial<RelayLimits>
  clock?: Clock
  timers?: Timers
  log?: RelayLog
}

export interface RelayServer {
  readonly port: number
  readonly aud: string
  readonly core: RelayCore
  stats(): RelayStats
  /** Closes every socket, empties the core and stops listening. */
  close(): Promise<void>
}

const PATHS: Record<string, Leg> = { '/v1/house': 'house', '/v1/device': 'device' }

export async function startRelay(o: RelayServerOptions): Promise<RelayServer> {
  const http: Server = createServer((req, res) => {
    // The orchestrator's health check. Nothing else is served over plain HTTP.
    if (req.method === 'GET' && req.url === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(o.port, o.host ?? 'localhost', () => { http.off('error', reject); resolve() })
  })
  const address = http.address()
  const port = typeof address === 'object' && address ? address.port : o.port
  const aud = o.aud ?? `localhost:${port}`
  const limits = { ...RELAY_LIMITS, ...o.limits }
  const core = new RelayCore({ aud, limits, clock: o.clock, timers: o.timers, log: o.log })
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: limits.maxOuter,
    clientTracking: false,
    handleProtocols: protocols => (protocols.has(WS_SUBPROTOCOL) ? WS_SUBPROTOCOL : false),
  })
  const sockets = new Set<WebSocket>()

  http.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const leg = PATHS[new URL(req.url ?? '/', 'http://relay').pathname]
    const ip = req.socket.remoteAddress ?? 'unknown'
    if (!leg) return reject(socket, 404)
    if (!offers(req, WS_SUBPROTOCOL)) return reject(socket, 400)
    if (leg === 'device' && o.origins && !o.origins.includes(String(req.headers.origin ?? ''))) return reject(socket, 403)
    if (!core.canAccept(ip)) { o.log?.('limit.conns', { leg }); return reject(socket, 429) }
    wss.handleUpgrade(req, socket, head, ws => {
      sockets.add(ws)
      const conn: Conn = {
        send: frame => ws.send(frame, { binary: true }),
        buffered: () => ws.bufferedAmount,
        close: code => ws.close(code),
        terminate: () => ws.terminate(),
      }
      const peer = core.attach(conn, leg, ip)
      ws.on('close', () => { sockets.delete(ws); if (peer) core.closed(peer) })
      ws.on('error', () => ws.terminate())
      if (!peer) return
      ws.on('message', (data, isBinary) => {
        // A defect in the core must cost one socket, never the process and every other house.
        try { core.message(peer, toBytes(data), isBinary) }
        catch (e) { o.log?.('core.error', { error: e instanceof Error ? e.name : 'unknown' }); core.closed(peer); ws.terminate() }
      })
    })
  })

  let closing: Promise<void> | undefined
  return {
    port, aud, core,
    stats: () => core.stats(),
    close: () => (closing ??= (async () => {
      core.shutdown()
      for (const ws of sockets) ws.terminate()
      sockets.clear()
      wss.close()
      http.closeAllConnections()
      await new Promise<void>(resolve => http.close(() => resolve()))
    })()),
  }
}

function offers(req: IncomingMessage, protocol: string): boolean {
  const header = req.headers['sec-websocket-protocol']
  if (typeof header !== 'string') return false
  return header.split(',').some(p => p.trim() === protocol)
}

function reject(socket: Duplex, status: number): void {
  socket.end(`HTTP/1.1 ${status} ${status === 429 ? 'Too Many Requests' : 'Refused'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy())
}

function toBytes(data: Buffer | ArrayBuffer | Buffer[]): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data)
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return data
}
