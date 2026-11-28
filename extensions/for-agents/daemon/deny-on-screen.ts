// The refusal of a permission card on the screen of an unsafe guia nobody commands (Soul and Codex; Claude has its own hook).
//
// A guia launched with its permissions released (`SlotState.unsafe`) that still shows a permission card is a card that would wait
// for a person for good (the engine only asks about what it judges dangerous). With no owner to answer it, the tether answers
// "no" in the person's place and then tells the agent why, so it rethinks the step instead of rewriting the same command.
//
// A pane with an owner is left alone: the owner receives the request (notices.ts) and decides. So is a pane the person is using
// (`slots.userFree`, the same interlock as the write gate): she answers her own cards. Nothing here reaches the ownership
// `WriteGate`, which stays the law of the owner: the writes of this module go through `ownerlessContext`, which keeps only the
// person's interlock.
//
// Cost: no timer lives for a guia. The work starts at an edge of `attention === 'waiting'` of a pane that qualifies; the card may
// not be drawn at that instant (Codex rings its bell first), so the screen is reread every CARD_POLL_MS up to CARD_WAIT_MS and
// then it is over. One run per pane at a time, one per edge.
import { slotIsLive, slotTitle } from '../../../app/shared/agent-info.ts'
import { toDisposable, type IDisposable } from '../../../app/shared/vscode-lifecycle.ts'
import type { TetherDaemon } from '../../../src/daemon/ext-api.ts'
import type { SlotState } from '../../../src/daemon/protocol.ts'
import { ConductError, conductorRegistry, type ConductorContext, type Detected } from '../conductor-api.ts'
import { createScreenReaders, type ScreenReaders } from '../screen/index.ts'
import { chunksOf } from './context.ts'
import type { OwnershipStore } from './ownership.ts'
import { CARD_POLL_MS, CARD_WAIT_MS, SYSTEM_FROM } from './notices.ts'
import { targetFor, type WatchApi } from './watch.ts'

// Copy of `DENY_MESSAGE` in src/report/claude-hook.mjs (the text Claude's hook gives). That file is the hook's standalone script,
// untyped JS the typecheck cannot import; keep the two in step.
export const DENY_MESSAGE =
  'Recusado pelo tether no lugar da pessoa: este pedido de permissão ficaria esperando alguém responder. ' +
  'Não reescreva o mesmo comando de outro jeito. Repense o passo na direção da segurança: por que isto precisava ser feito? ' +
  'Na dúvida, deixe como está e relate.'

/** `agents.denyPermissionPromptsOnScreen` in settings.json; read at every edge. Default on: only `false` turns it off. */
export const SETTING_KEY = 'agents.denyPermissionPromptsOnScreen'
/** The engines this covers. */
const KINDS: readonly string[] = ['soul', 'codex']
/** After "no", how long the card has to leave the screen before the message is delivered, and how often it is checked. */
export const GONE_WAIT_MS = 4000
export const GONE_POLL_MS = 150
const TITLE_CHARS = 80

export type DenyApi = WatchApi & Pick<TetherDaemon, 'delivery' | 'settings'>

/**
 * A conductor's context for a pane with no owner: the screen as the person sees it and writes that stop when she is there.
 * The owner's gate cannot serve (it refuses what no one commands); the person's interlock is the same one it uses.
 */
export function ownerlessContext(api: DenyApi, readers: ScreenReaders, paneId: string): ConductorContext {
  const target = targetFor(api, paneId)
  const kind = target.slot?.kind
  const free = (): void => {
    if (!api.slots.userFree(paneId)) throw new ConductError('with-user', 'a guia está com a pessoa agora; nada foi digitado')
  }
  return {
    target,
    slot: () => api.slots.get(paneId),
    agent: kind && kind !== 'shell' ? api.agents.get(kind) : undefined,
    screen: () => readers.read(paneId, (since) => api.slots.readScreen(paneId, since === undefined ? undefined : { since })),
    write: async (list) => {
      for (const c of chunksOf(list)) {
        if ('waitMs' in c) { await new Promise<void>((r) => setTimeout(r, c.waitMs)); continue }
        if (!('text' in c)) continue
        free()
        await api.slots.write(paneId, c.text, { answer: true })
      }
    },
    keys: async (keys, opts) => {
      for (let i = 0; i < keys.length; i++) {
        if (i > 0 && opts?.gapMs) await new Promise<void>((r) => setTimeout(r, opts.gapMs))
        free()
        await api.slots.keys(paneId, [keys[i]!], { answer: true })
      }
    },
    io: api.io,
    home: api.home,
    log: (m) => api.log(`condutor ${paneId}: ${m}`),
  }
}

export class ScreenDenier {
  private readonly api: DenyApi
  private readonly store: Pick<OwnershipStore, 'effectiveOf'>
  private readonly readers: ScreenReaders
  private readonly cardWaitMs: number
  private readonly cardPollMs: number
  private readonly goneWaitMs: number
  private readonly gonePollMs: number
  /** pane -> the edge already handled (`<since>`); gone when the attention goes. */
  private readonly edges = new Map<string, string>()
  private disposed = false

