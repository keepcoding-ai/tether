// The remote extension's pure rules: who may ask what (E-7, A-2), the registry of devices (<home>/remote/devices.json) and
// its transitions, the deny list it implies, and the projections that leave the extension. No I/O.
import type { DenyRow, PortalDevice, TicketRow } from '../../src/remoted/ipc.ts'

export const EXT_ID = 'remote'

/** The bench flag (molde TETHER_TEST_BLOCK): in tetherd's env, pairing and switching on are also accepted from cli/test. */
export const ENV_TEST_REMOTE = 'TETHER_TEST_REMOTE'

/**
 * Who may ask each request. `app`: only a connection that said `client:'app'` (or any non-remote one on the bench).
 * `any`: whatever lowers power (status, revoke, off) — the CLI keeps these (A-2). Nobody asks the portal's side: that
 * goes on the portal's private IPC channel, never on the pipe.
 */
export const ORIGIN = {
  'remote.status': 'any',
  'remote.off': 'any',
  'device.list': 'any',
  'device.revoke': 'any',
  'remote.on': 'app',
  'pair.begin': 'app',
  'pair.sas': 'app',
  'pair.cancel': 'app',
  'pair.state': 'app',
} as const
export type RemoteRequest = keyof typeof ORIGIN

/** E-7 (b): `pair.*` and `remote.on` only from an `app` connection; the bench flag widens it to cli/test, never to remote. */
export function originAllowed(name: RemoteRequest, client: string | undefined, bench: boolean): boolean {
  if (ORIGIN[name] === 'any') return true
  if (client === 'app') return true
  return bench && (client === 'cli' || client === 'test')
}

export interface DeviceEntry {
  deviceId: string
  pubD: string
  /** Declared by the device, sanitized: never an identity. */
  name: string
  access: 'code' | 'qr'
  state: 'pending' | 'active' | 'revoked'
  scopes: string[]
  createdAt: string
  activatedAt?: string
  revokedAt?: string
  lastSeenAt?: string
  maxVerUsed: number
  /** The live admission tickets (one, plus a renewal's predecessor until its deny is due). */
  tickets: TicketRow[]
  usedKeyIds: string[]
  /** Tickets superseded by a renewal: denied at the relay until they expire. */
  denied: DenyRow[]
}

export interface RegistryFile { v: 1; devices: DeviceEntry[] }

/** At most this many devices that are not revoked; a pairing beyond it is refused. */
export const DEVICES_MAX = 32

const HEX = (n: number): RegExp => new RegExp(`^[0-9a-f]{${n}}$`)
const isTicket = (t: unknown): t is TicketRow => {
  const x = t as TicketRow
  return typeof x === 'object' && x !== null && HEX(32).test(x.ticketId) && Number.isInteger(x.exp) && HEX(16).test(x.keyId)
}

/** Reads devices.json strictly: an entry that does not parse is dropped (and the drop is the caller's to log). */
export function parseRegistry(text: string | undefined): { devices: DeviceEntry[]; dropped: number } {
  if (text === undefined) return { devices: [], dropped: 0 }
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return { devices: [], dropped: 1 } }
  const list = (raw as Partial<RegistryFile>)?.devices
  if ((raw as Partial<RegistryFile>)?.v !== 1 || !Array.isArray(list)) return { devices: [], dropped: 1 }
  const devices: DeviceEntry[] = []
  let dropped = 0
  for (const d of list as Partial<DeviceEntry>[]) {
    const ok = d && HEX(32).test(String(d.deviceId)) && HEX(130).test(String(d.pubD)) && typeof d.name === 'string'
      && (d.state === 'pending' || d.state === 'active' || d.state === 'revoked') && Array.isArray(d.scopes)
      && Array.isArray(d.tickets) && d.tickets.every(isTicket) && Array.isArray(d.usedKeyIds) && Array.isArray(d.denied)
      && Number.isInteger(d.maxVerUsed) && typeof d.createdAt === 'string'
    if (ok) devices.push(d as DeviceEntry)
    else dropped++
  }
  return { devices, dropped }
}

