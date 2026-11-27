// What the portal may tell a device, message by message (plano §2 "Segredos", fio-spec 7.2 rule 6). Every body that leaves
// the portal in a RES or an EVT is built here, by the projector of its op or event: an ALLOW list that copies field by
// field from what the portal holds and never spreads an object of the pipe, so a field the pipe adds later (an env, the
// args, the text an agent asks) cannot reach a device. The table is total over the ops and the events (`satisfies` a
// mapped type): an op without a projector does not compile, and an op without a handler has a projector that cannot be
// called (its source is `never`), so it can only answer an error body.
//
// Processes go out with at most what `toEmbedProc` lets through (extensions/processes/embed.ts), and profiles likewise:
// the env by the NAMES of its variables only. The args of either do not go out at all: their mask (src/core/redact-args.ts)
// lives outside this pure module, and a device has no use for them yet. Text is hostile: names are sanitized and capped.
// Pure: no node:*, no DOM; the PWA imports the types of what it receives from here.
import { utf8, type Bytes } from './bytes.ts'
import { PRESENCE, type Presence } from './constants.ts'
import { sanitizeDeclaredName } from './content.ts'
import { knownScopes, type EvtName, type OpName, type ScopeFamily } from './scopes.ts'

// ---- shapes a device receives ------------------------------------------------------------------------------------

export interface SessionInfo {
  house: string
  name: string
  deviceId: string
  ver: number
  presence: Presence
  scopes: ScopeFamily[]
}

export interface AdmitRenewed { ticket: string }

/**
 * The answer of `uv.challenge`: the counter of the one pending challenge of the session and, for an unlock or an
 * elevation, the 32 bytes to sign (base64url). For an act the device computes the challenge itself from the request it
 * is about to send (`assertionChallenge`), because the portal recomputes it from the request it receives.
 */
export interface UvChallenged { uvCtr: number; challenge?: string }

/** The presence of the device after `uv.assert`, `uv.register` or `session.lock`: the HS_DONE byte and the window end (Unix s, 0 = none). */
export interface PresenceState { presence: Presence; elevUntil: number }

export interface AttentionItem {
  /** The slot's id (only ids of the shape `^[\w.:-]{1,64}$` are shown). */
  id: string
  /** The slot's own name, else its kind. Sanitized, at most 64 characters. */
  name: string
  /** The kind of pane: `claude`, `soul`, `codex`, `shell`… */
  kind: string
  /** Since when it waits (ISO), as far as the portal knows. */
  since: string
}

export interface AttentionList { items: AttentionItem[]; more: number }

/** Who registered or started a process, as a device may see it: the kind and the panel's name, never the OS user or session. */
export interface RemoteAuthor { kind: string; name?: string; agent?: string }

/** A process as a device may see it: a subset of `toEmbedProc`'s, without env values and without args. */
export interface RemoteProc {
  name: string
  status: string
  run?: number
  pid?: number
  startedAt?: string
  startedBy?: RemoteAuthor
  exit?: { code?: number; at: string; cause: string }
  reason?: string
  attention?: boolean
  error?: string
  ports?: { port: number; listening: boolean }[]
  memoryMB?: number
  external?: boolean
  card: { command: string; cwd: string; ports: number[]; description?: string; registeredBy?: RemoteAuthor; createdAt: string }
  /** The names of the card's variables; their values never leave the machine. */
  envNames: string[]
}

/** A profile as a device may see it: no args, no per-extension options, the env by names only. */
export interface RemoteProfile {
  id: string
  name: string
  agent: string
  envNames: string[]
  cwd?: string
  shell?: { command: string }
  default?: boolean
}

/** The error codes a body may carry; nothing else of a failure goes out. */
export const ERROR_CODES = ['unknown-op', 'bad-request', 'not-implemented', 'failed', 'refused'] as const
export type ErrorCode = (typeof ERROR_CODES)[number]

// ---- sources (what the portal holds; structural, so the pipe's types fit without being imported) -----------------

export interface SessionInfoSource {
  house: string
  name: string
  deviceId: string
  ver: number
  presence: number
  scopes: readonly unknown[]
}

/** The fields of a slot the attention projection reads; a SlotState of the pipe fits. */
export interface SlotSource { slotId: string; attention?: string; kind?: string; name?: string }

export interface AuthorSource { kind: string; name?: string; agent?: string }

/** The fields of a process the projection reads; a ProcState of the pipe fits. */
export interface ProcSource {
  name: string
  status: string
  run?: number
  pid?: number
  startedAt?: string
  startedBy?: AuthorSource
  exit?: { code?: number; at: string; cause: string }
  reason?: string
  attention?: boolean
  error?: string
  ports?: readonly { port: number; listening: boolean }[]
  memoryMB?: number
  external?: boolean
  card: {
    command: string
    cwd: string
    env?: Readonly<Record<string, string>>
    ports: readonly number[]
    description?: string
    registeredBy?: AuthorSource
    createdAt: string
  }
}

