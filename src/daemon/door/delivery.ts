// The agent door's delivery (contract section 4): a message for an agent slot reaches it by the first path open, in order:
// 1. inside: the slot's `tether` MCP server has its GET stream open (Claude Code today). Works with the agent busy (it lands
//    between tool calls) and with the pane in the user's hands (the input box is never touched);
// 2. the terminal: only when ALL of these hold: the pane is `held` (an extension said an agent has it); the process is alive
//    and `running`; the turn is idle and the attention is not `waiting` (typing on a permission card would answer the card;
//    a rerouted `attentionFor` counts too); the user interlock is free (no draft, USER_QUIET_MS of silence: user-presence.ts);
//    and the last terminal delivery to the slot has settled (DOOR_SETTLE_MS, so the next one never lands before the turn the
//    previous one opened is seen as busy);
// 3. wait: a queue per slot, in order, kept in <home>/slots/<slot>.inbox.jsonl (whole file, temp + rename, async only).
//    A slot whose pane the app suspended (suspend.ts) is resumed then, and its queue goes once the agent is up.
// The tether never types over the user: no `held`, no terminal path, ever.
//
// The queue is looked at again only at edges that already exist, with no timer per slot: a slot's state went out
// (`stateChanged`, which `setHeld` also fires), the slot's MCP stream opened, and ONE silence timer for all slots, armed only
// while some queued slot waits for time alone (the user's silence or the settle).
//
// Known limit: Soul and Codex say nothing outside the screen when they show a permission card (no hook, no report), so for
// them "attention is not `waiting`" holds even on a card; only Claude's `waiting` is reliable. The `held` owner is the guard
// there until a screen reading exists.
import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { toDisposable, type DisposableStore, type IDisposable } from '../../../app/shared/vscode-lifecycle.ts'
import { agentRegistry } from '../../agents/registry.ts'
import { slotsDir } from '../../core/paths.ts'
import type { SlotState } from '../protocol.ts'
import { deliveryMeta } from './channel-meta.ts'
import { DoorError, doorUnavailable, type InputMark, type InputOrigin, type SlotPort } from './port.ts'
import { terminalText } from './terminal-text.ts'
import { typingOf, type Typing } from './typing.ts'
import { UserPresence } from './user-presence.ts'
import type { DeliveryMessage, DeliveryPoll, DeliveryReceipt, DeliveryRole, DeliveryState, DoorDelivery, Typist, TypistContext } from './types.ts'

/** After a terminal delivery, the next one to the same slot waits this long (and then for the turn it opened to end). */
export const DOOR_SETTLE_MS = 2_000

type Path = 'inside' | 'terminal'
const KINDS = new Set(['message', 'request', 'notice'])
const ROLES = new Set<DeliveryRole>(['user', 'moderator', 'owner', 'member', 'system'])
const INBOX_SUFFIX = '.inbox.jsonl'

/** One queued delivery, as it sits in memory and in the inbox file (one JSON per line). */
interface QueuedItem {
  id: string
  ext: string
  slotId: string
  msg: DeliveryMessage
  paths?: Path[]
  at: string
  /** Still queued at this time (ISO): dropped, never delivered late. */
  until?: string
}

/** What the delivery needs of the MCP server (DoorMcp): the stream state, the channel, the stream edges. */
export interface DeliveryMcp {
  connected(slotId: string): boolean
  /** Connected AND a client that starts a turn from a channel message (see DoorMcp.wakes). */
  wakes(slotId: string): boolean
  sendChannel(slotId: string, content: string, meta: Record<string, string>): boolean
  onDidStream(listener: (slotId: string, open: boolean) => void): IDisposable
}

export interface DeliveryOptions {
  port(): SlotPort | undefined
  mcp: DeliveryMcp
  log(msg: string): void
  /** The typing of a slot's agent (tests override); default: the agent contribution's, else the core's. */
  typingFor?(agent: string): Typing
  now?(): number
  /**
   * A delivery had to wait: the slot's pane may be suspended by the app (an idle agent stopped to save resources), and then
   * it is resumed; the queue goes on its own once the agent is up (the `stateChanged` and stream edges).
   */
  wake?(slotId: string): void
}

