// The main process's link to the panel host (tether-ptyd protocol): one connection that reconnects by itself, and,
// per attached slot, the host's epoch plus the next output offset, so every byte reaches `onData` exactly once and in
// order across reconnections and `lag`. Pure and injectable (no Electron; never launches the host).
import type { Socket } from 'node:net'
import { HostClient } from '../../src/procd/client.ts'

/** What the link needs from a host connection (HostClient satisfies it). */
export interface PanelConn {
  on(event: 'data', fn: (name: string, data: string, off?: number) => void): unknown
  on(event: 'lag', fn: (name: string) => void): unknown
  on(event: 'close', fn: () => void): unknown
  request(body: { t: 'attach'; name: string; from?: number; epoch?: string } | { t: 'detach'; name: string } | { t: 'resize'; name: string; cols: number; rows: number }): Promise<{ scrollback?: string; off?: number; epoch?: string }>
  write(name: string, data: string): void
  close(): void
  readonly isClosed: boolean
  /** Bytes the socket still holds unsent. */
  pending(): number
}

export interface AttachResult { scrollback: string; off: number; epoch: string }

export interface PanelLinkOptions {
  pipe: string
  /** Output of an attached slot: exactly once per byte, in order. */
  onData: (slotId: string, data: string) => void
  /** The host answered a re-attach with its whole ring (epoch changed or the offset fell out of it): replace the screen. */
  onReset?: (slotId: string, scrollback: string) => void
  /** A re-attach was refused (the run is gone from the host); the slot stays attached and is retried on the next reconnect. */
  onLost?: (slotId: string, reason: string) => void
  onState?: (connected: boolean) => void
  /** Opens a connection; undefined when no host answers. Default: HostClient.tryOpen (never launches the host). */
  open?: (pipe: string) => Promise<PanelConn | undefined>
  /** Runs `fn` after `ms`; returns the canceller. Default: setTimeout. */
  schedule?: (fn: () => void, ms: number) => () => void
  retryMinMs?: number
  retryMaxMs?: number
  /** `write` is dropped while the host socket holds more than this unsent (default 1 MiB). */
  writeMaxPending?: number
  openTimeoutMs?: number
}

export interface PanelLinkStats { writesDropped: number; reconnects: number; resyncs: number; resets: number }

interface Slot {
  epoch: string
  /** Offset of the next byte expected. */
  next: number
  /** While a (re)attach is in flight (or its result is being handed over), host events wait here. */
  held: { data: string; off: number | undefined }[] | undefined
  /** A resync was asked while one was in flight. */
  again: boolean
}

export const WRITE_MAX_PENDING = 1024 * 1024

/** Adapts a HostClient (its socket is private to it) to PanelConn. */
export function adaptHostClient(c: HostClient): PanelConn {
  const sock = (): Socket | undefined => (c as unknown as { socket?: Socket }).socket
  return {
    on: (event: string, fn: (...a: never[]) => void) => c.on(event as 'close', fn as () => void),
    request: (body) => c.request(body),
    write: (n, d) => c.write(n, d),
    close: () => c.close(),
    get isClosed() { return c.isClosed },
    pending: () => sock()?.writableLength ?? 0,
  } as PanelConn
}

export class PanelLink {
  private readonly o: Required<Pick<PanelLinkOptions, 'pipe' | 'onData'>> & PanelLinkOptions
  private readonly slots = new Map<string, Slot>()
  private readonly counters: PanelLinkStats = { writesDropped: 0, reconnects: 0, resyncs: 0, resets: 0 }
  private conn: PanelConn | undefined
  private delay: number
  private cancelRetry: (() => void) | undefined
  private stopped = true
  private connecting = false

  constructor(opts: PanelLinkOptions) {
    this.o = opts
    this.delay = opts.retryMinMs ?? 200
  }

  get connected(): boolean {
    return !!this.conn && !this.conn.isClosed
  }

  /** The delay the next reconnection attempt will wait (grows 0.2 s -> 2 s while the host stays away). */
  get nextDelayMs(): number {
    return this.delay
  }

  stats(): PanelLinkStats {
    return { ...this.counters }
  }

  has(slotId: string): boolean {
    return this.slots.has(slotId)
  }

  /** Starts connecting (and keeps trying). Resolves after the first attempt; `connected` says how it went. */
  async start(): Promise<void> {
    this.stopped = false
    await this.connect()
  }

  stop(): void {
    this.stopped = true
    this.cancelRetry?.()
    this.cancelRetry = undefined
    const c = this.conn
    this.conn = undefined
    c?.close()
  }

  /**
   * Attaches `slotId` and returns what the host holds: with `from` and the epoch it handed out, only what is missing.
   * The slot's later output arrives through `onData`, from the microtask after this resolves on (await it directly).
   */
  async attach(slotId: string, from?: number, epoch?: string): Promise<AttachResult> {
    const c = this.conn
    if (!c || c.isClosed) throw new Error('o anfitrião de painéis não está conectado')
    const held: Slot['held'] = []
    const slot: Slot = { epoch: '', next: 0, held, again: false }
    this.slots.set(slotId, slot)
    let r: Awaited<ReturnType<PanelConn['request']>>
    try {
      r = await c.request({ t: 'attach', name: slotId, ...(from !== undefined ? { from } : {}), ...(epoch !== undefined ? { epoch } : {}) })
    } catch (e) {
      this.slots.delete(slotId)
      throw e
    }
    const res: AttachResult = { scrollback: r.scrollback ?? '', off: r.off ?? 0, epoch: r.epoch ?? '' }
    slot.epoch = res.epoch
    slot.next = res.off
    queueMicrotask(() => this.release(slotId, slot))
    return res
  }

