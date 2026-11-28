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
import { appActAnswer, APP_ACT_ERROR_CODES, type AppActAnswer } from './app-acts.ts'
import { ENV_MAX, PROC_NEW_ERROR_CODES } from './procs-new.ts'
import { CREATE_ERROR_CODES, createOptionsView, createSlotAnswer, type CreateOptions, type CreateSlotAnswer } from './create.ts'
import { b64url, utf8, type Bytes } from './bytes.ts'
import { PRESENCE, type Presence } from './constants.ts'
import { sanitizeDeclaredName } from './content.ts'
import { knownScopes, type EvtName, type OpName, type ScopeFamily } from './scopes.ts'
import { noticeTag, PUSH_BODIES, PUSH_TITLE, type PushKind, type PushNotice } from './webpush.ts'

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
  /** The uses declared on it (RR5 5.2): who, until when, what for. */
  uses?: RemoteUse[]
}

/** A declared use of a process, as the app's "in use" board shows it: who, until when, what for. */
export interface RemoteUse { by: RemoteAuthor; until: string; purpose: string }

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

/**
 * The refusals of a channel's write (step 4.2a), by the codes tetherd's rules use (src/remote/talk.ts TALK_REFUSALS gives
 * each its status), and the portal's own: `timeout` (tetherd did not answer in time: the act may or may not have happened;
 * the same actId later gets the real answer), `busy` (the writes in flight are at their ceiling: nothing was sent).
 */
export const TALK_ERROR_CODES = [
  'unknown-channel', 'unknown-line', 'unknown-poll', 'slow-down', 'bad-reaction', 'bad-option', 'too-long', 'closed', 'too-old',
  'not-a-message', 'poll-closed', 'not-called', 'vote-first', 'limit', 'nobody-called', 'timeout', 'busy',
  // The files of a speech (step 4.3): a secret's name, more files than a speech carries, the files of a speech that are not
  // whole at the portal, a copy into the channel's folder that failed.
  'secret-file', 'too-many', 'unknown-file', 'copy-failed',
  // Managing a channel (RR5, fio-spec 18; src/remote/talk.ts TALK_REFUSALS).
  'unknown-agent', 'name-taken', 'bad-name', 'exists', 'desk', 'not-closed', 'not-member',
] as const
/**
 * The refusals of a management act (RR5 5.2), by tetherd's own error codes (src/daemon/protocol.ts ErrorCode): an id that
 * names nothing (`unknown-slot`, `unknown-proc`, status 0x06), and what tetherd refused to do and why, by its code alone
 * (src/remote/manage.ts ACT_REFUSALS gives each its status). Never tetherd's message: it carries agents' text and paths.
 */
const MANAGE_ERROR_CODES_LIST = [
  'unknown-slot', 'unknown-proc', 'proc-in-use', 'proc-running', 'proc-not-stopped', 'port-busy', 'proc-host', 'unconfirmed',
  'ronda-unavailable', 'session-missing', 'cwd-missing', 'already-open', 'spawn-failed', 'agent-unavailable',
] as const
export const MANAGE_ERROR_CODES = MANAGE_ERROR_CODES_LIST
/** The error codes a body may carry; nothing else of a failure goes out. `too-large`: a read whose body passes READ_BODY_MAX. */
export const ERROR_CODES = [
  'unknown-op', 'bad-request', 'not-implemented', 'failed', 'refused', 'too-large', ...TALK_ERROR_CODES,
  // Web Push (step 4.4): the subscription's endpoint is not of a push service the portal posts to (M-11).
  'push-service',
  ...MANAGE_ERROR_CODES_LIST,
  // The gestures the app does (RR5 5.1, src/remote/app-acts.ts APP_ACT_REFUSALS gives each its status).
  ...APP_ACT_ERROR_CODES,
  // "+ Novo" from afar (RR5 5.3, src/remote/create.ts).
  ...CREATE_ERROR_CODES,
  // "Novo processo" from afar (RR5 5.5, src/remote/procs-new.ts).
  ...PROC_NEW_ERROR_CODES,
] as const
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
  uses?: readonly { by: AuthorSource; until: string; purpose: string }[]
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
      uses: Array.isArray(p.uses) ? remoteUses(p.uses) : undefined,
    },
  )
}

