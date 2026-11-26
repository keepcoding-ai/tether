// The device leg to the relay (fio-spec 2.2): one WebSocket, binary frames only, subprotocol `tether-remote.v1` echoed
// by the relay. Frames come out of a queue read with `next`, so the pairing and the handshake read as the sequence
// they are. A text frame, a frame that does not parse or a missing subprotocol closes the socket.
import { decodeOuter, encodeOuter, relayUrlAllowed, WireError, WS_SUBPROTOCOL, type Bytes, type OuterFrame } from '../../../src/remote/index.ts'

export class LinkClosed extends Error {
  constructor() { super('the relay socket closed') }
}

/** The `aud` of a relay URL as this device configured it: host, lowercase, with the port when there is one (spec 5.1). */
export function audOf(url: string): string {
  return new URL(url).host.toLowerCase()
}

export class RelayLink {
  readonly #ws: WebSocket
  readonly #queue: OuterFrame[] = []
  #wake: (() => void) | undefined
  #closed = false
  onClose: () => void = () => {}

  private constructor(ws: WebSocket) {
    this.#ws = ws
    ws.binaryType = 'arraybuffer'
    ws.onmessage = (ev) => {
      if (!(ev.data instanceof ArrayBuffer)) { this.close(); return }
      try {
        this.#queue.push(decodeOuter('device', 'relay', new Uint8Array(ev.data)))
      } catch (e) {
        if (!(e instanceof WireError)) throw e
        this.close()
        return
      }
      this.#poke()
    }
    ws.onclose = () => this.#gone()
    ws.onerror = () => this.#gone()
  }

  /** Opens `<relay>/v1/device`. Rejects when the URL breaks the transport rule (B-8) or the socket does not open. */
  static open(relayUrl: string, timeoutMs = 10_000): Promise<RelayLink> {
    const url = new URL('/v1/device', relayUrl).toString()
    if (!relayUrlAllowed(url)) return Promise.reject(new Error('relay URL refused'))
    return new Promise((resolve, reject) => {
      let ws: WebSocket
      try { ws = new WebSocket(url, WS_SUBPROTOCOL) } catch (e) { reject(e); return }
      const timer = setTimeout(() => { ws.close(); reject(new Error('relay did not answer')) }, timeoutMs)
      ws.onopen = () => {
        clearTimeout(timer)
        if (ws.protocol !== WS_SUBPROTOCOL) { ws.close(); reject(new Error('relay without the subprotocol')); return }
        resolve(new RelayLink(ws))
      }
      ws.onerror = () => { clearTimeout(timer); reject(new Error('relay unreachable')) }
      ws.onclose = () => { clearTimeout(timer); reject(new Error('relay unreachable')) }
    })
  }

  get closed(): boolean { return this.#closed }

  #poke(): void {
    const w = this.#wake
    this.#wake = undefined
    w?.()
  }

  #gone(): void {
    if (this.#closed) return
    this.#closed = true
    this.#poke()
    this.onClose()
  }

  /** The next frame, or undefined after `ms` without one. Throws LinkClosed once the socket is gone and drained. */
  async next(ms: number): Promise<OuterFrame | undefined> {
    if (this.#queue.length === 0 && !this.#closed) {
      await new Promise<void>((r) => {
        const t = setTimeout(() => { this.#wake = undefined; r() }, ms)
        this.#wake = () => { clearTimeout(t); r() }
      })
    }
    const f = this.#queue.shift()
    if (f) return f
    if (this.#closed) throw new LinkClosed()
    return undefined
  }

  sendFrame(f: Parameters<typeof encodeOuter>[0]): void { this.send(encodeOuter(f)) }

  send(bytes: Bytes): void {
    if (this.#closed || this.#ws.readyState !== WebSocket.OPEN) return
    this.#ws.send(bytes)
  }

  close(): void {
    if (!this.#closed) {
      try { this.#ws.close(1000) } catch { /* already closing */ }
    }
    this.#gone()
  }
}