  constructor(api: DenyApi, store: Pick<OwnershipStore, 'effectiveOf'>, opts: { cardWaitMs?: number; cardPollMs?: number; goneWaitMs?: number; gonePollMs?: number; readers?: ScreenReaders } = {}) {
    this.api = api
    this.store = store
    this.readers = opts.readers ?? createScreenReaders({ joinWrapped: false })
    this.cardWaitMs = opts.cardWaitMs ?? CARD_WAIT_MS
    this.cardPollMs = opts.cardPollMs ?? CARD_POLL_MS
    this.goneWaitMs = opts.goneWaitMs ?? GONE_WAIT_MS
    this.gonePollMs = opts.gonePollMs ?? GONE_POLL_MS
  }

  /** Every state of every slot comes here; only the edge of a 'waiting' of a qualifying pane does anything. */
  stateChanged(s: SlotState): void {
    if (this.disposed) return
    if (s.attention !== 'waiting') { this.edges.delete(s.slotId); return }
    const key = `${s.idleSince ?? s.busySince ?? ''}`
    if (this.edges.get(s.slotId) === key) return
    this.edges.set(s.slotId, key)
    if (!this.qualifies(s)) return
    void this.run(s.slotId, key).catch((e: unknown) => this.api.log(`recusa na tela de ${s.slotId} falhou: ${(e as Error).message}`))
  }

  /** The pane's own conditions: live, an engine covered, unsafe, waiting for the person and commanded by no one. */
  private qualifies(s: SlotState | undefined): s is SlotState {
    if (!s || !slotIsLive(s) || !s.unsafe || !KINDS.includes(s.kind) || s.attention !== 'waiting' || s.attentionFor) return false
    if (this.api.settings.get<unknown>(SETTING_KEY) === false) return false
    return this.store.effectiveOf(s.slotId).commander === undefined
  }

  private current(paneId: string, key: string): SlotState | undefined {
    const s = this.api.slots.get(paneId)
    return !this.disposed && this.edges.get(paneId) === key && this.qualifies(s) ? s : undefined
  }

  private async detect(paneId: string): Promise<Detected | undefined> {
    const ctx = ownerlessContext(this.api, this.readers, paneId)
    const c = conductorRegistry.pick(ctx.target, 'detect')
    if (!c) return undefined
    try { return await c.detect!(ctx) } catch { return undefined }
  }

  private async run(paneId: string, key: string): Promise<void> {
    // The card may be drawn after the signal: reread until it shows, a question or dialog appears, or the deadline.
    const deadline = Date.now() + this.cardWaitMs
    let card: Extract<Detected, { card: unknown }> | undefined
    for (;;) {
      const seen = await this.detect(paneId)
      if (!this.current(paneId, key)) return
      if (seen && 'card' in seen) {
        // A question or a dialog is for the person: only a permission card is refused.
        if (seen.state !== 'permission') return
        card = seen
        break
      }
      if (Date.now() >= deadline) return
      await new Promise<void>((r) => setTimeout(r, this.cardPollMs).unref?.())
    }
    const s = this.current(paneId, key)
    if (!s) return
    const ctx = ownerlessContext(this.api, this.readers, paneId)
    const conductor = conductorRegistry.pick(ctx.target, 'answer')
    if (!conductor) return
    try {
      await conductor.answer!(ctx, 'no')
    } catch (e) {
      // `with-user`: the person is there and answers her own card.
      this.api.log(`recusa na tela de ${paneId} não feita: ${(e as Error).message}`)
      return
    }
    this.api.log(`recusa na tela: guia ${paneId} (${s.kind} · ${slotTitle(s)}) "${card.card.title.replace(/\s+/g, ' ').slice(0, TITLE_CHARS)}"`)
    // Typing over an open card is refused, so the message waits for the card to leave.
    const gone = Date.now() + this.goneWaitMs
    for (;;) {
      const seen = await this.detect(paneId)
      if (this.disposed || !this.api.slots.get(paneId) || !slotIsLive(this.api.slots.get(paneId)!)) return
      if (seen && seen.state !== 'permission') break
      if (Date.now() >= gone) { this.api.log(`recusa na tela de ${paneId}: o cartão não saiu, a mensagem não foi entregue`); return }
      await new Promise<void>((r) => setTimeout(r, this.gonePollMs).unref?.())
    }
    await this.api.delivery.deliver(paneId, { kind: 'notice', from: SYSTEM_FROM, body: DENY_MESSAGE })
  }

  forget(paneId: string): void {
    this.edges.delete(paneId)
    this.readers.drop(paneId)
  }

  dispose(): void {
    this.disposed = true
    this.edges.clear()
    this.readers.dispose()
  }
}

/** Wiring in daemon.ts, one line after `registerNotices`:   `...registerDenyOnScreen(api, { store })` */
export function registerDenyOnScreen(api: DenyApi, wiring: { store: Pick<OwnershipStore, 'effectiveOf'> }): IDisposable[] {
  const denier = new ScreenDenier(api, wiring.store)
  return [
    api.slots.onState((s) => denier.stateChanged(s)),
    api.onSlot((ev) => { if (ev.kind === 'removed') denier.forget(ev.slot.slotId) }),
    toDisposable(() => denier.dispose()),
  ]
}
