// The remote extension's pure rules: who may ask what (E-7, A-2), the registry of devices (<home>/remote/devices.json) and
// its transitions, the deny list it implies, and the projections that leave the extension. No I/O.
import { LIVE_DOING, usableCredential, type CredentialRow, type DenyRow, type LiveDevice, type PortalDevice, type TicketRow } from '../../src/remoted/ipc.ts'

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
  /** Ends a device's live sessions without revoking it: it lowers power, like revoke. */
  'session.end': 'any',
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
  /** The presence credential (WebAuthn), registered once, in the pairing session. Absent: the device only reads. */
  credential?: CredentialRow
  registeredAt?: string
}

export interface RegistryFile { v: 1; devices: DeviceEntry[] }

/** At most this many devices that are not revoked; a pairing beyond it is refused. */
export const DEVICES_MAX = 32

const HEX = (n: number): RegExp => new RegExp(`^[0-9a-f]{${n}}$`)
const isTicket = (t: unknown): t is TicketRow => {
  const x = t as TicketRow
  return typeof x === 'object' && x !== null && HEX(32).test(x.ticketId) && Number.isInteger(x.exp) && HEX(16).test(x.keyId)
}

/** A credential row: base64url id within the WebAuthn cap, an uncompressed P-256 point, a u32 counter, a boolean. */
export function isCredential(c: unknown): c is CredentialRow {
  const x = c as CredentialRow
  return typeof x === 'object' && x !== null && typeof x.credentialId === 'string' && /^[A-Za-z0-9_-]{2,1364}$/.test(x.credentialId)
    && /^04[0-9a-f]{128}$/.test(String(x.publicKey)) && Number.isInteger(x.signCount) && x.signCount >= 0 && x.signCount <= 0xffffffff
    && typeof x.backupEligible === 'boolean'
    // The relying party it was registered with: both or neither (a row written before they were kept serves under none).
    && (x.rpId === undefined && x.origin === undefined
      || typeof x.rpId === 'string' && /^[a-z0-9.-]{1,253}$/.test(x.rpId) && typeof x.origin === 'string' && /^https?:\/\/[a-z0-9.-]{1,253}(:\d{1,5})?$/.test(x.origin))
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
      && (d.credential === undefined || isCredential(d.credential))
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
  return {
    deviceId: d.deviceId, pubD: d.pubD, state: d.state, maxVerUsed: d.maxVerUsed, scopes: [...d.scopes], tickets: d.tickets.map((t) => ({ ...t })),
    usedKeyIds: [...d.usedKeyIds], denied: d.denied.map((t) => ({ ...t })), ...(d.credential ? { credential: { ...d.credential } } : {}),
  }
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

/**
 * A renewal written to the registry (the portal already checked its rhythm): the live tickets become denied, the new one is
 * the only live ticket. Bounded twice, so devices.json never grows because of one device: expired denied tickets go, and a
 * renewal that would leave more than `deniedMax` alive is refused; the past keys keep the newest `keyIdsMax`.
 */
export function renewDevice(d: DeviceEntry, ticket: TicketRow, nowS: number, deniedMax: number, keyIdsMax: number): void {
  if (d.usedKeyIds.includes(ticket.keyId)) throw new Error('admission key already used')
  const denied = [...d.denied, ...d.tickets.map((t) => ({ ticketId: t.ticketId, exp: t.exp }))].filter((t) => t.exp + 300 >= nowS)
  if (denied.length > deniedMax) throw new Error('too many superseded tickets')
  d.denied = denied
  d.tickets = [ticket]
  d.usedKeyIds = [...d.usedKeyIds, ticket.keyId].slice(-keyIdsMax)
}

/**
 * A device as status and lists show it: no key, no ticket, no credential. `biometrics`: it registered a presence credential
 * that serves under `rp`, the remote's current origin (it can unlock and act); without one it only reads.
 */
export interface DeviceView {
  id: string; name: string; state: DeviceEntry['state']; access: DeviceEntry['access']; biometrics: boolean; createdAt: string
  lastSeenAt?: string; revokedAt?: string
}

export function deviceView(d: DeviceEntry, rp?: { origin: string; rpId: string }): DeviceView {
  return {
    id: d.deviceId, name: d.name, state: d.state, access: d.access, biometrics: usableCredential(d.credential, rp) !== undefined, createdAt: d.createdAt,
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

// ---- the app's screen (RR2.2): pure words and states of the devices, the state icon and the pairing ---------------------
// Everything here is a projection of what the daemon answers (`remote.status`, `pair.begin`, `pair.state`, `pair.sas`): the
// screen decides nothing the daemon or the portal already decides. Time is an input (`now`, ms), never read here.

/** What `remote.status` answers (the daemon's #status), as the screen reads it. */
export interface RemoteStatusInput {
  on: boolean
  relay?: string
  portal: { state: 'off' | 'starting' | 'up' | 'refused' | 'down'; reason?: string }
  link: 'up' | 'down'
  /** Live sessions in the portal, all devices together. */
  sessions: number
  fingerprint?: string
  devices: readonly DeviceView[]
  /** The devices live now (src/remoted/ipc.ts LiveDevice): since when, and one word of what they do. Absent = none. */
  live?: readonly { deviceId: string; since: string; doing?: string }[]
  /** The address of the phone's app, when configured: the QR carries it. */
  webUrl?: string
}

/**
 * The live devices as the extension passes them on: a hex id, an ISO instant and a word of LIVE_DOING, nothing else.
 * Whatever else came from the portal is dropped, never forwarded.
 */
export function sanitizeLive(raw: unknown): LiveDevice[] {
  if (!Array.isArray(raw)) return []
  const out: LiveDevice[] = []
  for (const x of raw.slice(0, DEVICES_MAX) as Partial<LiveDevice>[]) {
    if (!x || !HEX(32).test(String(x.deviceId)) || typeof x.since !== 'string' || Number.isNaN(Date.parse(x.since))) continue
    const doing = (LIVE_DOING as readonly string[]).includes(String(x.doing)) ? x.doing : undefined
    out.push({ deviceId: x.deviceId!, since: new Date(Date.parse(x.since)).toISOString(), ...(doing ? { doing } : {}) })
  }
  return out
}

/** The closed vocabulary of `doing` (src/remoted/ipc.ts LIVE_DOING) in the person's words; an unknown word says nothing. */
export const DOING_WORDS: Readonly<Record<string, string>> = {
  watching: 'acompanhando quem espera você',
}

/** The pairing ticket as the screen that asked sees it (src/remoted/ipc.ts PairView/PairBegun, structurally). */
export interface PairViewInput {
  pairId: string
  state: 'open' | 'revealed' | 'waiting-sas' | 'confirmed' | 'done' | 'burned'
  /** Unix ms. */
  expiresAt: number
  device?: { declaredName: string; caps: number; access: 'code' | 'qr' }
  triesLeft?: number
  burnReason?: string
  code?: string
  qr?: string
  fingerprint?: string
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** A span in words: "menos de 1 min", "5 min", "2 h", "3 d". */
export function spanWords(ms: number): string {
  const min = Math.round(Math.max(0, ms) / 60_000)
  if (min < 1) return 'menos de 1 min'
  if (min < 60) return `${min} min`
  if (min < 24 * 60) return `${Math.round(min / 60)} h`
  return `${Math.round(min / 1440)} d`
}

const ago = (iso: string | undefined, now: number): string | undefined => {
  const t = iso === undefined ? NaN : Date.parse(iso)
  return Number.isNaN(t) ? undefined : `há ${spanWords(now - t)}`
}

/** The state icon of the top bar: off, on with nobody, N devices connected; trouble when on and not reaching the relay. */
export interface RemoteIcon {
  kind: 'unknown' | 'off' | 'idle' | 'live' | 'trouble'
  /** The core's colour state of a status icon. */
  state: 'idle' | 'normal' | 'busy' | 'warn' | 'error'
  badge?: number
  /** The tooltip: the state in one sentence. */
  title: string
}

/** How many DEVICES are connected now (a device with three sessions is one). */
export function liveCount(s: RemoteStatusInput): number {
  if (!s.on) return 0
  return new Set((s.live ?? []).map(l => l.deviceId)).size
}

export function remoteIcon(s: RemoteStatusInput | undefined): RemoteIcon {
  if (!s) return { kind: 'unknown', state: 'idle', title: 'Acesso remoto: sem notícia do tether agora' }
  if (!s.on) return { kind: 'off', state: 'idle', title: 'Acesso remoto desligado: nenhum aparelho alcança este tether' }
  if (s.portal.state === 'refused') return { kind: 'trouble', state: 'error', title: `Acesso remoto ligado, mas recusado: ${s.portal.reason ?? 'o portal não sobe'}` }
  if (s.portal.state !== 'up' || s.link !== 'up') return { kind: 'trouble', state: 'warn', title: 'Acesso remoto ligado, mas sem conexão agora: os aparelhos não alcançam este tether' }
  const n = liveCount(s)
  if (n === 0) return { kind: 'idle', state: 'normal', title: 'Acesso remoto ligado: nenhum aparelho conectado agora' }
  return { kind: 'live', state: 'busy', badge: n, title: `Acesso remoto ligado: ${plural(n, 'aparelho conectado', 'aparelhos conectados')} agora` }
}

/** What a paired device may do (the scopes of fio-spec 7), in the person's words, in the order the screen lists them. */
export const SCOPE_WORDS: Readonly<Record<string, string>> = {
  'attention': 'ver quem espera você',
  'channels': 'ler e falar nos canais',
  'regency:read': 'ver as mesas e as guias',
  'manage:agents': 'criar, hibernar e despertar agentes',
  'manage:desks': 'criar e arrumar mesas',
  'manage:procs': 'iniciar e parar processos',
  'manage:destructive': 'fechar e apagar',
  'peek:terminal:read': 'ver os terminais',
  'peek:terminal:write': 'digitar nos terminais',
  'peek:browser': 'ver o navegador',
}
/** The scopes a pairing grants (the portal's DEFAULT_SCOPES; a unit test keeps them equal). */
export const PAIR_SCOPES: readonly string[] = Object.keys(SCOPE_WORDS)

export function scopeWords(scopes: readonly string[]): string[] {
  return scopes.map(s => SCOPE_WORDS[s] ?? s)
}

/** One paired device as the list draws it. */
export interface DeviceRow {
  id: string
  /** Declared by the device (sanitized by the portal): shown as such, never as an identity. */
  name: string
  nameTip: string
  state: 'pending' | 'active'
  stateText: string
  live: boolean
  /** "Ligado agora há 5 min · acompanhando quem espera você" / "Desligado". */
  liveText: string
  lastText: string
  pairedText: string
  can: { end: boolean; revoke: boolean }
}

export interface DevicesModel {
  on: boolean
  /** The head's sentence: "Ligada · relay x · 2 aparelhos conectados". */
  headText: string
  headIntent: 'ok' | 'warn' | 'bad' | 'off'
  fingerprint?: string
  rows: DeviceRow[]
  revoked: number
  can: { on: boolean; off: boolean; pair: boolean }
  /** Why "Parear um aparelho" is off, when it is. */
  pairWhy?: string
  empty?: string
}

export function devicesModel(s: RemoteStatusInput | undefined, now: number): DevicesModel {
  if (!s) {
    return { on: false, headText: 'Sem notícia do tether agora', headIntent: 'off', rows: [], revoked: 0, can: { on: false, off: false, pair: false }, pairWhy: 'O tether não respondeu', empty: 'Sem notícia do tether agora.' }
  }
  const icon = remoteIcon(s)
  const liveOf = (id: string): { since: string; doing?: string }[] => (s.live ?? []).filter(l => l.deviceId === id)
  const kept = s.devices.filter(d => d.state !== 'revoked')
  const rows = kept.map((d): DeviceRow => {
    const ls = s.on ? liveOf(d.id) : []
    const live = ls.length > 0
    const sinceMs = Math.min(...ls.map(l => Date.parse(l.since)).filter(t => !Number.isNaN(t)))
    const doing = [...new Set(ls.map(l => DOING_WORDS[l.doing ?? '']).filter((x): x is string => x !== undefined))]
    const liveText = !s.on ? 'Desligado: a remota está desligada'
      : live ? `Ligado agora${Number.isFinite(sinceMs) ? ` há ${spanWords(now - sinceMs)}` : ''}${doing.length ? ` · ${doing.join(', ')}` : ''}` : 'Desligado'
    const last = ago(d.lastSeenAt, now)
    return {
      id: d.id, name: d.name || 'Aparelho sem nome', nameTip: `Nome que o aparelho declarou: ${d.name || '(nenhum)'}`,
      state: d.state === 'pending' ? 'pending' : 'active',
      stateText: d.state === 'pending' ? 'Concluindo o pareamento' : 'Pareado',
      live, liveText,
      lastText: last ? `último uso ${last}` : 'nunca usado',
      pairedText: `pareado ${ago(d.createdAt, now) ?? ''} pelo ${d.access === 'qr' ? 'QR' : 'código'}`.replace('  ', ' '),
      can: { end: live, revoke: true },
    }
  }).sort((a, b) => Number(b.live) - Number(a.live) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.id < b.id ? -1 : 1))
  const n = liveCount(s)
  const headText = !s.on ? 'Desligada: nenhum aparelho alcança este tether'
    : icon.kind === 'trouble' ? (s.portal.state === 'refused' ? `Ligada, mas recusada: ${s.portal.reason ?? 'o portal não sobe'}` : 'Ligada, mas sem conexão agora')
      : `Ligada${s.relay ? ` pelo relay ${s.relay}` : ''} · ${n === 0 ? 'nenhum aparelho conectado' : plural(n, 'aparelho conectado', 'aparelhos conectados')}`
  const pairWhy = !s.on ? 'Ligue a remota para parear' : icon.kind === 'trouble' ? 'Sem conexão com o relay agora' : undefined
  return {
    on: s.on, headText, headIntent: !s.on ? 'off' : icon.kind === 'trouble' ? (icon.state === 'error' ? 'bad' : 'warn') : 'ok',
    ...(s.fingerprint ? { fingerprint: s.fingerprint } : {}),
    rows, revoked: s.devices.length - kept.length,
    can: { on: !s.on, off: s.on, pair: pairWhy === undefined },
    ...(pairWhy ? { pairWhy } : {}),
    ...(rows.length === 0 ? { empty: 'Nenhum aparelho pareado.' } : {}),
  }
}

/** The six digits typed so far: digits only (spaces and hyphens dropped), at most six. */
export function sasDigits(raw: string): { digits: string; complete: boolean } {
  const digits = raw.replace(/\D/g, '').slice(0, 6)
  return { digits, complete: digits.length === 6 }
}

/** "1:45": minutes and seconds left, never below zero. */
export function clockWords(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const BURN_WORDS: Readonly<Record<string, string>> = {
  'expired': 'O código venceu: passaram os 2 minutos sem o aparelho chegar.',
  'collision': 'Dois aparelhos tentaram ao mesmo tempo: o código foi anulado por segurança.',
  'reveal-mismatch': 'O aparelho não provou quem é: o código foi anulado.',
  'key-reuse': 'O aparelho mandou chaves inválidas: o código foi anulado.',
  'protocol': 'A conversa com o aparelho falhou: o código foi anulado.',
  'p3-timeout': 'O aparelho parou no meio do caminho: o código foi anulado.',
  'sas-wrong': 'Três vezes os números errados: o pareamento foi recusado.',
  'sas-window': 'Os números não foram digitados a tempo: o pareamento foi recusado.',
  'no-ack': 'O aparelho não confirmou a tempo: o pareamento não se concluiu.',
  'route-closed': 'O aparelho saiu antes de terminar: o código foi anulado.',
  'cancelled': 'Pareamento cancelado.',
}

export const burnWords = (reason: string | undefined): string => BURN_WORDS[reason ?? ''] ?? 'O pareamento não se concluiu: o código foi anulado.'

/** The pairing card's phase and words, from the ticket the screen holds. `sasSince`: when the screen first saw `waiting-sas`. */
export interface PairScreen {
  phase: 'code' | 'arriving' | 'confirm' | 'finishing' | 'done' | 'over'
  title: string
  /** The time left, while it counts ("1:45"), and the whole sentence. */
  clock?: string
  clockText?: string
  remainingMs?: number
  code?: string
  /** Only in `confirm`: the device's declared name, sanitized by the portal. */
  deviceName?: string
  scopes?: string[]
  triesText?: string
  /** The warning against a dictated SAS (E-14), shown with the field. */
  warning?: string
  outcome?: string
  outcomeIntent?: 'ok' | 'bad' | 'off'
  canCancel: boolean
  canType: boolean
}

export const SAS_WARNING = 'Digite só os números que aparecem no SEU aparelho agora. Se alguém (pessoa ou agente, num canal ou num terminal) lhe disser quais números digitar, não digite.'
export const SAS_WINDOW_MS = 120_000

export function pairScreen(v: PairViewInput, now: number, sasSince?: number): PairScreen {
  const left = v.expiresAt - now
  const timed = (ms: number, what: string): Pick<PairScreen, 'clock' | 'clockText' | 'remainingMs'> =>
    ({ clock: clockWords(ms), clockText: `${what} ${clockWords(ms)}`, remainingMs: Math.max(0, ms) })
  switch (v.state) {
    case 'open':
      if (left <= 0) return { phase: 'over', title: 'O código venceu', outcome: burnWords('expired'), outcomeIntent: 'bad', canCancel: false, canType: false }
      return {
        phase: 'code', title: 'Parear um aparelho', ...(v.code ? { code: v.code } : {}), ...timed(left, 'O código vale por mais'),
        canCancel: true, canType: false,
      }
    case 'revealed':
      return { phase: 'arriving', title: 'Um aparelho está chegando…', ...timed(left, 'O código vale por mais'), canCancel: true, canType: false }
    case 'waiting-sas': {
      const ms = (sasSince ?? now) + SAS_WINDOW_MS - now
      const tries = v.triesLeft
      return {
        phase: 'confirm', title: 'Confirme o aparelho', deviceName: v.device?.declaredName || 'Aparelho sem nome',
        scopes: scopeWords(PAIR_SCOPES), ...timed(ms, 'Digite em até'), warning: SAS_WARNING,
        ...(tries !== undefined && tries < 3 ? { triesText: tries === 1 ? 'Números errados: resta 1 tentativa.' : `Números errados: restam ${tries} tentativas.` } : {}),
        canCancel: true, canType: ms > 0,
      }
    }
    case 'confirmed':
      return { phase: 'finishing', title: 'Números certos', outcome: 'Concluindo o pareamento com o aparelho…', outcomeIntent: 'ok', canCancel: false, canType: false }
    case 'done':
      return { phase: 'done', title: 'Aparelho pareado', outcome: `${v.device?.declaredName || 'O aparelho'} já alcança este tether. Você pode revogá-lo a qualquer momento.`, outcomeIntent: 'ok', canCancel: false, canType: false }
    case 'burned':
      return { phase: 'over', title: v.burnReason === 'cancelled' ? 'Pareamento cancelado' : 'Pareamento recusado', outcome: burnWords(v.burnReason), outcomeIntent: v.burnReason === 'cancelled' ? 'off' : 'bad', canCancel: false, canType: false }
  }
}

/** The pairing link the QR carries: the PWA's address with the fragment, or the fragment alone while no address is known. */
export function qrPayload(qr: string, webUrl?: string): string {
  if (!webUrl) return qr
  return `${webUrl.replace(/#.*$/, '').replace(/\/?$/, '/')}${qr}`
}

/** "123 456 789 012" in three-digit groups (the portal already spaces it; a raw one is grouped here). */
export function codeGroups(code: string): string[] {
  const d = code.replace(/\D/g, '')
  const out: string[] = []
  for (let i = 0; i < d.length; i += 3) out.push(d.slice(i, i + 3))
  return out
}

/** The confirmation of a destructive act, in the house's words: the sentence, the button and what it does. */
export function confirmOf(act: 'off' | 'revoke' | 'end', name?: string): { sentence: string; go: string; hint: string } {
  switch (act) {
    case 'off': return { sentence: 'Desligar a remota? Todos os aparelhos perdem a conexão agora; os pareamentos continuam.', go: 'Desligar a remota', hint: 'Derruba todas as sessões e para o portal' }
    case 'revoke': return { sentence: `Revogar ${name ?? 'este aparelho'}? Ele perde a conexão agora e não volta mais; para usá-lo de novo, pareie outra vez.`, go: 'Revogar aparelho', hint: 'Derruba as sessões dele e recusa as próximas' }
    case 'end': return { sentence: `Encerrar a sessão de ${name ?? 'este aparelho'}? Ele cai agora e pode se conectar de novo.`, go: 'Encerrar sessão', hint: 'Derruba a conexão sem revogar o aparelho' }
  }
}

/**
 * The address of the phone's app the QR carries (B-8's rule for the relay, for pages): `https://`, or `http://` only for
 * `localhost`; no user nor password; no fragment (the QR's `#pair=` goes there).
 */
export function webUrlAllowed(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > 512) return false
  let u: URL
  try { u = new URL(url) } catch { return false }
  if (u.username !== '' || u.password !== '' || u.hash !== '') return false
  return u.protocol === 'https:' || (u.protocol === 'http:' && u.hostname === 'localhost')
}

/** The line above the code: with the app's address the QR opens it; without it, the code has to be typed. */
export function qrStepWords(webUrl: string | undefined): string {
  return webUrl
    ? 'No aparelho, aponte a câmera para o QR (ele abre o tether remoto), ou abra o tether remoto e digite o código:'
    : 'Este tether ainda não sabe o endereço do app do celular, então o QR não abre o app sozinho. No aparelho, abra o tether remoto e digite o código:'
}

export interface RemoteConfig { v: 1; on: boolean; relayUrl?: string; webUrl?: string; houseName: string }

export function parseConfig(text: string | undefined): RemoteConfig {
  const base: RemoteConfig = { v: 1, on: false, houseName: 'tether' }
  if (text === undefined) return base
  try {
    const c = JSON.parse(text) as Partial<RemoteConfig>
    return {
      v: 1, on: c.on === true, houseName: typeof c.houseName === 'string' && c.houseName.trim() ? c.houseName.slice(0, 64) : 'tether',
      ...(typeof c.relayUrl === 'string' ? { relayUrl: c.relayUrl } : {}),
      ...(webUrlAllowed(c.webUrl) ? { webUrl: c.webUrl } : {}),
    }
  } catch { return base }
}