export function inboxPath(home: string, slotId: string): string {
  return join(slotsDir(home), `${slotId}${INBOX_SUFFIX}`)
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const isStr = (x: unknown): x is string => typeof x === 'string'

/** The message as given, checked; `bad-request` otherwise. */
export function checkMessage(raw: unknown): DeliveryMessage {
  const m = raw as Partial<DeliveryMessage> | null
  const from = m?.from as Partial<DeliveryMessage['from']> | undefined
  if (!m || typeof m !== 'object' || !isStr(m.kind) || !KINDS.has(m.kind) || !isStr(m.body)
    || !from || !isStr(from.name) || !isStr(from.id) || !from.id || !isStr(from.role) || !ROLES.has(from.role as DeliveryRole)
    || (m.room !== undefined && !isStr(m.room)) || (m.inReplyTo !== undefined && !isStr(m.inReplyTo))
    || (m.ref !== undefined && !isStr(m.ref)) || (m.reactions !== undefined && !isStr(m.reactions)) || (m.to !== undefined && !(Array.isArray(m.to) && m.to.every(isStr)))
    || (m.poll !== undefined && !isPoll(m.poll))) {
    throw new DoorError('bad-request', 'delivery.deliver: mensagem inválida (kind, from {name, id, role} e body são obrigatórios)')
  }
  const poll = m.poll
    ? { poll: m.poll.poll, ...(['options', 'closes', 'closedBy', 'tally'] as const).reduce<Partial<DeliveryPoll>>((o, k) => (m.poll![k] ? { ...o, [k]: m.poll![k] } : o), {}) }
    : undefined
  return {
    kind: m.kind,
    ...(m.room ? { room: m.room } : {}),
    from: { name: from.name, id: from.id, role: from.role as DeliveryRole },
    body: m.body,
    ...(m.inReplyTo ? { inReplyTo: m.inReplyTo } : {}),
    ...(m.to && m.to.length ? { to: [...m.to] } : {}),
    ...(m.ref ? { ref: m.ref } : {}),
    ...(m.reactions ? { reactions: m.reactions } : {}),
    ...(poll ? { poll } : {}),
  }
}

/** A poll part: `poll` a non-empty string, the other fields strings when present. */
function isPoll(p: unknown): p is DeliveryPoll {
  const x = p as Partial<DeliveryPoll> | null
  return !!x && typeof x === 'object' && isStr(x.poll) && x.poll !== ''
    && [x.options, x.closes, x.closedBy, x.tally].every((v) => v === undefined || isStr(v))
}

function checkUntil(raw: unknown): string | undefined {
  if (raw === undefined) return undefined
  if (!isStr(raw) || !Number.isFinite(Date.parse(raw))) throw new DoorError('bad-request', 'delivery.deliver: until deve ser uma data ISO')
  return raw
}

function checkPaths(raw: unknown): Path[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every((p) => p === 'inside' || p === 'terminal')) {
    throw new DoorError('bad-request', "delivery.deliver: paths deve ser uma lista não vazia de 'inside' e 'terminal'")
  }
  return [...new Set(raw as Path[])]
}

function parseItem(line: string, slotId: string): QueuedItem | undefined {
  try {
    const x = JSON.parse(line) as Partial<QueuedItem>
    if (!isStr(x.id) || !isStr(x.ext) || x.slotId !== slotId || !isStr(x.at)) return undefined
    return { id: x.id, ext: x.ext, slotId, msg: checkMessage(x.msg), ...(x.paths ? { paths: checkPaths(x.paths) } : {}), at: x.at, ...(x.until ? { until: checkUntil(x.until) } : {}) }
  } catch {
    return undefined
  }
}