/** Uses of a process, each one line: who (an author), until when (ISO), what for (folded, at most 200 as tetherd keeps it). */
export function remoteUses(uses: readonly unknown[]): RemoteUse[] {
  return uses.slice(0, LIST_MAX).flatMap((u0): RemoteUse[] => {
    const u = (u0 && typeof u0 === 'object' ? u0 : {}) as { by?: AuthorSource; until?: unknown; purpose?: unknown }
    const by = author(u.by)
    const until = iso(u.until)
    return by && until ? [{ by, until, purpose: typeof u.purpose === 'string' ? sanitizeDeclaredName(u.purpose).slice(0, 200) : '' }] : []
  })
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

// ---- the reads of an extension (step 3.4a): channels.marks, channels.page, regency.tree ---------------------------
// Their sources are the answers of tetherd's own requests (src/remoted/gate.ts EXT_READS), unknown JSON as far as the
// portal can tell: every projector below reads them defensively and copies field by field. A field the daemon adds later
// does not go. Hostile text: one-line fields are sanitized like a declared name, a line's body keeps its line breaks and
// loses the other controls, everything is capped.

/** The most bytes of any read's body (the record carries MAX_RECORD_CONTENT, 255 KiB; this leaves room). Over it: `too-large`. */
export const READ_BODY_MAX = 224 * 1024
/** Rows of channels.marks; the rest is counted in `more`. */
export const MARKS_MAX = 256
/** Bytes of one channels.marks' JSON, under READ_BODY_MAX: past it the rows that do not call the person go to `more` first. */
export const MARKS_BYTES_MAX = 192 * 1024
/** Lines of one channels.page (the default and the ceiling of `limit`). */
export const PAGE_LINES_MAX = 50
/** Bytes of one channels.page's JSON: over it, the oldest lines go and the cursor follows the oldest one kept. */
export const PAGE_BYTES_MAX = 128 * 1024
/** Characters of a line's body; longer, it is cut and says so (`cut`). */
export const LINE_BODY_MAX = 4000
/** Channel ids in one channels.changed; more, and the notice says `all`. */
export const CHANGED_IDS_MAX = 32
/** Member ids of one row of channels.marks; the rest is counted in the row's `membersMore`. */
export const MARK_MEMBERS_MAX = 32
/** Member ids of all the rows of one channels.marks together (its bytes stay well under READ_BODY_MAX); past it, rows count only. */
export const MARKS_MEMBER_IDS_MAX = 1024
/** Members of one channels.page; the rest is counted in `membersMore`. */
export const PAGE_MEMBERS_MAX = 64
/** Seal lines of one pane of the tree, and the characters of each (extensions/regency/publish-rules.ts keeps the same). */
export const SEAL_LINES_MAX = 3
export const SEAL_LINE_MAX = 160

const SIG_RE = /^[0-9a-f]{16}$/
const MIME_RE = /^[\w.+-]{1,64}\/[\w.+-]{1,64}$/
const CTRL_RE = /[\p{Cc}\p{Cf}\s]/u
const BODY_CTRL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g
/** Bidi marks, embeddings, overrides and isolates, and the zero-width characters (RR3 gate O-3, Trojan Source). */
const FORMAT_RE = /[؜​‌‎‏‪-‮⁠-⁤⁦-⁩﻿]/g
/** A zero-width joiner that does not join two emoji: an emoji sequence (👩‍💻) keeps its joiner, a word loses it. */
const LONE_ZWJ_RE = /(?<![\p{Extended_Pictographic}\p{Emoji_Modifier}️])‍|‍(?!\p{Extended_Pictographic})/gu
/** Text of many lines (a line's body, an emoji): no controls but the line breaks, no bidi, no zero-width but an emoji's joiner. */
export const multiline = (s: string): string => s.replace(BODY_CTRL_RE, '').replace(FORMAT_RE, '').replace(LONE_ZWJ_RE, '')
const ROLES = ['owner', 'member', 'moderator', 'system'] as const
const LINE_EVENTS = ['create', 'join', 'leave', 'remove', 'mute', 'unmute', 'close', 'reopen', 'owner-ended', 'owner-changed', 'poll-close'] as const
const FIRST_WHY = ['to-you', 'reaction-asks', 'poll-owed'] as const
const POLL_BY = ['all-voted', 'timeout', 'author', 'channel-closed'] as const
const MISSING_WHY = ['no-answer', 'stopped', 'asleep', 'with-user', 'left'] as const

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const arr = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : [])
const oneOf = <T extends string>(v: unknown, set: readonly T[]): T | undefined => ((set as readonly unknown[]).includes(v) ? (v as T) : undefined)
/** One line of hostile text (a name, a title): controls and format characters out, whitespace folded, capped. */
const line = (v: unknown, max: number): string => (typeof v === 'string' ? sanitizeDeclaredName(v).slice(0, max) : '')
/** An id of the tree or of a channel: as given, when it is a short string without controls or spaces; else ''. */
const idOf = (v: unknown, max = 128): string => (typeof v === 'string' && v.length <= max && !CTRL_RE.test(v) ? v : '')
/** Who spoke or voted: the person, the tether, or an agent's id. */
const whoOf = (v: unknown): string => (v === 'user' || v === 'tether' ? v : typeof v === 'string' && ID_RE.test(v) ? v : '')
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

