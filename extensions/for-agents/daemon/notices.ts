// The notice to the owner (tether for agents, contract 4): what happens in a pane an owner commands reaches the owner, never the
// person. The core already silenced what calls the person (the state leaves with `attentionFor` and no `attention`); this
// listens to `slots.onState`, finds out what the edge is (finished, asks permission, asks a question: the conductor's
// `detect`, read from the screen) and delivers one notice to the owner in the guia's name (`role: 'member'`: the body carries
// text written by the agent). The tether's own news (the person took or gave back a pane) goes with `role: 'system'`.
//
// One notice per edge: the key is (pane, value, idleSince), kept in memory only; the state is broadcast many times with the
// same `attentionFor` and only the first one is an edge. The key is forgotten when the attention goes (the owner acted).
//
// The owner away (process ended): the core shows the attention to the person again, nothing is delivered and nothing waits in
// a queue to grow old. When the owner runs again the desvio returns by itself and ONE notice says what waits now. A pane's
// pending notices (queued: the owner has no way in yet) are indexed by pane: a newer notice replaces them, and a change of
// ownership cancels them.
//
// Wiring in daemon.ts, one line after `wire` builds the pieces:   `disposables.push(...registerNotices(api, { store, gate }))`
import { slotIsLive, slotTitle } from '../../../app/shared/agent-info.ts'
import { toDisposable, type IDisposable } from '../../../app/shared/vscode-lifecycle.ts'
import { slotAnswerPath } from '../../../src/core/paths.ts'
import type { DeliveryMessage, DeliveryReceipt, TetherDaemon } from '../../../src/daemon/ext-api.ts'
import type { SlotState } from '../../../src/daemon/protocol.ts'
import { conductorRegistry, type DetectedCard } from '../conductor-api.ts'
import { OBJECT_KEYS } from '../rules.ts'
import { createScreenReaders, screenString, type ScreenReaders } from '../screen/index.ts'
import { buildContext } from './context.ts'
import type { WriteGate } from './guard.ts'
import type { OwnershipStore } from './ownership.ts'
import { detectOn, panesAffected, targetFor, type WatchApi } from './watch.ts'

export type NoticesApi = WatchApi & Pick<TetherDaemon, 'delivery'>

export interface NoticesWiring {
  store: OwnershipStore
  gate: WriteGate
}

/** How much of the last answer goes in the notice, and how many lines of a card or a screen. */
export const ANSWER_CHARS = 600
export const CARD_LINES = 20
/** The owner's return is told after the burst of states it causes settles. */
export const RETURN_SETTLE_MS = 150
/** A 'waiting' whose card is not on the screen yet waits this long for it (polled every CARD_POLL_MS) before the generic notice. */
export const CARD_WAIT_MS = 8000
export const CARD_POLL_MS = 250
/** With the turn's start unknown (the daemon began in the middle of it), an answer written this long before its end still counts. */
export const ANSWER_SKEW_MS = 10_000

const SYSTEM_FROM = { name: 'tether', id: 'tether', role: 'system' } as const

// ---- the texts (contract 4.3) -------------------------------------------------------------------

export type What =
  | { what: 'finished' }
  | { what: 'permission'; card: DetectedCard }
  | { what: 'question'; card: DetectedCard }
  | { what: 'waiting'; tail: string[] }

/** The fixed first line: `<what> · guia <id> · mesa <desk>`, readable by a machine. */
export function firstLine(label: string, paneId: string, desk: string): string {
  return `${label} · guia ${paneId} · mesa ${desk}`
}

/** The first `n` lines, with an ellipsis line when there were more. */
export function clipLines(text: string, n: number = CARD_LINES): string {
  const lines = text.replace(/\s+$/, '').split('\n')
  return lines.length <= n ? lines.join('\n') : [...lines.slice(0, n), '…'].join('\n')
}

export function finishedBody(paneId: string, desk: string, answer: string | undefined): string {
  const out = [firstLine('terminou', paneId, desk)]
  const text = answer?.trim()
  if (text) {
    const total = text.length
    if (total > ANSWER_CHARS) {
      let cut = text.slice(0, ANSWER_CHARS)
      if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1)
      out.push(`Última resposta (${cut.length} de ${total} caracteres):`, `${cut}…`)
    } else {
      out.push(`Última resposta (${total} caracteres):`, text)
    }
  }
  out.push(`Ler tudo: agents last-answer ${paneId}`)
  return out.join('\n')
}