export class DeliveryService {
  private readonly opts: DeliveryOptions
  private readonly now: () => number
  /** slot -> what waits for it, in order. Only slots with items are here. */
  private readonly queues = new Map<string, QueuedItem[]>()
  /** slot -> the tail of its pumps (one pump at a time per slot keeps the order). */
  private readonly pumps = new Map<string, Promise<void>>()
  /** Slots with a pump chained and not started yet: a new edge needs no second one. */
  private readonly scheduled = new Set<string>()
  /** Slots whose inbox file may exist. */
  private readonly filed = new Set<string>()
  private readonly fileOps = new Map<string, Promise<void>>()
  /** slot -> when its last terminal delivery settles (ms epoch). */
  private readonly settleAt = new Map<string, number>()
  private readonly listeners = new Set<{ ext: string; fn: (r: DeliveryReceipt) => void }>()
  /** engine (SlotMeta.agent) -> its typist; the last one registered is in place. */
  private readonly typists = new Map<string, { typist: Typist }>()
  /** Slots whose MCP stream opened at least once in this daemon's life (memory only; `forgotten` clears it). */
  private readonly hadStream = new Set<string>()
  readonly presence = new UserPresence()
  /** > 0 while the delivery itself writes to a PTY: those writes are not the user's (nor the holder's). */
  private selfWriting = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private timerAt = Infinity
  private readonly streamSub: IDisposable
  /** Resolves once the inboxes on disk are loaded (a restarted daemon). */
  ready: Promise<void> = Promise.resolve()

  constructor(opts: DeliveryOptions) {
    this.opts = opts
    this.now = opts.now ?? Date.now
    this.streamSub = opts.mcp.onDidStream((slotId, open) => {
      if (open) this.hadStream.add(slotId)
      if (open && this.queues.has(slotId)) void this.kick(slotId)
    })
  }

  // ---- server hooks (through DoorHost) ---------------------------------------------------------

  /** The server's port arrived: the inboxes a previous tetherd left are read (async), and each queue is looked at. */
  attach(port: SlotPort): void {
    this.ready = this.load(port.home).catch((e: unknown) => this.opts.log(`door: entrega: filas no disco ilegíveis: ${message(e)}`))
  }

  /** A slot's state went out: a busy turn takes the user's draft with it; a slot with a queue is looked at. */
  stateChanged(state: SlotState): void {
    if (state.turn === 'busy') this.presence.turnBusy(state.slotId)
    if (this.queues.has(state.slotId)) void this.kick(state.slotId)
  }

  /** Keystrokes reached a slot. The delivery's own writes are skipped; the user's and the holder's feed the interlock. */
  input(slotId: string, data: string, origin: InputOrigin, mark?: InputMark): void {
    if (origin === 'agent' && this.selfWriting > 0) return
    if (origin === 'agent' && mark?.answer) this.presence.activity(slotId, this.now(), 'agent')
    else this.presence.input(slotId, data, this.now(), origin)
    if (this.queues.has(slotId)) this.armTimer()
  }

  /** The slot was forgotten: what waited for it is `dropped`, and its inbox goes. */
  async forgotten(slotId: string): Promise<void> {
    await this.ready
    const items = this.queues.get(slotId) ?? []
    this.queues.delete(slotId)
    this.settleAt.delete(slotId)
    this.hadStream.delete(slotId)
    this.presence.forget(slotId)
    for (const item of items) this.emit(item, 'dropped')
    await this.persist(slotId)
    this.armTimer()
  }

  // ---- the extensions' API ---------------------------------------------------------------------

  /** Extension `ext`'s delivery, without `enable` (the host adds it: it is the MCP server's switch). */
  apiFor(ext: string, own: DisposableStore): Omit<DoorDelivery, 'enable'> {
    return {
      deliver: (slotId, msg, opts) => this.deliver(ext, slotId, msg, opts?.paths, opts?.until),
      pending: (slotId) => (this.queues.get(slotId) ?? []).filter((i) => i.ext === ext).map((i) => this.receipt(i, 'queued', i.at)),
      cancel: (id) => this.cancel(ext, id),
      onDidDeliver: (fn) => {
        const entry = { ext, fn }
        this.listeners.add(entry)
        return own.add(toDisposable(() => { this.listeners.delete(entry) }))
      },
      pathOf: (slotId) => this.pathOf(slotId),
      routeOf: (slotId) => this.routeOf(slotId),
      hasTools: (slotId) => this.hasTools(slotId),
      useTypist: (agent, typist) => {
        const entry = { typist }
        this.typists.set(agent, entry)
        return own.add(toDisposable(() => { if (this.typists.get(agent) === entry) this.typists.delete(agent) }))
      },
    }
  }

