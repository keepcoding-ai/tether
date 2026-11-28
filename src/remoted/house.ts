// The house side of the remote wire inside the portal (fio-spec 3, 4, 5, 7): the routes the relay opens on the house's
// socket, the session handshakes of paired devices (HouseHandshake), the one pairing ticket (HousePairing), the sessions
// per device, and the gate of each request by the operations table. Transport-agnostic: frames in (`onFrame`), frames out
// (`deps.send`), time by `tick(nowMs)`; the relay socket, the pipe and the registry's writer are the caller's.
//
// What a device can get in this milestone: the session family (session.info, admit.renew, device.revoke-self,
// session.lock), the presence ceremonies (uv.register in the pairing session, uv.challenge and uv.assert), attention.list
// / attention.watch, and device.revoke with its per-act proof. Every other line of the table answers `failed` with
// `not-implemented`, after the gate: nothing is ever forwarded to the pipe, and no pipe object leaves whole (every body of
// a RES or EVT is built by src/remote/projection.ts).
//
// Presence (fio-spec 7.3, 7.4): the class of a device comes from the registry (a credential registered, and the origin of
// the PWA configured) and its state from the portal's memory (src/remoted/uv.ts), never from what the PWA says. Every
// proof is checked here against a challenge the portal computes, and one device verifies one proof at a time.
import {
  ActCache, ADMIT_TTL_S, CLOCK_SKEW_S, CLOSE, DENY_MAX, NOTICE, decodeOuter, decodeReq, encodeEvt, encodeOuter, encodeRes, fromB64url, fromHex,
  HousePairing, HouseHandshake, houseFingerprint, houseIdOf, issueAdmitTicket, keyIdOf, PairLockout, parseAdmitTicket,
  opByCode, opByName, parseJsonObject, parseKeyCert, PRESENCE, qrFragment, RES_STATUS, ROUTE_KIND,
  admitRenewKeyAllowed, b64url, sanitizeDeclaredName, toHex, WireError, PAIR_STATE, IDLE_LOCK_MS, EVT, SCOPE_FAMILIES,
  assertionChallenge, registrationChallenge, verifyAssertion, verifyRegistration, WEBAUTHN_LIMITS,
  type Bytes, type CloseCode, type DeviceRecord, type EvtLine, type EvtName, type HouseHsEffect, type HousePairEffect, type OpLine, type OuterFrame, type Req,
  type PresenceContext, type Presence, type RelyingParty, type ResStatus, type RoleKey, type Session, type SessionEffect,
} from '../remote/index.ts'
import {
  emptyBody, errorBody, eventBody, PAGE_LINES_MAX, pushNotice, READ_BODY_MAX, regencyChanged, resultBody, type EventSource, type MarksSource, type RegencyChanged,
} from '../remote/projection.ts'
import type { PushKind } from '../remote/webpush.ts'
import type { PortalPush } from './push.ts'
import type { AttentionView } from './attention.ts'
import { isTalkRefusal, TALK_REFUSALS, talkArgs, type TalkOp } from '../remote/talk.ts'
import { EXT_READS, FRESH_PAIR_REGISTER_MS, gate, gateEvent, type ExtReadOp, type ExtWriteOp } from './gate.ts'
import { ReadFeeds } from './feeds.ts'
import { DeviceLimiter, LIMITS, type Limits } from './limits.ts'
import { ReadError, SharedRead, type PipeReads } from './reads.ts'
import { PIPE_WRITE_TIMEOUT_MS, WriteError, type PipeWrites, type WriteOutcome } from './writes.ts'
import { ActError, PIPE_ACT_TIMEOUT_MS, type ActOutcome, type PipeActs } from './acts.ts'
import { ACT_REFUSALS, isActRefusal, isManageOp, manageArgs, type ManageOp } from '../remote/manage.ts'
import { APP_ACT_PORTAL_MS, APP_ACT_REFUSALS, appActArgs, isAppActOp, isAppActRefusal, type AppActOp } from '../remote/app-acts.ts'
import { CREATE_REFUSALS, createSlotArgs, isCreateRefusal, isCreateSlotOp, type CreateSlotOp } from '../remote/create.ts'
import { inUseBody } from '../remote/projection.ts'
import { linePathOf, type PortalFiles } from './files.ts'
import { cancelArgs, fileReadArgs, uploadArgs } from '../remote/files.ts'
import { usableCredential, type CredentialRow, type DenyRow, type LiveDevice, type PairBegun, type PairView, type PortalAsk, type PortalDevice, type PortalNote, type PortalStatus, type SessionEnded } from './ipc.ts'
import { challengeLive, DevicePresence, PRESENCE_CLOCK, type PendingChallenge, type PresenceClock, type UvPurposeName } from './uv.ts'

/** The body of uv.register (two base64url strings within the caps of WEBAUTHN_LIMITS) fits in this, JSON included. */
export const UV_REGISTER_BODY_MAX = 8 * 1024
const b64Max = (bytes: number): number => Math.ceil((bytes * 4) / 3)
const HEX32 = /^[0-9a-f]{32}$/
/** A channel's id as the store makes them (`c_…`, `desk_…`): the only argument a page sends tetherd besides two numbers. */
const CHANNEL_ID = /^[\w.:-]{1,64}$/

/**
 * What one handler answers: the status, the body, and the audit's result when it says more than the status. `final: false`:
 * an answer the act cache must not keep for its actId (nothing was sent, or the outcome is not known yet; a write keeps
 * its real outcome itself, #extWrite).
 */
/** `late`: the device was answered by the deadline, and this is the act's real outcome when it comes (an audit `late:<result>`). */
interface Served { status: ResStatus; bytes: Bytes; audit?: string; target?: string; lockout?: boolean; final?: false; closeSession?: true; late?: Promise<string> }
/** An act done, as the act cache keeps it: its op too, so its actId never answers for another op. */
interface DoneAct { op: number; status: ResStatus; body: Bytes }
type ProofVerdict = { ok: true; purpose: UvPurposeName } | { ok: false; status: ResStatus; audit: string; lockout?: boolean }

/** Old ticket denied this long after a renewal (spec 5.5). The limits are all in ./limits.ts. */
export const RENEW_DENY_AFTER_MS = 60_000
const PAIR_STATE_WAIT_MS = 5_000
const PAIR_REDRAWS = 3

export interface HouseKeys {
  kH: RoleKey
  kT: RoleKey
  /** The certificate of kT (the newest ticket key): every ticket this portal issues is signed with it. */
  certT: Bytes
}

export interface HouseDeps {
  keys: HouseKeys
  /** The relay's identity as this house configured it (host[:port], lowercase). */
  aud: string
  houseName: string
  attention: AttentionView
  /** One outer frame to the relay. A no-op while the link is down. */
  send(frame: Bytes): void
  /** Asks the registry's writer (the extension); resolves when it wrote, rejects when it refused. */
  ask(a: PortalAsk): Promise<void>
  note(n: PortalNote): void
  /** A native notice on the machine (spec 3.2 (d), 3.4): independent of the app's screen. */
  notice(text: string): void
  log(msg: string): void
  now(): number
  /** Bench knobs (only set under TETHER_TEST_REMOTE=1 by main.ts). */
  idleMs?: number
  renewDenyAfterMs?: number
  /** Bench: lower limits to reach them in a test. Absent, the values of ./limits.ts. */
  limits?: Partial<Limits>
  /** The relying party of WebAuthn: the origin of the PWA (the remote's `webUrl`). Absent: no device holds a usable credential. */
  rp?: RelyingParty
  /** Bench: a shorter idle lock or absolute ceiling of the presence. */
  presenceClock?: Partial<PresenceClock>
  /** The reads of tetherd's extensions (./reads.ts). Absent: the three read lines answer `not-implemented`. */
  reads?: PipeReads
  /** The writes to tetherd's extensions (./writes.ts): the person's speech. Absent: the five write lines answer `not-implemented`. */
  writes?: PipeWrites
  /** How long a repeat of a write still in flight waits for its outcome (the write path's deadline; a bench lowers both). */
  writeTimeoutMs?: number
  /** Bench: shorter gaps between the thin notices (./feeds.ts). */
  noticeGapsMs?: Partial<{ channels: number; regency: number }>
  /** The person's home folder (os.homedir()): it becomes `~` in the titles and names the reads carry (projection.ts pathsOut). */
  userHome?: string
  /** The files of a speech from afar (./files.ts). Absent: the three file lines answer `not-implemented`, and a speech's `files` too. */
  files?: PortalFiles
  /** Bench: a shorter idle time before an abandoned upload goes. */
  uploadIdleMs?: number
  /** Web Push (./push.ts, step 4.4). Absent: the push lines answer `not-implemented` and no notice is sent. */
  push?: PortalPush
  /** The management acts on tetherd (./acts.ts, RR5 5.2). Absent: the management lines answer `not-implemented`. */
  acts?: PipeActs
  /** How long a repeat of an act still in flight waits for its outcome (the act path's deadline; a bench lowers both). */
  actTimeoutMs?: number
  /**
   * The gestures the app does (RR5 5.1): a write path of their own (./writes.ts, never the speech's slots) to the ONE pair
   * `regency/act`. Absent: the lines answer `not-implemented`.
   */
  appActs?: PipeWrites
  /** How long a repeat of an app's act still in flight waits for its outcome (that path's deadline; a bench lowers both). */
  appActTimeoutMs?: number
}

/** The scope a device needs to be told anything (the push lines'), and the one a channel's notice also needs (it says a channel calls her and opens one). */
const PUSH_SCOPE = opByName('attention.push-on')!.scope
const CHANNELS_SCOPE = opByName('channels.page')!.scope
/** How long the person's name in the channels (what a line's `to` names her by) is kept before it is read again. */
const MODERATOR_TTL_MS = 5 * 60_000
const norm = (s: string): string => s.trim().toLowerCase()
const recOf = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})

/** The ops of the chunks of a file: counted by the device's bytes of files a minute, not its requests. */
const FILE_CHUNK_OPS: ReadonlySet<number> = new Set([opByName('channels.file')!.code, opByName('channels.upload')!.code])
/**
 * Writes the screen sends by itself, idempotent by the state they leave (`seen` only goes up; a chunk answers where the file
 * is; a cancel lets go of what is there): their answers stay out of the actId cache (RR4 B-2), so they never push out the
 * act of a speech within the device's resend window.
 */
const UNCACHED_ACT_OPS: ReadonlySet<number> = new Set(['channels.seen', 'channels.upload', 'channels.upload-cancel'].map((n) => opByName(n)!.code))

interface DeviceMem {
  acts: ActCache<DoneAct>
  /**
   * The writes of this device still waiting for tetherd, by actId (hex): a repeat of one waits for its outcome instead of
   * speaking again. At most the writes the pipe holds (PIPE_WRITES_MAX + PIPE_WRITES_LATE_MAX, every device together).
   */
  pending: Map<string, Promise<DoneAct>>
  limiter: DeviceLimiter
  sessions: Set<SessionRoute>
  /** A revocation started: nothing more is issued to this device. */
  revoking: boolean
  /** Unlocked, the window, the invalid proofs and the lane that verifies one proof of this device at a time. */
  presence: DevicePresence
  /** When this portal last accepted an admit.renew of the device (limits.ts `renewMinGapS`). */
  lastRenewMs?: number
}

interface SessionRoute {
  kind: 'session'
  route: number
  session: Session
  deviceId: string
  freshPair: boolean
  openedMs: number
  lastReqMs: number
  inflight: number
  watching: boolean
  /** The page is on the person's screen (session.visible; true until it says otherwise): no push goes to its device. */
  visible: boolean
  /** Subscribed to channels.changed / regency.changed: set by the first read of that family this session served. */
  follows: { channels: boolean; regency: boolean }
  /** The counter of the last presence challenge of this session, and the one pending (spec 7.4 point 6). */
  uvCtr: number
  uvPending?: PendingChallenge
}
interface PairingEntry { p: HousePairing; view: PairView; waitState?: (code: number) => void }

type Route =
  | { kind: 'admit'; route: number; hs: HouseHandshake; hint: string }
  | { kind: 'pair'; route: number }
  | SessionRoute