/** The fields of a profile the projection reads; a Profile of the pipe fits. */
export interface ProfileSource {
  id: string
  name: string
  agent: string
  env?: Readonly<Record<string, string>>
  cwd?: string
  shell?: { command: string }
  default?: boolean
}

// ---- field rules ---------------------------------------------------------------------------------------------------

const ID_RE = /^[\w.:-]{1,64}$/
const KIND_RE = /^[a-z][a-z0-9-]{0,31}$/
const HEX32_RE = /^[0-9a-f]{32}$/
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/
const B64URL_RE = /^[A-Za-z0-9_-]{1,4096}$/
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/
/** At most this many items in one attention list: the rest is counted, not sent. */
export const ATTENTION_MAX = 64
const TEXT_MAX = 512
const LIST_MAX = 64

const name64 = (v: unknown): string => (typeof v === 'string' ? sanitizeDeclaredName(v).slice(0, 64) : '')
const text = (v: unknown, max = TEXT_MAX): string | undefined => (typeof v === 'string' ? v.slice(0, max) : undefined)
const int = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : undefined
const iso = (v: unknown): string | undefined => (typeof v === 'string' && ISO_RE.test(v) ? v : undefined)
const presenceOf = (v: number): Presence =>
  v === PRESENCE.unlocked || v === PRESENCE.noCredential || v === PRESENCE.locked ? v : PRESENCE.locked
/** Only the names of the variables; a name with an odd shape is left out rather than sent. */
const envNames = (env: Readonly<Record<string, string>> | undefined): string[] =>
  env && typeof env === 'object' ? Object.keys(env).filter(k => ENV_NAME_RE.test(k)).slice(0, 256) : []

/** Copies the optional fields that are present, so absent stays absent in the JSON. */
function opt<T extends object>(out: T, extra: { [K in keyof T]?: T[K] | undefined }): T {
  for (const k of Object.keys(extra) as (keyof T)[]) if (extra[k] !== undefined) out[k] = extra[k] as T[keyof T]
  return out
}

// ---- projectors ----------------------------------------------------------------------------------------------------

export function sessionInfo(s: SessionInfoSource): SessionInfo {
  return {
    house: text(s.house, 64) ?? '',
    name: name64(s.name),
    deviceId: typeof s.deviceId === 'string' && HEX32_RE.test(s.deviceId) ? s.deviceId : '',
    ver: int(s.ver, 0, 255) ?? 0,
    presence: presenceOf(s.presence),
    scopes: knownScopes(Array.isArray(s.scopes) ? s.scopes : []),
  }
}

export function admitRenewed(s: AdmitRenewed): AdmitRenewed {
  return { ticket: typeof s.ticket === 'string' && B64URL_RE.test(s.ticket) ? s.ticket : '' }
}

const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/

export function uvChallenged(s: UvChallenged): UvChallenged {
  return opt<UvChallenged>({ uvCtr: int(s.uvCtr, 0, 0xffffffff) ?? 0 }, { challenge: typeof s.challenge === 'string' && CHALLENGE_RE.test(s.challenge) ? s.challenge : undefined })
}

export function presenceState(s: { presence: number; elevUntil: number }): PresenceState {
  return { presence: presenceOf(s.presence), elevUntil: int(s.elevUntil) ?? 0 }
}

/** A slot waiting for the person, as an attention item; undefined for a slot that does not wait or has an odd id. */
export function attentionItem(slot: SlotSource, since: string): AttentionItem | undefined {
  if (slot.attention !== 'waiting' || typeof slot.slotId !== 'string' || !ID_RE.test(slot.slotId)) return undefined
  const kind = typeof slot.kind === 'string' && KIND_RE.test(slot.kind) ? slot.kind : 'agent'
  return { id: slot.slotId, name: name64(slot.name) || kind, kind, since: iso(since) ?? '' }
}

export function attentionList(s: AttentionList): AttentionList {
  const items: AttentionItem[] = []
  for (const i of Array.isArray(s.items) ? s.items : []) {
    if (items.length >= ATTENTION_MAX) break
    if (typeof i?.id !== 'string' || !ID_RE.test(i.id)) continue
    const kind = typeof i.kind === 'string' && KIND_RE.test(i.kind) ? i.kind : 'agent'
    items.push({ id: i.id, name: name64(i.name) || kind, kind, since: iso(i.since) ?? '' })
  }
  return { items, more: int(s.more) ?? 0 }
}