  /** How a slot receives now. */
  pathOf(slotId: string): 'inside' | 'terminal' | 'wait' {
    const port = this.opts.port()
    if (!port) return 'wait'
    if (this.opts.mcp.wakes(slotId)) return 'inside'
    return this.terminalReady(port, slotId) ? 'terminal' : 'wait'
  }

  /**
   * Pure: why the slot has no open path now, in one phrase; undefined when a path is open (inside or terminal). Mirrors the
   * tests of `terminalReady`, in the same order, and changes nothing.
   */
  waitReason(slotId: string): string | undefined {
    const port = this.opts.port()
    if (!port) return 'porta indisponível'
    if (this.opts.mcp.wakes(slotId)) return undefined
    if (!port.meta(slotId)?.held) return 'guia não held'
    if (!port.isAlive(slotId)) return 'processo não vivo'
    const state = port.stateOf(slotId)
    if (!state || state.status !== 'running') return `estado ${state?.status ?? 'desconhecido'} (não running)`
    if (state.turn === 'busy') return 'turno busy'
    if ((state.attention ?? state.attentionFor?.value) === 'waiting') return 'cartão (attention waiting)'
    const now = this.now()
    const hold = this.presence.hold(slotId)
    if (hold !== undefined && now < hold.at) {
      if (hold.at === Infinity) return 'rascunho do usuário na caixa'
      const left = Math.ceil(hold.at - now)
      return hold.kind === 'answer' ? `assentamento da resposta de cartão, faltam ${left} ms` : `silêncio de digitação, faltam ${left} ms`
    }
    const settle = this.settleAt.get(slotId) ?? 0
    if (now < settle) return `assentamento da entrega anterior, faltam ${Math.ceil(settle - now)} ms`
    return undefined
  }

  /** The route a slot has, with no interlock: inside if its stream is open, the terminal if an agent holds a live pane, else wait. */
  routeOf(slotId: string): 'inside' | 'terminal' | 'wait' {
    const port = this.opts.port()
    if (!port) return 'wait'
    if (this.opts.mcp.wakes(slotId)) return 'inside'
    return this.holdsTerminal(port, slotId) ? 'terminal' : 'wait'
  }

  /**
   * Sticky: the stream is open now, or it opened once in this daemon's life (an agent restarting has no stream for a while and
   * still has the tools). `connected`, not `wakes`: Codex has tools and does not wake. False means "not known", not "none".
   */
  hasTools(slotId: string): boolean {
    return this.hadStream.has(slotId) || this.opts.mcp.connected(slotId)
  }

  /** Stops the silence timer and the stream subscription (tests, teardown). */
  dispose(): void {
    this.streamSub.dispose()
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.timerAt = Infinity
  }

  /** The inbox writes so far are on disk (tests, teardown). */
  async flush(): Promise<void> { await Promise.all([...this.pumps.values(), ...this.fileOps.values()]) }

  // ---- delivery --------------------------------------------------------------------------------

