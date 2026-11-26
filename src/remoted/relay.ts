// The portal's outgoing socket to the relay (fio-spec 2.2 house leg, 5.1): WSS (WS only to localhost, relayUrlAllowed),
// binary frames, subprotocol tether-remote.v1 that the relay must echo. The relay sends R_CHALLENGE; the house answers
// H_AUTH (K_R signs only relay-auth, built by the module); R_AUTH_OK opens the link. A text frame, a frame that does not
// parse, or a silence of HB_TIMEOUT closes it. Reconnects with exponential backoff and jitter, reset by a link that came up.
import {
  decodeOuter, encodeOuter, HB_INTERVAL_MS, HB_TIMEOUT_MS, MAX_OUTER, randomBytes, relayUrlAllowed, WireError, WS_SUBPROTOCOL,
  type Bytes, type OuterFrame,
} from '../remote/index.ts'

export interface RelayLinkDeps {
  url: string
  /** H_AUTH for this challenge (32 bytes). */
  auth(r: Bytes): Promise<Bytes>
  up(): void
  down(): void
  frame(bytes: Uint8Array): void
  log(msg: string): void
  /** Defaults: global WebSocket, Date.now, 1 s first backoff, 60 s cap. */
  WebSocketImpl?: typeof WebSocket
  now?: () => number
  backoffMs?: { first: number; max: number }
}

/** The `aud` of a relay URL: its host as the house configured it, lowercase, with the port when there is one. */
export function audOf(url: string): string {
  const u = new URL(url)
  return u.host.toLowerCase()
}

export class RelayLink {
  readonly #d: RelayLinkDeps
  #ws: WebSocket | undefined
  #authed = false
  #stopped = false
  #attempt = 0
  #timer: NodeJS.Timeout | undefined
  #beat: NodeJS.Timeout | undefined
  #lastRecvMs = 0

  constructor(deps: RelayLinkDeps) {
    if (!relayUrlAllowed(deps.url)) throw new Error('relay URL refused: wss:// only (ws:// only for localhost), no credentials in it')
    this.#d = deps
  }

  get up(): boolean { return this.#authed }

  start(): void { this.#stopped = false; this.#open() }

  stop(): void {
    this.#stopped = true
    clearTimeout(this.#timer)
    this.#drop('stopped')
  }

  send(frame: Bytes): void {
    const ws = this.#ws
    if (!ws || !this.#authed || ws.readyState !== ws.OPEN) return
    if (frame.length > MAX_OUTER) { this.#d.log('relay: an outgoing frame above MAX_OUTER was dropped'); return }
    ws.send(frame)
  }

  #now(): number { return (this.#d.now ?? Date.now)() }

  #open(): void {
    if (this.#stopped) return
    const Impl = this.#d.WebSocketImpl ?? WebSocket
    let ws: WebSocket
    try { ws = new Impl(this.#d.url, WS_SUBPROTOCOL) } catch (e) {
      this.#d.log(`relay: cannot open (${(e as Error).message})`)
      return this.#retry()
    }
    ws.binaryType = 'arraybuffer'
    this.#ws = ws
    this.#authed = false
    this.#lastRecvMs = this.#now()
    ws.onopen = () => {
      if (ws.protocol !== WS_SUBPROTOCOL) { this.#d.log('relay: the subprotocol was not echoed; closing'); ws.close(); return }
      this.#startBeat(ws)
    }
    ws.onmessage = (ev: MessageEvent) => { void this.#onMessage(ws, ev.data) }
    ws.onerror = () => { /* surfaces as close */ }
    ws.onclose = () => {
      if (this.#ws !== ws) return
      this.#drop('closed')
      this.#retry()
    }
  }

  #startBeat(ws: WebSocket): void {
    clearInterval(this.#beat)
    this.#beat = setInterval(() => {
      if (this.#ws !== ws) return
      if (this.#now() - this.#lastRecvMs >= HB_TIMEOUT_MS) { this.#d.log('relay: silent for HB_TIMEOUT; closing'); ws.close(); return }
      if (this.#authed) ws.send(encodeOuter({ type: 'LINK_PING', echo: randomBytes(8) }))
    }, Math.min(HB_INTERVAL_MS, 5_000))
  }

  async #onMessage(ws: WebSocket, data: unknown): Promise<void> {
    if (this.#ws !== ws) return
    if (!(data instanceof ArrayBuffer)) { this.#d.log('relay: a text frame; closing'); ws.close(); return }
    const bytes = new Uint8Array(data)
    this.#lastRecvMs = this.#now()
    if (this.#authed) {
      if (bytes.length >= 2 && bytes[1] === 0x3e) {
        // LINK_PING from the relay (the second-house check of spec 5.1 among others): answered at once.
        try {
          const f = decodeOuter('house', 'relay', bytes)
          if (f.type === 'LINK_PING') ws.send(encodeOuter({ type: 'LINK_PONG', echo: f.echo }))
        } catch { ws.close() }
        return
      }
      if (bytes.length >= 2 && bytes[1] === 0x3f) return
      this.#d.frame(bytes)
      return
    }
    let f: OuterFrame
    try { f = decodeOuter('house', 'relay', bytes, { preAuth: true }) } catch (e) {
      if (e instanceof WireError) { this.#d.log(`relay: frame refused before auth (${e.code}); closing`); ws.close(); return }
      throw e
    }
    if (f.type === 'R_CHALLENGE') {
      try { ws.send(await this.#d.auth(f.r)) } catch (e) { this.#d.log(`relay: no H_AUTH (${(e as Error).message}); closing`); ws.close() }
      return
    }
    if (f.type === 'R_AUTH_OK') {
      this.#authed = true
      this.#attempt = 0
      this.#d.log('relay: link up')
      this.#d.up()
      return
    }
    if (f.type === 'R_AUTH_FAIL') this.#d.log('relay: the relay refused the house')
    ws.close()
  }

  #drop(why: string): void {
    clearInterval(this.#beat)
    const ws = this.#ws
    this.#ws = undefined
    const was = this.#authed
    this.#authed = false
    if (ws) { ws.onclose = null; ws.onmessage = null; try { ws.close() } catch { /* already closed */ } }
    if (was) { this.#d.log(`relay: link down (${why})`); this.#d.down() }
  }

  #retry(): void {
    if (this.#stopped) return
    const { first, max } = this.#d.backoffMs ?? { first: 1_000, max: 60_000 }
    const base = Math.min(max, first * 2 ** Math.min(this.#attempt, 16))
    this.#attempt++
    const wait = Math.round(base / 2 + Math.random() * (base / 2))
    clearTimeout(this.#timer)
    this.#timer = setTimeout(() => this.#open(), wait)
  }
}