export function permissionBody(paneId: string, desk: string, card: DetectedCard): string {
  const out = [firstLine('pede permissão', paneId, desk), clipLines(card.text || card.title)]
  if (card.options.length > 0) out.push(`Opções: ${card.options.map((o) => o.id).join(' · ')}`)
  out.push(`Responder: agents answer ${paneId} <opção>`)
  return out.join('\n')
}

export function questionBody(paneId: string, desk: string, card: DetectedCard): string {
  const out = [firstLine('pergunta', paneId, desk), clipLines(card.text || card.title)]
  card.options.forEach((o, i) => out.push(`${i + 1}. ${o.label}`))
  out.push(`Responder: agents answer ${paneId} <n> ou agents send ${paneId} "<texto>"`)
  return out.join('\n')
}

/** A guia waits and no conductor could say for what: the tail of the screen, and the way to read all of it. */
export function waitingBody(paneId: string, desk: string, tail: readonly string[]): string {
  const out = [firstLine('espera por você', paneId, desk)]
  if (tail.length > 0) out.push(tail.join('\n'))
  out.push(`Ver a tela: agents read-screen ${paneId}`)
  return out.join('\n')
}

const LABEL: Record<What['what'], string> = { finished: 'terminou', permission: 'pede permissão', question: 'pergunta', waiting: 'espera por você' }

/** The return: what waits for the person now, by the owner's guias. `lines` are `<id> (<what>)`. */
export function returnedBody(lines: readonly string[]): string {
  return `você voltou · esperam por você: ${lines.join(', ')}`
}

export type HandState = 'owner' | 'taken' | 'paused'

/** The one line of a change of hand, from the state before to the state now (undefined: nothing to tell). */
export function handLine(prev: HandState, now: HandState, name: string): string | undefined {
  if (prev === now) return undefined
  if (now === 'taken') return `o usuário tomou a guia ${name}`
  if (now === 'paused') return `${name} foi pausada para você`
  return prev === 'paused' ? `${name} foi retomada` : `o usuário devolveu a guia ${name}`
}

// ---- the notices --------------------------------------------------------------------------------

export class Notices {
  private readonly api: NoticesApi
  private readonly wiring: NoticesWiring
  private readonly readers: ScreenReaders
  private readonly settleMs: number
  /** pane -> the edge already told (`<value>|<since>`); gone when the attention goes. */
  private readonly edges = new Map<string, string>()
  /** Panes whose attention shows to the person because the owner is away, with that value. */
  private readonly away = new Map<string, string>()
  /** Owners that came back, with the panes that waited for them; told once the burst settles. */
  private readonly returning = new Map<string, Set<string>>()
  private returnTimer: ReturnType<typeof setTimeout> | undefined
  /** Notices that wait for a way in, by pane and by receipt. */
  private readonly pendingByPane = new Map<string, Set<string>>()
  private readonly panesOfReceipt = new Map<string, string[]>()
  /** The hand of each pane as last told; a pane absent is with its owner. */
  private readonly hands = new Map<string, HandState>()
  /** pane -> when its current (or last) turn began (ISO), from the busy states. */
  private readonly turnStart = new Map<string, string>()
  /** `desk:<id>` / `pane:<id>` -> the live owner last told, to tell who gained and who lost on the next change. */
  private readonly owners = new Map<string, string>()
  /** The owners paused everywhere that were told. */
  private readonly frozenTold = new Set<string>()
  private disposed = false

  private readonly cardWaitMs: number
  private readonly cardPollMs: number

  constructor(api: NoticesApi, wiring: NoticesWiring, opts: { settleMs?: number; cardWaitMs?: number; cardPollMs?: number; readers?: ScreenReaders } = {}) {
    this.api = api
    this.wiring = wiring
    this.settleMs = opts.settleMs ?? RETURN_SETTLE_MS
    this.cardWaitMs = opts.cardWaitMs ?? CARD_WAIT_MS
    this.cardPollMs = opts.cardPollMs ?? CARD_POLL_MS
    this.readers = opts.readers ?? createScreenReaders({ joinWrapped: false })
  }

