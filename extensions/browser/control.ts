// Who has each tab, on the main side (Tether Browser E7, design §6): the state per tab (control-rules.ts), the open help
// requests and their timers, and the effects of each transition. Listeners hear every change: the gate tells the owner's
// connections (`Tether.tabStateChanged`), main tells the renderer and puts the input shield on (agent) or off (person).
// The clean hand-off (rule 15, every help request whatever its kind) and the reload of every help request's hand-back (rule 16)
// are the hooks main gives (they need the gate's scripts and the tab's session); the state flips to `user` before the hand-off runs,
// so the gate holds the page's events from the first instant.
import { randomUUID } from 'node:crypto'
import {
  type AskAnswer, type AskInput, controlOf, type Control, type ControlEvent, INITIAL, needsCleanHandoff, reasonOf, reloadsOnGive, reloadsOnGiveBack,
  type TabControl, transition,
} from './control-rules.ts'
import { isPersonOwned } from './tab-rules.ts'

/** What the renderer and the gate are told of a tab's control. */
export interface ControlView {
  tabId: string
  control: Control
  reason?: string
  holder: 'agent' | 'user'
  paused: boolean
  why?: TabControl['why']
  /** The open request: its id (the card's collapsed state is kept per request), the agent's message and kind. */
  ask?: { id: string; message: string; kind: 'login' | 'other' }
  askExpired?: boolean
}

export interface ControlHooks {
  /** The tab's owner (only it may ask on the tab). */
  ownerOf(tabId: string): string | undefined
  /** Scripts out, the origin's service worker out, reload (rule 15). */
  cleanHandoff(tabId: string): Promise<void>
  /** Before a help request's tab goes back to the agent: reload, so nothing the person typed and did not send is left (rule 16). */
  beforeGiveBack(tabId: string): Promise<void>
  /**
   * The clean give of her own tab when `give` is called without a hand-over of its own (unit tests). Throwing aborts the give.
   * Absent: nothing runs.
   */
  beforeGive?(tabId: string): Promise<void>
  log(msg: string): void
}

interface Waiting { tabId: string; owner: string; resolve(a: AskAnswer): void; timer: NodeJS.Timeout }

export class ControlHub {
  private readonly tabs = new Map<string, TabControl>()
  private readonly waiting = new Map<string, Waiting>()
  private readonly listeners = new Set<(v: ControlView) => void>()
  private readonly hooks: ControlHooks

  constructor(hooks: ControlHooks) { this.hooks = hooks }

  onChange(l: (v: ControlView) => void): { dispose(): void } {
    this.listeners.add(l)
    return { dispose: () => { this.listeners.delete(l) } }
  }

  state(tabId: string): TabControl { return this.tabs.get(tabId) ?? INITIAL }
  control(tabId: string): Control { return controlOf(this.state(tabId)) }
  view(tabId: string): ControlView {
    const t = this.state(tabId)
    const reason = reasonOf(t)
    return {
      tabId, control: controlOf(t), holder: t.holder, paused: t.paused,
      ...(reason ? { reason } : {}), ...(t.why ? { why: t.why } : {}),
      ...(t.ask ? { ask: { id: t.ask.id, message: t.ask.message, kind: t.ask.kind } } : {}), ...(t.askExpired ? { askExpired: true } : {}),
    }
  }
  views(): ControlView[] { return [...this.tabs.keys()].map(id => this.view(id)) }

  private apply(tabId: string, e: ControlEvent): { before: TabControl; after: TabControl } {
    const before = this.state(tabId)
    const { state: after, settle } = transition(before, e)
    if (after !== before) this.tabs.set(tabId, after)
    if (settle) { const { id, ...answer } = settle; this.settle(id, answer) }
    if (after !== before) {
      const v = this.view(tabId)
      for (const l of [...this.listeners]) { try { l(v) } catch (err) { this.hooks.log(`controle: ouvinte falhou (${(err as Error).message})`) } }
    }
    return { before, after }
  }

  private settle(id: string, answer: AskAnswer): void {
    const w = this.waiting.get(id)
    if (!w) return
    this.waiting.delete(id)
    clearTimeout(w.timer)
    w.resolve(answer)
  }

  /**
   * A new tab: the person's own tab (owner PERSON_OWNER, its popups too) is hers and stays hers; a popup of a tab the person
   * holds is hers from birth.
   */
  added(tabId: string, openerTabId: string | undefined, ownerSlotId?: string): void {
    if (isPersonOwned(ownerSlotId)) this.apply(tabId, { type: 'own' })
    else if (openerTabId !== undefined) this.apply(tabId, { type: 'popupOf', opener: this.state(openerTabId) })
  }

  /** The person takes the tab ("Assumir"). */
  take(tabId: string): void { this.apply(tabId, { type: 'take' }) }