  async detach(slotId: string): Promise<void> {
    if (!this.slots.delete(slotId)) return
    if (this.connected) await this.conn!.request({ t: 'detach', name: slotId }).catch(() => undefined)
  }

  /** Input to the slot's process; dropped (and counted) while the host socket is backed up or the link is down. */
  write(slotId: string, data: string): boolean {
    const c = this.conn
    if (!c || c.isClosed || c.pending() > (this.o.writeMaxPending ?? WRITE_MAX_PENDING)) {
      this.counters.writesDropped++
      return false
    }
    c.write(slotId, data)
    return true
  }

  resize(slotId: string, cols: number, rows: number): void {
    const c = this.conn
    if (!c || c.isClosed) return
    void c.request({ t: 'resize', name: slotId, cols, rows }).catch(() => undefined)
  }

  // ---- connection ----------------------------------------------------------------------------

  private async connect(): Promise<void> {
    if (this.stopped || this.connecting || this.connected) return
    this.connecting = true
    let c: PanelConn | undefined
    try {
      c = await (this.o.open ?? defaultOpen(this.o.openTimeoutMs))(this.o.pipe)
    } catch {
      c = undefined
    }
    this.connecting = false
    if (this.stopped) { c?.close(); return }
    if (!c) { this.scheduleRetry(); return }
    this.conn = c
    this.delay = this.o.retryMinMs ?? 200
    c.on('data', (name, data, off) => this.onHostData(c, name, data, off))
    c.on('lag', (name) => { if (c === this.conn) this.resync(name) })
    c.on('close', () => this.onClose(c))
    this.o.onState?.(true)
    for (const id of this.slots.keys()) this.resync(id)
  }

  private onClose(c: PanelConn): void {
    if (c !== this.conn) return
    this.conn = undefined
    this.counters.reconnects++
    this.o.onState?.(false)
    // Output of the dropped connection is gone; every slot is held until the new connection re-attaches it.
    for (const s of this.slots.values()) s.held ??= []
    if (!this.stopped) this.scheduleRetry()
  }

  private scheduleRetry(): void {
    const ms = this.delay
    this.delay = Math.min(this.delay * 2, this.o.retryMaxMs ?? 2_000)
    const schedule = this.o.schedule ?? ((fn, t) => { const h = setTimeout(fn, t); return () => clearTimeout(h) })
    this.cancelRetry = schedule(() => { this.cancelRetry = undefined; void this.connect() }, ms)
  }

  // ---- output --------------------------------------------------------------------------------

  private onHostData(c: PanelConn, name: string, data: string, off: number | undefined): void {
    if (c !== this.conn) return
    const s = this.slots.get(name)
    if (!s) return
    if (s.held) { s.held.push({ data, off }); return }
    this.deliver(name, s, data, off)
  }

  /** `off` is the offset after the chunk: bytes already delivered are trimmed, a hole forces a resync. */
  private deliver(name: string, s: Slot, data: string, off: number | undefined): void {
    if (off === undefined) { this.o.onData(name, data); s.next += data.length; return }
    const start = off - data.length
    if (off <= s.next) return
    if (start > s.next) { this.resync(name); return }
    const fresh = start < s.next ? data.slice(s.next - start) : data
    s.next = off
    this.o.onData(name, fresh)
  }

  private release(name: string, s: Slot): void {
    const held = s.held
    s.held = undefined
    if (!held || this.slots.get(name) !== s) return
    for (const h of held) {
      if (s.held) return // a resync started meanwhile; it re-reads from `next`
      this.deliver(name, s, h.data, h.off)
    }
  }

  /** Re-attaches from the last offset with the same epoch; what comes back is delivered in order, then the held events. */
  private resync(name: string): void {
    const s = this.slots.get(name)
    const c = this.conn
    if (!s || !c || c.isClosed) return
    if (s.held && s.epoch !== '' && s.held.length >= 0 && this.inflight.has(s)) { s.again = true; return }
    this.inflight.add(s)
    s.held = []
    this.counters.resyncs++
    void (async () => {
      try {
        const r = await c.request({ t: 'attach', name, from: s.next, epoch: s.epoch })
        if (this.slots.get(name) !== s || c !== this.conn) return
        const text = r.scrollback ?? ''
        const off = r.off ?? s.next
        const delta = r.epoch === s.epoch && text.length === off - s.next
        if (delta) { if (text) this.o.onData(name, text) } else { this.counters.resets++; this.o.onReset?.(name, text) }
        s.epoch = r.epoch ?? s.epoch
        s.next = off
        // Events queued on the wire before the reply are covered by it; trimming by offset drops them.
      } catch (e) {
        if (this.slots.get(name) === s && c === this.conn && !c.isClosed) this.o.onLost?.(name, (e as Error).message)
      } finally {
        this.inflight.delete(s)
        const again = s.again
        s.again = false
        this.release(name, s)
        if (again) this.resync(name)
      }
    })()
  }

  private readonly inflight = new Set<Slot>()
}

function defaultOpen(timeoutMs = 5_000): (pipe: string) => Promise<PanelConn | undefined> {
  return async (pipe) => {
    const c = await HostClient.tryOpen(pipe, timeoutMs)
    return c ? adaptHostClient(c) : undefined
  }
}