  // ---- the edge of the attention ----------------------------------------------------------------

  /** Every state of every slot comes here; only a change of the rerouted attention does anything. */
  stateChanged(s: SlotState): void {
    if (this.disposed) return
    // The start of the turn is only in the state while it runs; the finish needs it to tell this turn's answer from the last one's.
    if (s.turn === 'busy' && s.busySince) this.turnStart.set(s.slotId, s.busySince)
    const af = s.attentionFor
    if (!af) {
      this.edges.delete(s.slotId)
      if (s.attention && this.api.attention.routeOf(s.slotId) !== undefined) this.away.set(s.slotId, s.attention)
      else this.away.delete(s.slotId)
      return
    }
    // A guia is never told of itself (F5): its request goes to the person, and the core sends no route for it.
    if (af.slotId === s.slotId) return
    const key = `${af.value}|${s.idleSince ?? s.busySince ?? ''}`
    if (this.edges.get(s.slotId) === key) return
    this.edges.set(s.slotId, key)
    if (this.away.delete(s.slotId)) { this.comeBack(af.slotId, s.slotId); return }
    void this.announce(s.slotId, af.slotId, key).catch((e: unknown) => this.api.log(`aviso de ${s.slotId} falhou: ${(e as Error).message}`))
  }

  private async announce(paneId: string, owner: string, key: string): Promise<void> {
    const s = this.api.slots.get(paneId)
    if (!s?.attentionFor) return
    const what = await this.classifyEdge(s, key)
    if (!what) return
    // What the person or the owner did while the screen was read decides whether the notice is still true.
    const now = this.api.slots.get(paneId)
    if (this.disposed || !now?.attentionFor || now.attentionFor.slotId !== owner || this.edges.get(paneId) !== key) return
    if (this.wiring.store.effectiveOf(paneId).commander !== owner) return
    const answer = what.what === 'finished' ? await this.lastAnswer(now, owner) : undefined
    if (this.edges.get(paneId) !== key) return
    const desk = this.deskName(paneId)
    const body = what.what === 'finished' ? finishedBody(paneId, desk, answer)
      : what.what === 'permission' ? permissionBody(paneId, desk, what.card)
      : what.what === 'question' ? questionBody(paneId, desk, what.card)
      : waitingBody(paneId, desk, what.tail)
    const msg: DeliveryMessage = {
      kind: what.what === 'finished' ? 'notice' : 'request',
      from: { name: `${now.kind} · ${slotTitle(now)}`, id: paneId, role: 'member' },
      body,
    }
    this.supersede(paneId)
    await this.send(owner, msg, [paneId])
  }

  /**
   * What a fresh edge is. A 'waiting' can come from the engine's bell before the card is drawn (Codex rings when the request
   * arrives, and again when the turn ends, before its `done`): while a conductor that can read the screen sees no card, the
   * notice waits for the card, for the edge to be replaced (the `done`, the owner acting) or for the deadline, and only then
   * says the generic "waits for you". `undefined`: the edge is no longer the current one, nothing is told.
   */
  private async classifyEdge(s: SlotState, key: string): Promise<What | undefined> {
    if (s.attentionFor?.value === 'done') return { what: 'finished' }
    const paneId = s.slotId
    const owner = s.attentionFor?.slotId ?? ''
    const deadline = Date.now() + this.cardWaitMs
    for (;;) {
      const seen = await detectOn(this.api, this.wiring, this.readers, paneId, owner)
      if (seen && 'card' in seen) return { what: seen.state === 'permission' ? 'permission' : 'question', card: seen.card }
      const now = this.api.slots.get(paneId)
      if (this.disposed || !now?.attentionFor || this.edges.get(paneId) !== key) return undefined
      if (!seen || Date.now() >= deadline) return { what: 'waiting', tail: await this.tail(paneId) }
      await new Promise<void>((r) => setTimeout(r, this.cardPollMs).unref?.())
    }
  }