  /** "Recarregar limpo": the person holds the tab and the clean hand-off runs, whatever the state. */
  async cleanReload(tabId: string): Promise<void> {
    this.apply(tabId, { type: 'take' })
    await this.hooks.cleanHandoff(tabId).catch(e => this.hooks.log(`controle: entrega limpa falhou (${(e as Error).message})`))
  }

  /**
   * The person hands the tab back, with an optional note to the agent: the hand-back of a help request (any kind) first reloads
   * the page (rule 16).
   */
  giveBack(tabId: string, note?: unknown): Promise<void> { return this.handBack(tabId, { type: 'giveBack', note }) }

  /** "Não consigo ajudar": the request ends `declined` and the tab goes back to the agent, reloaded as on a hand-back. */
  decline(tabId: string, note?: unknown): Promise<void> { return this.handBack(tabId, { type: 'decline', note }) }

  private async handBack(tabId: string, e: { type: 'giveBack' | 'decline'; note?: unknown }): Promise<void> {
    const t = this.state(tabId)
    if (t.holder !== 'user') return
    if (reloadsOnGiveBack(t)) await this.hooks.beforeGiveBack(tabId).catch(err => this.hooks.log(`controle: recarga da devolução falhou (${(err as Error).message})`))
    this.apply(tabId, e)
  }

  /**
   * "Entregar a um agente…": her own tab leaves her hands. The state flips first, so the shield is on and her open dialog goes
   * while the clean give runs (`handOver`, else the `beforeGive` hook: main opens a fresh tab of the agent's at the same address,
   * and closes hers only after this resolves true). The give fails closed: a hand-over that throws puts the tab back in her hands
   * (her own again) and answers false, so the caller hands nothing over. False also when the tab is not hers to give.
   */
  async give(tabId: string, handOver?: (tabId: string) => Promise<void>): Promise<boolean> {
    const { before, after } = this.apply(tabId, { type: 'give' })
    if (after === before) return false
    if (!reloadsOnGive(before)) return true
    try {
      await (handOver ?? this.hooks.beforeGive)?.(tabId)
      return true
    } catch (e) {
      this.hooks.log(`controle: recarga da entrega falhou, a guia continua dela (${(e as Error).message})`)
      this.apply(tabId, { type: 'own' })
      return false
    }
  }

  pause(tabId: string): void { this.apply(tabId, { type: 'pause' }) }
  resume(tabId: string): void { this.apply(tabId, { type: 'resume' }) }
  pauseMany(tabIds: Iterable<string>): void { for (const id of tabIds) this.pause(id) }
  resumeMany(tabIds: Iterable<string>): void { for (const id of tabIds) this.resume(id) }

  /** Open requests: on the tab (and whether it is the owner's own), and of the agent across its tabs. */
  openAsks(tabId: string, owner: string): { tab: boolean; agent: number; own?: boolean } {
    let agent = 0
    for (const w of this.waiting.values()) if (w.owner === owner) agent++
    const open = this.state(tabId).ask
    return open ? { tab: true, agent, own: this.waiting.get(open.id)?.owner === owner } : { tab: false, agent }
  }

  /**
   * The agent's help request (already checked by `checkAsk`): the tab goes to the person now (with the clean hand-off, whatever
   * the kind) and the promise settles when she hands it back or declines (with her note, if any), the time runs out, the tab
   * closes or the agent gives up (`cancel`).
   */
  ask(tabId: string, owner: string, input: AskInput): { answer: Promise<AskAnswer>; cancel(): void } {
    const id = randomUUID()
    let resolve!: (a: AskAnswer) => void
    const answer = new Promise<AskAnswer>(r => { resolve = r })
    const timer = setTimeout(() => this.apply(tabId, { type: 'askTimeout', id }), input.timeoutMs)
    timer.unref?.()
    this.waiting.set(id, { tabId, owner, resolve, timer })
    const { before, after } = this.apply(tabId, { type: 'ask', ask: { id, message: input.message, kind: input.kind } })
    if (needsCleanHandoff(before, after)) {
      void this.hooks.cleanHandoff(tabId).catch(e => this.hooks.log(`controle: entrega limpa falhou (${(e as Error).message})`))
    }
    this.hooks.log(`controle: guia ${tabId} pede ajuda (${input.kind})`)
    return { answer, cancel: () => this.apply(tabId, { type: 'askDismissed', id }) }
  }

  /** The tab closed: its request is dismissed, its state forgotten. */
  closed(tabId: string): void {
    const ask = this.state(tabId).ask
    if (ask) this.settle(ask.id, { outcome: 'dismissed' })
    this.tabs.delete(tabId)
  }

  /** The agent exited: its open requests are dismissed; its tabs stay as they are (nobody is connected to them any more). */
  agentExited(slotId: string): void {
    for (const [id, w] of [...this.waiting]) if (w.owner === slotId) this.apply(w.tabId, { type: 'askDismissed', id })
  }

  dispose(): void {
    for (const id of [...this.waiting.keys()]) this.settle(id, { outcome: 'dismissed' })
    this.listeners.clear()
  }
}