export class House {
  readonly #d: HouseDeps
  readonly #lim: Limits
  readonly #routes = new Map<number, Route>()
  /** The frames of each route waiting their turn (see #routeData); gone when the route goes. */
  readonly #queues = new Map<number, { tail: Promise<void>; pending: number; bytes: number }>()
  /** Bytes of every frame waiting in #queues (limits.ts `houseQueueBytesMax`). */
  #queuedBytes = 0
  readonly #devices = new Map<string, PortalDevice>()
  readonly #mem = new Map<string, DeviceMem>()
  /** ticketId → exp (Unix s): what the relay must refuse; resent whole at each link up (spec 6.1). */
  readonly #deny = new Map<string, number>()
  /** The entries of #deny that the handshake rate put there (bounded by `rateDenyMax`). */
  readonly #rateDeny = new Map<string, number>()
  /** Old tickets of renewals whose denial is still due (RENEW_DENY_AFTER_MS): room of the list already promised. */
  #denyPending = 0
  /** When the person last got the native notice of a refused deny list. */
  #relayNoticeMs: number | undefined
  /** ticketId hint → arrival instants within the last minute (spec 5.8). */
  readonly #hsRate = new Map<string, number[]>()
  readonly #lockout = new PairLockout()
  #pairing: PairingEntry | undefined
  #linkUp = false
  #fingerprint = ''
  #rp: RelyingParty | undefined
  readonly #clock: PresenceClock
  /** What changed for the reads (channels.changed, regency.changed), from tetherd's events. */
  readonly #feeds: ReadFeeds

  constructor(deps: HouseDeps) {
    this.#d = deps
    this.#lim = { ...LIMITS, ...deps.limits }
    this.#rp = deps.rp
    this.#clock = { ...PRESENCE_CLOCK, ...deps.presenceClock }
    this.#feeds = new ReadFeeds(deps.noticeGapsMs)
    const reads = deps.reads
    this.#marks = reads ? new SharedRead(() => reads.read('channels.marks', {}), { now: () => this.#d.now() }) : undefined
  }

  /**
   * `channels.marks` takes no argument: one answer serves every device, one request at a time at tetherd, kept until the
   * next `channels` event or SHARED_READ_TTL_MS (./reads.ts SharedRead; RR3 gate M-1).
   */
  readonly #marks: SharedRead<unknown> | undefined

  /** An `ext-event` of tetherd: only what makes a thin notice is kept (./feeds.ts); its payload never goes to a device. */
  extEvent(ext: string, name: string, payload: unknown): void {
    if (ext === EXT_READS['channels.marks'].ext) this.#marks?.invalidate()
    this.#feeds.extEvent(ext, name, payload)
    if (ext === EXT_READS['channels.marks'].ext && (name === 'line' || name === 'poll') && this.#d.push && this.#d.push.devices().length > 0) {
      void this.#channelNotice(name, payload).catch((e: Error) => this.#d.log(`push: ${e.message}`))
    }
  }

  // ---- Web Push (step 4.4) -------------------------------------------------------------------------------------

  /** The person's name in the channels, as tetherd's last marks or page said it (kept MODERATOR_TTL_MS). */
  #moderator: { name: string; atMs: number } | undefined