  /** What the edge is: a 'done' is a finish; a 'waiting' is read from the screen by the conductor that knows. */
  private async classify(s: SlotState): Promise<What> {
    if (s.attentionFor?.value === 'done') return { what: 'finished' }
    const owner = s.attentionFor?.slotId ?? ''
    const seen = await detectOn(this.api, this.wiring, this.readers, s.slotId, owner)
    if (seen && 'card' in seen) return { what: seen.state === 'permission' ? 'permission' : 'question', card: seen.card }
    return { what: 'waiting', tail: await this.tail(s.slotId) }
  }

  private async tail(paneId: string): Promise<string[]> {
    try {
      const t = await this.readers.read(paneId, (since) => this.api.slots.readScreen(paneId, since === undefined ? undefined : { since }))
      return screenString(t).split('\n').filter((l) => l.trim() !== '').slice(-CARD_LINES)
    } catch {
      return []
    }
  }

  /** The start of the answer: the file the engine's reporter writes before the `done` (K2), else the conductor's source. */
  private async lastAnswer(s: SlotState, owner: string): Promise<string | undefined> {
    // An answer older than the turn that ended is the previous turn's (the reporter writes nothing for a turn with no text):
    // it is never sent as this one's. Without the turn's start, the answer must be next to the end of the turn.
    const start = this.turnStart.get(s.slotId)
    const floor = start ? Date.parse(start) : s.idleSince ? Date.parse(s.idleSince) - ANSWER_SKEW_MS : Number.NaN
    const fresh = (at: unknown): boolean => {
      if (Number.isNaN(floor)) return true
      const t = typeof at === 'number' ? at : typeof at === 'string' ? Date.parse(at) : Number.NaN
      return t >= floor
    }
    try {
      const raw = await this.api.io.tryReadText(slotAnswerPath(this.api.home, s.slotId))
      const file = raw ? (JSON.parse(raw) as { text?: unknown; ts?: unknown }) : undefined
      if (typeof file?.text === 'string' && file.text.trim() && fresh(file.ts)) return file.text
    } catch { /* a half-written or foreign file: the conductor is next */ }
    const target = targetFor(this.api, s.slotId)
    const c = conductorRegistry.pick(target, 'lastAnswer')
    if (!c) return undefined
    try {
      const found = (await c.lastAnswer!(buildContext({ api: this.api, gate: this.wiring.gate, readers: this.readers }, owner, target)))?.value
      return found && fresh(found.at) ? found.text : undefined
    } catch {
      return undefined
    }
  }

  // ---- the owner away and back ------------------------------------------------------------------

  private comeBack(owner: string, paneId: string): void {
    let set = this.returning.get(owner)
    if (!set) this.returning.set(owner, set = new Set())
    set.add(paneId)
    this.returnTimer ??= setTimeout(() => { this.returnTimer = undefined; void this.flushReturns() }, this.settleMs)
    this.returnTimer.unref?.()
  }

  /** One notice per owner, with the state of now: what still waits for the person, each as it is on its screen. */
  private async flushReturns(): Promise<void> {
    const batch = [...this.returning]
    this.returning.clear()
    for (const [owner, panes] of batch) {
      if (this.disposed) return
      const lines: string[] = []
      for (const id of panes) {
        const s = this.api.slots.get(id)
        if (!s?.attentionFor || s.attentionFor.slotId !== owner) continue
        const what = await this.classify(s)
        lines.push(`${id} (${LABEL[what.what]})`)
      }
      if (lines.length === 0) continue
      await this.send(owner, { kind: 'notice', from: SYSTEM_FROM, body: returnedBody(lines) })
    }
  }

  // ---- the hand ---------------------------------------------------------------------------------

  /** Remembers the hands that are not with the owners at the start, so that giving one back is told. */
  seed(): void {
    for (const [id, o] of this.wiring.store.ownedPanes()) { this.noteHand(id); if (!o.ended) this.owners.set(`pane:${id}`, o.owner) }
    for (const [id, o] of this.wiring.store.ownedDesks()) if (!o.ended) this.owners.set(`desk:${id}`, o.owner)
    for (const [deskId] of this.wiring.store.ownedDesks()) {
      for (const p of this.api.desks.map()?.desks.find((d) => d.id === deskId)?.panes ?? []) this.noteHand(p.id)
    }
  }

