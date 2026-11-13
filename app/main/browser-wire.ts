// The line between the app and its browser process (app/main/browser-host.ts ↔ app/main/browser-child.ts): newline-delimited
// JSON over a named pipe (a Unix socket elsewhere) the app opens and the child connects to with a one-time token. Each side can
// call the other (`call` → the peer's handler of that method, answered with a value or an error message) and post one-way
// messages (`post`). Buffers and Uint8Arrays travel as base64. A pending call fails with BROWSER_CRASHED when the line closes.
import type { Socket } from 'node:net'

export const BROWSER_CRASHED = 'BROWSER_CRASHED'

type Handler = (...args: unknown[]) => unknown

interface Pending { resolve(v: unknown): void; reject(e: Error): void }

/** Bytes as `{ $b64 }` on the line; everything else as JSON. */
function encode(v: unknown): unknown {
  if (v instanceof Uint8Array) return { $b64: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64') }
  if (Array.isArray(v)) return v.map(encode)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) if (x !== undefined && typeof x !== 'function') out[k] = encode(x)
    return out
  }
  return v
}

function decode(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decode)
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (typeof o.$b64 === 'string' && Object.keys(o).length === 1) return Buffer.from(o.$b64, 'base64')
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(o)) out[k] = decode(x)
    return out
  }
  return v
}

export class Wire {
  private readonly socket: Socket
  private readonly handlers = new Map<string, Handler>()
  private readonly pending = new Map<number, Pending>()
  private next = 1
  private buf = ''
  private closedFlag = false
  private readonly onClose = new Set<() => void>()

  constructor(socket: Socket) {
    this.socket = socket
    socket.setEncoding('utf8')
    socket.on('data', (d: string) => {
      this.buf += d
      let i: number
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i)
        this.buf = this.buf.slice(i + 1)
        if (line) this.receive(line)
      }
    })
    socket.on('close', () => this.close())
    socket.on('error', () => this.close())
  }

  get closed(): boolean { return this.closedFlag }

  /** Answers the peer's calls and posts of `method`. */
  handle(method: string, fn: Handler): void { this.handlers.set(method, fn) }

  call(method: string, ...args: unknown[]): Promise<unknown> {
    if (this.closedFlag) return Promise.reject(new Error(BROWSER_CRASHED))
    const id = this.next++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.write({ id, m: method, a: args })
    })
  }

  post(method: string, ...args: unknown[]): void {
    if (!this.closedFlag) this.write({ m: method, a: args })
  }

  whenClosed(fn: () => void): void { if (this.closedFlag) fn(); else this.onClose.add(fn) }

  close(): void {
    if (this.closedFlag) return
    this.closedFlag = true
    for (const p of this.pending.values()) p.reject(new Error(BROWSER_CRASHED))
    this.pending.clear()
    try { this.socket.destroy() } catch { /* gone */ }
    for (const fn of this.onClose) { try { fn() } catch { /* a listener's own */ } }
    this.onClose.clear()
  }

  private write(msg: unknown): void {
    try { this.socket.write(`${JSON.stringify(encode(msg))}\n`) } catch { this.close() }
  }

  private receive(line: string): void {
    let msg: { id?: number; m?: string; a?: unknown[]; r?: unknown; e?: string }
    try { msg = decode(JSON.parse(line)) as typeof msg } catch { return }
    if (msg.m === undefined && msg.id !== undefined) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.e !== undefined) p.reject(new Error(msg.e))
      else p.resolve(msg.r)
      return
    }
    if (typeof msg.m !== 'string') return
    const fn = this.handlers.get(msg.m)
    const id = msg.id
    if (id === undefined) { try { void Promise.resolve(fn?.(...(msg.a ?? []))).catch(() => {}) } catch { /* one-way */ } return }
    if (!fn) { this.write({ id, e: `método desconhecido: ${msg.m}` }); return }
    Promise.resolve().then(() => fn(...(msg.a ?? []))).then(
      r => this.write({ id, r: r === undefined ? null : r }),
      (e: unknown) => this.write({ id, e: e instanceof Error ? e.message : String(e) }),
    )
  }
}
