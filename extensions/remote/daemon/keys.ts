// The house keys (fio-spec 1.2, 5.1, 6.2, 6.3), made by the only writer of <home>/remote/: K_H once; K_R with a 30-day
// certificate, replaced 15 days before it ends; K_T with a 90-day certificate, a new one as soon as the newest has less
// than ADMIT_TTL + 1 day left (so a ticket of 30 days always fits under a certificate), the previous one kept until its
// certificate ends (the relay still admits the tickets it signed). K_V (VAPID, RR4 4.4): once, independent of K_H (a new
// identity keeps it; it certifies nothing and nothing certifies it, M-11). The private halves are generated extractable
// only to be written as PKCS#8; the portal re-imports them non-extractable (src/remoted/keyfiles.ts).
import {
  ADMIT_TTL_S, b64url, CERT_ROLE_RELAY, CERT_ROLE_TICKET, generateRoleKey, issueKeyCert, KEYCERT_TTL_R_S, KEYCERT_TTL_T_S, parseKeyCert,
  toHex, fromHex, type KeyRole,
} from '../../../src/remote/index.ts'
import { importRoleKey, loadVapidKey, type HouseKeyFile, type RelayKeyFile, type TicketKeyFile, type VapidKeyFile } from '../../../src/remoted/keyfiles.ts'

const DAY_S = 86_400
const RELAY_RENEW_S = 15 * DAY_S
const TICKET_RENEW_S = ADMIT_TTL_S + DAY_S

async function fresh(role: KeyRole): Promise<{ pkcs8: string; pub: string }> {
  const { privateKey, pub } = await generateRoleKey(role, { extractable: true })
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', privateKey))
  try { return { pkcs8: b64url(der), pub: toHex(pub) } } finally { der.fill(0) }
}

export interface KeyTexts { house?: string; relay?: string; ticket?: string; vapid?: string }

/** A fresh K_V: an ECDSA P-256 pair of its own (Web Push only). */
async function freshVapid(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  try { return JSON.stringify({ v: 1, role: 'vapid', pkcs8: b64url(der), pub: toHex(pub) } satisfies VapidKeyFile) + '\n' } finally { der.fill(0) }
}

/** K_V is kept while it loads; one missing or unreadable is made again (the devices then subscribe again: a push key changed). */
async function vapidOk(text: string | undefined): Promise<boolean> {
  if (text === undefined) return false
  try { await loadVapidKey(text); return true } catch { return false }
}

const tryParse = <T>(t: string | undefined): T | undefined => {
  if (t === undefined) return undefined
  try { return JSON.parse(t) as T } catch { return undefined }
}

/**
 * The key files as they must be at `nowS`: what is missing is made, what is near its end is replaced. Returns only the
 * texts that changed (the caller writes them), so a house that is fine writes nothing.
 */
export async function ensureKeys(cur: KeyTexts, nowS: number): Promise<KeyTexts> {
  const out: KeyTexts = {}
  if (!(await vapidOk(cur.vapid))) out.vapid = await freshVapid()
  let house = tryParse<HouseKeyFile>(cur.house)
  if (!house || house.v !== 1 || house.role !== 'house') {
    house = { v: 1, role: 'house', ...(await fresh('house')) }
    out.house = JSON.stringify(house) + '\n'
    // A new identity: nothing certified by the old one is worth keeping.
    cur = {}
  }
  const kH = await importRoleKey('house', house)
  const certFor = async (role: typeof CERT_ROLE_RELAY | typeof CERT_ROLE_TICKET, pub: string, ttl: number): Promise<string> =>
    toHex(await issueKeyCert(kH, { role, pub: fromHex(pub), notBefore: nowS, notAfter: nowS + ttl }))

  const relay = tryParse<RelayKeyFile>(cur.relay)
  const relayEnds = relay?.cert ? safeNotAfter(relay.cert) : 0
  if (!relay || relay.v !== 1 || relay.role !== 'relay' || relayEnds - nowS < RELAY_RENEW_S) {
    const k = await fresh('relay')
    out.relay = JSON.stringify({ v: 1, role: 'relay', ...k, cert: await certFor(CERT_ROLE_RELAY, k.pub, KEYCERT_TTL_R_S) } satisfies RelayKeyFile) + '\n'
  }

  const ticket = tryParse<TicketKeyFile>(cur.ticket)
  const live = (ticket?.v === 1 && ticket.role === 'ticket' && Array.isArray(ticket.keys) ? ticket.keys : []).filter((k) => safeNotAfter(k.cert) > nowS)
  const newestEnds = live.length ? safeNotAfter(live[live.length - 1]!.cert) : 0
  if (newestEnds - nowS < TICKET_RENEW_S || live.length !== (ticket?.keys?.length ?? -1)) {
    const keys = live.slice(-1)
    if (newestEnds - nowS < TICKET_RENEW_S) {
      const k = await fresh('ticket')
      keys.push({ ...k, cert: await certFor(CERT_ROLE_TICKET, k.pub, KEYCERT_TTL_T_S) })
    }
    out.ticket = JSON.stringify({ v: 1, role: 'ticket', keys: keys.slice(-2) } satisfies TicketKeyFile) + '\n'
  }
  return out
}

function safeNotAfter(certHex: string): number {
  try { return parseKeyCert(fromHex(certHex)).notAfter } catch { return 0 }
}
