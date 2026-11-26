// Test support of the relay: houses and devices with real keys, a fake Conn for the core, and WebSocket clients for
// the shell. Test-only: nothing in src/ imports it.
import WebSocket from 'ws'
import {
  buildDeviceAdmit, buildHouseAuth, decodeOuter, encodeOuter, generateRoleKey, houseIdOf, issueAdmitTicket, issueKeyCert,
  KEYCERT_TTL_R_S, KEYCERT_TTL_T_S, WS_SUBPROTOCOL,
  type Bytes, type OuterFrame, type RoleKey,
} from '../../../src/remote/index.ts'
import type { Conn } from '../src/core.ts'

export const nowS = (): number => Math.floor(Date.now() / 1000)

export interface Home { kH: RoleKey; kR: RoleKey; kT: RoleKey; certR: Bytes; certT: Bytes; houseId: Bytes }

export async function makeHome(): Promise<Home> {
  const t = nowS()
  const kH = (await generateRoleKey('house')).key
  const kR = (await generateRoleKey('relay')).key
  const kT = (await generateRoleKey('ticket')).key
  return {
    kH, kR, kT, houseId: await houseIdOf(kH.pub),
    certR: await issueKeyCert(kH, { role: 1, pub: kR.pub, notBefore: t - 60, notAfter: t - 60 + KEYCERT_TTL_R_S }),
    certT: await issueKeyCert(kH, { role: 2, pub: kT.pub, notBefore: t - 60, notAfter: t - 60 + KEYCERT_TTL_T_S }),
  }
}

export interface Device { kA: RoleKey; ticket: Bytes; ticketId: Bytes }

export async function makeDevice(h: Home, aud: string, o: { notBefore?: number; exp?: number } = {}): Promise<Device> {
  const t = nowS()
  const kA = (await generateRoleKey('admission')).key
  const ticket = await issueAdmitTicket(h.kT, { certT: h.certT, pubA: kA.pub, aud, notBefore: o.notBefore ?? t - 60, exp: o.exp ?? t + 86_400 })
  // AdmitTicket = lp16(body) ‖ sig; ticketId sits after version(1) ‖ houseId(32) ‖ ktId(8) in the body.
  return { kA, ticket, ticketId: ticket.slice(2 + 41, 2 + 57) }
}

export const houseAuth = (h: Home, r: Uint8Array, aud: string): Promise<Bytes> =>
  buildHouseAuth({ r, aud, pubH: h.kH.pub, certR: h.certR, certsT: [h.certT], kR: h.kR, nowS: nowS() })

export const deviceAdmit = (d: Device, nR: Uint8Array, aud: string, kA: RoleKey = d.kA): Promise<Bytes> =>
  buildDeviceAdmit({ ticket: d.ticket, aud, nR, kA })

export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

export async function until(cond: () => boolean, ms = 3000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(5)
  }
}

// ---------------------------------------------------------------------------------------------------------------
// A fake Conn for the core
// ---------------------------------------------------------------------------------------------------------------

export class FakeConn implements Conn {
  readonly sent: Uint8Array[] = []
  closedWith: number | 'terminate' | undefined
  bufferedBytes = 0
  send(frame: Uint8Array): void { this.sent.push(frame) }
  buffered(): number { return this.bufferedBytes }
  close(code: number): void { this.closedWith ??= code }
  terminate(): void { this.closedWith ??= 'terminate' }
  /** The frames sent, decoded as the end of `leg` reads them. */
  frames(leg: 'house' | 'device'): OuterFrame[] { return this.sent.map(b => decodeOuter(leg, 'relay', b)) }
  last(leg: 'house' | 'device'): OuterFrame | undefined { return this.frames(leg).at(-1) }
  types(leg: 'house' | 'device'): string[] { return this.frames(leg).map(f => f.type) }
}

// ---------------------------------------------------------------------------------------------------------------
// WebSocket clients for the shell
// ---------------------------------------------------------------------------------------------------------------

