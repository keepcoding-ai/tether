// Who has each tab, on the main side (Tether Browser E7, design §6): the state per tab (control-rules.ts), the open help
// requests and their timers, and the effects of each transition. Listeners hear every change: the gate tells the owner's
// connections (`Tether.tabStateChanged`), main tells the renderer and puts the input shield on (agent) or off (person).
// The clean hand-off (rule 15, every help request whatever its kind) and the reload of every help request's hand-back (rule 16)
// are the hooks main gives (they need the gate's scripts and the tab's session); the state flips to `user` before the hand-off runs,
// so the gate holds the page's events from the first instant.
import { randomUUID } from 'node:crypto'
import {
  type AskInput, type AskOutcome, controlOf, type Control, type ControlEvent, INITIAL, needsCleanHandoff, reasonOf, reloadsOnGiveBack,
  type TabControl, transition,
} from './control-rules.ts'

/** What the renderer and the gate are told of a tab's control. */
export interface ControlView {
  tabId: string
  control: Control
  reason?: string
  holder: 'agent' | 'user'
  paused: boolean
  why?: TabControl['why']
  ask?: { message: string; kind: 'login' | 'other' }
  askExpired?: boolean
}

export interface ControlHooks {
  /** The tab's owner (only it may ask on the tab). */
  ownerOf(tabId: string): string | undefined
  /** Scripts out, the origin's service worker out, reload (rule 15). */
  cleanHandoff(tabId: string): Promise<void>
  /** Before a help request's tab goes back to the agent: reload, so nothing the person typed and did not send is left (rule 16). */
  beforeGiveBack(tabId: string): Promise<void>
  log(msg: string): void
}

interface Waiting { tabId: string; owner: string; resolve(o: AskOutcome): void; timer: NodeJS.Timeout }

export class ControlHub {
  private readonly tabs = new Map<string, TabControl>()
  private readonly waiting = new Map<string, Waiting>()
  private readonly listeners = new Set<(v: ControlView) => void>()
  /** Test builds: every upload consent asked (E13 shows the dialog). */
  readonly uploadAsks: { tabId: string; path: string; frameUrl?: string }[] = []
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
      ...(t.ask ? { ask: { message: t.ask.message, kind: t.ask.kind } } : {}), ...(t.askExpired ? { askExpired: true } : {}),
    }
  }
  views(): ControlView[] { return [...this.tabs.keys()].map(id => this.view(id)) }

  private apply(tabId: string, e: ControlEvent): { before: TabControl; after: TabControl } {
    const before = this.state(tabId)
    const { state: after, settle } = transition(before, e)
    if (after !== before) this.tabs.set(tabId, after)
    if (settle) this.settle(settle.id, settle.outcome)
    if (after !== before) {
      const v = this.view(tabId)
      for (const l of [...this.listeners]) { try { l(v) } catch (err) { this.hooks.log(`controle: ouvinte falhou (${(err as Error).message})`) } }
    }
    return { before, after }
  }

  private settle(id: string, outcome: AskOutcome): void {
    const w = this.waiting.get(id)
    if (!w) return
    this.waiting.delete(id)
    clearTimeout(w.timer)
    w.resolve(outcome)
  }

  /** A new tab: a popup of a tab the person holds is hers from birth. */
  added(tabId: string, openerTabId: string | undefined): void {
    if (openerTabId !== undefined) this.apply(tabId, { type: 'popupOf', opener: this.state(openerTabId) })
  }

  /** The person takes the tab ("Assumir o controle"). */
  take(tabId: string): void { this.apply(tabId, { type: 'take' }) }

  /** "Recarregar limpo": the person holds the tab and the clean hand-off runs, whatever the state. */
  async cleanReload(tabId: string): Promise<void> {
    this.apply(tabId, { type: 'take' })
    await this.hooks.cleanHandoff(tabId).catch(e => this.hooks.log(`controle: entrega limpa falhou (${(e as Error).message})`))
  }

  /** The person hands the tab back: the hand-back of a help request (any kind) first reloads the page (rule 16). */
  async giveBack(tabId: string): Promise<void> {
    const t = this.state(tabId)
    if (t.holder !== 'user') return
    if (reloadsOnGiveBack(t)) await this.hooks.beforeGiveBack(tabId).catch(e => this.hooks.log(`controle: recarga da devolução falhou (${(e as Error).message})`))
    this.apply(tabId, { type: 'giveBack' })
  }

  pause(tabId: string): void { this.apply(tabId, { type: 'pause' }) }
  resume(tabId: string): void { this.apply(tabId, { type: 'resume' }) }
  pauseMany(tabIds: Iterable<string>): void { for (const id of tabIds) this.pause(id) }
  resumeMany(tabIds: Iterable<string>): void { for (const id of tabIds) this.resume(id) }

  /** Open requests: on the tab, and of the agent across its tabs. */
  openAsks(tabId: string, owner: string): { tab: boolean; agent: number } {
    let agent = 0
    for (const w of this.waiting.values()) if (w.owner === owner) agent++
    return { tab: !!this.state(tabId).ask, agent }
  }

  /**
   * The agent's help request (already checked by `checkAsk`): the tab goes to the person now (with the clean hand-off, whatever
   * the kind) and the promise settles when she hands it back, the time runs out, the tab closes or the agent gives up (`cancel`).
   */
  ask(tabId: string, owner: string, input: AskInput): { outcome: Promise<AskOutcome>; cancel(): void } {
    const id = randomUUID()
    let resolve!: (o: AskOutcome) => void
    const outcome = new Promise<AskOutcome>(r => { resolve = r })
    const timer = setTimeout(() => this.apply(tabId, { type: 'askTimeout', id }), input.timeoutMs)
    timer.unref?.()
    this.waiting.set(id, { tabId, owner, resolve, timer })
    const { before, after } = this.apply(tabId, { type: 'ask', ask: { id, message: input.message, kind: input.kind } })
    if (needsCleanHandoff(before, after)) {
      void this.hooks.cleanHandoff(tabId).catch(e => this.hooks.log(`controle: entrega limpa falhou (${(e as Error).message})`))
    }
    this.hooks.log(`controle: guia ${tabId} pede ajuda (${input.kind})`)
    return { outcome, cancel: () => this.apply(tabId, { type: 'askDismissed', id }) }
  }

  /** The tab closed: its request is dismissed, its state forgotten. */
  closed(tabId: string): void {
    const ask = this.state(tabId).ask
    if (ask) this.settle(ask.id, 'dismissed')
    this.tabs.delete(tabId)
  }

  /** The agent exited: its open requests are dismissed; its tabs stay as they are (nobody is connected to them any more). */
  agentExited(slotId: string): void {
    for (const [id, w] of [...this.waiting]) if (w.owner === slotId) this.apply(w.tabId, { type: 'askDismissed', id })
  }

  dispose(): void {
    for (const id of [...this.waiting.keys()]) this.settle(id, 'dismissed')
    this.listeners.clear()
  }
}