  private async deliver(ext: string, slotId: string, rawMsg: DeliveryMessage, rawPaths: unknown, rawUntil?: unknown): Promise<DeliveryReceipt> {
    const port = this.opts.port()
    if (!port) throw doorUnavailable(`delivery.deliver, extensão ${ext}`)
    const msg = checkMessage(rawMsg)
    const paths = checkPaths(rawPaths)
    const until = checkUntil(rawUntil)
    await this.ready
    if (!port.meta(slotId)) throw new DoorError('unknown-slot', `slot desconhecido: ${slotId}`)
    const item: QueuedItem = {
      id: `m_${Date.now().toString(36)}${randomBytes(5).toString('hex')}`, ext, slotId, msg, ...(paths ? { paths } : {}), at: new Date().toISOString(),
      ...(until ? { until } : {}),
    }
    let result: DeliveryReceipt | undefined
    const listen = { ext: '', fn: (r: DeliveryReceipt): void => { if (r.id === item.id) result = r } }
    this.listeners.add(listen)
    try {
      this.enqueue(item)
      await this.kick(slotId)
    } finally {
      this.listeners.delete(listen)
    }
    if (result) return result
    // Still waiting: it goes to disk before the answer, so a restart does not lose it.
    this.opts.log(`door: entrega ${item.id} (${ext}) enfileirada para ${slotId}: ${this.waitReason(slotId) ?? (paths ? `paths ${paths.join('+')} sem caminho aberto` : 'o digitador não escreveu (fica na fila)')}`)
    await this.persist(slotId)
    this.opts.wake?.(slotId)
    return this.receipt(item, 'queued', item.at)
  }

  private cancel(ext: string, id: string): boolean {
    for (const [slotId, items] of this.queues) {
      const i = items.findIndex((x) => x.id === id && x.ext === ext)
      if (i < 0) continue
      items.splice(i, 1)
      if (items.length === 0) this.queues.delete(slotId)
      void this.persist(slotId)
      return true
    }
    return false
  }

  private enqueue(item: QueuedItem): void {
    const q = this.queues.get(item.slotId)
    if (q) q.push(item)
    else this.queues.set(item.slotId, [item])
  }

  /** Chains one pump of the slot after the running one (none chained twice); resolves when that pump is done. */
  private kick(slotId: string): Promise<void> {
    const pending = this.pumps.get(slotId)
    if (pending && this.scheduled.has(slotId)) return pending
    this.scheduled.add(slotId)
    const run = (pending ?? Promise.resolve())
      .then(() => { this.scheduled.delete(slotId); return this.pump(slotId) })
      .catch((e: unknown) => this.opts.log(`door: entrega para ${slotId} falhou: ${message(e)}`))
    this.pumps.set(slotId, run)
    void run.then(() => { if (this.pumps.get(slotId) === run) this.pumps.delete(slotId) })
    return run
  }

  /** Delivers the slot's queue from the head while a path is open; the first item that must wait stops it (the order holds). */
  private async pump(slotId: string): Promise<void> {
    const port = this.opts.port()
    if (!port) return
    let delivered = false
    for (;;) {
      const item = this.queues.get(slotId)?.[0]
      if (!item) break
      if (item.until !== undefined && Date.parse(item.until) <= this.now()) {
        this.shift(item, 'dropped')
        delivered = true
        continue
      }
      const insideOk = !item.paths || item.paths.includes('inside')
      const terminalOk = !item.paths || item.paths.includes('terminal')
      if (insideOk && this.opts.mcp.wakes(slotId) && this.opts.mcp.sendChannel(slotId, item.msg.body, deliveryMeta(item.msg, item.ext, item.id))) {
        this.shift(item, 'inside')
      } else if (terminalOk && this.terminalReady(port, slotId)) {
        const outcome = await this.type(port, slotId, item)
        if (outcome === 'held-back') break
        this.shift(item, 'typed', outcome === 'unsent')
      } else break
      delivered = true
    }
    if (delivered && this.filed.has(slotId)) await this.persist(slotId)
    this.armTimer()
  }

  /** The static part of the terminal path: the pane is held by an agent and its process is alive (shared by `terminalReady` and `routeOf`). */
  private holdsTerminal(port: SlotPort, slotId: string): boolean {
    return !!port.meta(slotId)?.held && port.isAlive(slotId)
  }