  #sawModerator(answer: unknown): void {
    const name = recOf(recOf(answer).moderator).name
    if (typeof name === 'string' && name.trim() !== '') this.#moderator = { name, atMs: this.#d.now() }
  }

  async #moderatorName(): Promise<string | undefined> {
    const m = this.#moderator
    if (m && this.#d.now() - m.atMs < MODERATOR_TTL_MS) return m.name
    if (!this.#marks) return m?.name
    try { this.#sawModerator(await this.#marks.get()) } catch { /* the last one known, if any */ }
    return this.#moderator?.name
  }

  /**
   * A line or a poll of a channel, from tetherd's events: a notice when a speech of an agent is addressed to the person (her
   * name in `to`, by the rule of the channels' marks) or a poll calls her (`user` among those called). Nothing of the line
   * goes on but the channel's id (the notice's opaque tag and the place it opens).
   */
  async #channelNotice(event: 'line' | 'poll', payload: unknown): Promise<void> {
    const p = recOf(payload)
    const line = recOf(p.line)
    const from = recOf(line.from)
    if (from.id === 'user' || from.role === 'moderator' || from.role === 'system') return
    let kind: PushKind
    if (event === 'poll') {
      if (line.kind !== 'poll') return
      const to = recOf(line.poll).to
      if (!Array.isArray(to) || !to.some((x) => recOf(x).id === 'user')) return
      kind = 'poll'
    } else {
      if (line.kind !== 'message' || !Array.isArray(line.to) || line.to.length === 0) return
      const me = await this.#moderatorName()
      if (me === undefined || !line.to.some((n) => typeof n === 'string' && norm(n) === norm(me))) return
      kind = 'talk'
    }
    const notice = pushNotice({ kind, channelId: typeof p.channelId === 'string' ? p.channelId : undefined })
    if (notice) this.#d.push?.notify(notice, this.#pushTargets([PUSH_SCOPE, CHANNELS_SCOPE]))
  }

  /**
   * The devices a notice may go to: subscribed, active, holding the scopes (`attention`, and `channels` for a channel's
   * notice: it tells of a channel and opens one), not being revoked, and with no session that is live and on the person's screen.
   */
  #pushTargets(scopes: readonly string[]): string[] {
    const push = this.#d.push
    if (!push) return []
    const out: string[] = []
    for (const id of push.devices()) {
      const dv = this.#devices.get(id)
      if (!dv || dv.state !== 'active' || !scopes.every((sc) => dv.scopes.includes(sc))) continue
      const mem = this.#mem.get(id)
      if (mem?.revoking) continue
      if (mem && [...mem.sessions].some((s) => s.visible && s.session.state === 'open')) continue
      out.push(id)
    }
    return out
  }

  /** The push service said a subscription is gone (404/410): the registry's writer forgets it too. */
  pushGone(deviceId: string): void {
    const dv = this.#devices.get(deviceId)
    if (dv) delete dv.push
    void this.#d.ask({ ask: 'push-drop', deviceId, why: 'gone' }).catch((e: Error) => this.#d.log(`push: the registry did not drop a subscription (${e.message})`))
  }

  /** attention.push-on: the subscription checked (M-11), written by the registry's writer, then kept here. */
  async #pushOn(s: SessionRoute, body: Record<string, unknown>): Promise<Served> {
    const push = this.#d.push
    if (!push) return { status: RES_STATUS.failed, bytes: errorBody('not-implemented'), final: false }
    const v = await push.check(body)
    if (!v.ok) return { status: RES_STATUS.badRequest, bytes: errorBody(v.why === 'keys' || v.why === 'malformed' ? 'bad-request' : 'push-service'), audit: `refused:${v.why}` }
    const row = { ...v.sub, at: new Date(this.#d.now()).toISOString() }
    try { await this.#d.ask({ ask: 'push-sub', deviceId: s.deviceId, sub: row }) } catch (e) {
      this.#d.log(`push: the registry refused a subscription (${(e as Error).message})`)
      return { status: RES_STATUS.failed, bytes: errorBody('failed'), final: false }
    }
    push.set(s.deviceId, row)
    const dv = this.#devices.get(s.deviceId)
    if (dv) dv.push = row
    return { status: RES_STATUS.ok, bytes: resultBody('attention.push-on', { on: push.has(s.deviceId) }) }
  }

  /** attention.push-off: the subscription goes, here and in the registry. */
  async #pushOff(s: SessionRoute): Promise<Served> {
    const push = this.#d.push
    if (!push) return { status: RES_STATUS.failed, bytes: errorBody('not-implemented'), final: false }
    try { await this.#d.ask({ ask: 'push-drop', deviceId: s.deviceId, why: 'off' }) } catch (e) {
      this.#d.log(`push: the registry did not drop a subscription (${(e as Error).message})`)
      return { status: RES_STATUS.failed, bytes: errorBody('failed'), final: false }
    }
    push.set(s.deviceId, undefined)
    const dv = this.#devices.get(s.deviceId)
    if (dv) delete dv.push
    return { status: RES_STATUS.ok, bytes: resultBody('attention.push-off', { on: false }) }
  }

  /** A slot's state changed or it went: the Regency a device sees with the app closed changed too. */
  slotsChanged(): void { this.#feeds.slotsChanged() }

  /**
   * The origin of the PWA changed (or went): the presence credentials are checked against the new one from now on. A
   * credential keeps the relying party it was registered with, so one of another origin stops serving (its device only
   * reads, and no attempt counts toward the lockout). When that happens to registered credentials, one security line and
   * one native notice say so.
   */
  setRelyingParty(rp: RelyingParty | undefined): void {
    this.#rp = rp
    let stale = 0
    for (const dv of this.#devices.values()) if (dv.state !== 'revoked' && dv.credential && !usableCredential(dv.credential, rp)) stale++
    if (stale === 0) return
    this.#audit('uv.credential-stale', `n:${stale}`, undefined, rp ? new URL(rp.origin).host : 'none')
    this.#d.notice(`O endereço do app do celular mudou: ${stale === 1 ? 'um aparelho com biometria cadastrada passa' : `${stale} aparelhos com biometria cadastrada passam`} a só ler. Para destravar de novo, pareie o aparelho outra vez.`)
  }

  /** The credential of a device that serves under the current origin of the PWA (see setRelyingParty). */
  #credential(deviceId: string): CredentialRow | undefined {
    return usableCredential(this.#devices.get(deviceId)?.credential, this.#rp)
  }

  /** One line of the audit (the extension writes and rotates it; never content, M-10). */
  #audit(act: string, result: string, deviceId?: string, target?: string): void {
    this.#d.note({ note: 'audit', act, result, ...(deviceId ? { deviceId } : {}), ...(target ? { target } : {}) })
  }

  async init(devices: readonly PortalDevice[], deny: readonly DenyRow[]): Promise<void> {
    this.#fingerprint = houseFingerprint(await houseIdOf(this.#d.keys.kH.pub))
    for (const dv of devices) {
      this.#devices.set(dv.deviceId, dv)
      if (dv.state === 'active') this.#d.push?.set(dv.deviceId, dv.push)
    }
    for (const r of deny) this.#addDeny(r.ticketId, r.exp)
    // What a previous portal left of uploads: this one holds none of them.
    await this.#d.files?.sweepDisk()
  }

  get fingerprint(): string { return this.#fingerprint }

  /** Bytes of the relay's frames waiting their turn, all routes together (diagnostics and tests). */
  get queuedBytes(): number { return this.#queuedBytes }

  status(): PortalStatus {
    return { link: this.#linkUp ? 'up' : 'down', sessions: this.#sessionCount(), houseFingerprint: this.#fingerprint, live: this.#live() }
  }

  // ---- registry (from the extension) -------------------------------------------------------------------------

  upsertDevice(dv: PortalDevice): void {
    this.#devices.set(dv.deviceId, dv)
    this.#d.push?.set(dv.deviceId, dv.state === 'active' ? dv.push : undefined)
  }

  forgetDevice(deviceId: string): void {
    this.#d.push?.forget(deviceId)
    this.#devices.delete(deviceId)
    this.#closeDevice(deviceId, CLOSE.revoked)
    this.#mem.delete(deviceId)
    void this.#d.files?.forgetDevice(deviceId)
  }

  /** Spec 6.1, after the registry was written: close the live sessions with CLOSE(0x04), deny every live ticket. */
  async revoke(deviceId: string, deny: readonly DenyRow[]): Promise<void> {
    const dv = this.#devices.get(deviceId)
    if (dv) { dv.state = 'revoked'; delete dv.push }
    // A revoked device is told nothing more, and what waited for it is dropped (the registry dropped its row too).
    this.#d.push?.forget(deviceId)
    const mem = this.#mem.get(deviceId)
    if (mem) mem.revoking = true
    await this.#closeDevice(deviceId, CLOSE.revoked)
    const added: DenyRow[] = []
    for (const r of deny) if (this.#addDeny(r.ticketId, r.exp)) added.push(r)
    if (added.length) this.#sendDeny(added)
    this.#mem.delete(deviceId)
    void this.#d.files?.forgetDevice(deviceId)
    this.#audit('device.revoke.closed', 'ok', deviceId) // the registry's own line says who revoked; this one says the sessions are down
  }

  /** The remote goes off: every session gets CLOSE(0x06), the pairing in course is cancelled. */
  async shutdown(): Promise<void> {
    for (const deviceId of [...this.#mem.keys()]) await this.#closeDevice(deviceId, CLOSE.remoteOff)
    if (this.#pairing && !this.#isOver(this.#pairing.view.state)) this.#pairEffects(await this.#pairing.p.cancel(this.#d.now()))
  }

  // ---- the relay link ----------------------------------------------------------------------------------------

  linkUp(): void {
    this.#linkUp = true
    this.#pruneDeny()
    const all = [...this.#deny].map(([ticketId, exp]) => ({ ticketId, exp }))
    if (all.length) this.#sendDeny(all)
    this.#d.note({ note: 'link', state: 'up' })
  }

  linkDown(): void {
    if (!this.#linkUp && this.#routes.size === 0) return
    this.#linkUp = false
    for (const r of this.#routes.values()) {
      if (r.kind === 'session') this.#endSession(r, 'link down')
      else if (r.kind === 'admit') void r.hs.routeClosed()
    }
    this.#routes.clear()
    this.#queues.clear()
    if (this.#pairing && !this.#isOver(this.#pairing.view.state)) void this.#pairing.p.cancel(this.#d.now()).then((fx) => this.#pairEffects(fx))
    this.#d.note({ note: 'link', state: 'down' })
    this.#noteSessions()
  }

  /** One frame of the house leg written by the relay (after R_AUTH_OK). */
  onFrame(bytes: Uint8Array): void {
    let f: OuterFrame
    try { f = decodeOuter('house', 'relay', bytes) } catch (e) {
      if (e instanceof WireError) { this.#d.log(`relay frame refused: ${e.code}`); return }
      throw e
    }
    switch (f.type) {
      case 'ROUTE_OPEN': return this.#routeOpen(f.routeId, f.kind, f.hint)
      case 'ROUTE_DATA': return this.#routeData(f.routeId, f.inner)
      case 'ROUTE_CLOSE': return this.#routeClosed(f.routeId)
      case 'R_PAIR_STATE': this.#pairing?.waitState?.(f.code); return
      case 'R_NOTICE': return this.#relayNotice(f.code)
      default: return
    }
  }

  #routeOpen(route: number, kind: number, hint: Bytes): void {
    if (this.#routes.has(route)) return this.#close(route)
    if (this.#routes.size >= this.#lim.routesPerHouse) return this.#close(route)
    if (kind === ROUTE_KIND.pair) {
      if (!this.#pairing || this.#isOver(this.#pairing.view.state)) return this.#close(route)
      this.#routes.set(route, { kind: 'pair', route })
      return
    }
    if (kind !== ROUTE_KIND.admit) return this.#close(route)
    // Admission: the hint (ticketId) is unauthenticated and used only for the limits of spec 5.8.
    const hintHex = toHex(hint)
    const nowMs = this.#d.now()
    const pending = [...this.#routes.values()].filter((r) => r.kind === 'admit').length
    const recent = (this.#hsRate.get(hintHex) ?? []).filter((t) => nowMs - t < 60_000)
    recent.push(nowMs)
    this.#hsRate.set(hintHex, recent)
    if (this.#hsRate.size > 1024) this.#hsRate.delete(this.#hsRate.keys().next().value!)
    if (recent.length > this.#lim.hsPerTicketPerMin) {
      // The hint is unauthenticated: its denials have a share of their own and never take the revocations' reserve.
      const exp = Math.floor(nowMs / 1000) + this.#lim.hsRateDenyS
      const room = hint.length === 16 && (this.#deny.has(hintHex) || (this.#denyRoom(1, this.#lim.denyRevokeReserve) && this.#rateDeny.size < this.#lim.rateDenyMax))
      if (room && this.#addDeny(hintHex, exp)) {
        this.#rateDeny.set(hintHex, exp)
        this.#sendDeny([{ ticketId: hintHex, exp }])
      }
      return this.#close(route)
    }
    if (pending >= this.#lim.hsPendingMax) return this.#close(route)
    const hs = new HouseHandshake({ kH: this.#d.keys.kH, nowMs, lookup: (id) => this.#lookup(toHex(id)) })
    this.#routes.set(route, { kind: 'admit', route, hs, hint: hintHex })
  }

  #lookup(deviceId: string): DeviceRecord | undefined {
    const dv = this.#devices.get(deviceId)
    if (!dv || dv.state !== 'active') return undefined
    const mem = this.#mem.get(deviceId)
    // The class comes from the registry (a credential and the origin to check it), never from `caps` (E-12).
    const { presence, elevUntilS } = this.#devicePresence(deviceId, this.#d.now())
    return {
      pubD: fromHex(dv.pubD), revoked: mem?.revoking === true, expired: false, maxVerUsed: dv.maxVerUsed,
      liveSessions: mem?.sessions.size ?? 0, presence, elevUntil: elevUntilS,
    }
  }

  /** A device's presence, as a new session of it starts: no credential, or locked / unlocked by the portal's memory. */
  #devicePresence(deviceId: string, nowMs: number): { presence: Presence; elevUntilS: number } {
    if (!this.#credential(deviceId)) return { presence: PRESENCE.noCredential, elevUntilS: 0 }
    const p = this.#memOf(deviceId).presence
    return { presence: p.presence(nowMs), elevUntilS: p.elevUntilS(nowMs) }
  }

  /**
   * A session's presence. The session that concluded the pairing is born locked while it may still register its credential
   * (E-10: only the session family, then uv.register and the first uv.assert); past that, a device without one only reads.
   */
  #sessionPresence(s: SessionRoute, nowMs: number): { presence: Presence; elevUntilS: number } {
    const registering = this.#rp !== undefined && s.freshPair && nowMs - s.openedMs <= FRESH_PAIR_REGISTER_MS
    if (registering && !this.#devices.get(s.deviceId)?.credential) return { presence: PRESENCE.locked, elevUntilS: 0 }
    return this.#devicePresence(s.deviceId, nowMs)
  }

  /**
   * Frames of one route are handled one after the other: frame N+1 is dispatched only after frame N was handled and
   * its effects applied (a pairing that becomes a session, the AES-GCM counter per direction). The kind of the route is
   * read at dispatch, never at arrival.
   */
  #routeData(route: number, inner: Bytes): void {
    if (!this.#routes.has(route)) return
    let q = this.#queues.get(route)
    if (!q) { q = { tail: Promise.resolve(), pending: 0, bytes: 0 }; this.#queues.set(route, q) }
    // Counted in frames and in bytes, per route and for the house: a frame that would pass any ceiling closes its route.
    const n = inner.length
    const over = q.pending >= this.#lim.routeQueueMax ? `more than ${this.#lim.routeQueueMax} frames`
      : q.bytes + n > this.#lim.routeQueueBytesMax ? `more than ${this.#lim.routeQueueBytesMax} bytes`
        : this.#queuedBytes + n > this.#lim.houseQueueBytesMax ? `the house over ${this.#lim.houseQueueBytesMax} bytes` : undefined
    if (over) {
      this.#d.log(`route ${route}: ${over} waiting; closed`)
      this.#routeClosed(route)
      this.#d.send(encodeOuter({ type: 'ROUTE_CLOSE', routeId: route }))
      return
    }
    const queue = q
    queue.pending++
    queue.bytes += n
    this.#queuedBytes += n
    queue.tail = queue.tail.then(async () => {
      try {
        if (this.#queues.get(route) === queue) await this.#dispatch(route, inner)
      } catch (e) {
        this.#d.log(`route ${route}: frame failed (${(e as Error).message})`)
      } finally {
        // Released when the frame leaves memory: handled, or skipped because its route went.
        queue.pending--
        queue.bytes -= n
        this.#queuedBytes -= n
      }
    })
  }

  async #dispatch(route: number, inner: Bytes): Promise<void> {
    const r = this.#routes.get(route)
    if (!r) return
    const nowMs = this.#d.now()
    if (r.kind === 'admit') this.#hsEffects(r, await r.hs.onFrame(inner, nowMs))
    else if (r.kind === 'pair') {
      const pr = this.#pairing
      if (!pr) return this.#close(route)
      this.#pairEffects(await pr.p.onFrame(route, inner, nowMs))
    } else this.#sessionEffects(r, await r.session.receive(inner, nowMs))
  }

  #routeClosed(route: number): void {
    const r = this.#routes.get(route)
    if (!r) return
    this.#routes.delete(route)
    this.#queues.delete(route)
    if (r.kind === 'admit') void r.hs.routeClosed()
    else if (r.kind === 'pair') void this.#pairing?.p.routeClosed(route, this.#d.now()).then((fx) => this.#pairEffects(fx))
    else this.#endSession(r, 'route closed by the relay')
  }

  #close(route: number): void {
    this.#routes.delete(route)
    this.#queues.delete(route)
    this.#d.send(encodeOuter({ type: 'ROUTE_CLOSE', routeId: route }))
  }

  #data(route: number, inner: Bytes): void {
    if (!this.#routes.has(route)) return
    this.#d.send(encodeOuter({ type: 'ROUTE_DATA', routeId: route, inner }))
  }

  #hsEffects(r: Extract<Route, { kind: 'admit' }>, fx: HouseHsEffect[]): void {
    for (const [i, e] of fx.entries()) {
      const at = e.t === 'established' ? undefined : e.notBeforeMs
      const wait = at === undefined ? 0 : at - this.#d.now()
      if (at !== undefined && wait > 0) {
        // `notBeforeMs` (the uniform failure of spec 4.2 rule 7): this effect and the rest leave from one timer, in their
        // order, after one reading of the clock. A timer and a clock reading per effect let the clock cross the instant
        // between two effects: the close went at once and the HS_FAIL it follows was dropped with its route.
        const rest = fx.slice(i).map((x) => (x.t !== 'established' && x.notBeforeMs !== undefined && x.notBeforeMs <= at ? { ...x, notBeforeMs: undefined } : x))
        setTimeout(() => this.#hsEffects(r, rest), wait)
        return
      }
      if (e.t === 'send') this.#data(r.route, e.frame)
      else if (e.t === 'close') { if (this.#routes.get(r.route) === r) this.#close(r.route) }
      else {
        const deviceId = toHex(e.device.deviceId)
        if (this.#routes.get(r.route) !== r || this.#sessionCount() >= this.#lim.sessionsMax) {
          void e.session.close(CLOSE.limit, this.#d.now()).then((x) => this.#flush(r.route, x))
          continue
        }
        this.#adopt(r.route, e.session, deviceId, false)
        const dv = this.#devices.get(deviceId)
        if (dv && e.device.ver > dv.maxVerUsed) dv.maxVerUsed = e.device.ver
        this.#d.note({ note: 'seen', deviceId, ver: e.device.ver })
        this.#audit('session.open', 'ok', deviceId)
      }
    }
  }

  #adopt(route: number, session: Session, deviceId: string, freshPair: boolean): void {
    const nowMs = this.#d.now()
    const s: SessionRoute = { kind: 'session', route, session, deviceId, freshPair, openedMs: nowMs, lastReqMs: nowMs, inflight: 0, watching: false, visible: true, follows: { channels: false, regency: false }, uvCtr: 0 }
    this.#routes.set(route, s)
    this.#memOf(deviceId).sessions.add(s)
    this.#noteSessions()
  }

  /** The extension learns every change of the sessions: their count and, per device, since when and what it does. */
  #noteSessions(): void {
    this.#d.note({ note: 'sessions', count: this.#sessionCount(), live: this.#live() })
  }

  /** The devices with a live session: the oldest one's start, and `watching` when any of them follows who waits. */
  #live(): LiveDevice[] {
    const out: LiveDevice[] = []
    for (const [deviceId, mem] of this.#mem) {
      if (mem.sessions.size === 0) continue
      let since = Infinity
      let watching = false
      for (const s of mem.sessions) { since = Math.min(since, s.openedMs); watching ||= s.watching }
      out.push({ deviceId, since: new Date(since).toISOString(), ...(watching ? { doing: 'watching' as const } : {}) })
    }
    return out
  }

  #memOf(deviceId: string): DeviceMem {
    let m = this.#mem.get(deviceId)
    if (!m) {
      m = { acts: new ActCache<DoneAct>({ sizeOf: (d) => d.body.length }), pending: new Map(), limiter: new DeviceLimiter(this.#lim), sessions: new Set(), revoking: false, presence: new DevicePresence(this.#clock) }
      this.#mem.set(deviceId, m)
    }
    return m
  }

  #sessionCount(): number {
    let n = 0
    for (const r of this.#routes.values()) if (r.kind === 'session') n++
    return n
  }

  #flush(route: number, fx: SessionEffect[]): void {
    for (const e of fx) {
      if (e.t === 'send') this.#data(route, e.frame)
      else if (e.t === 'closed' && this.#routes.has(route)) this.#close(route)
    }
  }

  #sessionEffects(s: SessionRoute, fx: SessionEffect[]): void {
    for (const e of fx) {
      if (e.t === 'send') this.#data(s.route, e.frame)
      else if (e.t === 'closed') {
        this.#endSession(s, e.reason)
        if (this.#routes.has(s.route)) this.#close(s.route)
      } else if (e.ctype === 'REQ') void this.#request(s, e.content)
      else {
        // A device writes only REQ and BIN; BIN needs a stream opened by a REQ, and this milestone opens none.
        void s.session.close(CLOSE.protocol, this.#d.now()).then((x) => this.#sessionEffects(s, x))
      }
    }
  }

  #endSession(s: SessionRoute, reason: string): void {
    if (this.#routes.get(s.route) === s) { this.#routes.delete(s.route); this.#queues.delete(s.route) }
    else if (!this.#mem.get(s.deviceId)?.sessions.has(s)) return // already ended: one line per session
    this.#audit('session.end', reason, s.deviceId)
    this.#mem.get(s.deviceId)?.sessions.delete(s)
    s.session.drop('ended')
    this.#noteSessions()
  }

  /**
   * The person ends the live sessions of one device on the machine (CLOSE(0x01)): nothing is denied and the registry is
   * not touched, so the device may connect again. The extension writes the line of who asked; each session's own end
   * leaves its line here.
   */
  async endSessions(deviceId: string): Promise<SessionEnded> {
    const dv = this.#devices.get(deviceId)
    if (!dv || dv.state === 'revoked') throw new PortalError('not-found', 'nenhum aparelho pareado com esse id')
    const ended = this.#mem.get(deviceId)?.sessions.size ?? 0
    await this.#closeDevice(deviceId, CLOSE.normal)
    return { deviceId, ended }
  }

  async #closeDevice(deviceId: string, code: CloseCode): Promise<void> {
    const mem = this.#mem.get(deviceId)
    if (!mem) return
    await Promise.all([...mem.sessions].map(async (s) => {
      const fx = await s.session.close(code, this.#d.now())
      this.#flush(s.route, fx)
      this.#endSession(s, 'closed by the house')
    }))
  }

  /** Whether nothing more may be served on `s`: its device is not active (revoked, forgotten), a revocation runs, or `s` ended. */
  #closedTo(s: SessionRoute): boolean {
    return this.#deviceShut(s.deviceId) || !this.#mem.get(s.deviceId)?.sessions.has(s)
  }

  /** Whether the device is not active (revoked, forgotten) or its revocation runs. */
  #deviceShut(deviceId: string): boolean {
    const dv = this.#devices.get(deviceId)
    return !dv || dv.state !== 'active' || this.#mem.get(deviceId)?.revoking === true
  }

  /** Closes `s` as revoked without serving it (closing twice is nothing: the revocation may be closing it too). */
  async #shut(s: SessionRoute): Promise<void> {
    const fx = await s.session.close(CLOSE.revoked, this.#d.now())
    this.#flush(s.route, fx)
    this.#endSession(s, 'closed by the house')
  }

  // ---- requests ----------------------------------------------------------------------------------------------

  async #request(s: SessionRoute, content: Bytes): Promise<void> {
    let req: Req
    try { req = decodeReq(content) } catch {
      const fx = await s.session.close(CLOSE.protocol, this.#d.now())
      return this.#sessionEffects(s, fx)
    }
    // A device being revoked or forgotten, or a session already ended, is served nothing (RR4 B-4): the door shuts before
    // its sessions are down. Checked before the device's memory is looked up, so a revoked device's memory never comes back.
    if (this.#closedTo(s)) return this.#shut(s)
    const nowMs = this.#d.now()
    s.lastReqMs = nowMs
    const mem = this.#memOf(s.deviceId)
    // The rate of the device, all its sessions together, before anything of the request is looked at, the ceiling in flight
    // included: a request refused for being one too many in flight still counts, so insisting closes the session.
    // A chunk of a file counts against the device's bytes of files a minute instead (limits.ts fileChunksPerDevicePerMin).
    const chunk = FILE_CHUNK_OPS.has(req.op)
    const rate = chunk ? mem.limiter.fileChunk(nowMs) : mem.limiter.request(nowMs)
    if (rate !== 'ok') return this.#overRate(s, req, chunk ? 'file' : 'req', rate)
    if (s.inflight >= this.#lim.inflightMax) {
      this.#audit('limit.inflight', 'limit', s.deviceId, opByCode(req.op)?.name)
      return this.#send(s, req.reqId, RES_STATUS.limit, emptyBody())
    }
    const dv = this.#devices.get(s.deviceId)
    const { presence, elevUntilS } = this.#sessionPresence(s, nowMs)
    const verdict = gate(req, {
      scopes: new Set(dv?.scopes ?? []), presence, elevUntilS, freshPair: s.freshPair,
      openedMs: s.openedMs, nowMs,
    })
    // Every request of a line that changes state or is a gesture leaves a line, accepted or refused (plano §2; the test of
    // remote.audit walks the table). It is written before the answer goes, so the answer never outruns its record.
    if (!verdict.ok) {
      if (verdict.line && audited(verdict.line)) this.#audit(verdict.line.name, statusName(verdict.status), s.deviceId)
      return this.#send(s, req.reqId, verdict.status, verdict.status === RES_STATUS.unknownOp ? errorBody('unknown-op') : emptyBody())
    }
    const line = verdict.line
    if (line.gesture) {
      const gestureRate = mem.limiter.gesture(nowMs)
      if (gestureRate !== 'ok') return this.#overRate(s, req, 'gesture', gestureRate)
    }
    if (req.actId) {
      // An actId names one act of one op: the same id on another op is a malformed request, never that act's answer.
      const waitMs = isManageOp(line.name) ? (this.#d.actTimeoutMs ?? PIPE_ACT_TIMEOUT_MS) : isAppActOp(line.name) || isCreateSlotOp(line.name) ? (this.#d.appActTimeoutMs ?? APP_ACT_PORTAL_MS) : undefined
      const done = mem.acts.get(req.actId, nowMs) ?? (await this.#pendingAct(mem, req.actId, req.op, waitMs))
      if (done) {
        const same = done.op === req.op
        if (audited(line)) this.#audit(line.name, same ? 'replay' : statusName(RES_STATUS.badRequest), s.deviceId)
        return same ? this.#send(s, req.reqId, done.status, done.body) : this.#send(s, req.reqId, RES_STATUS.badRequest, errorBody('bad-request'))
      }
    }
    let body: Record<string, unknown>
    try {
      if (line.name === 'uv.register' && req.body.length > UV_REGISTER_BODY_MAX) throw new WireError('malformed', 'body too large')
      body = parseJsonObject(req.body)
      const allowed = line.body
      if (allowed && Object.keys(body).some((k) => !allowed.includes(k))) throw new WireError('malformed', 'unknown field')
    } catch {
      if (audited(line)) this.#audit(line.name, statusName(RES_STATUS.badRequest), s.deviceId)
      return this.#send(s, req.reqId, RES_STATUS.badRequest, errorBody('bad-request'))
    }
    s.inflight++
    let served: Served
    try {
      served = await this.#serve(s, line, req, body, presence)
    } catch (e) {
      this.#d.log(`request ${line.name} failed: ${(e as Error).message}`)
      served = { status: RES_STATUS.failed, bytes: errorBody('failed') }
    } finally { s.inflight-- }
    const { status, bytes } = served
    // Only an accepted gesture of the person resets the idle clock (E-11), never a refused one nor a read.
    if (status === RES_STATUS.ok && line.gesture) mem.presence.gesture(this.#d.now())
    if (line.mutates && req.actId && served.final !== false && !UNCACHED_ACT_OPS.has(req.op)) mem.acts.put(req.actId, { op: req.op, status, body: bytes }, this.#d.now())
    if (audited(line)) this.#audit(line.name, served.audit ?? statusName(status), s.deviceId, served.target)
    // Chained after the line above, so `late:<result>` always follows the `timeout` it corrects.
    if (served.late && audited(line)) void served.late.then((r) => this.#audit(line.name, `late:${r}`, s.deviceId, served.target))
    await this.#send(s, req.reqId, status, bytes)
    // The fifth invalid proof (spec 7.4 point 6): the answer goes, then every session of the device.
    if (served.lockout) await this.#closeDevice(s.deviceId, CLOSE.limit)
    // A device that insists over its speech ceiling (limits.ts strikes): the answer goes, then this session, as #overRate.
    else if (served.closeSession) this.#sessionEffects(s, await s.session.close(CLOSE.limit, this.#d.now()))
  }

  /** The handler of one request that passed the gate. Every body is built by the projector of its op (src/remote/projection.ts). */
  async #serve(s: SessionRoute, line: OpLine, req: Req, body: Record<string, unknown>, presence: Presence): Promise<Served> {
    const dv = this.#devices.get(s.deviceId)
    const ok = (bytes: Bytes): Served => ({ status: RES_STATUS.ok, bytes })
    // A per-act line runs only after its proof verified against the challenge recomputed from THIS request (spec 7.4 point 4).
    if (line.presence === 'per-act') {
      const v = await this.#checkProof(s, line, req)
      // Not kept for the actId: the same act may come again with a good proof.
      if (!v.ok) return { status: v.status, bytes: emptyBody(), audit: v.audit, final: false, ...(v.lockout ? { lockout: true } : {}) }
    }
    if (isManageOp(line.name)) return this.#manage(s, line.name, req, body)
    if (isAppActOp(line.name) || isCreateSlotOp(line.name)) return this.#appAct(s, line.name, req, body)
    switch (line.name) {
      case 'session.info':
        return ok(resultBody('session.info', { house: this.#fingerprint, name: this.#d.houseName, deviceId: s.deviceId, ver: s.session.ver, presence, scopes: dv?.scopes ?? [] }))
      case 'attention.list':
        return ok(resultBody('attention.list', this.#d.attention.items()))
      case 'attention.watch':
        if (!s.watching) { s.watching = true; this.#noteSessions() }
        return ok(resultBody('attention.watch', this.#d.attention.items()))
      case 'session.visible':
        if (typeof body.visible !== 'boolean') return { status: RES_STATUS.badRequest, bytes: errorBody('bad-request') }
        s.visible = body.visible
        return ok(resultBody('session.visible', {}))
      case 'attention.push-key': {
        const push = this.#d.push
        if (!push) return { status: RES_STATUS.failed, bytes: errorBody('not-implemented') }
        return ok(resultBody('attention.push-key', { key: push.publicKey, on: push.has(s.deviceId) }))
      }
      case 'attention.push-on': return this.#pushOn(s, body)
      case 'attention.push-off': return this.#pushOff(s)
      case 'channels.marks':
      case 'channels.page':
      case 'regency.tree':
      case 'create.options':
        return this.#extRead(s, line.name, body, dv?.scopes ?? [])
      case 'channels.say':
      case 'channels.react':
      case 'channels.vote':
      case 'channels.poll':
      case 'channels.seen':
      case 'channels.create':
      case 'channels.join':
      case 'channels.remove':
      case 'channels.mute':
      case 'channels.unmute':
      case 'channels.close':
      case 'channels.reopen':
      case 'channels.poll-close':
        return this.#extWrite(s, line.name, req, body)
      case 'channels.file': return this.#fileRead(s, body)
      case 'channels.upload': return this.#upload(s, body)
      case 'channels.upload-cancel': return this.#uploadCancel(s, body)
      case 'admit.renew': return this.#renew(s, body)
      case 'device.revoke-self':
        // Only lowers power: no proof needed. The registry's writer runs the revocation (spec 6.1 order).
        this.#d.note({ note: 'revoke-self', deviceId: s.deviceId })
        return ok(resultBody('device.revoke-self', {}))
      case 'session.lock':
        // Only lowers power: the device goes back to locked and the window closes, in every session of it (6.2).
        this.#memOf(s.deviceId).presence.lock()
        s.uvPending = undefined
        return ok(resultBody('session.lock', this.#presenceBody(s)))
      case 'uv.challenge': return this.#uvChallenge(s, body)
      case 'uv.assert': return this.#uvAssert(s, line, req)
      case 'uv.register': return this.#uvRegister(s, body)
      case 'device.revoke': {
        const target = body.deviceId
        if (typeof target !== 'string' || !HEX32.test(target)) return { status: RES_STATUS.badRequest, bytes: errorBody('bad-request') }
        const t = this.#devices.get(target)
        if (!t || t.state === 'revoked') return { status: RES_STATUS.notFound, bytes: emptyBody(), target }
        // The registry's writer runs the revocation in the order of spec 6.1, and its line says which device asked.
        this.#d.note({ note: 'revoke-device', deviceId: s.deviceId, target })
        return { ...ok(resultBody('device.revoke', {})), target }
      }
      default:
        return { status: RES_STATUS.failed, bytes: errorBody('not-implemented') }
    }
  }

  /**
   * One read of a daemon extension (PIPE_REACH `ext-read`): the pair comes from EXT_READS by the line (./reads.ts), the
   * arguments are rebuilt here from the strict body of the line, and the body of the answer from the line's projector. A
   * read is no gesture and leaves no audit line (house.ts `audited`); its first success subscribes the session to the
   * thin notice of its family.
   */
  async #extRead(s: SessionRoute, op: Exclude<ExtReadOp, 'channels.file'>, body: Record<string, unknown>, scopes: readonly string[]): Promise<Served> {
    const reads = this.#d.reads
    if (!reads) return { status: RES_STATUS.failed, bytes: errorBody('not-implemented') }
    const bad: Served = { status: RES_STATUS.badRequest, bytes: errorBody('bad-request') }
    const count = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
    let bytes: Bytes
    try {
      switch (op) {
        case 'channels.marks': {
          const marks = await this.#marks!.get()
          this.#sawModerator(marks)
          bytes = resultBody(op, marks as MarksSource)
          break
        }
        case 'channels.page': {
          const { channel, before } = body
          const limit = body.limit ?? PAGE_LINES_MAX
          if (typeof channel !== 'string' || !CHANNEL_ID.test(channel)) return bad
          if (before !== undefined && !count(before, 1, Number.MAX_SAFE_INTEGER)) return bad
          if (!count(limit, 1, PAGE_LINES_MAX)) return bad
          const at = before !== undefined ? { before } : {}
          const answer = await reads.read(op, { channel, limit, ...at })
          this.#sawModerator(answer)
          bytes = resultBody(op, { answer, limit, ...at, home: this.#d.userHome })
          break
        }
        case 'regency.tree': {
          const view = await reads.read(op, {})
          // The first call's text is a line of a channel: the tree carries it only to a device that may read the channels.
          bytes = resultBody(op, { view, channels: scopes.includes(opByName('channels.marks')!.scope), home: this.#d.userHome })
          const v = (view && typeof view === 'object' ? view : {}) as { live?: unknown; sig?: unknown; asOf?: unknown }
          this.#feeds.sawTree(regencyChanged(v as RegencyChanged))
          break
        }
        // "+ Novo" (RR5 5.3): the choices; the projector drops every path (the folders go by id and label).
        case 'create.options':
          bytes = resultBody(op, { answer: await reads.read(op, {}) })
          break
      }
    } catch (e) {
      if (!(e instanceof ReadError)) throw e
      if (e.why === 'limit') return { status: RES_STATUS.limit, bytes: emptyBody() }
      if (e.why === 'refused' && e.code === 'unknown-channel') return { status: RES_STATUS.notFound, bytes: emptyBody() }
      if (e.why !== 'refused' || e.code !== 'bad-request') this.#d.log(`read ${op}: ${e.message}`)
      return { status: RES_STATUS.failed, bytes: errorBody('failed') }
    }
    if (bytes.length > READ_BODY_MAX) return { status: RES_STATUS.failed, bytes: errorBody('too-large') }
    if (op === 'regency.tree') s.follows.regency = true
    else if (op !== 'create.options') s.follows.channels = true
    return { status: RES_STATUS.ok, bytes }
  }

  /**
   * One write of a daemon extension (the pairs of EXT_WRITES: the person's speech in a channel, step 4.2a). Order: the body
   * checked field by field and the arguments rebuilt (src/remote/talk.ts), the speech's own ceiling, then the ONE pair of
   * the line through the write path (./writes.ts), never the read path's slots. The device is answered by the deadline;
   * the real outcome is kept for the actId whenever it comes (a repeat waits for it meanwhile, #pendingAct), so a resend
   * after reconnecting never speaks twice. Nothing here keeps an answer that was not tetherd's: a refusal before the pipe
   * or a `timeout` is `final: false`. The audit's target is the channel; the text never goes to it (M-10).
   */
  async #extWrite(s: SessionRoute, op: ExtWriteOp & TalkOp, req: Req, body: Record<string, unknown>): Promise<Served> {
    const writes = this.#d.writes
    if (!writes) return { status: RES_STATUS.failed, bytes: errorBody('not-implemented'), final: false }
    const checked = talkArgs(op, body)
    if (typeof checked === 'string') return { status: RES_STATUS.badRequest, bytes: errorBody(checked), final: false }
    const target = checked.channel
    // Checked again as the write is dispatched (RR4 B-4): a revocation that began while this request waited sends nothing.
    // From here to writes.write nothing awaits, so no revocation slips in between (nor are a speech's files marked said).
    if (this.#closedTo(s)) return { status: RES_STATUS.failed, bytes: errorBody('failed'), audit: 'refused:revoked', target, final: false }
    const mem = this.#memOf(s.deviceId)
    if (op === 'channels.say') {
      const rate = mem.limiter.speech(this.#d.now())
      if (rate !== 'ok') return { status: RES_STATUS.limit, bytes: errorBody('slow-down'), audit: `limit:speech`, target, final: false, ...(rate === 'close' ? { closeSession: true as const } : {}) }
    }
    // A speech's files: the ones uploaded under its own actId, whole, of this channel; tetherd gets their paths (never the
    // device's words) and copies them as it does the app's. Missing or not whole: `0x06 unknown-file`, nothing sent.
    let act: string | undefined
    if (checked.files) {
      const files = this.#d.files
      if (!files) return { status: RES_STATUS.failed, bytes: errorBody('not-implemented'), final: false }
      act = toHex(req.actId!)
      const sources = files.forSpeech(s.deviceId, act, target, checked.files)
      if (!sources) return { status: RES_STATUS.notFound, bytes: errorBody('unknown-file'), audit: 'refused:unknown-file', target, final: false }
      checked.args.files = sources
    }
    const flight = writes.write(op, checked.args)
    if (act !== undefined) {
      const files = this.#d.files!
      const speech = act
      // Its temporary files go once tetherd answered (it copied them, or refused); a speech never sent keeps them for a resend.
      void flight.settled.then((o) => files.settled(s.deviceId, speech, o.ok === false && o.error.why === 'limit'))
    }
    const id = req.actId ? toHex(req.actId) : undefined
    const outcome = (o: WriteOutcome): Served => this.#written(op, o, target)
    if (id && req.actId) {
      const actId = req.actId
      const kept = flight.settled.then((o): DoneAct => {
        const sv = outcome(o)
        // `limit`: never sent, so nothing to keep; any other outcome is the act's, whatever the device was told.
        if (!(o.ok === false && o.error.why === 'limit') && !UNCACHED_ACT_OPS.has(req.op)) mem.acts.put(actId, { op: req.op, status: sv.status, body: sv.bytes }, this.#d.now())
        return { op: req.op, status: sv.status, body: sv.bytes }
      })
      mem.pending.set(id, kept)
      void kept.finally(() => { if (mem.pending.get(id) === kept) mem.pending.delete(id) })
    }
    try {
      return { ...outcome({ ok: true, result: await flight.answer }), final: false }
    } catch (e) {
      const error = e instanceof WriteError ? e : new WriteError('failed')
      // Past the deadline the act may still happen: its real outcome gets its own audit line when it comes (RR4 B-3, M-10).
      const late = error.why === 'timeout'
        ? flight.settled.then((o) => { const sv = outcome(o); return sv.audit ?? statusName(sv.status) }, () => statusName(RES_STATUS.failed))
        : undefined
      return { ...outcome({ ok: false, error }), final: false, ...(late ? { late } : {}) }
    }
  }

  /**
   * `channels.file`: one chunk of a file of a line. The line is read from tetherd (one line of `history`, the pair of
   * EXT_READS), its path taken from there, and the file given only by ./files.ts's rule (inside that channel's folder once
   * resolved). Every refusal of where the file is (no line, no file at that index, a path outside, a link out, gone) is the
   * same `0x06`. The first chunk of a file leaves an audit line with its size (never its name).
   */
  async #fileRead(s: SessionRoute, body: Record<string, unknown>): Promise<Served> {
    const reads = this.#d.reads
    const files = this.#d.files
    if (!reads || !files) return { status: RES_STATUS.failed, bytes: errorBody('not-implemented') }
    const a = fileReadArgs(body)
    if (typeof a === 'string') return { status: RES_STATUS.badRequest, bytes: errorBody('bad-request') }
    const notFound: Served = { status: RES_STATUS.notFound, bytes: emptyBody() }
    let answer: unknown
    try { answer = await reads.read('channels.file', { channel: a.channel, before: a.seq + 1, limit: 1 }) } catch (e) {
      if (!(e instanceof ReadError)) throw e
      if (e.why === 'limit') return { status: RES_STATUS.limit, bytes: errorBody('busy') }
      if (e.why === 'refused' && e.code === 'unknown-channel') return notFound
      this.#d.log(`read channels.file: ${e.message}`)
      return { status: RES_STATUS.failed, bytes: errorBody('failed') }
    }
    const path = linePathOf(answer, a.seq, a.file)
    if (!path) return notFound
    const c = await files.chunk(a.channel, path, a.offset)
    if (c === 'not-found') return notFound
    if (c === 'busy') return { status: RES_STATUS.limit, bytes: errorBody('busy') }
    if (c === 'too-large') return { status: RES_STATUS.failed, bytes: errorBody('too-large') }
    if (c === 'bad-request') return { status: RES_STATUS.badRequest, bytes: errorBody('bad-request') }
    if (a.offset === 0) this.#audit('channels.file', `ok:${c.size}`, s.deviceId, a.channel)
    return { status: RES_STATUS.ok, bytes: resultBody('channels.file', c) }
  }

  /**
   * `channels.upload`: one chunk of a file of a speech still to be said (./files.ts). A repeat changes nothing; an offset
   * the portal is not at answers where it is (`received`), so a device that comes back goes on from there. The last chunk's
   * audit line carries the file's size; the others are `ok` (the audit counts equal lines together).
   */
  async #upload(s: SessionRoute, body: Record<string, unknown>): Promise<Served> {
    const files = this.#d.files
    if (!files) return { status: RES_STATUS.failed, bytes: errorBody('not-implemented'), final: false }
    const a = uploadArgs(body)
    if (a === 'too-large') return { status: RES_STATUS.badRequest, bytes: errorBody('too-large') }
    if (typeof a === 'string') return { status: RES_STATUS.badRequest, bytes: errorBody('bad-request') }
    const target = a.channel
    const shut: Served = { status: RES_STATUS.failed, bytes: errorBody('failed'), audit: 'refused:revoked', target, final: false }
    if (this.#closedTo(s)) return shut
    const r = await files.upload(s.deviceId, a)
    // Revoked while the chunk was written: what it left goes now, the forgetting of the device having run before it (RR4 B-4).
    if (this.#deviceShut(s.deviceId)) { await files.forgetDevice(s.deviceId); return shut }
    switch (r) {
      case 'busy': return { status: RES_STATUS.limit, bytes: errorBody('busy'), audit: 'limit:busy', target, final: false }
      case 'not-found': return { status: RES_STATUS.notFound, bytes: errorBody('unknown-channel'), target }
      case 'bad-request': return { status: RES_STATUS.badRequest, bytes: errorBody('bad-request'), target }
      case 'secret-file': return { status: RES_STATUS.failed, bytes: errorBody('secret-file'), audit: 'refused:secret-file', target }
      case 'failed': return { status: RES_STATUS.failed, bytes: errorBody('failed'), target, final: false }
    }
    return { status: RES_STATUS.ok, bytes: resultBody('channels.upload', r), target, ...(r.done ? { audit: `done:${a.size}` } : {}) }
  }

  /** `channels.upload-cancel`: the files of a speech still to be said go (one, or all). */
  async #uploadCancel(s: SessionRoute, body: Record<string, unknown>): Promise<Served> {
    const files = this.#d.files
    if (!files) return { status: RES_STATUS.failed, bytes: errorBody('not-implemented'), final: false }
    const a = cancelArgs(body)
    if (typeof a === 'string') return { status: RES_STATUS.badRequest, bytes: errorBody('bad-request') }
    await files.cancel(s.deviceId, a.act, a.file)
    return { status: RES_STATUS.ok, bytes: resultBody('channels.upload-cancel', {}) }
  }

  /** The answer of a write's outcome: the line's projector on success, tetherd's code mapped by TALK_REFUSALS otherwise. */
  #written(op: ExtWriteOp & TalkOp, o: WriteOutcome, target: string): Served {
    if (o.ok) {
      const bytes = resultBody(op, { answer: o.result })
      return bytes.length > READ_BODY_MAX ? { status: RES_STATUS.failed, bytes: errorBody('too-large'), target } : { status: RES_STATUS.ok, bytes, target }
    }
    const e = o.error
    if (e.why === 'limit') return { status: RES_STATUS.limit, bytes: errorBody('busy'), audit: 'limit:busy', target }
    if (e.why === 'timeout') return { status: RES_STATUS.failed, bytes: errorBody('timeout'), audit: 'timeout', target }
    if (e.why === 'refused' && isTalkRefusal(e.code)) return { status: TALK_REFUSALS[e.code], bytes: errorBody(e.code), audit: `refused:${e.code}`, target }
    this.#d.log(`write ${op}: ${e.message}`)
    return { status: RES_STATUS.failed, bytes: errorBody('failed'), target }
  }

  /**
   * One management act (RR5 5.2, fio-spec 16): the body checked field by field and the ONE pipe message of the op rebuilt
   * (src/remote/manage.ts), the door conferred again as it is dispatched (RR4 B-4), then the act path (./acts.ts), which
   * checks the message by tetherd's own rule before sending. The target is the real id the device named; tetherd resolves
   * it and a stale one comes back `0x06`. A read answers through the projector; an act like a write (#extWrite): by its
   * deadline to the device, its real outcome kept for the actId whenever it comes (a repeat waits for it meanwhile), so a
   * resend after reconnecting never stops or restarts twice. Refused "in use by another", the answer carries the uses of
   * the others (a fresh read of the process), the board the app shows; going ahead is the `-force` op, a second act.
   */
  async #manage(s: SessionRoute, op: ManageOp, req: Req, body: Record<string, unknown>): Promise<Served> {
    const acts = this.#d.acts
    if (!acts) return { status: RES_STATUS.failed, bytes: errorBody('not-implemented'), final: false }
    const checked = manageArgs(op, body)
    if (typeof checked === 'string') return { status: RES_STATUS.badRequest, bytes: errorBody(checked), final: false }
    const { msg, target } = checked
    const aim = target === '' ? {} : { target }
    if (this.#closedTo(s)) return { status: RES_STATUS.failed, bytes: errorBody('failed'), audit: 'refused:revoked', ...aim, final: false }
    if (!opByName(op)!.mutates) {
      try {
        const reply = await acts.read(msg)
        const bytes = resultBody(op, { answer: reply })
        return bytes.length > READ_BODY_MAX ? { status: RES_STATUS.failed, bytes: errorBody('too-large') } : { status: RES_STATUS.ok, bytes }
      } catch (e) {
        return this.#acted(op, { ok: false, error: e instanceof ActError ? e : new ActError('failed') }, target)
      }
    }
    const flight = acts.act(msg)
    // The real outcome as the device would be told it (the board of uses read once), whenever tetherd answers.
    const result = flight.settled.then((o) => this.#acted(op, o, target)).catch((): Served => ({ status: RES_STATUS.failed, bytes: errorBody('failed'), ...aim }))
    const mem = this.#memOf(s.deviceId)
    if (req.actId) {
      const actId = req.actId
      const id = toHex(actId)
      const kept = Promise.all([flight.settled, result]).then(([o, sv]): DoneAct => {
        if (!(o.ok === false && o.error.why === 'limit')) mem.acts.put(actId, { op: req.op, status: sv.status, body: sv.bytes }, this.#d.now())
        return { op: req.op, status: sv.status, body: sv.bytes }
      })
      mem.pending.set(id, kept)
      void kept.finally(() => { if (mem.pending.get(id) === kept) mem.pending.delete(id) })
    }
    try {
      await flight.answer
    } catch (e) {
      if (e instanceof ActError && e.why === 'timeout') {
        const late = result.then((sv) => sv.audit ?? statusName(sv.status))
        return { status: RES_STATUS.failed, bytes: errorBody('timeout'), audit: 'timeout', ...aim, final: false, late }
      }
    }
    return { ...(await result), final: false }
  }

  /** The answer of an act's outcome: the line's projector on success; tetherd's code mapped by ACT_REFUSALS otherwise. */
  async #acted(op: ManageOp, o: ActOutcome, target: string): Promise<Served> {
    const aim = target === '' ? {} : { target }
    if (o.ok) {
      const bytes = resultBody(op, { answer: o.reply })
      return bytes.length > READ_BODY_MAX ? { status: RES_STATUS.failed, bytes: errorBody('too-large'), ...aim } : { status: RES_STATUS.ok, bytes, ...aim }
    }
    const e = o.error
    if (e.why === 'limit') return { status: RES_STATUS.limit, bytes: errorBody('busy'), audit: 'limit:busy', ...aim }
    if (e.why === 'timeout') return { status: RES_STATUS.failed, bytes: errorBody('timeout'), audit: 'timeout', ...aim }
    if (e.why === 'refused' && isActRefusal(e.code)) {
      if (e.code === 'proc-in-use') return { status: ACT_REFUSALS[e.code], bytes: inUseBody(await this.#othersUses(target)), audit: 'refused:proc-in-use', ...aim }
      return { status: ACT_REFUSALS[e.code], bytes: errorBody(e.code), audit: `refused:${e.code}`, ...aim }
    }
    this.#d.log(`act ${op}: ${e.message}`)
    return { status: RES_STATUS.failed, bytes: errorBody('failed'), ...aim }
  }

  /**
   * One gesture the app does (RR5 5.1, fio-spec 17): the act built from the strict body by the closed list
   * (src/remote/app-acts.ts), the door conferred again as it is dispatched (RR4 B-4), then the ONE pair `regency/act` through
   * the app acts' own write path. tetherd confers the ids, refuses `no-app` at once when no app holds the tree's lease and
   * hands the act to the app. As a write (#extWrite): the device is answered by the deadline, the real outcome is kept for
   * the actId whenever it comes (a repeat waits for it meanwhile) and, past the deadline, gets its own `late:` audit line.
   * The audit's target is the pane, the slot or the desk by its id; never a desk's name.
   */
  async #appAct(s: SessionRoute, op: AppActOp | CreateSlotOp, req: Req, body: Record<string, unknown>): Promise<Served> {
    const acts = this.#d.appActs
    if (!acts) return { status: RES_STATUS.failed, bytes: errorBody('not-implemented'), final: false }
    // An agent or a terminal of "+ Novo" (RR5 5.3) goes the same path to the ONE pair `regency/create`: tetherd creates it alone.
    const checked = isCreateSlotOp(op) ? createSlotArgs(op, body) : appActArgs(op, body)
    if (typeof checked === 'string') return { status: RES_STATUS.badRequest, bytes: errorBody(checked), final: false }
    const aim = checked.target === '' ? {} : { target: checked.target }
    // From here to acts.write nothing awaits, so no revocation slips in between.
    if (this.#closedTo(s)) return { status: RES_STATUS.failed, bytes: errorBody('failed'), audit: 'refused:revoked', ...aim, final: false }
    const flight = acts.write(op, checked.args as unknown as Record<string, unknown>)
    const outcome = (o: WriteOutcome): Served => this.#appActed(op, o, checked.target)
    const mem = this.#memOf(s.deviceId)
    if (req.actId) {
      const actId = req.actId
      const id = toHex(actId)
      const kept = flight.settled.then((o): DoneAct => {
        const sv = outcome(o)
        // `limit`: never sent, so nothing to keep; any other outcome is the act's, whatever the device was told.
        if (!(o.ok === false && o.error.why === 'limit')) mem.acts.put(actId, { op: req.op, status: sv.status, body: sv.bytes }, this.#d.now())
        return { op: req.op, status: sv.status, body: sv.bytes }
      })
      mem.pending.set(id, kept)
      void kept.finally(() => { if (mem.pending.get(id) === kept) mem.pending.delete(id) })
    }
    try {
      return { ...outcome({ ok: true, result: await flight.answer }), final: false }
    } catch (e) {
      const error = e instanceof WriteError ? e : new WriteError('failed')
      const late = error.why === 'timeout'
        ? flight.settled.then((o) => { const sv = outcome(o); return sv.audit ?? statusName(sv.status) }, () => statusName(RES_STATUS.failed))
        : undefined
      return { ...outcome({ ok: false, error }), final: false, ...(late ? { late } : {}) }
    }
  }

  /** The answer of an app's act: the line's projector on success, tetherd's or the app's code mapped by APP_ACT_REFUSALS otherwise. */
  #appActed(op: AppActOp | CreateSlotOp, o: WriteOutcome, target: string): Served {
    const aim = target === '' ? {} : { target }
    if (o.ok) return { status: RES_STATUS.ok, bytes: resultBody(op, { answer: o.result }), ...aim }
    const e = o.error
    if (e.why === 'limit') return { status: RES_STATUS.limit, bytes: errorBody('busy'), audit: 'limit:busy', ...aim }
    if (e.why === 'timeout') return { status: RES_STATUS.failed, bytes: errorBody('timeout'), audit: 'timeout', ...aim }
    if (e.why === 'refused' && isCreateRefusal(e.code)) return { status: CREATE_REFUSALS[e.code], bytes: errorBody(e.code), audit: `refused:${e.code}`, ...aim }
    if (e.why === 'refused' && isAppActRefusal(e.code)) return { status: APP_ACT_REFUSALS[e.code], bytes: errorBody(e.code), audit: `refused:${e.code}`, ...aim }
    this.#d.log(`app act ${op}: ${e.message}`)
    return { status: RES_STATUS.failed, bytes: errorBody('failed'), ...aim }
  }

  /** The uses of a process by others than the person (the app's `othersUses`), read now; none when it cannot be read. */
  async #othersUses(name: string): Promise<unknown[]> {
    try {
      const reply = await this.#d.acts!.read({ t: 'proc-info', name })
      const uses = (reply.proc as { uses?: unknown } | undefined)?.uses
      const now = this.#d.now()
      return Array.isArray(uses)
        ? uses.filter((u) => recOf(recOf(u).by).kind !== 'app' && Date.parse(String(recOf(u).until)) > now)
        : []
    } catch { return [] }
  }

  /**
   * The outcome of a write of this device still waiting for tetherd under the same actId, within one write's deadline; past
   * it, `timeout` again (the act is NOT run a second time). Undefined when no write of that actId is waiting.
   */
  async #pendingAct(mem: DeviceMem, actId: Bytes, op: number, waitMs?: number): Promise<DoneAct | undefined> {
    const waiting = mem.pending.get(toHex(actId))
    if (!waiting) return undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<undefined>((r) => { timer = setTimeout(() => r(undefined), waitMs ?? this.#d.writeTimeoutMs ?? PIPE_WRITE_TIMEOUT_MS) })
    try {
      const done = await Promise.race([waiting, late])
      return done ?? { op, status: RES_STATUS.failed, body: errorBody('timeout') }
    } finally { clearTimeout(timer) }
  }

  #presenceBody(s: SessionRoute): { presence: Presence; elevUntil: number } {
    const p = this.#sessionPresence(s, this.#d.now())
    return { presence: p.presence, elevUntil: p.elevUntilS }
  }

  // ---- presence (spec 7.4) -------------------------------------------------------------------------------------

  /**
   * `uv.challenge { purpose, op? }`: a new counter and the one pending challenge of the session (a new one replaces it).
   * For an unlock or an elevation the answer carries the challenge; for an act only the counter, because the challenge of
   * an act is computed from the request that carries the proof, by the device before sending and by the portal on receipt.
   */
  async #uvChallenge(s: SessionRoute, body: Record<string, unknown>): Promise<Served> {
    const bad: Served = { status: RES_STATUS.badRequest, bytes: errorBody('bad-request') }
    const purpose = body.purpose
    if (purpose !== 'unlock' && purpose !== 'elevate' && purpose !== 'act') return bad
    const op = body.op
    if (purpose === 'act' ? typeof op !== 'number' || opByCode(op)?.presence !== 'per-act' : op !== undefined) return bad
    const nowMs = this.#d.now()
    if (!this.#credential(s.deviceId)) return { status: RES_STATUS.presenceRequired, bytes: emptyBody() }
    if (this.#memOf(s.deviceId).presence.lockedOut(nowMs)) return { status: RES_STATUS.limit, bytes: emptyBody() }
    if (s.uvCtr >= 0xffffffff) return { status: RES_STATUS.failed, bytes: errorBody('refused') }
    const uvCtr = ++s.uvCtr
    s.uvPending = { uvCtr, purpose, ...(purpose === 'act' ? { op: op as number } : {}), issuedMs: nowMs }
    if (purpose === 'act') return { status: RES_STATUS.ok, bytes: resultBody('uv.challenge', { uvCtr }) }
    const challenge = await assertionChallenge(s.session.sessionId, uvCtr, this.#context(s, purpose))
    return { status: RES_STATUS.ok, bytes: resultBody('uv.challenge', { uvCtr, challenge: b64url(challenge) }) }
  }

  #context(s: SessionRoute, purpose: 'unlock' | 'elevate'): PresenceContext {
    return purpose === 'elevate' ? { purpose: 'elevate', deviceId: fromHex(s.deviceId) } : { purpose: 'unlock' }
  }

  /** `uv.assert` with the proof in the envelope: unlocks, or opens the elevation window (which also renews the unlock). */
  async #uvAssert(s: SessionRoute, line: OpLine, req: Req): Promise<Served> {
    if (!req.uvProof) return { status: RES_STATUS.badRequest, bytes: errorBody('bad-request') }
    const v = await this.#checkProof(s, line, req)
    if (!v.ok) return { status: v.status, bytes: emptyBody(), audit: v.audit, ...(v.lockout ? { lockout: true } : {}) }
    const p = this.#memOf(s.deviceId).presence
    const nowMs = this.#d.now()
    if (v.purpose === 'elevate') p.elevate(nowMs)
    else p.unlock(nowMs)
    return { status: RES_STATUS.ok, bytes: resultBody('uv.assert', this.#presenceBody(s)), audit: `ok:${v.purpose}` }
  }

  /**
   * Verifies the proof of `req` against the pending challenge of the session, which is taken here whatever follows (one
   * use). Inside the device's lane: the stored counter is compared and the new one written before the next proof of the
   * same device is looked at. A refusal by the counter has its own line and does not count toward the lockout.
   */
  async #checkProof(s: SessionRoute, line: OpLine, req: Req): Promise<ProofVerdict> {
    const pending = s.uvPending
    s.uvPending = undefined
    const proof = req.uvProof!
    const mem = this.#memOf(s.deviceId)
    return mem.presence.serial(async (): Promise<ProofVerdict> => {
      const nowMs = this.#d.now()
      const cred = this.#credential(s.deviceId)
      if (!cred) {
        const why = this.#devices.get(s.deviceId)?.credential ? 'other-origin' : 'no-credential'
        return { ok: false, status: RES_STATUS.presenceRequired, audit: `refused:${why}` }
      }
      // The relying party stored with the credential, which usableCredential found equal to the remote's current one.
      const rp: RelyingParty = { origin: cred.origin!, rpId: cred.rpId! }
      if (mem.presence.lockedOut(nowMs)) return { ok: false, status: RES_STATUS.limit, audit: 'refused:locked-out' }
      const isAct = line.presence === 'per-act'
      const fits = pending !== undefined && challengeLive(pending, nowMs) && pending.uvCtr === proof.uvCtr
        && (isAct ? pending.purpose === 'act' && pending.op === req.op : pending.purpose !== 'act')
      let reason = 'challenge'
      if (fits) {
        const ctx: PresenceContext = isAct
          ? { purpose: 'act', op: req.op, actId: req.actId!, body: req.body }
          : this.#context(s, pending.purpose as 'unlock' | 'elevate')
        const challenge = await assertionChallenge(s.session.sessionId, pending.uvCtr, ctx)
        const v = await verifyAssertion({ rp, challenge, proof, credential: { publicKey: fromHex(cred.publicKey), signCount: cred.signCount } })
        if (v.ok) {
          if (v.signCount !== cred.signCount) {
            try { await this.#d.ask({ ask: 'sign-count', deviceId: s.deviceId, signCount: v.signCount }) } catch {
              return { ok: false, status: RES_STATUS.failed, audit: 'failed:registry' }
            }
            cred.signCount = v.signCount
          }
          mem.presence.accepted()
          return { ok: true, purpose: pending.purpose }
        }
        if (v.reason === 'sign-count') {
          this.#audit('uv.sign-count', 'refused', s.deviceId, line.name)
          return { ok: false, status: RES_STATUS.presenceRequired, audit: 'refused:sign-count' }
        }
        reason = v.reason
      }
      if (mem.presence.invalid(nowMs) === 'locked-out') {
        this.#audit('uv.lockout', 'locked', s.deviceId, line.name)
        return { ok: false, status: RES_STATUS.presenceRequired, audit: `refused:${reason}`, lockout: true }
      }
      return { ok: false, status: RES_STATUS.presenceRequired, audit: `refused:${reason}` }
    })
  }

  /**
   * `uv.register { clientDataJSON, attestationObject }` (base64url), only in the session that concluded the pairing (the
   * gate) and once per device: the registration is as trustworthy as that session, the only one that can carry it. Without
   * the origin of the PWA, or with an authenticator this profile refuses, the device stays without credential and only reads.
   */
  async #uvRegister(s: SessionRoute, body: Record<string, unknown>): Promise<Served> {
    const refused = (why: string): Served => ({ status: RES_STATUS.failed, bytes: errorBody('refused'), audit: `refused:${why}` })
    const bad: Served = { status: RES_STATUS.badRequest, bytes: errorBody('bad-request') }
    const dv = this.#devices.get(s.deviceId)
    const rp = this.#rp
    if (!dv || dv.state === 'revoked' || this.#mem.get(s.deviceId)?.revoking) return refused('device')
    if (dv.credential) return refused('already')
    if (!rp) return refused('no-origin')
    const cd = body.clientDataJSON
    const ao = body.attestationObject
    if (typeof cd !== 'string' || typeof ao !== 'string') return bad
    if (cd.length > b64Max(WEBAUTHN_LIMITS.clientDataJSON) || ao.length > b64Max(WEBAUTHN_LIMITS.attestationObject)) return bad
    let clientDataJSON: Bytes
    let attestationObject: Bytes
    try { clientDataJSON = fromB64url(cd); attestationObject = fromB64url(ao) } catch { return bad }
    return this.#memOf(s.deviceId).presence.serial(async (): Promise<Served> => {
      if (this.#devices.get(s.deviceId)?.credential) return refused('already')
      const challenge = await registrationChallenge(s.session.sessionId, fromHex(dv.pubD))
      const v = await verifyRegistration({ rp, challenge, clientDataJSON, attestationObject })
      if (!v.ok) return refused(v.reason)
      const credential = {
        credentialId: b64url(v.credential.credentialId), publicKey: toHex(v.credential.publicKey),
        signCount: v.credential.signCount, backupEligible: v.credential.backupEligible, rpId: rp.rpId, origin: rp.origin,
      }
      try { await this.#d.ask({ ask: 'credential', deviceId: s.deviceId, credential }) } catch { return { status: RES_STATUS.failed, bytes: errorBody('failed'), audit: 'failed:registry' } }
      const now = this.#devices.get(s.deviceId)
      if (now) now.credential = credential
      return { status: RES_STATUS.ok, bytes: resultBody('uv.register', this.#presenceBody(s)) }
    })
  }

  /**
   * The device went over its rate (src/remoted/limits.ts): the request is answered `limit` and leaves a line naming the
   * operation; a device that insists (`close`) loses the session with CLOSE(0x07). Its counters outlive the session.
   */
  async #overRate(s: SessionRoute, req: Req, kind: 'req' | 'gesture' | 'file', verdict: 'limit' | 'close'): Promise<void> {
    this.#audit(`limit.${kind}`, verdict, s.deviceId, opByCode(req.op)?.name)
    if (verdict === 'limit') return this.#send(s, req.reqId, RES_STATUS.limit, kind === 'file' ? errorBody('slow-down') : emptyBody())
    this.#sessionEffects(s, await s.session.close(CLOSE.limit, this.#d.now()))
  }

  /**
   * admit.renew: exempt from proof, never from a ceiling (src/remoted/limits.ts). Refused with `limit`, before anything is
   * issued or written, when the device renewed less than `renewMinGapS` ago, when its live ticket has not lived
   * `renewMinAgeS`, when its superseded tickets would pass `deniedPerDevice`, or when the relay's list has no room left
   * outside the revocations' reserve. Every refusal is audited (the line mutates) with its reason.
   */
  async #renew(s: SessionRoute, body: Record<string, unknown>): Promise<Served> {
    const refused: Served = { status: RES_STATUS.failed, bytes: errorBody('refused') }
    const bad: Served = { status: RES_STATUS.badRequest, bytes: errorBody('bad-request') }
    const limit = (why: string): Served => ({ status: RES_STATUS.limit, bytes: emptyBody(), audit: `limit:${why}` })
    const dv = this.#devices.get(s.deviceId)
    const mem = this.#memOf(s.deviceId)
    if (!dv || dv.state !== 'active' || mem.revoking) return refused
    if (typeof body.pubA !== 'string') return bad
    let pubA: Bytes
    try { pubA = fromB64url(body.pubA) } catch { return bad }
    const nowMs = this.#d.now()
    const nowS = Math.floor(nowMs / 1000)
    if (mem.lastRenewMs !== undefined && nowMs - mem.lastRenewMs < this.#lim.renewMinGapS * 1000) return limit('gap')
    const liveExp = Math.max(0, ...dv.tickets.map((t) => t.exp))
    if (nowS < liveExp - ADMIT_TTL_S + this.#lim.renewMinAgeS) return limit('age')
    const old = dv.tickets.slice()
    const denied = [...(dv.denied ?? []), ...old.map((t) => ({ ticketId: t.ticketId, exp: t.exp }))].filter((t) => t.exp + CLOCK_SKEW_S >= nowS)
    if (denied.length > this.#lim.deniedPerDevice) return limit('denied')
    if (!this.#denyRoom(old.length, this.#lim.denyRevokeReserve)) return limit('deny-list')
    if (!(await admitRenewKeyAllowed(pubA, fromHex(dv.pubD), dv.usedKeyIds.map(fromHex)))) return refused
    const { ticket, row } = await this.#issue(pubA)
    try { await this.#d.ask({ ask: 'renew', deviceId: s.deviceId, ticket: row }) } catch { return refused }
    mem.lastRenewMs = nowMs
    dv.tickets = [row]
    dv.denied = denied
    dv.usedKeyIds = [...dv.usedKeyIds, row.keyId].slice(-this.#lim.usedKeyIdsPerDevice)
    // One live ticket per device, plus the slack of the switch: the previous ones are denied a minute later. They count
    // against the room of the list from now on, so two renewals within the minute never promise the same room twice.
    this.#denyPending += old.length
    setTimeout(() => {
      this.#denyPending -= old.length
      const added = old.filter((t) => this.#addDeny(t.ticketId, t.exp)).map((t) => ({ ticketId: t.ticketId, exp: t.exp }))
      if (added.length) this.#sendDeny(added)
    }, this.#d.renewDenyAfterMs ?? RENEW_DENY_AFTER_MS).unref?.()
    return { status: RES_STATUS.ok, bytes: resultBody('admit.renew', { ticket: b64url(ticket) }) }
  }

  async #issue(pubA: Bytes): Promise<{ ticket: Bytes; row: { ticketId: string; exp: number; keyId: string } }> {
    const nowS = Math.floor(this.#d.now() / 1000)
    const cert = parseKeyCert(this.#d.keys.certT)
    const ticket = await issueAdmitTicket(this.#d.keys.kT, {
      certT: this.#d.keys.certT, pubA, aud: this.#d.aud, notBefore: nowS, exp: Math.min(nowS + ADMIT_TTL_S, cert.notAfter),
    })
    const t = parseAdmitTicket(ticket)
    return { ticket, row: { ticketId: toHex(t.ticketId), exp: t.exp, keyId: toHex(await keyIdOf(pubA)) } }
  }

  /** `body` comes from a projector of src/remote/projection.ts (resultBody, errorBody, emptyBody), never built here. */
  async #send(s: SessionRoute, reqId: number, status: ResStatus, body: Bytes): Promise<void> {
    if (s.session.state !== 'open') return
    try {
      const fx = await s.session.send('RES', encodeRes({ reqId, status, body }), this.#d.now())
      this.#sessionEffects(s, fx)
    } catch (e) { if (!(e instanceof WireError)) throw e }
  }

  // ---- time --------------------------------------------------------------------------------------------------

  async tick(): Promise<void> {
    const nowMs = this.#d.now()
    const idleMs = this.#d.idleMs ?? IDLE_LOCK_MS
    const jobs: Promise<void>[] = []
    for (const r of [...this.#routes.values()]) {
      if (r.kind === 'admit') jobs.push(r.hs.tick(nowMs).then((fx) => this.#hsEffects(r, fx)))
      else if (r.kind === 'session') {
        if (nowMs - r.lastReqMs >= idleMs) jobs.push(r.session.close(CLOSE.idle, nowMs).then((fx) => this.#sessionEffects(r, fx)))
        else jobs.push(r.session.tick(nowMs).then((fx) => this.#sessionEffects(r, fx)))
      }
    }
    if (this.#pairing && !this.#isOver(this.#pairing.view.state)) jobs.push(this.#pairing.p.tick(nowMs).then((fx) => this.#pairEffects(fx)))
    if (this.#d.files) jobs.push(this.#d.files.sweep(nowMs, this.#d.uploadIdleMs))
    if (this.#d.attention.takeChange()) jobs.push(this.#pushEvent(EVT.attentionChanged, this.#d.attention.items(), (r) => r.watching))
    // Who began to wait since the last tick: a notice each, to the devices with no session on the screen (step 4.4).
    const entered = this.#d.attention.takeEntered()
    if (entered.length > 0 && this.#d.push) {
      const targets = this.#pushTargets([PUSH_SCOPE])
      for (const it of entered) {
        const n = pushNotice({ kind: 'waiting', slotId: it.id })
        if (n && targets.length > 0) this.#d.push.notify(n, targets)
      }
    }
    const channels = this.#feeds.takeChannels(nowMs)
    if (channels) jobs.push(this.#pushEvent(EVT.channelsChanged, channels, (r) => r.follows.channels))
    const regency = this.#feeds.takeRegency(nowMs)
    if (regency) jobs.push(this.#pushEvent(EVT.regencyChanged, regency, (r) => r.follows.regency))
    await Promise.all(jobs)
  }

  /** One event to every open session that follows it and whose device may get it now (gateEvent: scope and presence). */
  async #pushEvent<K extends EvtName>(line: EvtLine & { name: K }, src: EventSource<K>, follows: (r: SessionRoute) => boolean): Promise<void> {
    const evt = encodeEvt({ evt: line.code, body: eventBody(line.name, src) })
    for (const r of [...this.#routes.values()]) {
      if (r.kind !== 'session' || !follows(r) || r.session.state !== 'open') continue
      const dv = this.#devices.get(r.deviceId)
      if (!gateEvent(line, { scopes: new Set(dv?.scopes ?? []), presence: this.#sessionPresence(r, this.#d.now()).presence })) continue
      try { this.#sessionEffects(r, await r.session.send('EVT', evt, this.#d.now())) } catch (e) { if (!(e instanceof WireError)) throw e }
    }
  }

  // ---- deny list ---------------------------------------------------------------------------------------------

  #addDeny(ticketId: string, exp: number): boolean {
    const cur = this.#deny.get(ticketId)
    if (cur !== undefined && cur >= exp) return false
    this.#deny.set(ticketId, exp)
    return true
  }

  /** Drops what the relay drops too (spec 11 Q13: `now > exp + CLOCK_SKEW`), so both count the same list. */
  #pruneDeny(): void {
    const nowS = Math.floor(this.#d.now() / 1000)
    for (const [id, exp] of this.#deny) if (nowS > exp + CLOCK_SKEW_S) this.#deny.delete(id)
    for (const [id, exp] of this.#rateDeny) if (nowS > exp + CLOCK_SKEW_S) this.#rateDeny.delete(id)
  }

  /** `n` more entries fit in the relay's list leaving `reserve` free (the denials due after renewals already count). */
  #denyRoom(n: number, reserve: number): boolean {
    this.#pruneDeny()
    return this.#deny.size + this.#denyPending + n <= DENY_MAX - reserve
  }

  /**
   * R_NOTICE from the relay. 0x02: an H_DENY was refused whole (its list is at DENY_MAX), so what it carried (a revocation,
   * a superseded ticket) is not refused there: the portal still refuses those devices, the relay no longer does. Audited
   * every time; the person gets a native notice at most once per `relayNoticeEveryS`.
   */
  #relayNotice(code: number): void {
    const name = code === NOTICE.limit ? 'deny-full' : code === NOTICE.secondHouse ? 'second-house' : String(code)
    this.#d.log(`relay notice ${code}`)
    this.#audit('relay.notice', name)
    if (code !== NOTICE.limit) return
    const nowMs = this.#d.now()
    if (this.#relayNoticeMs !== undefined && nowMs - this.#relayNoticeMs < this.#lim.relayNoticeEveryS * 1000) return
    this.#relayNoticeMs = nowMs
    this.#d.notice('O relay recusou a lista de bloqueio deste computador: um aparelho revogado ainda chega ao relay, mas não entra na máquina. Confira os aparelhos na tela do tether.')
  }

  #sendDeny(rows: readonly DenyRow[]): void {
    if (!this.#linkUp) return
    for (let i = 0; i < rows.length; i += 256) {
      this.#d.send(encodeOuter({ type: 'H_DENY', overflow: false, entries: rows.slice(i, i + 256).map((r) => ({ ticketId: fromHex(r.ticketId), exp: r.exp })) }))
    }
  }

  // ---- pairing -----------------------------------------------------------------------------------------------

  #isOver(s: PairView['state']): boolean { return s === 'done' || s === 'burned' }

  async pairBegin(): Promise<PairBegun> {
    if (!this.#linkUp) throw new PortalError('offline', 'o portal não está ligado ao relay agora')
    if (this.#pairing && !this.#isOver(this.#pairing.view.state)) {
      this.#pairEffects(await this.#pairing.p.cancel(this.#d.now()))
    }
    for (let attempt = 0; attempt < PAIR_REDRAWS; attempt++) {
      let p: HousePairing
      try { p = await HousePairing.create({ kH: this.#d.keys.kH, lockout: this.#lockout, nowMs: this.#d.now() }) } catch (e) {
        if (e instanceof WireError && e.code === 'locked') throw new PortalError('locked', 'pareamento bloqueado por uma hora depois de cinco tentativas falhas')
        throw e
      }
      const view: PairView = { pairId: toHex(p.pairId), state: 'open', expiresAt: p.expiresAtMs }
      const entry: PairingEntry = { p, view }
      this.#pairing = entry
      const state = await new Promise<number | undefined>((resolve) => {
        const timer = setTimeout(() => resolve(undefined), PAIR_STATE_WAIT_MS)
        entry.waitState = (code) => { clearTimeout(timer); entry.waitState = undefined; resolve(code) }
        this.#d.send(encodeOuter({ type: 'H_PAIR_LISTEN', ttl: 120, rvs: [p.rvCode, p.rvQr] }))
      })
      if (state === PAIR_STATE.listening) {
        const code = p.code()
        const qr = qrFragment(await p.qr(this.#d.aud))
        this.#d.notice('Um pareamento de aparelho foi iniciado neste computador. Se não foi você, cancele na tela do tether.')
        // The line of the request is the extension's (`pair.begin`, by whom); the portal says the ticket is out.
        this.#audit('pair.listen', 'ok')
        return { ...view, code, qr, fingerprint: this.#fingerprint }
      }
      await p.cancel(this.#d.now())
      this.#pairing = undefined
      this.#d.send(encodeOuter({ type: 'H_PAIR_CANCEL' }))
      if (state !== PAIR_STATE.rvInUse) throw new PortalError('relay', 'o relay não confirmou o ponto de encontro')
    }
    throw new PortalError('relay', 'o relay recusou os pontos de encontro sorteados')
  }

  #pairOf(pairId: string): PairingEntry {
    const pr = this.#pairing
    if (!pr || pr.view.pairId !== pairId) throw new PortalError('not-found', 'nenhum pareamento com esse id')
    return pr
  }

  pairState(pairId: string): PairView { return { ...this.#pairOf(pairId).view } }

  async pairSas(pairId: string, digits: string): Promise<PairView> {
    const pr = this.#pairOf(pairId)
    if (pr.view.state !== 'waiting-sas') throw new PortalError('bad-state', 'o pareamento não está esperando os dígitos')
    this.#pairEffects(await pr.p.submitSas(digits, this.#d.now()))
    // sas-ok continues asynchronously (registry write, then PAIR_DONE); the view says where it is.
    return { ...pr.view }
  }

  async pairCancel(pairId: string): Promise<PairView> {
    const pr = this.#pairOf(pairId)
    if (!this.#isOver(pr.view.state)) this.#pairEffects(await pr.p.cancel(this.#d.now()))
    return { ...pr.view }
  }

  #pairEffects(fx: HousePairEffect[]): void {
    const pr = this.#pairing
    if (!pr) return
    for (const e of fx) {
      switch (e.t) {
        case 'send': this.#data(e.route, e.frame); break
        case 'close': if (this.#routes.has(e.route)) this.#close(e.route); break
        case 'await-sas':
          pr.view.state = 'waiting-sas'
          pr.view.device = { declaredName: sanitizeDeclaredName(e.device.declaredName).slice(0, 64), caps: e.device.caps, access: e.device.access }
          pr.view.triesLeft = 3
          break
        case 'sas-wrong': pr.view.triesLeft = e.triesLeft; break
        case 'sas-ok': pr.view.state = 'confirmed'; void this.#confirm(pr, e.device); break
        case 'burned': {
          pr.view.state = 'burned'
          pr.view.burnReason = e.reason
          delete pr.view.triesLeft
          if (this.#linkUp) this.#d.send(encodeOuter({ type: 'H_PAIR_CANCEL' }))
          if (e.eraseDeviceId) {
            const id = toHex(e.eraseDeviceId)
            this.#devices.delete(id)
            this.#d.note({ note: 'erase', deviceId: id })
          }
          this.#audit('pair.refused', e.reason, e.eraseDeviceId ? toHex(e.eraseDeviceId) : undefined)
          if (e.countsForLockout || e.reason === 'collision') {
            this.#d.notice(e.reason === 'collision'
              ? 'Duas tentativas de pareamento ao mesmo tempo: o código foi anulado. Gere outro.'
              : 'Um pareamento de aparelho falhou neste computador e o código foi anulado.')
          }
          break
        }
        case 'done': {
          pr.view.state = 'done'
          delete pr.view.triesLeft
          if (this.#linkUp) this.#d.send(encodeOuter({ type: 'H_PAIR_CANCEL' }))
          const deviceId = toHex(e.deviceId)
          const dv = this.#devices.get(deviceId)
          if (dv) dv.state = 'active'
          this.#adopt(e.route, e.session, deviceId, true)
          this.#d.note({ note: 'acked', deviceId })
          this.#d.notice('Um aparelho foi pareado com este computador. Você pode revogá-lo a qualquer momento.')
          break
        }
      }
    }
  }

  async #confirm(pr: PairingEntry, device: { deviceId: Bytes; pubD: Bytes; pubA: Bytes; name: string; ver: number; access: 'code' | 'qr' }): Promise<void> {
    const deviceId = toHex(device.deviceId)
    try {
      const { ticket, row } = await this.#issue(device.pubA)
      const name = sanitizeDeclaredName(device.name).slice(0, 64)
      await this.#d.ask({ ask: 'paired', device: { deviceId, pubD: toHex(device.pubD), name, ver: device.ver, access: device.access }, ticket: row })
      this.#devices.set(deviceId, {
        deviceId, pubD: toHex(device.pubD), state: 'pending', maxVerUsed: device.ver, scopes: [...DEFAULT_SCOPES],
        tickets: [row], usedKeyIds: [row.keyId],
      })
      if (this.#pairing !== pr) return
      this.#pairEffects(await pr.p.confirm({ admitTicket: ticket, houseName: sanitizeDeclaredName(this.#d.houseName).slice(0, 64), nowMs: this.#d.now() }))
    } catch (e) {
      this.#d.log(`pairing: the device could not be written (${(e as Error).message}); cancelled`)
      if (this.#pairing === pr) this.#pairEffects(await pr.p.cancel(this.#d.now()))
    }
  }
}

/** A line of the table whose every request is audited: it changes state or is a gesture. */
export const audited = (line: OpLine): boolean => line.mutates || line.gesture

/** The name of a RES status, as the audit says it (`ok`, `failed`, `presenceRequired`…). */
const statusName = (status: ResStatus): string => Object.entries(RES_STATUS).find(([, v]) => v === status)?.[0] ?? String(status)

/** Every scope a device gets at pairing (plano §2 "Escopos": all on, adjustable on the machine from RR2). */
export const DEFAULT_SCOPES = SCOPE_FAMILIES

export class PortalError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'PortalError'
    this.code = code
  }
}