function author(a: AuthorSource | undefined): RemoteAuthor | undefined {
  if (!a || typeof a.kind !== 'string' || !KIND_RE.test(a.kind)) return undefined
  return opt<RemoteAuthor>({ kind: a.kind }, { name: name64(a.name) || undefined, agent: typeof a.agent === 'string' && KIND_RE.test(a.agent) ? a.agent : undefined })
}

export function remoteProc(p: ProcSource): RemoteProc {
  const c = p.card
  const card = opt<RemoteProc['card']>(
    {
      command: text(c?.command) ?? '',
      cwd: text(c?.cwd) ?? '',
      ports: (Array.isArray(c?.ports) ? c.ports : []).map(n => int(n, 1, 65_535)).filter((n): n is number => n !== undefined).slice(0, LIST_MAX),
      createdAt: iso(c?.createdAt) ?? '',
    },
    { description: text(c?.description), registeredBy: author(c?.registeredBy) },
  )
  const exit = p.exit && typeof p.exit === 'object'
    ? opt<NonNullable<RemoteProc['exit']>>({ at: iso(p.exit.at) ?? '', cause: text(p.exit.cause, 32) ?? '' }, { code: int(p.exit.code, -0x8000_0000, 0xffff_ffff) })
    : undefined
  const ports = Array.isArray(p.ports)
    ? p.ports.slice(0, LIST_MAX).flatMap(x => { const port = int(x?.port, 1, 65_535); return port === undefined ? [] : [{ port, listening: x.listening === true }] })
    : undefined
  return opt<RemoteProc>(
    { name: name64(p.name), status: text(p.status, 32) ?? '', card, envNames: envNames(c?.env) },
    {
      run: int(p.run), pid: int(p.pid), startedAt: iso(p.startedAt), startedBy: author(p.startedBy), exit, reason: text(p.reason),
      attention: p.attention === true ? true : undefined, error: text(p.error), ports,
      memoryMB: typeof p.memoryMB === 'number' && Number.isFinite(p.memoryMB) && p.memoryMB >= 0 ? p.memoryMB : undefined,
      external: p.external === true ? true : undefined,
    },
  )
}

export function remoteProfile(p: ProfileSource): RemoteProfile {
  return opt<RemoteProfile>(
    { id: text(p.id, 64) ?? '', name: name64(p.name), agent: typeof p.agent === 'string' && KIND_RE.test(p.agent) ? p.agent : '', envNames: envNames(p.env) },
    {
      cwd: text(p.cwd),
      shell: p.shell && typeof p.shell.command === 'string' ? { command: text(p.shell.command) ?? '' } : undefined,
      default: p.default === true ? true : undefined,
    },
  )
}

const empty = (_: Record<string, never>): Record<string, never> => ({})
/** The projector of an op that has no handler yet: its source is `never`, so no result of it can be built. */
const unbuilt = (src: never): never => src

/** The body of each op's result. Total over the ops: a new op without a projector does not compile. */
export const RESULTS = {
  'session.info': sessionInfo,
  'admit.renew': admitRenewed,
  'uv.challenge': uvChallenged,
  'uv.assert': presenceState,
  'uv.register': presenceState,
  'device.revoke-self': empty,
  'session.lock': presenceState,
  'house.key-rotate.ack': unbuilt,
  'attention.list': attentionList,
  'attention.watch': attentionList,
  'channels.marks': unbuilt,
  'regency.tree': unbuilt,
  'device.list': unbuilt,
  'device.revoke': empty,
} as const satisfies { readonly [K in OpName]: (src: never) => unknown }

/** The body of each event. Total over the events. */
export const EVENTS = {
  'attention.changed': attentionList,
} as const satisfies { readonly [K in EvtName]: (src: never) => unknown }

export type ResultSource<K extends OpName> = Parameters<(typeof RESULTS)[K]>[0]
export type EventSource<K extends EvtName> = Parameters<(typeof EVENTS)[K]>[0]

const encode = (v: unknown): Bytes => utf8(JSON.stringify(v))

/** The plaintext body of a successful RES for `op`, through its projector. */
export function resultBody<K extends OpName>(op: K, src: ResultSource<K>): Bytes {
  return encode((RESULTS[op] as (s: ResultSource<K>) => unknown)(src))
}

/** The plaintext body of an EVT, through its projector. */
export function eventBody<K extends EvtName>(evt: K, src: EventSource<K>): Bytes {
  return encode((EVENTS[evt] as (s: EventSource<K>) => unknown)(src))
}

/** The body of a refusal or failure: only a known code, else `failed`. */
export function errorBody(code: ErrorCode): Bytes {
  return encode({ error: (ERROR_CODES as readonly string[]).includes(code) ? code : 'failed' })
}

/** The body of an answer that carries nothing (a refusal by status alone). */
export const emptyBody = (): Bytes => encode({})