  /** The four conditions of the terminal path (see the header), plus the settle of the previous terminal delivery. */
  private terminalReady(port: SlotPort, slotId: string): boolean {
    if (!this.holdsTerminal(port, slotId)) return false
    const state = port.stateOf(slotId)
    if (!state || state.status !== 'running' || state.turn === 'busy') return false
    if ((state.attention ?? state.attentionFor?.value) === 'waiting') return false
    const now = this.now()
    return this.presence.isFree(slotId, now) && now >= (this.settleAt.get(slotId) ?? 0)
  }

  /**
   * Types the item with the engine's typist (useTypist), else with a typist made of the engine's typing, each chunk after its
   * wait. 'held-back' when nothing could be written (the item stays queued). Before the first byte the terminal path's
   * conditions are checked again (a typist may look at the screen first). Once the first chunk is in, the item counts as
   * typed: if the pane changed hands, the process died or the user typed during a wait, the rest (the Enter) is not sent and
   * nothing of the tether's goes after it: the text is left in the box, untouched, for whoever has the pane now, and the
   * outcome is 'unsent' (the receipt says `unsent`). The typist's own 'unsent' (it saw the Enter not taken) is 'unsent' too.
   */
  private async type(port: SlotPort, slotId: string, item: QueuedItem): Promise<'sent' | 'unsent' | 'held-back'> {
    const agent = port.meta(slotId)?.agent ?? 'shell'
    const typist = this.typists.get(agent)?.typist ?? this.typingTypist(agent)
    const typedAt = (): number | undefined => this.presence.freeAt(slotId)
    let mark: number | undefined
    let written = false
    /** A check failed or a write threw: nothing more of this delivery. */
    let refused = false
    /** The typist answered: a late write of its writes nothing. */
    let over = false
    const ctx: TypistContext = {
      slotId,
      log: (m) => this.opts.log(`door: entrega ${item.id} (${agent}): ${m}`),
      write: async (chunks) => {
        for (const chunk of chunks) {
          if (refused || over) return false
          if (chunk.waitMs && chunk.waitMs > 0) await sleep(chunk.waitMs)
          if (refused || over) return false
          if (!written ? !this.terminalReady(port, slotId) : (!port.meta(slotId)?.held || !port.isAlive(slotId) || typedAt() !== mark)) {
            if (written) this.opts.log(`door: entrega ${item.id}: o resto não foi digitado (a guia mudou de mãos, o processo saiu ou o usuário digitou)`)
            refused = true
            return false
          }
          this.selfWriting++
          try {
            port.write(slotId, chunk.data, 'agent')
          } catch (e) {
            this.opts.log(written ? `door: entrega ${item.id}: o resto não foi digitado (${message(e)})` : `door: entrega ${item.id}: terminal indisponível (${message(e)}); fica na fila`)
            refused = true
            return false
          } finally {
            this.selfWriting--
          }
          if (!written) { written = true; mark = typedAt() }
        }
        return true
      },
    }
    let answer: 'sent' | 'unsent'
    try {
      answer = await typist.type(ctx, terminalText(item.msg, item.ext, item.id))
    } catch (e) {
      this.opts.log(`door: entrega ${item.id}: o digitador de ${agent} falhou: ${message(e)}`)
      answer = 'unsent'
    }
    over = true
    if (!written) return 'held-back'
    this.settleAt.set(slotId, this.now() + DOOR_SETTLE_MS)
    return answer === 'sent' && !refused ? 'sent' : 'unsent'
  }

  /** The engine's typing as a typist: its chunks in one write (the behaviour before the typists). */
  private typingTypist(agent: string): Typist {
    const typing = this.opts.typingFor?.(agent) ?? typingOf(agent === 'shell' ? undefined : agentRegistry.get(agent))
    return { type: async (ctx, text) => ((await ctx.write(typing.submit(text))) ? 'sent' : 'unsent') }
  }

  private shift(item: QueuedItem, state: DeliveryState, unsent = false): void {
    const q = this.queues.get(item.slotId)
    if (q?.[0] === item) q.shift()
    if (q && q.length === 0) this.queues.delete(item.slotId)
    this.emit(item, state, unsent)
  }