export interface Client {
  ws: WebSocket
  /** Next binary message, in order. */
  next(ms?: number): Promise<Uint8Array>
  /** Next message decoded as the end of this leg reads frames from the relay. */
  frame(ms?: number): Promise<OuterFrame>
  send(b: Uint8Array): void
  closed: Promise<{ code: number; reason: string; at: number }>
  received: Uint8Array[]
}

const liveClients = new Set<WebSocket>()

/** Terminates every client socket a test opened: a paused client never reads the FIN and would keep the loop alive. */
export function terminateClients(): void {
  for (const ws of liveClients) ws.terminate()
  liveClients.clear()
}

export function connect(port: number, leg: 'house' | 'device', o: { protocol?: string | null; origin?: string; deflate?: boolean } = {}): Promise<Client> {
  const protocols = o.protocol === null ? [] : [o.protocol ?? WS_SUBPROTOCOL]
  const ws = new WebSocket(`ws://localhost:${port}/v1/${leg}`, protocols, {
    perMessageDeflate: o.deflate ?? false, origin: o.origin, maxPayload: 64 * 1024 * 1024,
  })
  liveClients.add(ws)
  ws.on('close', () => liveClients.delete(ws))
  const received: Uint8Array[] = []
  const waiters: ((b: Uint8Array) => void)[] = []
  let cursor = 0
  ws.on('message', (data: Buffer) => {
    const b = new Uint8Array(data)
    received.push(b)
    const w = waiters.shift()
    if (w) { cursor++; w(b) }
  })
  const closed = new Promise<{ code: number; reason: string; at: number }>(resolve => {
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString(), at: performance.now() }))
  })
  const next = (ms = 3000): Promise<Uint8Array> => {
    if (cursor < received.length) return Promise.resolve(received[cursor++]!)
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no message on ${leg} in ${ms} ms`)), ms)
      waiters.push(b => { clearTimeout(t); resolve(b) })
    })
  }
  const client: Client = {
    ws, received, closed, next,
    frame: async ms => decodeOuter(leg, 'relay', await next(ms)),
    send: b => ws.send(b, { binary: true }),
  }
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(client))
    ws.once('unexpected-response', (_req, res) => reject(new Error(`upgrade refused: ${res.statusCode}`)))
    ws.once('error', reject)
  })
}

/** A house that connects and proves its key; resolves once R_AUTH_OK arrived. */
export async function houseOnline(port: number, h: Home, aud: string): Promise<Client> {
  const c = await connect(port, 'house')
  const ch = await c.frame()
  if (ch.type !== 'R_CHALLENGE') throw new Error(`expected R_CHALLENGE, got ${ch.type}`)
  c.send(await houseAuth(h, ch.r, aud))
  const ok = await c.frame()
  if (ok.type !== 'R_AUTH_OK') throw new Error(`expected R_AUTH_OK, got ${ok.type}`)
  return c
}

/** A device that connects and sends `admit(nR)`; returns the client, the reply and the time from send to reply. */
export async function deviceTry(port: number, admit: (nR: Bytes) => Promise<Uint8Array>): Promise<{ c: Client; reply: Uint8Array; ms: number }> {
  const c = await connect(port, 'device')
  const hello = await c.frame()
  if (hello.type !== 'R_HELLO') throw new Error(`expected R_HELLO, got ${hello.type}`)
  const frame = await admit(hello.nR)
  const t0 = performance.now()
  c.send(frame)
  const reply = await c.next(5000)
  return { c, reply, ms: performance.now() - t0 }
}

export const dPair = (rv: Uint8Array): Bytes => encodeOuter({ type: 'D_PAIR', rv: Uint8Array.from(rv) })
export const data = (inner: Uint8Array): Bytes => encodeOuter({ type: 'DATA', inner: Uint8Array.from(inner) })
export const routeData = (routeId: number, inner: Uint8Array): Bytes =>
  encodeOuter({ type: 'ROUTE_DATA', routeId, inner: Uint8Array.from(inner) })
