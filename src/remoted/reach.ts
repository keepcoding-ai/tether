// The reach of the `remote` client on the pipe (rule 3; RR3 gate B-8): the ONE source both sides read. The portal
// (src/remoted/gate.ts re-exports it, src/remoted/reads.ts sends by it) and tetherd (src/daemon/server.ts refuses by it)
// take the same tables, so what the portal may send and what tetherd lets through cannot drift apart. Only type imports:
// tetherd loads this file and nothing of the portal with it.
//
// Every message type a client may send tetherd is classified here, and the type is a mapped type over the pipe's union,
// so a new message type of src/daemon/protocol.ts does not compile until it is classified. `op`: some line of the table
// may emit it; `ext-read`: only `ext-request`, and only as one of the pairs (extension, request) of the remote's reach
// (EXT_READS, EXT_WRITES); `portal`: only the portal's own client sends it, to keep its views, never on a device's behalf;
// `never`: no remote path reaches it, and tetherd refuses it to a `remote` client.
import type { OP_TABLE } from '../remote/scopes.ts'
import type { ClientMessage } from '../daemon/protocol.ts'
import type { OpName } from '../remote/index.ts'

export type PipeType = ClientMessage['t']
export type PipeReach = 'op' | 'ext-read' | 'portal' | 'never'

/** Every message type of the pipe, classified. Total: a type of the pipe without a key here does not compile. */
export const PIPE_REACH = {
  // The portal's own client: its handshake and the list that feeds the attention view.
  'auth': 'portal', 'hello': 'portal', 'list': 'portal',
  'perf': 'never', 'debug-block': 'never',
  'create': 'never', 'start': 'never', 'attach': 'never', 'detach': 'never', 'read-screen': 'never', 'resize': 'never',
  'stop': 'never', 'forget': 'never', 'rename-slot': 'never', 'shutdown': 'never',
  'profiles-list': 'never', 'profile-save': 'never', 'profile-delete': 'never', 'set-profile': 'never', 'restart': 'never',
  'seen': 'never', 'unseen': 'never', 'desk-map': 'never',
  // Tunnels (rule 4): a remote op never carries another type inside its body. An extension request that is exposed gets its
  // own op, and `ext-request` reaches tetherd only as one pair of the reach (below): every other one stays without a path.
  'ext-request': 'ext-read',
  'verb-list': 'never', 'verb': 'never', 'object-get': 'never', 'object-set': 'never',
  'pause-start': 'never', 'pause-get': 'never', 'pause-remove': 'never', 'pause-cancel': 'never', 'pause-resume': 'never',
  'ronda-set': 'never', 'ronda-get': 'never', 'ronda-off': 'never',
  'proc-list': 'never', 'proc-info': 'never', 'proc-start': 'never', 'proc-stop': 'never', 'proc-restart': 'never',
  'proc-adopt': 'never', 'proc-forget': 'never', 'proc-use': 'never', 'proc-release': 'never', 'proc-ports': 'never',
  'proc-seen': 'never', 'proc-attach': 'never', 'proc-detach': 'never', 'proc-host': 'never', 'proc-host-stop': 'never',
  'input': 'never', 'typed': 'never',
} as const satisfies { readonly [T in PipeType]: PipeReach }

/** Every pipe type a line of the table may emit is a type of the pipe (a misspelt or removed type does not compile). */
type EmittedByOps = (typeof OP_TABLE)[OpName]['pipe'][number]
const emittedArePipeTypes: [EmittedByOps] extends [PipeType] ? true : false = true
void emittedArePipeTypes

// ---- the class `ext-read`: the extension requests a device may reach, listed by name ------------------------------

type Lines = { readonly [name: string]: { readonly mutates: boolean; readonly gesture: boolean; readonly pipe: readonly string[] } }
/** The lines of a table that emit `ext-request`. */
export type ExtRequestLinesOf<T extends Lines> = { [K in keyof T]: 'ext-request' extends T[K]['pipe'][number] ? K : never }[keyof T]
/** The lines of a table that may hold a pair: they emit `ext-request`, change no state and are no gesture. */
export type ExtReadLinesOf<T extends Lines> = {
  [K in keyof T]: T[K] extends { readonly mutates: false; readonly gesture: false } ? (K extends ExtRequestLinesOf<T> ? K : never) : never
}[keyof T]
export type ExtReadOp = ExtReadLinesOf<typeof OP_TABLE>

type WriteLines = { readonly [name: string]: { readonly mutates: boolean; readonly gesture: boolean; readonly scope: string; readonly presence: string; readonly pipe: readonly string[] } }
/**
 * The lines of a table that may hold a write pair: they emit `ext-request`, change state, are of a scope family (never the
 * session's, which is what stays when a session is locked) and need the session unlocked at least.
 */