  private receipt(item: QueuedItem, state: DeliveryState, at = new Date().toISOString(), unsent = false): DeliveryReceipt {
    return { id: item.id, slotId: item.slotId, state, at, ...(unsent ? { unsent: true as const } : {}) }
  }

  private emit(item: QueuedItem, state: DeliveryState, unsent = false): void {
    const r = this.receipt(item, state, undefined, unsent)
    for (const l of [...this.listeners]) {
      if (l.ext !== '' && l.ext !== item.ext) continue
      try { l.fn(r) } catch (e) { this.opts.log(`door: ouvinte da entrega falhou: ${message(e)}`) }
    }
  }

  // ---- the one silence timer -------------------------------------------------------------------

  /**
   * Armed at the earliest moment some queued slot is freed by time alone (the user's silence, the settle); not armed when no
   * queued slot waits for time. A draft has no time: only an edge (Enter, a busy turn) frees it.
   */
  private armTimer(): void {
    const now = this.now()
    let next = Infinity
    for (const slotId of this.queues.keys()) {
      const at = Math.max(this.presence.freeAt(slotId) ?? 0, this.settleAt.get(slotId) ?? 0)
      if (at > now && at < next) next = at
    }
    if (next === this.timerAt) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.timerAt = next
    if (next === Infinity) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.timerAt = Infinity
      for (const slotId of [...this.queues.keys()]) void this.kick(slotId)
      this.armTimer()
    }, next - now + 5)
    this.timer.unref?.()
  }

  // ---- disk ------------------------------------------------------------------------------------

  /** The queues of the inbox files in <home>/slots, in file order; then each queue is looked at. */
  private async load(home: string): Promise<void> {
    let names: string[]
    try { names = await readdir(slotsDir(home)) } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
      throw e
    }
    for (const name of names) {
      if (!name.endsWith(INBOX_SUFFIX)) continue
      const slotId = name.slice(0, -INBOX_SUFFIX.length)
      let text: string
      try { text = await readFile(join(slotsDir(home), name), 'utf8') } catch (e) { this.opts.log(`door: entrega: ${name} ilegível: ${message(e)}`); continue }
      this.filed.add(slotId)
      const items = text.split('\n').filter((l) => l.trim()).map((l) => parseItem(l, slotId))
      const good = items.filter((i): i is QueuedItem => i !== undefined)
      if (good.length < items.length) this.opts.log(`door: entrega: ${items.length - good.length} linha(s) inválida(s) em ${name}, ignoradas`)
      // Items queued while the file was being read go after the ones from disk.
      const later = this.queues.get(slotId) ?? []
      if (good.length + later.length > 0) this.queues.set(slotId, [...good, ...later])
    }
    for (const slotId of [...this.queues.keys()]) void this.kick(slotId)
  }

  /** Writes the slot's queue as it is now (temp + rename), or removes the file when it is empty; one op at a time per file. */
  private persist(slotId: string): Promise<void> {
    const home = this.opts.port()?.home
    if (home === undefined) return Promise.resolve()
    const items = this.queues.get(slotId) ?? []
    if (items.length === 0 && !this.filed.has(slotId)) return Promise.resolve()
    const file = inboxPath(home, slotId)
    const text = items.map((i) => JSON.stringify(i)).join('\n')
    if (items.length > 0) this.filed.add(slotId)
    else this.filed.delete(slotId)
    const op = items.length > 0
      ? async (): Promise<void> => {
        await mkdir(slotsDir(home), { recursive: true })
        const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
        await writeFile(tmp, text + '\n', 'utf8')
        await rename(tmp, file)
      }
      : (): Promise<void> => rm(file, { force: true })
    const prev = this.fileOps.get(file) ?? Promise.resolve()
    const mine = prev.then(op).catch((e: unknown) => this.opts.log(`door: entrega: não gravei ${file}: ${message(e)}`))
    this.fileOps.set(file, mine)
    void mine.then(() => { if (this.fileOps.get(file) === mine) this.fileOps.delete(file) })
    return mine
  }
}
