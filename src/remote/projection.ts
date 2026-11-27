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

/** The error codes a body may carry; nothing else of a failure goes out. `too-large`: a read whose body passes READ_BODY_MAX. */
export const ERROR_CODES = ['unknown-op', 'bad-request', 'not-implemented', 'failed', 'refused', 'too-large'] as const
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

// ---- the reads of an extension (step 3.4a): channels.marks, channels.page, regency.tree ---------------------------
// Their sources are the answers of tetherd's own requests (src/remoted/gate.ts EXT_READS), unknown JSON as far as the
// portal can tell: every projector below reads them defensively and copies field by field. A field the daemon adds later
// does not go. Hostile text: one-line fields are sanitized like a declared name, a line's body keeps its line breaks and
// loses the other controls, everything is capped.

/** The most bytes of any read's body (the record carries MAX_RECORD_CONTENT, 255 KiB; this leaves room). Over it: `too-large`. */
export const READ_BODY_MAX = 224 * 1024
/** Rows of channels.marks; the rest is counted in `more`. */
export const MARKS_MAX = 256
/** Lines of one channels.page (the default and the ceiling of `limit`). */
export const PAGE_LINES_MAX = 50
/** Bytes of one channels.page's JSON: over it, the oldest lines go and the cursor follows the oldest one kept. */
export const PAGE_BYTES_MAX = 128 * 1024
/** Characters of a line's body; longer, it is cut and says so (`cut`). */
export const LINE_BODY_MAX = 4000
/** Channel ids in one channels.changed; more, and the notice says `all`. */
export const CHANGED_IDS_MAX = 32

const SIG_RE = /^[0-9a-f]{16}$/
const MIME_RE = /^[\w.+-]{1,64}\/[\w.+-]{1,64}$/
const CTRL_RE = /[\p{Cc}\p{Cf}\s]/u
const BODY_CTRL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g
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
const POSIX_HOME_RE = /(^|[\s"'(=:,;[])\/(?:Users|home)\/[^/]+/g
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `home` (when known) and every shape of a home folder in `s` become `~`. */
function homesOut(s: string, home: string | undefined): string {
  let out = s
  const h = home?.trim().replace(/[\\/]+$/, '')
  if (h && h.length > 1) out = out.replace(new RegExp(h.split(/[\\/]+/).map(escapeRe).join('[\\\\/]+'), 'gi'), '~')
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
}
export interface ChannelsMarks { channels: MarkRow[]; more: number }

/** The `marks` answer of tetherd (extensions/channels/daemon/marks.ts RemoteMarks); a RemoteMarks fits. */
export interface MarkRowSource {
  channel: string; name: string; unread: number; toMe: number; seen: number; asks: number; owed: number
  firstToMe?: number; firstCall?: { why: string; text: string }
}
export interface MarksSource { channels: readonly MarkRowSource[] }

export function channelsMarks(s: MarksSource): ChannelsMarks {
  const rows: MarkRow[] = []
  const all = Array.isArray(rec(s).channels) ? (s.channels as readonly unknown[]) : []
  for (const r0 of all) {
    if (rows.length >= MARKS_MAX) break
    const r = rec(r0)
    const channel = typeof r.channel === 'string' && ID_RE.test(r.channel) ? r.channel : ''
    if (!channel) continue
    const f = rec(r.firstCall)
    const why = oneOf(f.why, FIRST_WHY)
    rows.push(opt<MarkRow>(
      { channel, name: name64(r.name), unread: int(r.unread) ?? 0, toMe: int(r.toMe) ?? 0, seen: int(r.seen) ?? 0, asks: int(r.asks) ?? 0, owed: int(r.owed) ?? 0 },
      { firstToMe: int(r.firstToMe, 1), firstCall: why ? { why, text: line(f.text, 240) } : undefined },
    ))
  }
  return { channels: rows, more: Math.max(0, all.length - rows.length) }
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
}

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
  const raw = typeof l.body === 'string' ? l.body.replace(BODY_CTRL_RE, '') : ''
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
    },
  )
}

function pageReactions(v: unknown): PageReactions | undefined {
  const r = rec(v)
  const seq = int(r.seq, 1)
  if (seq === undefined) return undefined
  const tallies = arr(r.tallies, 32).map((t0) => {
    const t = rec(t0)
    const emoji = typeof t.emoji === 'string' ? t.emoji.replace(BODY_CTRL_RE, '').slice(0, 32) : ''
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
  let total = byteLength({ channel, lines: [], reactions: [], polls: [], last, before: 0 }) + [...sizeOf.values()].reduce((n, b) => n + b, 0)
  let cut = 0
  while (total > PAGE_BYTES_MAX && cut < lines.length - 1) total -= sizeOf.get(lines[cut++]!.seq) ?? 0
  const kept = lines.slice(cut)
  if (cut > 0) from = kept[0]!.seq
  const keep = new Set(kept.map(l => l.seq))
  return opt<ChannelPage>(
    { channel, lines: kept, reactions: reactions.filter(r => cut === 0 || keep.has(r.seq)), polls: polls.filter(p => cut === 0 || keep.has(p.seq)), last },
    { before: from > 1 ? from : undefined },
  )
}

// ---- regency.tree

export interface RemotePane { id: string; type: string; icon: string; title: string; attention?: 'done' | 'waiting'; busy?: true; asleep?: true; exited?: true }
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

function remotePane(v: unknown, home: string | undefined): RemotePane {
  const p = rec(v)
  return opt<RemotePane>(
    { id: idOf(p.id), type: short(p.type), icon: short(p.icon), title: label(p.title, 256, home) },
    { attention: oneOf(p.attention, ['done', 'waiting'] as const), busy: p.busy === true ? true : undefined, asleep: p.asleep === true ? true : undefined, exited: p.exited === true ? true : undefined },
  )
}

function remoteDesk(v: unknown, home: string | undefined): RemoteDesk {
  const d = rec(v)
  return opt<RemoteDesk>(
    { id: idOf(d.id), name: label(d.name, 128, home), color: short(d.color), kind: oneOf(d.kind, ['queue', 'system', 'drawer'] as const) ?? 'queue', asleep: d.asleep === true, panes: arr(d.panes, TREE_PANES_MAX).map(p => remotePane(p, home)) },
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
  const since: Record<string, number> = {}
  for (const [k, at] of Object.entries(byId(i.since, num))) if (at !== undefined) since[k] = at
  const owner = (x: unknown): RemoteOwner => ({ id: idOf(rec(x).id), name: label(rec(x).name, 64, home) })
  const input = opt<RemoteRegencyInput>(
    {
      desks: { desks: arr(rec(i.desks).desks, TREE_DESKS_MAX).map(d => remoteDesk(d, home)) },
      owners: { desk: byId(owners.desk, owner), pane: byId(owners.pane, owner) },
      channels: arr(i.channels, TREE_CHANNELS_MAX).map(c => remoteChannel(c, home)),
      channelMarks: byId(i.channelMarks, x => remoteMarks(x, s.channels === true)),
      agents: arr(i.agents, TREE_AGENTS_MAX).map(a => remoteAgent(a, home)),
      since,
      collapsed: [],
    },
    { selfDeskId: typeof i.selfDeskId === 'string' ? idOf(i.selfDeskId) : undefined, closed: Array.isArray(i.closed) ? arr(i.closed, TREE_CLOSED_MAX).map(c => remoteClosed(c, home)) : undefined },
  )
  const live = view.live === true
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
  'channels.marks': channelsMarks,
  'channels.page': channelsPage,
  'regency.tree': regencyTree,
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
