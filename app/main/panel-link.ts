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
  /** The socket's send buffer emptied: queued input may go. */
  on(event: 'drain', fn: () => void): unknown
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
  /** `write` queues (per slot) while the host socket holds more than this unsent (default 1 MiB). */
  writeMaxPending?: number
  /** Per-slot ceiling of queued input chars while the link is down or backed up (default 64 KiB); the excess is dropped and counted. */
  writeQueueMax?: number
  openTimeoutMs?: number
}

export interface PanelLinkStats { writesDropped: number; writesQueued: number; reconnects: number; resyncs: number; resets: number }

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
export const WRITE_QUEUE_MAX = 64 * 1024

/** Adapts a HostClient (its socket is private to it) to PanelConn. */
export function adaptHostClient(c: HostClient): PanelConn {
  const sock = (): Socket | undefined => (c as unknown as { socket?: Socket }).socket
  return {
    on: (event: string, fn: (...a: never[]) => void) => (event === 'drain' ? sock()?.on('drain', fn as () => void) : c.on(event as 'close', fn as () => void)),
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
  private readonly counters: PanelLinkStats = { writesDropped: 0, writesQueued: 0, reconnects: 0, resyncs: 0, resets: 0 }
  /** Input waiting for the link, per slot, in order. */
  private readonly queues = new Map<string, { chunks: string[]; size: number }>()
  /** Slots whose output nobody looks at: nothing is delivered and `next` stays put, so the resume reads what is missing from the host. */
  private readonly paused = new Set<string>()
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
    this.queues.clear()
    this.paused.clear()
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
    queueMicrotask(() => { this.release(slotId, slot); this.drain() })
    return res
  }

  /**
   * A paused slot stays attached but its output is not delivered (the window's terminal is off screen and need not parse it);
   * the offset stops where it was. Resuming re-attaches from that offset with the host's epoch: the host answers only what is
   * missing (delivered through `onData`) or, when the offset left its ring, the whole ring (`onReset`). No-op for a slot not attached.
   */
  setPaused(slotId: string, paused: boolean): void {
    if (paused) { if (this.slots.has(slotId)) this.paused.add(slotId); return }
    if (this.paused.delete(slotId)) this.resync(slotId)
  }

  isPaused(slotId: string): boolean {
    return this.paused.has(slotId)
  }

  async detach(slotId: string): Promise<void> {
    this.queues.delete(slotId)
    this.paused.delete(slotId)
    if (!this.slots.delete(slotId)) return
    if (this.connected) await this.conn!.request({ t: 'detach', name: slotId }).catch(() => undefined)
  }

  /**
   * Input to the slot's process. While the link is down or the host socket is backed up (or older input of the slot is
   * still waiting) it is queued per slot and goes out in order once the link allows; false only when the queue ceiling
   * dropped it (counted).
   */
  write(slotId: string, data: string): boolean {
    if (!this.queues.has(slotId) && this.canSend()) { this.conn!.write(slotId, data); return true }
    let q = this.queues.get(slotId)
    if (!q) this.queues.set(slotId, (q = { chunks: [], size: 0 }))
    if (q.size + data.length > (this.o.writeQueueMax ?? WRITE_QUEUE_MAX)) {
      this.counters.writesDropped++
      if (!q.chunks.length) this.queues.delete(slotId)
      return false
    }
    q.chunks.push(data)
    q.size += data.length
    this.counters.writesQueued++
    this.drain()
    return true
  }

  private canSend(): boolean {
    const c = this.conn
    return !!c && !c.isClosed && c.pending() <= (this.o.writeMaxPending ?? WRITE_MAX_PENDING)
  }

  /** Sends queued input, slot by slot, in order, while the link has room. */
  private drain(): void {
    for (const [id, q] of this.queues) {
      while (q.chunks.length && this.canSend()) {
        const d = q.chunks.shift()!
        q.size -= d.length
        this.conn!.write(id, d)
      }
      if (!q.chunks.length) this.queues.delete(id)
      if (!this.canSend()) return
    }
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
    c.on('drain', () => { if (c === this.conn) this.drain() })
    this.o.onState?.(true)
    for (const id of this.slots.keys()) this.resync(id)
    this.drain()
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
    if (!s || this.paused.has(name)) return
    if (s.held) { s.held.push({ data, off }); return }
    this.deliver(name, s, data, off)
  }

  /** `off` is the offset after the chunk: bytes already delivered are trimmed, a hole forces a resync. */
  private deliver(name: string, s: Slot, data: string, off: number | undefined): void {
    if (this.paused.has(name)) return // events held from before the pause too: the resume reads them from the host
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
    if (!s || !c || c.isClosed || this.paused.has(name)) return
    if (s.held && s.epoch !== '' && s.held.length >= 0 && this.inflight.has(s)) { s.again = true; return }
    this.inflight.add(s)
    s.held = []
    this.counters.resyncs++
    void (async () => {
      try {
        const r = await c.request({ t: 'attach', name, from: s.next, epoch: s.epoch })
        if (this.slots.get(name) !== s || c !== this.conn || this.paused.has(name)) return
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
        this.drain()
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
