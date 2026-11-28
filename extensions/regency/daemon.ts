// The Regency's daemon half (RR3 3.2): keeps the ONE tree the app last published (plano D2 (b)) and gives it, joined with
// the slots tetherd sees live, to whoever reads it. Memory is bounded: one tree of at most TREE_MAX_BYTES, one timer.
//
// Requests (ext `regency`):
// - `tree.publish { sig, tree? }`, from the app only: with `tree`, the tree is projected again by the allow list, measured,
//   signed and kept (`{ sig, at }`); without it, a lease: "still the tree `sig`" (`{ sig }`), or `{ need: 'tree' }` when
//   tetherd does not keep that tree (it restarted, or another tree came meanwhile).
// - `tree.read {}`: the view a remote screen draws (publish-rules.ts regencyViewOf): `{ input, live, asOf?, sig? }`.
// - `act`, `act.take`, `act.done`: the bridge of the app's gestures asked from afar (RR5 5.1, ActBridge below).
// Event `tree.changed { sig?, at?, live }`: a new tree was kept, or its lease ran out (the app left). It carries no tree.
// Event `act { ask, act, until }`: an act for the app to claim and do.
//
// How tetherd knows the app left: the lease. The open app renews it every LEASE_MS; a tree not renewed for STALE_MS is
// the app's last (the app closed, crashed or hangs). No connection hook is needed, and a reload simply publishes again.
import { toDisposable, type IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { remoteBenchOn } from '../../src/core/paths.ts'
import { DoorError } from '../../src/daemon/door/port.ts'
import type { TetherDaemon } from '../../src/daemon/ext-api.ts'
import type { DeskMap, DeskMapDesk, DoorSlots, ExtRequestContext } from '../../src/daemon/door/types.ts'
import type { ErrorCode } from '../../src/daemon/protocol.ts'
import {
  ACT_TAKE, APP_ACT_BRIDGE_MS, APP_ACT_DONE, APP_ACT_EVENT, APP_ACT_REQUEST, APP_ACTS_PENDING_MAX, APP_ANSWER_CODES, appActAnswer, appActTarget, parseAppAct, seenMatches,
  type AppAct, type AppActAnswer, type AppActCode, type AppActEvent,
} from '../../src/remote/app-acts.ts'
import {
  CREATE_DESKS_MAX, CREATE_OPTIONS_REQUEST, CREATE_PROFILES_MAX, CREATE_REQUEST, createSlotAnswer, knownFolders, parseCreateSlot,
  type CreateCode, type CreateOptionsAnswer, type CreateSlotAnswer, type KnownFolder,
} from '../../src/remote/create.ts'
import { join } from 'node:path'
import type { RegencyInput } from './model.ts'
import {
  isLive, publishedTreeOf, regencyViewOf, signatureOf, STALE_MS, TREE_CHANGED as EVT_CHANGED, TREE_MAX_BYTES, TREE_REQ as REQ,
  treeJson, utf8Length, type KeptTree, type PublishAnswer, type RegencyView,
} from './publish-rules.ts'
import type { RemoteState } from './remote-input.ts'

export { manifest } from './manifest.ts'

const SIG_RE = /^[0-9a-f]{16}$/

export interface TreeKeeperDeps {
  now?: () => number
  live?: () => RemoteState
  emit?: (name: string, payload: unknown) => void
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
  /** The bench: a `test` connection may publish too (never `cli` or `remote`). */
  bench?: boolean
}

/** The one kept tree and its lease. */
export class TreeKeeper {
  #kept: KeptTree | undefined
  #timer: unknown
  readonly #now: () => number
  readonly #live: () => RemoteState
  readonly #emit: (name: string, payload: unknown) => void
  readonly #setTimer: (fn: () => void, ms: number) => unknown
  readonly #clearTimer: (t: unknown) => void
  readonly #bench: boolean

  constructor(deps: TreeKeeperDeps = {}) {
    this.#now = deps.now ?? Date.now
    this.#live = deps.live ?? (() => ({}))
    this.#emit = deps.emit ?? (() => {})
    this.#setTimer = deps.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t })
    this.#clearTimer = deps.clearTimer ?? (t => clearTimeout(t as ReturnType<typeof setTimeout>))
    this.#bench = deps.bench ?? false
  }

  get kept(): KeptTree | undefined { return this.#kept }

  publish(args: unknown, ctx: ExtRequestContext): PublishAnswer {
    if (!(ctx.client === 'app' || (this.#bench && ctx.client === 'test'))) throw new DoorError('door-denied', 'só o app publica a árvore da Regência')
    const a = (args && typeof args === 'object' ? args : {}) as { sig?: unknown; tree?: unknown }
    const now = this.#now()
    if (a.tree === undefined) {
      if (typeof a.sig !== 'string' || !SIG_RE.test(a.sig)) throw new DoorError('bad-request', 'tree.publish sem sig nem árvore')
      // The lease counts only from the connection that published the kept tree: the signature goes to every client in
      // `tree.changed`, so naming it proves nothing, and a lease from elsewhere would keep `live` after the app left. Any
      // other connection is asked for the tree (a publish of its own, visible as a new tree).
      if (!this.#kept || this.#kept.sig !== a.sig || this.#kept.conn === undefined || this.#kept.conn !== ctx.conn) return { need: 'tree' }
      const wasLive = isLive(this.#kept, now)
      this.#kept.seenAt = now
      this.#arm()
      if (!wasLive) this.#emit(EVT_CHANGED, { sig: this.#kept.sig, at: this.#kept.at, live: true })
      return { sig: this.#kept.sig }
    }
    if (!a.tree || typeof a.tree !== 'object') throw new DoorError('bad-request', 'tree.publish: árvore inválida')
    const tree = publishedTreeOf(a.tree as RegencyInput)
    const json = treeJson(tree)
    const bytes = utf8Length(json)
    if (bytes > TREE_MAX_BYTES) throw new DoorError('bad-request', `árvore grande demais (${bytes} bytes; o teto é ${TREE_MAX_BYTES})`)
    const sig = signatureOf(json)
    // The same tree from another connection is a new publish (the lease changes hands in the open, as a new tree).
    const same = this.#kept?.sig === sig && this.#kept.conn === ctx.conn
    const wasLive = isLive(this.#kept, now)
    // The same tree again keeps its time: "como estavam às" names when it last changed, not when it was last sent.
    this.#kept = { tree, sig, bytes, at: same ? this.#kept!.at : now, seenAt: now, ...(ctx.conn !== undefined ? { conn: ctx.conn } : {}) }
    this.#arm()
    if (!same || !wasLive) this.#emit(EVT_CHANGED, { sig, at: this.#kept.at, live: true })
    return { sig, at: this.#kept.at }
  }

  read(): RegencyView {
    return regencyViewOf(this.#kept, this.#live(), this.#now())
  }

  /** Whether an app holds the lease of the kept tree now, and the connection that published it. */
  liveApp(): { live: boolean; conn?: number } {
    const k = this.#kept
    return { live: isLive(k, this.#now()), ...(k?.conn !== undefined ? { conn: k.conn } : {}) }
  }

  /** One timer: when the lease runs out, the screens hear that the app left. */
  #arm(): void {
    if (this.#timer !== undefined) this.#clearTimer(this.#timer)
    this.#timer = this.#setTimer(() => {
      this.#timer = undefined
      const k = this.#kept
      if (k && !isLive(k, this.#now())) this.#emit(EVT_CHANGED, { sig: k.sig, at: k.at, live: false })
    }, STALE_MS + 1)
  }

  dispose(): void {
    if (this.#timer !== undefined) this.#clearTimer(this.#timer)
    this.#timer = undefined
  }
}

// ---- the bridge of acts (RR5 5.1, fio-spec 17) ---------------------------------------------------------------------
//
// The gestures only the app knows (hibernate a desk, move a pane, give a desk to an agent...) asked from afar: the portal
// sends `act { act, ...ids }` (src/remote/app-acts.ts, the closed list taken here field by field), tetherd confers what it
// can alone and hands the act to the app, in the SleepBridge's mould (extensions/for-agents/daemon/verbs/hibernate.ts):
//   1. the event `act { ask, act, until }` to every client; the app claims it with `act.take { ask }` within ACK_MS, and
//      only a claim tetherd accepts lets the app act (so an act tetherd gave up on never runs, and nothing waits for an app
//      that opens later: no claim in time is `no-app`, nothing kept);
//   2. the app does it as its own gesture and answers `act.done { ask, ok, ... }` within the bridge's wait, else `no-answer`.
// No app holding the tree's lease: `no-app` at once. One act at a time per target (a desk, a pane, a slot), and at most
// APP_ACTS_PENDING_MAX waiting: `busy`. Memory: one entry and one timer per act waiting, bounded by that ceiling.

/** How long the app has to claim an act: past it, there is no app to do it (`no-app`). */
export const ACT_ACK_MS = 2_000
const LIVE_STATUS: ReadonlySet<string> = new Set(['running', 'starting', 'queued'])
const refuseAct = (code: AppActCode | 'bad-request' | 'door-denied', message: string): never => { throw new DoorError(code as ErrorCode, message) }

export interface ActBridgeDeps {
  /** tetherd's own knowledge: the desk map the app last sent, and the slots. */
  map: () => DeskMap | undefined
  slots: Pick<DoorSlots, 'get' | 'userFree' | 'start'>
  /** Whether an app holds the tree's lease now, and its connection (an answer comes only from it). */
  app: () => { live: boolean; conn?: number }
  emit: (name: string, payload: unknown) => void
  now?: () => number
  ackMs?: number
  bridgeMs?: number
  /** The bench: a `test` connection may ask and answer too. */
  bench?: boolean
  /** The map changed (api.desks.onDidChange): an act's answer waits for the map to show what it made. */
  mapChanged?: (listener: () => void) => IDisposable
  mapWaitMs?: number
  /** Whether a folder id is of the list tetherd knows now ("+ Novo", a note): absent, none is. */
  folderKnown?: (id: string) => Promise<boolean>
}

/** How long an answer waits for tetherd's map to show what the act made. */
export const MAP_WAIT_MS = 3_000

interface Waiting { target: string; claimed: boolean; done: (a: Record<string, unknown> | AppActCode) => void; timer: ReturnType<typeof setTimeout> }

export class ActBridge {
  readonly #d: ActBridgeDeps
  readonly #waiting = new Map<string, Waiting>()
  readonly #targets = new Set<string>()
  #seq = 0

  constructor(deps: ActBridgeDeps) { this.#d = deps }

  get pending(): number { return this.#waiting.size }

  /** `act`: from the portal (`remote`) only; the act by the closed list, conferred, then the app's answer. */
  async act(args: unknown, ctx: ExtRequestContext): Promise<AppActAnswer> {
    if (!(ctx.client === 'remote' || (this.#d.bench && ctx.client === 'test'))) refuseAct('door-denied', 'só o portal pede um ato da Regência')
    const a = parseAppAct(args) ?? refuseAct('bad-request', 'ato fora da lista')
    const map = this.#d.map()
    // Waking a pane is the slot's start: tetherd does it alone, with or without the app (the app clears the moon on any
    // stopped → live change of the slot, now or when it opens).
    if (a.act === 'panes.wake') {
      this.#paneOf(map, a.deskId, a.paneId)
      const slot = this.#d.slots.get(a.paneId) ?? refuseAct('cannot', 'só guias com processo despertam')
      if (LIVE_STATUS.has(slot.status)) return { state: 'already' }
      if (slot.status === 'unconfirmed') refuseAct('unconfirmed', 'a sessão desta guia precisa de uma escolha na própria guia')
      await this.#d.slots.start(a.paneId)
      return { state: 'done' }
    }
    if (!this.#d.app().live || !map) refuseAct('no-app', 'o app não está aberto; nada foi feito')
    this.#confer(a, map!)
    // A note's folder: an id of the list tetherd knows now (the app looks it up again in its own).
    if (a.act === 'create.note' && !(await this.#d.folderKnown?.(a.folder))) refuseAct('unknown-folder', 'essa pasta não está entre as conhecidas')
    const target = appActTarget(a)
    if (this.#waiting.size >= APP_ACTS_PENDING_MAX || (target !== '' && this.#targets.has(target))) refuseAct('busy', 'outro ato espera o app')
    const answer = await this.#ask(a, target)
    if (typeof answer === 'string') refuseAct(answer, 'o app não fez o ato')
    const r = answer as Record<string, unknown>
    if (r.ok !== true) refuseAct((APP_ANSWER_CODES as readonly unknown[]).includes(r.code) ? (r.code as AppActCode) : 'refused', 'o app recusou o ato')
    const out = appActAnswer(r)
    await this.#mapShows(a, out)
    return out
  }

  /**
   * What an act made (a new desk, a pane on another desk, a reopened session) is answered once tetherd's own map shows it,
   * so the very next act on it is not refused as unknown; bounded by MAP_WAIT_MS (the map comes from the app, a moment after).
   */
  async #mapShows(a: AppAct, out: AppActAnswer): Promise<void> {
    const hasPane = (deskId: string, paneId: string): boolean => this.#d.map()?.desks.some((d) => d.id === deskId && d.panes.some((p) => p.id === paneId)) === true
    const shown: (() => boolean) | undefined =
      a.act === 'desks.create' && out.deskId ? () => this.#d.map()?.desks.some((d) => d.id === out.deskId) === true
      : a.act === 'panes.move' ? () => hasPane(a.to, a.paneId)
      : a.act === 'closed.reopen' ? () => hasPane(a.deskId, a.slotId)
      : undefined
    const watch = this.#d.mapChanged
    if (!shown || shown() || !watch) return
    await new Promise<void>((resolve) => {
      const end = (): void => { clearTimeout(timer); sub.dispose(); resolve() }
      const sub = watch(() => { if (shown()) end() })
      const timer = setTimeout(end, this.#d.mapWaitMs ?? MAP_WAIT_MS)
    })
  }

  /** `act.take { ask }`: the app claims an act; only a claimed act may be done. A claim of an act not waiting is refused. */
  take(args: unknown, ctx: ExtRequestContext): { go: true } {
    const w = this.#answering(args, ctx)
    if (w.claimed) refuseAct('bad-request', 'ato já tomado')
    w.claimed = true
    clearTimeout(w.timer)
    w.timer = setTimeout(() => this.#settle(String((args as { ask: unknown }).ask), 'no-answer'), this.#d.bridgeMs ?? APP_ACT_BRIDGE_MS)
    return { go: true }
  }

  /** `act.done { ask, ok, state?, deskId?, code? }`: the app's answer to an act it claimed. */
  done(args: unknown, ctx: ExtRequestContext): Record<string, never> {
    const w = this.#answering(args, ctx)
    if (!w.claimed) refuseAct('bad-request', 'ato não tomado')
    const a = args as Record<string, unknown>
    if (typeof a.ok !== 'boolean') refuseAct('bad-request', 'act.done: { ask, ok }')
    this.#settle(String(a.ask), a)
    return {}
  }

  dispose(): void {
    for (const ask of [...this.#waiting.keys()]) this.#settle(ask, 'no-app')
  }

  /** The act waiting for this answer, from the app's connection that holds the lease. */
  #answering(args: unknown, ctx: ExtRequestContext): Waiting {
    if (!(ctx.client === 'app' || (this.#d.bench && ctx.client === 'test'))) refuseAct('door-denied', 'só o app responde a um ato')
    const app = this.#d.app()
    if (app.conn !== undefined && ctx.conn !== undefined && ctx.conn !== app.conn) refuseAct('door-denied', 'só o app que publica a árvore responde')
    const ask = (args as { ask?: unknown } | undefined)?.ask
    const w = typeof ask === 'string' ? this.#waiting.get(ask) : undefined
    return w ?? refuseAct('bad-request', 'nenhum ato com esse ask')
  }

  #ask(act: AppAct, target: string): Promise<Record<string, unknown> | AppActCode> {
    const ask = `a${++this.#seq}`
    const now = (this.#d.now ?? Date.now)()
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.#settle(ask, 'no-app'), this.#d.ackMs ?? ACT_ACK_MS)
      this.#waiting.set(ask, { target, claimed: false, done: resolve, timer })
      if (target !== '') this.#targets.add(target)
      this.#d.emit(APP_ACT_EVENT, { ask, act, until: now + (this.#d.ackMs ?? ACT_ACK_MS) } satisfies AppActEvent)
    })
  }

  #settle(ask: string, answer: Record<string, unknown> | AppActCode): void {
    const w = this.#waiting.get(ask)
    if (!w) return
    this.#waiting.delete(ask)
    this.#targets.delete(w.target)
    clearTimeout(w.timer)
    w.done(answer)
  }

  /** A queue desk of the map, by id. */
  #desk(map: DeskMap | undefined, id: string): DeskMapDesk {
    const d = map?.desks.find((x) => x.id === id)
    return d && d.kind === 'queue' ? d : refuseAct('unknown-desk', 'essa mesa não existe')
  }

  /** A pane of that desk, by id: the device names the desk it saw the pane in, and a pane that moved since is unknown. */
  #paneOf(map: DeskMap | undefined, deskId: string, paneId: string): { id: string; type: string } {
    return this.#desk(map, deskId).panes.find((p) => p.id === paneId) ?? refuseAct('unknown-pane', 'essa guia não está nessa mesa')
  }

  /** The pane of a slot, and the person not typing in it now (an act would take it from under her hands). */
  #handsOff(paneId: string): void {
    if (this.#d.slots.get(paneId) && !this.#d.slots.userFree(paneId)) refuseAct('with-user', 'a pessoa está usando esta guia agora')
  }

  /** What tetherd confers alone, from its map and its slots; the app confers the rest with its own rules. */
  #confer(a: AppAct, map: DeskMap): void {
    const inMap = (id: string): boolean => map.desks.some((d) => d.panes.some((p) => p.id === id)) || map.drawer.some((p) => p.id === id)
    // An act that destroys or changes who holds a desk or a pane names the desk as the device saw it (RR5 M-1): a desk of
    // that id under another name is not the one the person confirmed.
    if ('seen' in a && !seenMatches(a, this.#desk(map, a.deskId).name)) refuseAct('stale', 'a mesa mudou desde que o aparelho a viu')
    switch (a.act) {
      case 'desks.create': return
      case 'desks.hibernate': case 'desks.wake': case 'desks.rename': case 'desks.color': case 'desks.close':
        this.#desk(map, a.deskId)
        return
      case 'panes.hibernate': case 'panes.suspend':
        this.#paneOf(map, a.deskId, a.paneId)
        if (!this.#d.slots.get(a.paneId)) refuseAct('cannot', 'só guias com processo hibernam ou suspendem')
        this.#handsOff(a.paneId)
        return
      case 'panes.move':
        this.#paneOf(map, a.deskId, a.paneId)
        this.#desk(map, a.to)
        if (a.to === a.deskId) refuseAct('same-desk', 'a guia já está nessa mesa')
        this.#handsOff(a.paneId)
        return
      case 'panes.close':
        this.#paneOf(map, a.deskId, a.paneId)
        this.#handsOff(a.paneId)
        return
      case 'closed.reopen':
        this.#desk(map, a.deskId)
        if (!this.#d.slots.get(a.slotId)) refuseAct('unknown-slot', 'essa sessão não existe')
        if (inMap(a.slotId)) refuseAct('not-closed', 'essa sessão tem guia')
        return
      case 'closed.forget':
        if (!this.#d.slots.get(a.slotId)) refuseAct('unknown-slot', 'essa sessão não existe')
        if (inMap(a.slotId)) refuseAct('not-closed', 'essa sessão tem guia')
        return
      case 'owners.give': case 'owners.revoke': case 'owners.take': case 'owners.return':
        if (a.paneId !== undefined) {
          const p = this.#paneOf(map, a.deskId, a.paneId)
          // Ownership is about the panes of a slot (a terminal's): a note, a browser tab or a channel is never given.
          if (p.type !== 'terminal' || !this.#d.slots.get(a.paneId)) refuseAct('cannot', 'só guias de agente ou de terminal têm dono')
        } else this.#desk(map, a.deskId)
        if (a.act === 'owners.give' && !this.#d.slots.get(a.to)) refuseAct('unknown-agent', 'esse agente não existe')
        return
      // "+ Novo" from afar (RR5 5.3): the desk is of the queue (the folder of a note was conferred before, in `act`).
      case 'create.note': case 'create.browser':
        this.#desk(map, a.deskId)
        return
    }
  }
}

// ---- "+ Novo" from afar (RR5 5.3, fio-spec 18) ---------------------------------------------------------------------
//
// The choices a device gets (`create.options`) and the creation tetherd does alone (`create`: an agent or a terminal born in
// a desk). The device never names a path: a folder is one of the list tetherd knows, read fresh at each request from the
// same home the app writes (layout.json's pinned projects, recent-folders.json) and from its agents' folders, and named by
// its id (src/remote/create.ts folderId). A profile is named, within its engine; its env, args and folder never leave.
// Memory: nothing kept between requests.

const refuseCreate = (code: CreateCode | 'bad-request' | 'door-denied', message: string): never => { throw new DoorError(code as ErrorCode, message) }

export interface CreateDeps {
  map: () => DeskMap | undefined
  slots: Pick<DoorSlots, 'list' | 'create'>
  /** The engines registered now (`claude`, `codex`…), without `shell`. */
  engines: () => Promise<readonly string[]>
  /** The profiles the person keeps (profiles.json) and the one each engine opens with. */
  profiles: () => Promise<readonly { id: string; name: string; agent: string }[]>
  defaultFor: (engine: string) => { id: string; name: string; agent: string } | undefined
  /** The app's pinned projects and recent folders, from the home they share. */
  appFolders: () => Promise<{ pinned: readonly string[]; recent: readonly string[] }>
  exists: (path: string) => Promise<boolean>
  caseInsensitive: boolean
  /** The bench: a `test` connection may create too. */
  bench?: boolean
}

export class Creator {
  readonly #d: CreateDeps
  constructor(deps: CreateDeps) { this.#d = deps }

  async folders(): Promise<KnownFolder[]> {
    const app = await this.#d.appFolders()
    const agents = this.#d.slots.list().filter((s) => s.kind !== 'shell').map((s) => (s as { folder?: string }).folder ?? s.cwd)
    return knownFolders({ pinned: app.pinned, agents, recent: app.recent }, this.#d.caseInsensitive)
  }

  async #profiles(): Promise<{ id: string; name: string; engine: string; default?: true }[]> {
    const engines = new Set([...await this.#d.engines(), 'shell'])
    const out: { id: string; name: string; engine: string; default?: true }[] = []
    for (const p of await this.#d.profiles()) {
      if (!engines.has(p.agent) || out.length >= CREATE_PROFILES_MAX) continue
      out.push({ id: p.id, name: p.name, engine: p.agent, ...(this.#d.defaultFor(p.agent)?.id === p.id ? { default: true as const } : {}) })
    }
    // An engine the file has no profile of opens with the default tetherd merges in (core/profile.ts mergeMissingMotors).
    for (const e of engines) {
      const d = this.#d.defaultFor(e)
      if (d && !out.some((p) => p.id === d.id) && out.length < CREATE_PROFILES_MAX) out.push({ id: d.id, name: d.name, engine: e, default: true })
    }
    return out
  }

  /** `create.options`: the choices. The paths go to the portal, which keeps them (the projector drops them for the device). */
  async options(): Promise<CreateOptionsAnswer> {
    const desks = (this.#d.map()?.desks ?? []).filter((d) => d.kind === 'queue').slice(0, CREATE_DESKS_MAX)
    return {
      engines: [...await this.#d.engines(), 'shell'],
      profiles: (await this.#profiles()).map(({ id: _id, ...p }) => p),
      desks: desks.map((d) => ({ deskId: d.id, name: d.name, ...(d.asleep ? { asleep: true as const } : {}) })),
      folders: await this.folders(),
    }
  }

  /** The path of a folder id of the list now, or `unknown-folder`. */
  async folderPath(id: string): Promise<string> {
    return (await this.folders()).find((f) => f.id === id)?.path ?? refuseCreate('unknown-folder', 'essa pasta não está entre as conhecidas')
  }

  /** A queue desk of the map, awake. */
  desk(id: string): DeskMapDesk {
    const d = this.#d.map()?.desks.find((x) => x.id === id)
    if (!d || d.kind !== 'queue') return refuseCreate('unknown-desk', 'essa mesa não existe')
    if (d.asleep) refuseCreate('desk-asleep', 'essa mesa está hibernando')
    return d
  }

  /** `create`: from the portal (`remote`) only; the act exactly as it builds it, every choice resolved here, then the slot. */
  async create(args: unknown, ctx: ExtRequestContext): Promise<CreateSlotAnswer> {
    if (!(ctx.client === 'remote' || (this.#d.bench && ctx.client === 'test'))) refuseCreate('door-denied', 'só o portal pede uma criação de longe')
    const a = parseCreateSlot(args) ?? refuseCreate('bad-request', 'criação fora da forma')
    if (a.what === 'agent' && !(await this.#d.engines()).includes(a.engine)) refuseCreate('unknown-engine', 'esse motor não existe')
    this.desk(a.deskId)
    const cwd = await this.folderPath(a.folder)
    let profileId: string | undefined
    if (a.profile !== undefined) {
      profileId = (await this.#profiles()).find((p) => p.engine === a.engine && p.name === a.profile)?.id
      if (profileId === undefined) refuseCreate('unknown-profile', 'esse perfil não existe nesse motor')
    } else profileId = this.#d.defaultFor(a.engine)?.id
    if (!(await this.#d.exists(cwd))) refuseCreate('cwd-missing', 'a pasta não existe mais')
    let slot
    try {
      slot = await this.#d.slots.create({ kind: a.engine, cwd, ...(profileId ? { profileId } : {}), ...(a.name ? { name: a.name } : {}), desk: a.deskId, start: true })
    } catch (e) {
      // The desk vanished between the check and the create (`bad-request` of the map) or the launch failed: by code alone.
      const code = (e as { code?: unknown }).code
      refuseCreate(code === 'bad-request' ? 'unknown-desk' : 'spawn-failed', 'o tether não criou')
    }
    return createSlotAnswer({ slotId: slot!.slotId })
  }
}

/** The app's pinned projects (layout.json `workspace.pinned`) and recent folders (recent-folders.json), from the shared home. */
async function appFoldersOf(io: TetherDaemon['io'], home: string): Promise<{ pinned: string[]; recent: string[] }> {
  const json = async (name: string): Promise<unknown> => {
    try { const t = await io.tryReadText(join(home, name)); return t === undefined ? undefined : JSON.parse(t) } catch { return undefined }
  }
  const layout = await json('layout.json') as { workspace?: { pinned?: unknown } } | undefined
  const pinned = Array.isArray(layout?.workspace?.pinned) ? (layout.workspace.pinned as unknown[]).map((p) => (p as { path?: unknown })?.path).filter((p): p is string => typeof p === 'string') : []
  const recent = await json('recent-folders.json')
  return { pinned, recent: Array.isArray(recent) ? recent.filter((p): p is string => typeof p === 'string') : [] }
}

/** The profiles of profiles.json (names, engines, ids): only what the choices show. */
async function profilesOf(io: TetherDaemon['io'], home: string): Promise<{ id: string; name: string; agent: string }[]> {
  // Loaded when asked: core/profile.ts loads the agents, which load the extensions, this one among them (a cycle at import).
  const { parseProfilesFile, profilesPath } = await import('../../src/core/profile.ts')
  const text = await io.tryReadText(profilesPath(home)).catch(() => undefined)
  if (text === undefined) return []
  const parsed = parseProfilesFile(text)
  return parsed.ok ? parsed.profiles.map((p) => ({ id: p.id, name: p.name, agent: p.agent })) : []
}

/**
 * The bench of the Regency (a `test` connection may publish): TETHER_TEST_REMOTE_REGENCY=1, and only where the remote's bench
 * counts (src/core/paths.ts remoteBenchOn: the flag AND an explicit bench home). Its name is of the TETHER_TEST_REMOTE* family,
 * so a tetherd started by a CLI or the app never inherits it (daemonEnv drops the family).
 */
export function regencyBenchOn(env: NodeJS.ProcessEnv, home: string | undefined): boolean {
  return remoteBenchOn(env, home) && env.TETHER_TEST_REMOTE_REGENCY === '1'
}

export function activateWith(
  api: TetherDaemon, extra: TreeKeeperDeps = {}, actsExtra: Partial<ActBridgeDeps> = {}, createExtra: Partial<CreateDeps> = {},
): { keeper: TreeKeeper; acts: ActBridge; creator: Creator; disposables: IDisposable[] } {
  const bench = regencyBenchOn(process.env, api.home)
  const keeper = new TreeKeeper({
    live: () => ({ slots: api.slots.list(), deskMap: api.desks.map() }),
    emit: (name, payload) => api.events.emit(name, payload),
    bench,
    ...extra,
  })
  const creator = new Creator({
    map: () => api.desks.map(),
    slots: api.slots,
    // Loaded when asked, as profilesOf: the registry loads the agents, which load the extensions (a cycle at import).
    engines: async () => (await import('../../src/agents/registry.ts')).agentRegistry.names(),
    profiles: () => profilesOf(api.io, api.home),
    defaultFor: (engine) => api.profiles.defaultFor(engine),
    appFolders: () => appFoldersOf(api.io, api.home),
    exists: (path) => api.io.exists(path),
    caseInsensitive: process.platform === 'win32' || process.platform === 'darwin',
    bench,
    ...createExtra,
  })
  const acts = new ActBridge({
    map: () => api.desks.map(),
    slots: api.slots,
    app: () => keeper.liveApp(),
    emit: (name, payload) => api.events.emit(name, payload),
    mapChanged: (listener) => api.desks.onDidChange(() => listener()),
    folderKnown: async (id) => (await creator.folders()).some((f) => f.id === id),
    bench,
    ...actsExtra,
  })
  const disposables: IDisposable[] = [
    api.requests.handle(REQ.publish, (args, ctx) => keeper.publish(args, ctx)),
    api.requests.handle(REQ.read, () => keeper.read()),
    api.requests.handle(APP_ACT_REQUEST, (args, ctx) => acts.act(args, ctx)),
    api.requests.handle(ACT_TAKE, (args, ctx) => acts.take(args, ctx)),
    api.requests.handle(APP_ACT_DONE, (args, ctx) => acts.done(args, ctx)),
    api.requests.handle(CREATE_OPTIONS_REQUEST, () => creator.options()),
    api.requests.handle(CREATE_REQUEST, (args, ctx) => creator.create(args, ctx)),
    toDisposable(() => keeper.dispose()),
    toDisposable(() => acts.dispose()),
  ]
  return { keeper, acts, creator, disposables }
}

export function activate(api: TetherDaemon): IDisposable[] {
  return activateWith(api).disposables
}
