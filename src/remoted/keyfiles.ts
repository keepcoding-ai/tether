// The house keys on disk, in <home>/remote/ (fio-spec 1.2): one file per role. Only the `remote` extension writes them
// (it generates the keys and the certificates); the portal reads them and imports the private halves NON-extractable, so
// inside the portal no key can be exported again. Node has no persistent non-extractable key: the files are the
// residue the plan names ("chave da casa em arquivo comum"), guarded by the folder's owner-only ACL (M-7).
//   house.key   { v:1, role:'house',  pkcs8, pub }
//   relay.key   { v:1, role:'relay',  pkcs8, pub, cert }
//   ticket.key  { v:1, role:'ticket', keys: [{ pkcs8, pub, cert }] }   newest last; the others live until their certificate ends
//   vapid.key   { v:1, role:'vapid',  pkcs8, pub }   K_V, Web Push only (RFC 8292; M-11: never K_H), no certificate
// pkcs8 in base64url, pub (65 bytes) and cert (179 bytes) in hex. Pure: crypto.subtle only.
import { fromB64url, fromHex, roleKey, type Bytes, type KeyRole, type RoleKey } from '../remote/index.ts'
import { importVapidKey, type VapidKey } from '../remote/webpush.ts'

export const KEY_FILES = { house: 'house.key', relay: 'relay.key', ticket: 'ticket.key', vapid: 'vapid.key' } as const
export interface VapidKeyFile { v: 1; role: 'vapid'; pkcs8: string; pub: string }

/** K_V from its file, the private half non-extractable; throws with a short reason (never key material) when malformed. */
export async function loadVapidKey(text: string): Promise<VapidKey> {
  const k = JSON.parse(text) as Partial<VapidKeyFile>
  if (k.v !== 1 || k.role !== 'vapid' || !isStr(k.pkcs8) || !isStr(k.pub)) throw new Error('vapid.key malformado')
  const der = fromB64url(k.pkcs8)
  try { return await importVapidKey(der, fromHex(k.pub)) } finally { der.fill(0) }
}

export interface KeyEntry { pkcs8: string; pub: string; cert?: string }
export interface HouseKeyFile { v: 1; role: 'house'; pkcs8: string; pub: string }
export interface RelayKeyFile { v: 1; role: 'relay'; pkcs8: string; pub: string; cert: string }
export interface TicketKeyFile { v: 1; role: 'ticket'; keys: { pkcs8: string; pub: string; cert: string }[] }

export async function importRoleKey(role: KeyRole, e: { pkcs8: string; pub: string }): Promise<RoleKey> {
  const der = fromB64url(e.pkcs8)
  try {
    const key = await crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
    return roleKey(role, key, fromHex(e.pub))
  } finally { der.fill(0) }
}

export interface LoadedKeys {
  kH: RoleKey
  kR: RoleKey
  certR: Bytes
  kT: RoleKey
  certT: Bytes
  /** Every live ticket certificate (one or two), newest last: what H_AUTH registers at the relay. */
  certsT: Bytes[]
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/** Parses the three files' texts; throws with a short reason (never key material) when one is malformed. */
export async function loadKeys(text: { house: string; relay: string; ticket: string }): Promise<LoadedKeys> {
  const h = JSON.parse(text.house) as Partial<HouseKeyFile>
  const r = JSON.parse(text.relay) as Partial<RelayKeyFile>
  const t = JSON.parse(text.ticket) as Partial<TicketKeyFile>
  if (h.v !== 1 || h.role !== 'house' || !isStr(h.pkcs8) || !isStr(h.pub)) throw new Error('house.key malformado')
  if (r.v !== 1 || r.role !== 'relay' || !isStr(r.pkcs8) || !isStr(r.pub) || !isStr(r.cert)) throw new Error('relay.key malformado')
  if (t.v !== 1 || t.role !== 'ticket' || !Array.isArray(t.keys) || t.keys.length < 1 || t.keys.length > 2) throw new Error('ticket.key malformado')
  for (const k of t.keys) if (!isStr(k?.pkcs8) || !isStr(k?.pub) || !isStr(k?.cert)) throw new Error('ticket.key malformado')
  const newest = t.keys[t.keys.length - 1]!
  return {
    kH: await importRoleKey('house', { pkcs8: h.pkcs8, pub: h.pub }),
    kR: await importRoleKey('relay', { pkcs8: r.pkcs8, pub: r.pub }),
    certR: fromHex(r.cert),
    kT: await importRoleKey('ticket', newest),
    certT: fromHex(newest.cert),
    certsT: t.keys.map((k) => fromHex(k.cert)),
  }
}