export function serializeRegistry(devices: readonly DeviceEntry[]): string {
  return JSON.stringify({ v: 1, devices: [...devices] } satisfies RegistryFile, null, 2) + '\n'
}

/** What the portal needs of a device. */
export function toPortalDevice(d: DeviceEntry): PortalDevice {
  return { deviceId: d.deviceId, pubD: d.pubD, state: d.state, maxVerUsed: d.maxVerUsed, scopes: [...d.scopes], tickets: d.tickets.map((t) => ({ ...t })), usedKeyIds: [...d.usedKeyIds] }
}

/** The relay must refuse: every live ticket of a revoked device, and every superseded ticket, until it expires. */
export function denyList(devices: readonly DeviceEntry[], nowS: number): DenyRow[] {
  const out = new Map<string, number>()
  const add = (ticketId: string, exp: number): void => { if (exp + 300 >= nowS) out.set(ticketId, Math.max(exp, out.get(ticketId) ?? 0)) }
  for (const d of devices) {
    if (d.state === 'revoked') for (const t of d.tickets) add(t.ticketId, t.exp)
    for (const t of d.denied) add(t.ticketId, t.exp)
  }
  return [...out].map(([ticketId, exp]) => ({ ticketId, exp }))
}

/** Drops what no longer matters: a revoked device whose tickets all expired, and expired superseded tickets. */
export function pruneRegistry(devices: readonly DeviceEntry[], nowS: number): DeviceEntry[] {
  const out: DeviceEntry[] = []
  for (const d of devices) {
    const denied = d.denied.filter((t) => t.exp + 300 >= nowS)
    if (d.state === 'revoked' && d.tickets.every((t) => t.exp + 300 < nowS)) continue
    out.push(denied.length === d.denied.length ? d : { ...d, denied })
  }
  return out
}

/** A device as status and lists show it: no key, no ticket. */
export interface DeviceView { id: string; name: string; state: DeviceEntry['state']; access: DeviceEntry['access']; createdAt: string; lastSeenAt?: string; revokedAt?: string }

export function deviceView(d: DeviceEntry): DeviceView {
  return {
    id: d.deviceId, name: d.name, state: d.state, access: d.access, createdAt: d.createdAt,
    ...(d.lastSeenAt ? { lastSeenAt: d.lastSeenAt } : {}), ...(d.revokedAt ? { revokedAt: d.revokedAt } : {}),
  }
}

/** The device a CLI argument names: its whole id, or a unique prefix of at least 4 hex digits. */
export function findDevice(devices: readonly DeviceEntry[], arg: unknown): DeviceEntry | 'ambiguous' | undefined {
  if (typeof arg !== 'string') return undefined
  const a = arg.trim().toLowerCase()
  if (!/^[0-9a-f]{4,32}$/.test(a)) return undefined
  const hits = devices.filter((d) => d.deviceId.startsWith(a))
  if (hits.length > 1) return hits.find((d) => d.deviceId === a) ?? 'ambiguous'
  return hits[0]
}

/** The SAS the person typed on the machine: six digits, spaces and hyphens allowed. */
export function digitsOk(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 32 && /^[0-9 -]+$/.test(v) && v.replace(/[ -]/g, '').length === 6
}

export const PAIR_ID_RE = /^[0-9a-f]{32}$/

export interface RemoteConfig { v: 1; on: boolean; relayUrl?: string; houseName: string }

export function parseConfig(text: string | undefined): RemoteConfig {
  const base: RemoteConfig = { v: 1, on: false, houseName: 'tether' }
  if (text === undefined) return base
  try {
    const c = JSON.parse(text) as Partial<RemoteConfig>
    return {
      v: 1, on: c.on === true, houseName: typeof c.houseName === 'string' && c.houseName.trim() ? c.houseName.slice(0, 64) : 'tether',
      ...(typeof c.relayUrl === 'string' ? { relayUrl: c.relayUrl } : {}),
    }
  } catch { return base }
}
