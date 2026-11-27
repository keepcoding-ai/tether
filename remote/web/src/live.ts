// A live session with the house (fio-spec 4, 7.1): admission at the relay with the stored ticket, the session handshake
// under the pinned pub_H, then requests and events over the record layer. Every effect of the session goes through one
// queue, so frames reach the socket in the order their counters were sealed. The heartbeat is the session's own
// (`tick` once a second lets PING and HB_TIMEOUT happen); nothing here asks the house for news: events are pushed.
import {
  buildDeviceAdmit, decodeEvt, decodeRes, DeviceHandshake, encodeReq, randomBytes, roleKey, WireError,
  type Bytes, type CloseCode, type DeviceHsFailure, type UvProof, type HsDoneInfo, type Session, type SessionEffect,
} from '../../../src/remote/index.ts'
import { LinkClosed, RelayLink } from './link.ts'
import type { HouseRecord } from './store.ts'

export interface Reply { status: number; body: Record<string, unknown> }

export type Ended =
  /** The house closed with CLOSE(code). */
  | { by: 'peer'; code?: CloseCode }
  /** This end closed (heartbeat timeout, protocol error, rekey due). */
  | { by: 'local'; code?: CloseCode }
  /** The socket went away without a CLOSE: a cut. */
  | { by: 'route' }

const TICK_MS = 1_000
const REQUEST_MS = 15_000
const utf8 = new TextDecoder('utf-8', { fatal: true })

/** A JSON body from the house: an object at the root, or nothing. Hostile text all the way down. */
function parseBody(b: Uint8Array): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(utf8.decode(b))
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
  } catch { return undefined }
}

export class Live {
  readonly #session: Session
  readonly #link: RelayLink
  readonly #waiting = new Map<number, (r: Reply) => void>()
  #reqId = 1
  #chain: Promise<void> = Promise.resolve()
  #ended: Ended | undefined
  onEvent: (evt: number, body: Record<string, unknown>) => void = () => {}
  onEnded: (e: Ended) => void = () => {}

  constructor(session: Session, link: RelayLink) {
    this.#session = session
    this.#link = link
    void this.#pump()
  }