export type ExtWriteLinesOf<T extends WriteLines> = {
  [K in keyof T]: T[K] extends { readonly mutates: true; readonly scope: Exclude<T[K]['scope'], 'session'>; readonly presence: 'unlocked' | 'window' | 'per-act' }
    ? (K extends ExtRequestLinesOf<T> ? K : never) : never
}[keyof T]
export type ExtWriteOp = ExtWriteLinesOf<typeof OP_TABLE>
/**
 * Every line that emits `ext-request` is a read (no state, no gesture) or a write (state, a scope family, unlocked or
 * stronger), never anything in between: a gesture that changes nothing, a write of the session family or a write a locked
 * session could send does not compile. (RR4 4.2a lifted the guard that allowed reads only; this one replaces it.)
 */
const extRequestReadsOrWrites: [ExtRequestLinesOf<typeof OP_TABLE>] extends [ExtReadOp | ExtWriteOp] ? true : false = true
void extRequestReadsOrWrites
/** No line is both: a pair is read-only or a write by its line, never by the pair's name. */
const readsAreNotWrites: [ExtReadOp & ExtWriteOp] extends [never] ? true : false = true
void readsAreNotWrites

/** One request of a daemon extension: the extension and the request's name, exactly as tetherd registers them. */
export interface ExtPair { readonly ext: string; readonly name: string }
/** A pair on a line that only reads. */
export type ExtReadPair = ExtPair

/**
 * The closed list of the extension reads a device may reach, by the line of the table that reaches each one. Total both
 * ways by type: a line that emits `ext-request` without a pair, a pair without a line, and a pair on a line that changes
 * state do not compile. The device never names the extension nor the request: the portal takes them from here by the op
 * the gate already checked, and test/unit/remote.scopes.test.ts proves on the daemon halves that each pair only reads.
 */
export const EXT_READS = {
  'channels.marks': { ext: 'channels', name: 'marks' },
  'channels.page': { ext: 'channels', name: 'history' },
  // A file of a line (step 4.3): the line itself, one line of history, read to find the path the device never names.
  'channels.file': { ext: 'channels', name: 'history' },
  'regency.tree': { ext: 'regency', name: 'tree.read' },
} as const satisfies { readonly [K in ExtReadOp]: ExtReadPair }

/**
 * The extension writes a device may reach, by the line that reaches each one: total by type over ExtWriteOp, as EXT_READS
 * is over ExtReadOp. One line per write. The channels' five are the person's speech (requests.ts gate `person`, which takes
 * `app` and `remote`); everything that manages a channel stays out (gate `moderator`, the app alone), and
 * test/unit/ext.channels-person.test.ts keeps this list and that gate in step.
 */
export const EXT_WRITES = {
  'channels.say': { ext: 'channels', name: 'say' },
  'channels.react': { ext: 'channels', name: 'react' },
  'channels.vote': { ext: 'channels', name: 'vote' },
  'channels.poll': { ext: 'channels', name: 'poll' },
  'channels.seen': { ext: 'channels', name: 'seen' },
} as const satisfies { readonly [K in ExtWriteOp]: ExtPair }

/** The pair of a read line, or undefined for a name that has none (every request outside the list stays `never`). */
export const extReadOf = (op: string): ExtReadPair | undefined =>
  Object.hasOwn(EXT_READS, op) ? EXT_READS[op as ExtReadOp] : undefined

/** The pair of a write line, or undefined for a name that has none. */
export const extWriteOf = (op: string): ExtPair | undefined =>
  Object.hasOwn(EXT_WRITES, op) ? EXT_WRITES[op as ExtWriteOp] : undefined

// ---- what tetherd lets a `remote` client send ----------------------------------------------------------------------

/** Every pair a `remote` client may send as `ext-request`: the reads and the writes of the reach, nothing else. */
export const REMOTE_EXT_PAIRS: readonly ExtPair[] = Object.freeze([...Object.values(EXT_READS), ...Object.values(EXT_WRITES as Record<string, ExtPair>)])

const pairKey = (ext: string, name: string): string => `${ext}\u0000${name}`
const REMOTE_EXT_KEYS: ReadonlySet<string> = new Set(REMOTE_EXT_PAIRS.map((p) => pairKey(p.ext, p.name)))

/** Whether a `remote` client may send a message of type `t` at all (a type PIPE_REACH does not list is refused). */
export const remoteMaySend = (t: unknown): boolean =>
  typeof t === 'string' && Object.hasOwn(PIPE_REACH, t) && PIPE_REACH[t as PipeType] !== 'never'

/** Whether a `remote` client may send `ext-request` for this extension and request name. */
export const remoteMayRequest = (ext: unknown, name: unknown): boolean =>
  typeof ext === 'string' && typeof name === 'string' && REMOTE_EXT_KEYS.has(pairKey(ext, name))