  private noteHand(paneId: string): void {
    const eff = this.wiring.store.effectiveOf(paneId)
    if (eff.commander !== undefined && eff.hand === 'user') this.hands.set(paneId, eff.handWhy ?? 'taken')
  }

  /** A change of the ownership objects: pending notices of the panes go, and a change of hand is told to the owner. */
  objectChanged(e: { kind: 'desk' | 'pane'; id: string; key: string; value?: unknown }): void {
    if (this.disposed) return
    const panes = panesAffected(this.api, this.wiring.store, e)
    for (const id of panes) this.cancelPending(id)
    if (e.key === OBJECT_KEYS.owner) this.ownerChanged(e)
    if (e.key === OBJECT_KEYS.frozen) this.frozenChanged(e)
    // The hands are kept up to date by every change that can move them; only a change of the hand itself is told.
    const tell = e.key === OBJECT_KEYS.hand
    // One notice per owner, one line per pane (taking a desk touches every pane it commands).
    const byOwner = new Map<string, { lines: string[]; panes: string[] }>()
    for (const id of panes) {
      const eff = this.wiring.store.effectiveOf(id)
      const now: HandState = eff.commander === undefined || eff.hand === 'owner' ? 'owner' : (eff.handWhy ?? 'taken')
      const prev = this.hands.get(id) ?? 'owner'
      if (now === 'owner') this.hands.delete(id)
      else this.hands.set(id, now)
      // The guia "de si" is the owner's own: it is never told of it (F5).
      if (!tell || eff.commander === undefined || eff.commander === id) continue
      const s = this.api.slots.get(id)
      const line = handLine(prev, now, s ? slotTitle(s) : id)
      if (!line) continue
      const entry = byOwner.get(eff.commander) ?? { lines: [], panes: [] }
      entry.lines.push(line)
      entry.panes.push(id)
      byOwner.set(eff.commander, entry)
    }
    // A hand notice that waits is indexed by its panes too: the next change of those panes replaces it, so the queue an owner
    // reads later holds the latest news of each pane and not the history.
    for (const [owner, { lines, panes: told }] of byOwner) {
      void this.send(owner, { kind: 'notice', from: SYSTEM_FROM, body: lines.join('\n') }, told).catch((err: unknown) => this.api.log(`aviso da mão falhou: ${(err as Error).message}`))
    }
  }

  // ---- giving and revoking, pausing everywhere ------------------------------------------------------

  /** The gains and losses of a change of `owner`: each agent affected is told in one line (the person's gestures and agents' `give`). */
  private ownerChanged(e: { kind: 'desk' | 'pane'; id: string; value?: unknown }): void {
    const key = `${e.kind}:${e.id}`
    const v = e.value as { owner?: unknown; ended?: unknown } | undefined
    const next = v && typeof v.owner === 'string' && !v.ended ? v.owner : undefined
    const prev = this.owners.get(key)
    if (next !== undefined) this.owners.set(key, next)
    else this.owners.delete(key)
    if (prev === next) return
    const told = (to: string, text: string, panes?: string[]): void => {
      void this.send(to, { kind: 'notice', from: SYSTEM_FROM, body: text }, panes).catch((err: unknown) => this.api.log(`aviso da posse falhou: ${(err as Error).message}`))
    }
    if (e.kind === 'desk') {
      const name = this.api.desks.map()?.desks.find((d) => d.id === e.id)?.name ?? e.id
      if (next !== undefined) told(next, `você recebeu a mesa ${name}`)
      if (prev !== undefined) told(prev, `a mesa ${name} foi revogada`)
      return
    }
    const nameOf = (id: string): string => { const s = this.api.slots.get(id); return s ? slotTitle(s) : id }
    const name = nameOf(e.id)
    const panes = [e.id]
    if (next !== undefined && next !== e.id) {
      told(next, `você recebeu a guia ${name}`, panes)
      // The desk's owner no longer commands it: it only sees.
      const deskOwner = this.wiring.store.deskOfPane(e.id)?.owner
      if (deskOwner && !deskOwner.ended && deskOwner.owner !== next && deskOwner.owner !== e.id) {
        told(deskOwner.owner, `a guia ${name} foi dada a ${nameOf(next)}: agora você só vê`, panes)
      }
    }
    if (prev !== undefined && prev !== e.id) told(prev, `a guia ${name} foi revogada`, panes)
  }