// ---- the machine's paths in a label (RR3 gate B-4)
// A pane's title is often its session's folder, a browser tab's a `file:` address: the user's home (with the login) is
// `~`, a `file:` address its last segment. Without the person's home, any shape of a home folder counts as one: a
// drive's `Users\<login>` (any slash, any case) and a `/Users/<login>` or `/home/<login>` that begins a path. Losing a
// label's word next to a path is the price; the login never goes.
const FILE_URL_RE = /\bfile:\/\/[^\s"'<>]*/gi
const WIN_HOME_RE = /\b[A-Za-z]:[\\/]+users[\\/]+[^\\/]+/gi
// The drive reached from a POSIX shell: Git Bash/MSYS `/c/Users/<login>`, WSL `/mnt/c/Users/<login>`; macOS ignores case.
const POSIX_HOME_RE = /(^|[\s"'(=:,;[])(?:\/mnt)?(?:\/[a-z])?\/(?:users|home)\/[^/]+/gi
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `home` (when known) and every shape of a home folder in `s` become `~`. */
function homesOut(s: string, home: string | undefined): string {
  let out = s
  const h = home?.trim().replace(/[\\/]+$/, '')
  if (h && h.length > 1) {
    const parts = h.split(/[\\/]+/)
    out = out.replace(new RegExp(parts.map(escapeRe).join('[\\\\/]+'), 'gi'), '~')
    // The same folder as a POSIX shell names it: `C:\Users\x` is also `/c/Users/x` and `/mnt/c/Users/x`.
    const drive = /^([A-Za-z]):$/.exec(parts[0]!)
    if (drive && parts.length > 1) {
      const rest = parts.slice(1).map(escapeRe).join('/+')
      out = out.replace(new RegExp(`(^|[\\s"'(=:,;[])(?:/mnt)?/${drive[1]}/+${rest}`, 'gi'), '$1~')
    }
  }
  return out.replace(WIN_HOME_RE, '~').replace(POSIX_HOME_RE, '$1~')
}

/** A label of the house without the machine's paths: `file:` addresses reduced to `~/…/<last segment>`, homes to `~`. */
export function pathsOut(s: string, home?: string): string {
  const files = s.replace(FILE_URL_RE, (u) => {
    let path = u.replace(/^file:\/\//i, '').replace(/[?#].*$/, '')
    try { path = decodeURIComponent(path) } catch { /* kept as it came */ }
    const segs = homesOut(path, home).split(/[\\/]+/).filter(Boolean)
    const last = segs[segs.length - 1]
    return !last || last === '~' || segs.length === 1 ? '~' : `~/…/${last}`
  })
  return homesOut(files, home)
}

/** A title or a name of the tree: one line of hostile text, without the machine's paths, capped. */
const label = (v: unknown, max: number, home: string | undefined): string =>
  typeof v === 'string' ? pathsOut(sanitizeDeclaredName(v), home).slice(0, max) : ''
const byteLength = (v: unknown): number => utf8(JSON.stringify(v)).length

// ---- channels.marks

export interface MarkRow {
  channel: string
  name: string
  unread: number
  toMe: number
  seen: number
  asks: number
  owed: number
  firstToMe?: number
  firstCall?: { why: (typeof FIRST_WHY)[number]; text: string }
  /** The ids of the agents in the channel now (never `user`: the person is in every one), at most MARK_MEMBERS_MAX. */
  members: string[]
  /** How many member ids were left out of `members` (the row's cap, or the answer's MARKS_MEMBER_IDS_MAX). */
  membersMore?: number
}
/** `moderator.name`: the person's name in the channels, the one the lines' `to` name her by. */
export interface ChannelsMarks { channels: MarkRow[]; more: number; moderator: { name: string } }

/** The `marks` answer of tetherd (extensions/channels/daemon/marks.ts RemoteMarks); a RemoteMarks fits. */
export interface MarkRowSource {
  channel: string; name: string; unread: number; toMe: number; seen: number; asks: number; owed: number
  firstToMe?: number; firstCall?: { why: string; text: string }; members?: readonly string[]
}
export interface MarksSource { channels: readonly MarkRowSource[]; moderator?: { name: string } }

/** The agents' ids of a member list: an id of the shape of ID_RE, each once, the person left out. */
const memberIds = (v: unknown): string[] => [...new Set(arr(v, 4096).filter((id): id is string => typeof id === 'string' && id !== 'user' && ID_RE.test(id)))]

/** A row that calls the person (a call, a mention, a request or a poll owed): it is kept before the quiet ones when the answer is cut. */
const callsMe = (r0: unknown): boolean => {
  const r = rec(r0)
  return rec(r.firstCall).why !== undefined || (int(r.toMe) ?? 0) > 0 || (int(r.asks) ?? 0) > 0 || (int(r.owed) ?? 0) > 0
}

export function channelsMarks(s: MarksSource): ChannelsMarks {
  const rows: MarkRow[] = []
  const given = Array.isArray(rec(s).channels) ? (s.channels as readonly unknown[]) : []
  // Stable: the callers first, each group in tetherd's order, so the cut below is the same for the same answer.
  const all = [...given.filter(callsMe), ...given.filter((r) => !callsMe(r))]
  const moderator = { name: name64(rec(rec(s).moderator).name) }
  let room = MARKS_MEMBER_IDS_MAX
  let bytes = byteLength({ channels: [], more: all.length, moderator })
  for (const r0 of all) {
    if (rows.length >= MARKS_MAX) break
    const r = rec(r0)
    const channel = typeof r.channel === 'string' && ID_RE.test(r.channel) ? r.channel : ''
    if (!channel) continue
    const f = rec(r.firstCall)
    const why = oneOf(f.why, FIRST_WHY)
    const ids = memberIds(r.members)
    const members = ids.slice(0, Math.min(MARK_MEMBERS_MAX, room))
    const row = opt<MarkRow>(
      { channel, name: name64(r.name), unread: int(r.unread) ?? 0, toMe: int(r.toMe) ?? 0, seen: int(r.seen) ?? 0, asks: int(r.asks) ?? 0, owed: int(r.owed) ?? 0, members },
      { firstToMe: int(r.firstToMe, 1), firstCall: why ? { why, text: line(f.text, 240) } : undefined, membersMore: ids.length > members.length ? ids.length - members.length : undefined },
    )
    const size = byteLength(row) + 1
    if (bytes + size > MARKS_BYTES_MAX) break
    bytes += size
    room -= members.length
    rows.push(row)
  }
  return { channels: rows, more: Math.max(0, all.length - rows.length), moderator }
}

// ---- channels.page

export interface Person { id: string; name: string }
export interface PageFile { name: string; size: number; type: string }
export interface PagePoll { type: 'ok' | 'choice'; question: string; options: string[]; to: Person[]; closesAt: string }
export interface PageLine {
  seq: number
  at: string
  kind: 'message' | 'notice' | 'poll'
  from: { id: string; name: string; role: (typeof ROLES)[number] }
  body: string
  cut?: true
  to?: string[]
  replyTo?: number
  event?: { type: (typeof LINE_EVENTS)[number]; who?: string; by?: string }
  poll?: PagePoll
  files?: PageFile[]
  /** The person said it from afar (a device of the remote): the screens label it "de longe". */
  afar?: true
}
export interface PageReactions { seq: number; tallies: { emoji: string; name?: string; by: Person[] }[] }
export interface PollOpen extends PagePoll { author: Person; votes: (Person & { option: number; reason?: string })[] }
export interface PollOutcome {
  poll: number
  by: (typeof POLL_BY)[number]
  closer?: Person
  away?: true
  tally: { option: number; text: string; voters: (Person & { reason?: string })[] }[]
  missing: (Person & { why: (typeof MISSING_WHY)[number] })[]
}
export interface PagePollState { seq: number; open?: PollOpen; result?: PollOutcome; closedAt?: string }
export interface ChannelPage {
  channel: { id: string; name: string; title: string; closed?: true }
  lines: PageLine[]
  reactions: PageReactions[]
  polls: PagePollState[]
  last: number
  /** The cursor of the page before this one (`{ channel, before }`); absent at the start of the channel. */
  before?: number
  /** Who is in the channel now (agents; the person is in every one), in the order they joined, at most PAGE_MEMBERS_MAX. */
  members: PageMember[]
  /** How many members were left out of `members`. */
  membersMore?: number
  /** The person's name in the channels: a line whose `to` holds it is for her. */
  moderator: { name: string }
}
export interface PageMember { id: string; name: string; muted?: true }

/** The `history` answer of tetherd (extensions/channels/daemon/requests.ts), with what the portal asked: unknown JSON. */
export interface PageSource {
  answer: unknown
  before?: number
  limit: number
  /** The person's home folder: it becomes `~` in the channel's title (regencyTree's rule). */
  home?: string
}

const person = (v: unknown): Person => { const p = rec(v); return { id: whoOf(p.id), name: name64(p.name) } }
const persons = (v: unknown, max = 64): Person[] => arr(v, max).map(person)
const reason = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? line(v, 140) : undefined)

function pagePoll(v: unknown): PagePoll | undefined {
  const p = rec(v)
  const type = oneOf(p.type, ['ok', 'choice'] as const)
  if (!type) return undefined
  return { type, question: line(p.question, 300), options: arr(p.options, 6).map(o => line(o, 60)), to: persons(p.to), closesAt: iso(p.closesAt) ?? '' }
}

function pageLine(v: unknown): PageLine | undefined {
  const l = rec(v)
  const kind = oneOf(l.kind, ['message', 'notice', 'poll'] as const)
  const seq = int(l.seq, 1)
  if (!kind || seq === undefined) return undefined
  const from = rec(l.from)
  const raw = typeof l.body === 'string' ? multiline(l.body) : ''
  const ev = rec(l.event)
  const evType = kind === 'notice' ? oneOf(ev.type, LINE_EVENTS) : undefined
  const event = evType ? opt<NonNullable<PageLine['event']>>({ type: evType }, { who: whoOf(ev.who) || undefined, by: whoOf(ev.by) || undefined }) : undefined
  const to = Array.isArray(l.to) ? arr(l.to, 32).map(n => name64(n)).filter(n => n !== '') : undefined
  // Attachments: the name shown, the size and the type. The path in the channel's folder never leaves the machine.
  const files = kind === 'message' && Array.isArray(l.files)
    ? arr(l.files, 32).map((f0): PageFile => { const f = rec(f0); return { name: line(f.name, 128), size: int(f.size) ?? 0, type: typeof f.type === 'string' && MIME_RE.test(f.type) ? f.type : '' } })
    : undefined
  return opt<PageLine>(
    { seq, at: iso(l.at) ?? '', kind, from: { id: whoOf(from.id), name: name64(from.name), role: oneOf(from.role, ROLES) ?? 'member' }, body: raw.slice(0, LINE_BODY_MAX) },
    {
      cut: raw.length > LINE_BODY_MAX ? true : undefined, to: to?.length ? to : undefined, replyTo: int(l.replyTo, 1), event,
      poll: kind === 'poll' ? pagePoll(l.poll) : undefined, files: files?.length ? files : undefined,
      afar: l.afar === true ? true : undefined,
    },
  )
}

function pageReactions(v: unknown): PageReactions | undefined {
  const r = rec(v)
  const seq = int(r.seq, 1)
  if (seq === undefined) return undefined
  const tallies = arr(r.tallies, 32).map((t0) => {
    const t = rec(t0)
    const emoji = typeof t.emoji === 'string' ? multiline(t.emoji).slice(0, 32) : ''
    return opt<PageReactions['tallies'][number]>({ emoji, by: persons(t.by) }, { name: typeof t.name === 'string' && KIND_RE.test(t.name) ? t.name : undefined })
  }).filter(t => t.emoji !== '')
  return { seq, tallies }
}

function pollOpen(v: unknown): PollOpen | undefined {
  const spec = pagePoll(v)
  if (!spec) return undefined
  const p = rec(v)
  const votes = Object.entries(rec(p.votes)).slice(0, 64).map(([id, v0]) => {
    const x = rec(v0)
    return opt<PollOpen['votes'][number]>({ id: whoOf(id), name: name64(x.name), option: int(x.option, 1, 6) ?? 0 }, { reason: reason(x.reason) })
  })
  return { ...spec, author: person(p.author), votes }
}

function pollOutcome(v: unknown): PollOutcome | undefined {
  const r = rec(v)
  const poll = int(r.poll, 1)
  const by = oneOf(r.by, POLL_BY)
  if (poll === undefined || !by) return undefined
  const tally = arr(r.tally, 6).map((t0) => {
    const t = rec(t0)
    return { option: int(t.option, 1, 6) ?? 0, text: line(t.text, 60), voters: arr(t.voters, 64).map(x => opt<Person & { reason?: string }>(person(x), { reason: reason(rec(x).reason) })) }
  })
  const missing = arr(r.missing, 64).flatMap((m0) => { const why = oneOf(rec(m0).why, MISSING_WHY); return why ? [{ ...person(m0), why }] : [] })
  return opt<PollOutcome>({ poll, by, tally, missing }, { closer: r.closer ? person(r.closer) : undefined, away: r.away === true ? true : undefined })
}

function pagePollState(v: unknown): PagePollState | undefined {
  const p = rec(v)
  const seq = int(p.seq, 1)
  if (seq === undefined) return undefined
  return opt<PagePollState>({ seq }, { open: p.open ? pollOpen(p.open) : undefined, result: p.result ? pollOutcome(p.result) : undefined, closedAt: iso(p.closedAt) })
}

/**
 * One page of a channel. The cursor is the store's arithmetic (seqs are contiguous: the page asked with `before` and
 * `limit` starts at max(1, min(before − 1, last) − limit + 1)), so it holds even when every line of the page is a reaction
 * or a vote. Over PAGE_BYTES_MAX the oldest lines go, with their reactions and polls, and the cursor is the oldest kept.
 */
export function channelsPage(s: PageSource): ChannelPage {
  const a = rec(s.answer)
  const ch = rec(a.channel)
  const channel = opt<ChannelPage['channel']>(
    { id: typeof ch.id === 'string' && ID_RE.test(ch.id) ? ch.id : '', name: name64(ch.name), title: label(ch.title, 256, s.home) },
    { closed: ch.closed ? true : undefined },
  )
  const seenIds = new Set<string>()
  const allMembers = arr(a.members, 4096).flatMap((m0): PageMember[] => {
    const m = rec(m0)
    const id = typeof m.id === 'string' && m.id !== 'user' && ID_RE.test(m.id) ? m.id : ''
    if (!id || seenIds.has(id)) return []
    seenIds.add(id)
    return [opt<PageMember>({ id, name: label(m.name, 64, s.home) }, { muted: m.muted === true ? true : undefined })]
  })
  const members = allMembers.slice(0, PAGE_MEMBERS_MAX)
  const head = opt<Pick<ChannelPage, 'members' | 'membersMore' | 'moderator'>>(
    { members, moderator: { name: label(rec(a.moderator).name, 64, s.home) } },
    { membersMore: allMembers.length > members.length ? allMembers.length - members.length : undefined },
  )
  const limit = int(s.limit, 1, PAGE_LINES_MAX) ?? PAGE_LINES_MAX
  const lines = arr(a.lines, limit).map(pageLine).filter((l): l is PageLine => l !== undefined).sort((x, y) => x.seq - y.seq)
  const reactions = arr(a.reactions, limit).map(pageReactions).filter((r): r is PageReactions => r !== undefined)
  const polls = arr(a.polls, limit).map(pagePollState).filter((p): p is PagePollState => p !== undefined)
  const last = int(a.last) ?? 0
  const before = int(s.before, 1)
  const hi = before === undefined ? last : Math.min(before - 1, last)
  let from = Math.max(1, hi - limit + 1)

  const sizeOf = new Map<number, number>()
  for (const x of [...lines, ...reactions, ...polls]) sizeOf.set(x.seq, (sizeOf.get(x.seq) ?? 0) + byteLength(x) + 1)
  let total = byteLength({ channel, lines: [], reactions: [], polls: [], last, before: 0, ...head }) + [...sizeOf.values()].reduce((n, b) => n + b, 0)
  let cut = 0
  while (total > PAGE_BYTES_MAX && cut < lines.length - 1) total -= sizeOf.get(lines[cut++]!.seq) ?? 0
  const kept = lines.slice(cut)
  if (cut > 0) from = kept[0]!.seq
  const keep = new Set(kept.map(l => l.seq))
  return opt<ChannelPage>(
    { channel, lines: kept, reactions: reactions.filter(r => cut === 0 || keep.has(r.seq)), polls: polls.filter(p => cut === 0 || keep.has(p.seq)), last, members: head.members, moderator: head.moderator },
    { before: from > 1 ? from : undefined, membersMore: head.membersMore },
  )
}

// ---- the person's writes (step 4.2a): channels.say, react, vote, poll, seen
// Their sources are tetherd's answers to the person's requests (extensions/channels/daemon/requests.ts), unknown JSON:
// each projector keeps what the screen needs and nothing of the line written (its body, the receipts of the delivery).

/** A speech: where it landed. */
export interface Said { seq: number }
/** A reaction: whether it changed anything (a repeat does not), and the emoji as the channel keeps it. */
export interface Reacted { changed: boolean; emoji: string; name?: string }
/**
 * A vote: whether it changed anything, the option counted, and the poll's card as channels.page draws it (`open` with the
 * votes now, or `result` when this vote was the last one and closed it).
 */
export interface Voted { changed: boolean; option: number; state: PagePollState }
/** Why a called agent does not hear the poll now (it gets it when it is back, if the poll is still open). */
export const DEAF_WHY = ['asleep', 'stopped', 'with-user'] as const
/** A poll opened: its line, its card (`open`), and the called agents that do not hear it now. */
export interface PollOpened { seq: number; state: PagePollState; deaf: (Person & { why: (typeof DEAF_WHY)[number] })[] }
/** The person's mark of the channel after a "seen" (it only goes up). */
export interface SeenMark { seenByUser: number }
/** What tetherd answered to the write. */
export interface WriteSource { answer: unknown }

function said(s: WriteSource): Said {
  return { seq: int(rec(rec(s.answer).line).seq, 1) ?? 0 }
}

function reacted(s: WriteSource): Reacted {
  const a = rec(s.answer)
  return opt<Reacted>(
    { changed: a.changed === true, emoji: typeof a.emoji === 'string' ? multiline(a.emoji).slice(0, 32) : '' },
    { name: typeof a.name === 'string' && KIND_RE.test(a.name) ? a.name : undefined },
  )
}

function voted(s: WriteSource): Voted {
  const a = rec(s.answer)
  const result = a.result ? pollOutcome(a.result) : undefined
  const seq = int(rec(a.poll).seq, 1) ?? result?.poll ?? 0
  const state = result
    ? opt<PagePollState>({ seq, result }, { closedAt: iso(a.closedAt) })
    : opt<PagePollState>({ seq }, { open: pollOpen(a.poll) })
  return { changed: a.changed === true, option: int(a.option, 1, 6) ?? 0, state }
}

function pollOpened(s: WriteSource): PollOpened {
  const a = rec(s.answer)
  const seq = int(a.seq, 1) ?? 0
  const deaf = arr(a.deaf, 64).flatMap((d0) => { const why = oneOf(rec(d0).why, DEAF_WHY); return why ? [{ ...person(d0), why }] : [] })
  return { seq, state: opt<PagePollState>({ seq }, { open: pollOpen(a.poll) }), deaf }
}

function seenMark(s: WriteSource): SeenMark {
  return { seenByUser: int(rec(s.answer).seenByUser) ?? 0 }
}

// ---- the person managing a channel from afar (RR5, fio-spec 18): what changed, never the channel's summary whole.

/** A channel made: its id and its room name (the screen reads its page next). */
export interface ChannelMade { channel: string; name: string }
/** A join, a mute or an unmute: whether it was so already (nothing changed, no line). */
export interface ChannelAlready { already: boolean }
/** A poll closed by the person: its card as channels.page draws it, with the result. */
export interface PollClosedState { state: PagePollState }
const MADE_ID_RE = /^[\w.:-]{1,64}$/
const MADE_NAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

function channelMade(s: WriteSource): ChannelMade {
  const c = rec(rec(s.answer).channel)
  return {
    channel: typeof c.id === 'string' && MADE_ID_RE.test(c.id) ? c.id : '',
    name: typeof c.name === 'string' && c.name.length <= 40 && MADE_NAME_RE.test(c.name) ? c.name : '',
  }
}
const channelAlready = (s: WriteSource): ChannelAlready => ({ already: rec(s.answer).already === true })
const channelActed = (_: WriteSource): Record<string, never> => ({})
function pollClosedState(s: WriteSource): PollClosedState {
  const a = rec(s.answer)
  const result = a.result ? pollOutcome(a.result) : undefined
  return { state: result ? opt<PagePollState>({ seq: result.poll, result }, { closedAt: iso(a.closedAt) }) : { seq: 0 } }
}

// ---- the files of a speech from afar (step 4.3)

/**
 * One chunk of a file of a line: its whole size and type first (every chunk says them, so the first one announces them),
 * the offset of this chunk and its bytes in base64url. `type` is decided by the file's first bytes at the portal: one of
 * the four images, or `application/octet-stream` (an SVG or an HTML among them). Never the path nor the name.
 */
export interface FileChunk { size: number; type: string; offset: number; data: string }
/** The source the portal built from the disk; nothing of it is copied whole. */
export interface FileChunkSource { size: number; type: string; offset: number; data: string }
const FILE_TYPE_RE = /^(image\/(png|jpeg|webp|gif)|application\/octet-stream)$/
const B64URL_BODY_RE = /^[A-Za-z0-9_-]*$/

export function fileChunk(s: FileChunkSource): FileChunk {
  return {
    size: int(s.size) ?? 0,
    type: typeof s.type === 'string' && FILE_TYPE_RE.test(s.type) ? s.type : 'application/octet-stream',
    offset: int(s.offset) ?? 0,
    data: typeof s.data === 'string' && B64URL_BODY_RE.test(s.data) ? s.data : '',
  }
}

/** An upload's chunk: how many bytes of the file the portal holds now, and whether the file is whole and checked. */
export interface Uploaded { received: number; done: boolean }
export interface UploadedSource { received: number; done: boolean }

function uploaded(s: UploadedSource): Uploaded {
  return { received: int(s.received) ?? 0, done: s.done === true }
}

// ---- regency.tree

/**
 * `lines`: what the pane's seal says (the terminal's line, the extensions' messages; the app shows the first that is not
 * "Esperando você" as what the agent is doing). Only while the app publishes (`live`); each one line, as a title is.
 */
export interface RemotePane { id: string; type: string; icon: string; title: string; attention?: 'done' | 'waiting'; busy?: true; asleep?: true; exited?: true; lines?: string[] }
export interface RemoteDesk { id: string; name: string; color: string; kind: 'queue' | 'system' | 'drawer'; asleep: boolean; icon?: string; panes: RemotePane[] }
export interface RemoteOwner { id: string; name: string }
export interface RemoteChannel {
  id: string
  name: string
  title: string
  desk?: string
  owner: { kind: 'user' } | { kind: 'agent'; id: string; name: string }
  ownerEnded?: { at: string; name: string; why: 'forgotten' | 'left' | 'removed' }
  closed?: { at: string; by: string }
  members: number
  seenByUser: number
  createdAt: string
}
export interface RemoteChannelMarks { unread: number; toMe: number; asks: number; owed: number; first?: { why: (typeof FIRST_WHY)[number]; text: string } }
export interface RemoteAgent { id: string; kind: string; name: string; emblem?: { name: string; color: string; icon: string } }
export interface RemoteClosed { slotId: string; kind: string; name: string; title?: string; endedAt?: string }
/** The entry of the Regency's model as a device gets it: the shape of RegencyInput (extensions/regency/model.ts), field by field. */
export interface RemoteRegencyInput {
  desks: { desks: RemoteDesk[] }
  owners: { desk: Record<string, RemoteOwner>; pane: Record<string, RemoteOwner> }
  channels: RemoteChannel[]
  channelMarks: Record<string, RemoteChannelMarks>
  agents: RemoteAgent[]
  since: Record<string, number>
  collapsed: string[]
  selfDeskId?: string
  closed?: RemoteClosed[]
}
export interface RegencyTree { input: RemoteRegencyInput; live: boolean; asOf?: number; sig?: string }

/** The `tree.read` answer of tetherd (publish-rules.ts RegencyView), and whether the device holds `channels`. */
export interface RegencyTreeSource {
  view: unknown
  channels: boolean
  /** The person's home folder, as the portal's machine knows it: it becomes `~` in every title and name. */
  home?: string
}

const TREE_DESKS_MAX = 256
const TREE_PANES_MAX = 512
const TREE_CHANNELS_MAX = 512
const TREE_AGENTS_MAX = 1024
const TREE_KEYS_MAX = 2048
const TREE_CLOSED_MAX = 50

const short = (v: unknown, max = 32): string => idOf(v, max)

function remotePane(v: unknown, home: string | undefined, live: boolean): RemotePane {
  const p = rec(v)
  // Seal lines are text an agent writes: one line each, without controls, bidi, zero-width or the machine's paths (as a title).
  // A tree the app no longer publishes says what the agent WAS doing: no lines (tetherd drops them too).
  const lines = arr(live ? p.lines : [], SEAL_LINES_MAX).map(l => label(l, SEAL_LINE_MAX, home)).filter(l => l !== '')
  return opt<RemotePane>(
    { id: idOf(p.id), type: short(p.type), icon: short(p.icon), title: label(p.title, 256, home) },
    {
      attention: oneOf(p.attention, ['done', 'waiting'] as const), busy: p.busy === true ? true : undefined, asleep: p.asleep === true ? true : undefined, exited: p.exited === true ? true : undefined,
      lines: lines.length > 0 ? lines : undefined,
    },
  )
}

function remoteDesk(v: unknown, home: string | undefined, live: boolean): RemoteDesk {
  const d = rec(v)
  return opt<RemoteDesk>(
    { id: idOf(d.id), name: label(d.name, 128, home), color: short(d.color), kind: oneOf(d.kind, ['queue', 'system', 'drawer'] as const) ?? 'queue', asleep: d.asleep === true, panes: arr(d.panes, TREE_PANES_MAX).map(p => remotePane(p, home, live)) },
    { icon: typeof d.icon === 'string' ? short(d.icon) : undefined },
  )
}

/** A record by id, its keys sorted and capped, each value through `f`. */
function byId<T>(v: unknown, f: (x: unknown) => T): Record<string, T> {
  const src = rec(v)
  const out: Record<string, T> = {}
  for (const k of Object.keys(src).filter(k => idOf(k, 160) !== '').sort().slice(0, TREE_KEYS_MAX)) out[k] = f(src[k])
  return out
}

function remoteChannel(v: unknown, home: string | undefined): RemoteChannel {
  const c = rec(v)
  const o = rec(c.owner)
  const ended = rec(c.ownerEnded)
  const closed = rec(c.closed)
  return opt<RemoteChannel>(
    {
      id: idOf(c.id), name: label(c.name, 64, home), title: label(c.title, 256, home),
      owner: o.kind === 'agent' ? { kind: 'agent', id: idOf(o.id), name: label(o.name, 64, home) } : { kind: 'user' },
      members: int(c.members) ?? 0, seenByUser: int(c.seenByUser) ?? 0, createdAt: iso(c.createdAt) ?? '',
    },
    {
      desk: typeof c.desk === 'string' ? idOf(c.desk) : undefined,
      ownerEnded: c.ownerEnded ? { at: iso(ended.at) ?? '', name: label(ended.name, 64, home), why: oneOf(ended.why, ['forgotten', 'left', 'removed'] as const) ?? 'removed' } : undefined,
      closed: c.closed ? { at: iso(closed.at) ?? '', by: whoOf(closed.by) } : undefined,
    },
  )
}

function remoteMarks(v: unknown, withText: boolean): RemoteChannelMarks {
  const m = rec(v)
  const f = rec(m.first)
  const why = oneOf(f.why, FIRST_WHY)
  return opt<RemoteChannelMarks>(
    { unread: int(m.unread) ?? 0, toMe: int(m.toMe) ?? 0, asks: int(m.asks) ?? 0, owed: int(m.owed) ?? 0 },
    // The first call's text is a line of a channel: it goes only to a device that holds `channels`.
    { first: why && withText ? { why, text: line(f.text, 512) } : undefined },
  )
}

function remoteAgent(v: unknown, home: string | undefined): RemoteAgent {
  const a = rec(v)
  const e = rec(a.emblem)
  return opt<RemoteAgent>(
    { id: idOf(a.id), kind: short(a.kind), name: label(a.name, 64, home) },
    { emblem: a.emblem ? { name: label(e.name, 128, home), color: short(e.color), icon: short(e.icon) } : undefined },
  )
}

function remoteClosed(v: unknown, home: string | undefined): RemoteClosed {
  const c = rec(v)
  return opt<RemoteClosed>(
    { slotId: idOf(c.slotId), kind: short(c.kind), name: label(c.name, 64, home) },
    { title: typeof c.title === 'string' ? label(c.title, 256, home) : undefined, endedAt: typeof c.endedAt === 'string' ? (iso(c.endedAt) ?? '') : undefined },
  )
}

/** Titles and names of the tree go through `label`: without the machine's paths (`home`: the person's, when the portal knows it). */
export function regencyTree(s: RegencyTreeSource): RegencyTree {
  const view = rec(s.view)
  const i = rec(view.input)
  const owners = rec(i.owners)
  const home = s.home
  const live = view.live === true
  const since: Record<string, number> = {}
  for (const [k, at] of Object.entries(byId(i.since, num))) if (at !== undefined) since[k] = at
  const owner = (x: unknown): RemoteOwner => ({ id: idOf(rec(x).id), name: label(rec(x).name, 64, home) })
  const input = opt<RemoteRegencyInput>(
    {
      desks: { desks: arr(rec(i.desks).desks, TREE_DESKS_MAX).map(d => remoteDesk(d, home, live)) },
      owners: { desk: byId(owners.desk, owner), pane: byId(owners.pane, owner) },
      channels: arr(i.channels, TREE_CHANNELS_MAX).map(c => remoteChannel(c, home)),
      channelMarks: byId(i.channelMarks, x => remoteMarks(x, s.channels === true)),
      agents: arr(i.agents, TREE_AGENTS_MAX).map(a => remoteAgent(a, home)),
      since,
      collapsed: [],
    },
    { selfDeskId: typeof i.selfDeskId === 'string' ? idOf(i.selfDeskId) : undefined, closed: Array.isArray(i.closed) ? arr(i.closed, TREE_CLOSED_MAX).map(c => remoteClosed(c, home)) : undefined },
  )
  return opt<RegencyTree>(
    { input, live },
    { asOf: live ? undefined : int(view.asOf), sig: typeof view.sig === 'string' && SIG_RE.test(view.sig) ? view.sig : undefined },
  )
}

// ---- the thin notices

export interface ChannelsChanged { channels: string[]; all?: true }
export interface ChannelsChangedSource { channels: readonly string[]; all?: boolean }

export function channelsChanged(s: ChannelsChangedSource): ChannelsChanged {
  const ids = (Array.isArray(s.channels) ? s.channels : []).filter((id): id is string => typeof id === 'string' && ID_RE.test(id))
  return s.all === true || ids.length > CHANGED_IDS_MAX ? { channels: [], all: true } : { channels: [...new Set(ids)] }
}

export interface RegencyChanged { live: boolean; sig?: string; asOf?: number }

export function regencyChanged(s: RegencyChanged): RegencyChanged {
  const live = s.live === true
  return opt<RegencyChanged>({ live }, { sig: typeof s.sig === 'string' && SIG_RE.test(s.sig) ? s.sig : undefined, asOf: live ? undefined : int(s.asOf) })
}

// ---- Web Push (step 4.4)

/** The house's VAPID public key (base64url, the browser's `applicationServerKey`) and whether this device is subscribed. */
export interface PushKey { key: string; on: boolean }
export function pushKey(s: { key: Uint8Array; on: boolean }): PushKey {
  return { key: b64url(s.key), on: s.on === true }
}
/**
 * The one notice a push carries (src/remote/webpush.ts PushNotice), built here like every other body that leaves for a
 * device. It goes to a locked screen, so it holds only the house's own words (RR4 gate B-6; R-9 / M-11: a notice is an
 * easy screen to forge): the fixed title, the fixed phrase of its kind, an opaque tag per agent or channel, and the query
 * of the place to open. No agent's name, no channel's name, no text. Undefined when the id does not have the shape of one.
 */
export function pushNotice(s: { kind: PushKind; slotId?: string; channelId?: string }): PushNotice | undefined {
  const base = { kind: s.kind, title: PUSH_TITLE, body: PUSH_BODIES[s.kind] }
  if (s.kind === 'waiting') {
    if (typeof s.slotId !== 'string' || !ID_RE.test(s.slotId)) return undefined
    return { ...base, tag: noticeTag('a', s.slotId), url: '?tab=waiting' }
  }
  if (typeof s.channelId !== 'string' || !ID_RE.test(s.channelId)) return undefined
  return { ...base, tag: noticeTag('c', s.channelId), url: `?c=${s.channelId}` }
}

/** Whether this device is subscribed, after push-on / push-off. */
export function pushState(s: { on: boolean }): { on: boolean } { return { on: s.on === true } }

// ---- management from afar (RR5 5.2): the answers of tetherd's own requests, field by field ----------------------

/** A slot's ronda as a device may see it. `nudge` and `criterion` are an agent's text: one line each, capped. */
export interface RemoteRonda { intervalMs: number; nextAt: string; nudge?: string; criterion?: string; lastAt?: string; due?: true; channel?: 'listening' | 'none' }
/** A slot after an act on it: what it is and how it stands, never its folder, args, env or binding. */
export interface RemoteSlot {
  slotId: string
  kind: string
  name?: string
  status: string
  want?: string
  turn?: 'busy'
  attention?: 'done' | 'waiting'
  canRestart?: true
  stopping?: true
  ronda?: RemoteRonda
}
/** One event of a process's history: what happened, when, by whom; the reason and the purpose as one line each. */
export interface RemoteProcEvent { kind: string; ts: string; by?: RemoteAuthor; run?: number; code?: number; cause?: string; action?: string; reason?: string; until?: string; purpose?: string }
export interface SlotActed { slot: RemoteSlot }
export interface RondaView { ronda: RemoteRonda | null; outcome?: 'created' | 'updated' | 'unchanged' | 'off' | 'was-off' }
export interface ProcsList { procs: RemoteProc[]; more: number }
export interface ProcInfo { proc: RemoteProc; events: RemoteProcEvent[] }
export interface ProcActed { proc: RemoteProc }
export interface ProcReleased { proc: RemoteProc; released: boolean }
/** A refusal "in use by another" (proc-in-use): the uses that refused it, as the app's board shows them. */
export interface InUseRefused { error: 'proc-in-use'; uses: RemoteUse[] }

/** Processes in one procs.list; past them `more` counts (READ_BODY_MAX holds this many cards with room). */
export const PROCS_LIST_MAX = 128
const PROC_EVENTS_MAX = 20
const PROC_EVENT_KINDS = [
  'registered', 'recipe-changed', 'adopted', 'started', 'start-failed', 'stop-requested', 'restart-requested', 'ended', 'forgotten',
  'use-declared', 'use-released', 'use-expired', 'refused-in-use', 'forced',
] as const
const SLOT_STATUS = ['running', 'queued', 'starting', 'exited', 'unconfirmed', 'error'] as const
const SLOT_WANT = ['run', 'ended', 'asleep', 'suspended'] as const
const RONDA_OUTCOME = ['created', 'updated', 'unchanged', 'off', 'was-off'] as const
const GUARDED = ['stop', 'restart', 'forget'] as const

function remoteRonda(v: unknown): RemoteRonda | undefined {
  const r = rec(v)
  const intervalMs = int(r.intervalMs, 1)
  const nextAt = iso(r.nextAt)
  if (intervalMs === undefined || nextAt === undefined) return undefined
  return opt<RemoteRonda>({ intervalMs, nextAt }, {
    nudge: typeof r.nudge === 'string' && r.nudge !== '' ? line(r.nudge, 500) : undefined,
    criterion: typeof r.criterion === 'string' && r.criterion !== '' ? line(r.criterion, 500) : undefined,
    lastAt: iso(r.lastAt), due: r.due === true ? true : undefined, channel: oneOf(r.channel, ['listening', 'none'] as const),
  })
}

export function remoteSlot(v: unknown): RemoteSlot {
  const s = rec(v)
  return opt<RemoteSlot>(
    { slotId: idOf(s.slotId, 64), kind: typeof s.kind === 'string' && KIND_RE.test(s.kind) ? s.kind : '', status: oneOf(s.status, SLOT_STATUS) ?? '' },
    {
      name: typeof s.name === 'string' && s.name !== '' ? name64(s.name) : undefined, want: oneOf(s.want, SLOT_WANT),
      turn: s.turn === 'busy' ? 'busy' : undefined, attention: oneOf(s.attention, ['done', 'waiting'] as const),
      canRestart: s.canRestart === true ? true : undefined, stopping: s.stopping === true ? true : undefined, ronda: remoteRonda(s.ronda),
    },
  )
}

function remoteProcEvent(v: unknown): RemoteProcEvent | undefined {
  const e = rec(v)
  const kind = oneOf(e.kind, PROC_EVENT_KINDS)
  const ts = iso(e.ts)
  if (!kind || !ts) return undefined
  // Never `before`/`after` (a recipe's change carries env values), `message`, `pid` or a path.
  return opt<RemoteProcEvent>({ kind, ts }, {
    by: author(e.by as AuthorSource | undefined), run: int(e.run), code: int(e.code, -0x8000_0000, 0xffff_ffff), cause: text(e.cause, 32),
    action: oneOf(e.action, GUARDED), reason: typeof e.reason === 'string' && e.reason !== '' ? line(e.reason, 200) : undefined,
    until: iso(e.until), purpose: typeof e.purpose === 'string' && e.purpose !== '' ? line(e.purpose, 200) : undefined,
  })
}

const procOf = (v: unknown): RemoteProc => remoteProc(rec(v) as unknown as ProcSource)

function slotActed(s: WriteSource): SlotActed { return { slot: remoteSlot(rec(s.answer).slot) } }
function rondaView(s: WriteSource): RondaView {
  const a = rec(s.answer)
  return opt<RondaView>({ ronda: remoteRonda(a.ronda) ?? null }, { outcome: oneOf(a.rondaOutcome, RONDA_OUTCOME) })
}
function procsList(s: WriteSource): ProcsList {
  const all = Array.isArray(rec(s.answer).procs) ? (rec(s.answer).procs as unknown[]) : []
  return { procs: all.slice(0, PROCS_LIST_MAX).map(procOf), more: Math.max(0, all.length - PROCS_LIST_MAX) }
}
function procInfo(s: WriteSource): ProcInfo {
  const a = rec(s.answer)
  const events = arr(Array.isArray(a.events) ? (a.events as unknown[]).slice(-PROC_EVENTS_MAX) : [], PROC_EVENTS_MAX)
  return { proc: procOf(a.proc), events: events.map(remoteProcEvent).filter((e): e is RemoteProcEvent => e !== undefined) }
}
function procActed(s: WriteSource): ProcActed { return { proc: procOf(rec(s.answer).proc) } }
function procReleased(s: WriteSource): ProcReleased { return { proc: procOf(rec(s.answer).proc), released: rec(s.answer).released === true } }
const forgot = (_: WriteSource): Record<string, never> => ({})
/** An act the app did (RR5 5.1): done or already so, and a new desk's id; nothing else of the app's answer. */
const appActed = (s: WriteSource): AppActAnswer => appActAnswer(s.answer)
/** "+ Novo" (RR5 5.3): the choices without a path, and a new slot by its id alone. */
const createOptions = (s: WriteSource): CreateOptions => createOptionsView(s.answer)
const slotCreated = (s: WriteSource): CreateSlotAnswer => createSlotAnswer(s.answer)

/**
 * The body of a new process refused for its variables (RR5 5.5): the names that look like a secret, so the screen says
 * which ones go in the command itself (`dotenvx run -- …`). Names only, of the form a name takes; never a value.
 */
export function secretEnvBody(names: readonly string[]): Bytes {
  return encode({ error: 'secret-env', names: names.filter((n) => ENV_NAME_RE.test(n)).slice(0, ENV_MAX) })
}

/** The body of a refusal "in use by another": the uses of others the board shows (the person's own never refuses her). */
export function inUseBody(uses: readonly unknown[]): Bytes {
  const body: InUseRefused = { error: 'proc-in-use', uses: remoteUses(uses) }
  return encode(body)
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
  'session.visible': empty,
  'attention.list': attentionList,
  'attention.watch': attentionList,
  'attention.push-key': pushKey,
  'attention.push-on': pushState,
  'attention.push-off': pushState,
  'channels.marks': channelsMarks,
  'channels.page': channelsPage,
  'channels.say': said,
  'channels.react': reacted,
  'channels.vote': voted,
  'channels.poll': pollOpened,
  'channels.seen': seenMark,
  'channels.file': fileChunk,
  'channels.upload': uploaded,
  'channels.upload-cancel': empty,
  'channels.create': channelMade,
  'channels.join': channelAlready,
  'channels.remove': channelActed,
  'channels.mute': channelAlready,
  'channels.unmute': channelAlready,
  'channels.close': channelActed,
  'channels.reopen': channelActed,
  'channels.poll-close': pollClosedState,
  'regency.tree': regencyTree,
  'agents.stop': slotActed,
  'agents.start': slotActed,
  'agents.restart': slotActed,
  'agents.rename': slotActed,
  'agents.forget': forgot,
  'ronda.get': rondaView,
  'ronda.set': rondaView,
  'ronda.off': rondaView,
  'procs.list': procsList,
  'procs.info': procInfo,
  'procs.start': procActed,
  'procs.stop': procActed,
  'procs.stop-force': procActed,
  'procs.restart': procActed,
  'procs.restart-force': procActed,
  'procs.use': procActed,
  'procs.release': procReleased,
  'procs.forget': forgot,
  'procs.forget-force': forgot,
  'procs.new': procActed,
  'desks.hibernate': appActed,
  'desks.wake': appActed,
  'desks.create': appActed,
  'desks.rename': appActed,
  'desks.color': appActed,
  'desks.close': appActed,
  'panes.hibernate': appActed,
  'panes.wake': appActed,
  'panes.suspend': appActed,
  'panes.move': appActed,
  'panes.close': appActed,
  'closed.reopen': appActed,
  'closed.forget': appActed,
  'owners.give': appActed,
  'owners.revoke': appActed,
  'owners.take': appActed,
  'owners.return': appActed,
  'create.options': createOptions,
  'create.agent': slotCreated,
  'create.agent-unrestricted': slotCreated,
  'create.terminal': slotCreated,
  'create.note': appActed,
  'create.browser': appActed,
  'device.list': unbuilt,
  'device.revoke': empty,
} as const satisfies { readonly [K in OpName]: (src: never) => unknown }

/** The body of each event. Total over the events. */
export const EVENTS = {
  'attention.changed': attentionList,
  'channels.changed': channelsChanged,
  'regency.changed': regencyChanged,
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