  get ended(): Ended | undefined { return this.#ended }

  /** Runs a session step and applies its effects, strictly one after the other. */
  #step(f: () => Promise<SessionEffect[]>): Promise<void> {
    const next = this.#chain.then(async () => {
      if (this.#ended) return
      let fx: SessionEffect[]
      try { fx = await f() } catch (e) {
        if (!(e instanceof WireError)) throw e
        fx = this.#session.drop(e.message)
      }
      this.#apply(fx)
    })
    this.#chain = next.catch(() => {})
    return next
  }

  #apply(fx: SessionEffect[]): void {
    for (const e of fx) {
      if (e.t === 'send') this.#link.sendFrame({ type: 'DATA', inner: e.frame })
      else if (e.t === 'closed') this.#end(e.by === 'peer' ? { by: 'peer', ...(e.code !== undefined ? { code: e.code } : {}) } : { by: 'local', ...(e.code !== undefined ? { code: e.code } : {}) })
      else if (e.ctype === 'RES') {
        const r = decodeRes(e.content)
        const body = parseBody(r.body)
        const w = this.#waiting.get(r.reqId)
        this.#waiting.delete(r.reqId)
        w?.({ status: r.status, body: body ?? {} })
      } else if (e.ctype === 'EVT') {
        const v = decodeEvt(e.content)
        const body = parseBody(v.body)
        if (body) this.onEvent(v.evt, body)
      }
    }
  }

  #end(e: Ended): void {
    if (this.#ended) return
    this.#ended = e
    this.#link.close()
    for (const w of this.#waiting.values()) w({ status: -1, body: {} })
    this.#waiting.clear()
    this.onEnded(e)
  }

  async #pump(): Promise<void> {
    for (;;) {
      if (this.#ended) return
      let f
      try { f = await this.#link.next(TICK_MS) } catch (e) {
        if (!(e instanceof LinkClosed)) throw e
        this.#session.drop('route closed')
        this.#end({ by: 'route' })
        return
      }
      if (!f) { await this.#step(() => this.#session.tick(Date.now())); continue }
      if (f.type !== 'DATA') continue
      const inner = f.inner
      await this.#step(() => this.#session.receive(inner, Date.now()))
    }
  }

  /** The session's id: what every presence challenge of this session is bound to (spec 7.4). */
  get sessionId(): Bytes { return this.#session.sessionId }

  /**
   * One request. Resolves with the answer; status -1 when the session ended before it came. `body` given as bytes goes
   * out as is (an act bound to a presence proof is hashed over these exact bytes); `actId` fixes the act's id.
   */
  request(op: number, body: Record<string, unknown> | Bytes = {}, o: { mutates?: boolean; actId?: Bytes; uvProof?: UvProof } = {}): Promise<Reply> {
    const reqId = this.#reqId++
    const actId = o.actId ?? (o.mutates ? randomBytes(16) : undefined)
    const bytes = body instanceof Uint8Array ? body : new TextEncoder().encode(JSON.stringify(body))
    const content = encodeReq({ reqId, op, ...(actId ? { actId } : {}), ...(o.uvProof ? { uvProof: o.uvProof } : {}), body: bytes })
    const got = new Promise<Reply>((resolve) => {
      this.#waiting.set(reqId, resolve)
      setTimeout(() => { if (this.#waiting.delete(reqId)) resolve({ status: -1, body: {} }) }, REQUEST_MS)
    })
    void this.#step(() => this.#session.send('REQ', content, Date.now()))
    return got
  }

  /** Clean close: CLOSE(code), then the socket. */
  async close(code: CloseCode): Promise<void> {
    await this.#step(() => this.#session.close(code, Date.now()))
    this.#end({ by: 'local', code })
  }
}

export type ConnectResult =
  | { ok: true; live: Live; info: HsDoneInfo }
  /** `relay`: the socket did not open, or the relay answered R_FAIL. The device cannot tell why (spec 5.3). */
  | { ok: false; why: 'relay' | DeviceHsFailure; hard: boolean }

/** Admission with the stored ticket, then the session handshake under the pinned pub_H (spec 5.2, 4.1). */
export async function connect(rec: HouseRecord): Promise<ConnectResult> {
  let link: RelayLink
  try { link = await RelayLink.open(rec.relayUrl) } catch { return { ok: false, why: 'relay', hard: false } }
  try {
    const hello = await link.next(5_000)
    if (!hello || hello.type !== 'R_HELLO') { link.close(); return { ok: false, why: 'relay', hard: false } }
    const kA = roleKey('admission', rec.kA.privateKey, rec.kA.pub)
    link.send(await buildDeviceAdmit({ ticket: rec.admitTicket, aud: rec.aud, nR: hello.nR, kA }))
    const ok = await link.next(5_000)
    if (!ok || ok.type !== 'R_OK') { link.close(); return { ok: false, why: 'relay', hard: false } }
    const kD = roleKey('device', rec.kD.privateKey, rec.kD.pub)
    const { hs, effects } = await DeviceHandshake.start({ pinnedPubH: rec.pubH, kD, nowMs: Date.now(), pinnedVer: rec.pinnedVer })
    let fx = effects
    for (;;) {
      for (const e of fx) {
        if (e.t === 'send') link.sendFrame({ type: 'DATA', inner: e.frame })
        else if (e.t === 'failed') { link.close(); return { ok: false, why: e.reason, hard: e.hard } }
        else return { ok: true, live: new Live(e.session, link), info: e.info }
      }
      let f
      try { f = await link.next(TICK_MS) } catch (e) {
        if (!(e instanceof LinkClosed)) throw e
        await hs.routeClosed()
        return { ok: false, why: 'route-closed', hard: false }
      }
      if (!f) { fx = await hs.tick(Date.now()); continue }
      if (f.type !== 'DATA') continue
      fx = await hs.onFrame(f.inner, Date.now())
    }
  } catch (e) {
    link.close()
    if (e instanceof LinkClosed) return { ok: false, why: 'relay', hard: false }
    throw e
  }
}