  /** "Pausar <dono> em tudo" (and back): the owner is told once. */
  private frozenChanged(e: { kind: 'desk' | 'pane'; id: string; value?: unknown }): void {
    if (e.kind !== 'pane') return
    const now = e.value !== undefined
    if (now === this.frozenTold.has(e.id)) return
    if (now) this.frozenTold.add(e.id)
    else this.frozenTold.delete(e.id)
    void this.send(e.id, { kind: 'notice', from: SYSTEM_FROM, body: now ? 'você foi pausada em tudo' : 'você foi retomada' }).catch((err: unknown) => this.api.log(`aviso da pausa falhou: ${(err as Error).message}`))
  }

  // ---- delivering -------------------------------------------------------------------------------

  /** Delivers to a live owner (an owner that is away gets nothing: no queue). `panes` index a notice that may wait. */
  private async send(owner: string, msg: DeliveryMessage, panes: readonly string[] = []): Promise<void> {
    const o = this.api.slots.get(owner)
    if (!o || !slotIsLive(o)) return
    let receipt: DeliveryReceipt
    try {
      receipt = await this.api.delivery.deliver(owner, msg)
    } catch (e) {
      this.api.log(`entregar o aviso a ${owner} falhou: ${(e as Error).message}`)
      return
    }
    if (panes.length === 0 || receipt.state !== 'queued') return
    for (const paneId of panes) {
      let set = this.pendingByPane.get(paneId)
      if (!set) this.pendingByPane.set(paneId, set = new Set())
      set.add(receipt.id)
    }
    this.panesOfReceipt.set(receipt.id, [...panes])
  }

  /** A final state of a delivery: it no longer waits. */
  delivered(r: DeliveryReceipt): void {
    if (r.state === 'queued') return
    const panes = this.panesOfReceipt.get(r.id)
    if (!panes) return
    this.panesOfReceipt.delete(r.id)
    for (const pane of panes) {
      const set = this.pendingByPane.get(pane)
      set?.delete(r.id)
      if (set?.size === 0) this.pendingByPane.delete(pane)
    }
  }

  /** A newer notice of the pane replaces the ones that still wait; so does a change of ownership. */
  private supersede(paneId: string): void { this.cancelPending(paneId) }

  cancelPending(paneId: string): void {
    const set = this.pendingByPane.get(paneId)
    if (!set) return
    this.pendingByPane.delete(paneId)
    for (const id of set) {
      this.panesOfReceipt.delete(id)
      try { this.api.delivery.cancel(id) } catch { /* it was delivered meanwhile */ }
    }
  }

  forget(paneId: string): void {
    this.cancelPending(paneId)
    this.edges.delete(paneId)
    this.away.delete(paneId)
    this.hands.delete(paneId)
    this.turnStart.delete(paneId)
    this.owners.delete(`pane:${paneId}`)
    this.frozenTold.delete(paneId)
    this.readers.drop(paneId)
  }

  private deskName(paneId: string): string {
    return this.api.desks.deskOf(paneId)?.name ?? 'sem mesa'
  }

  dispose(): void {
    this.disposed = true
    if (this.returnTimer) { clearTimeout(this.returnTimer); this.returnTimer = undefined }
    this.returning.clear()
    this.readers.dispose()
  }
}

export function registerNotices(api: NoticesApi, wiring: NoticesWiring): IDisposable[] {
  const notices = new Notices(api, wiring)
  Promise.all([api.objects.ready, api.desks.ready]).then(() => notices.seed()).catch(() => {})
  return [
    api.slots.onState((s) => notices.stateChanged(s)),
    api.objects.onDidChange((e) => notices.objectChanged(e)),
    api.delivery.onDidDeliver((r) => notices.delivered(r)),
    api.onSlot((ev) => { if (ev.kind === 'removed') notices.forget(ev.slot.slotId) }),
    toDisposable(() => notices.dispose()),
  ]
}
