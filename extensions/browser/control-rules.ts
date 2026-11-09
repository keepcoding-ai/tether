// The pure rules of who has a tab (Tether Browser E7, design §3.3, §6, §12b rules 14-16). Two separate bits per tab: who
// HOLDS it (the agent, by default, or the person: she took it, or the agent asked for help) and whether it is PAUSED (the
// brake: one tab, all of them, all of one agent's). What the agent sees is one of three: `user` while the person holds it
// (pausing does not take a tab from her hands), else `paused` while paused, else `agent`. Outside `agent` the gate refuses
// every command of the agent on that tab and holds (drops) every event of it; only the `Tether.*` methods answer.
// A help request (`Tether.askUser`) puts the tab in the person's hands at once and waits until she hands it back (`returned`),
// until its time runs out (`timeout`: the tab stays with her, the bar says the agent gave up), or until the tab closes or the
// agent gives up (`dismissed`).

export type Control = 'agent' | 'user' | 'paused'
export type AskKind = 'login' | 'other'
export type AskOutcome = 'returned' | 'timeout' | 'dismissed'

/** The open help request of a tab (at most one). */
export interface TabAsk {
  id: string
  message: string
  kind: AskKind
}

export interface TabControl {
  holder: 'agent' | 'user'
  paused: boolean
  /** Why the person holds it: she took it, the agent asked (login or other), or the tab is a popup of a tab she holds. */
  why?: 'taken' | 'asked' | 'login' | 'popup'
  ask?: TabAsk
  /** The last help request ran out of time and the tab was not handed back yet ("desistiu de esperar"). */
  askExpired?: boolean
}

export const INITIAL: TabControl = { holder: 'agent', paused: false }

/** What the agent is told. */
export function controlOf(t: TabControl): Control {
  return t.holder === 'user' ? 'user' : t.paused ? 'paused' : 'agent'
}

/** The short reason sent with the state (`Tether.getTabState`/`tabStateChanged`), never the person's words. */
export function reasonOf(t: TabControl): string | undefined {
  if (t.holder === 'user') return t.why === 'asked' || t.why === 'login' ? 'the person is helping, as you asked' : t.why === 'popup' ? 'opened from a tab the person holds' : 'the person took control'
  return t.paused ? 'paused by the person' : undefined
}

export type ControlEvent =
  | { type: 'take' }
  | { type: 'giveBack' }
  | { type: 'ask'; ask: TabAsk }
  | { type: 'askTimeout'; id: string }
  | { type: 'askDismissed'; id: string }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'popupOf'; opener: TabControl }

/** What a transition settles besides the new state: the help request it ends, and how. */
export interface Transition {
  state: TabControl
  settle?: { id: string; outcome: AskOutcome }
}

export function transition(t: TabControl, e: ControlEvent): Transition {
  switch (e.type) {
    case 'take':
      return { state: t.holder === 'user' ? t : { ...t, holder: 'user', why: 'taken' } }
    case 'giveBack': {
      const state: TabControl = { holder: 'agent', paused: t.paused }
      return t.ask ? { state, settle: { id: t.ask.id, outcome: 'returned' } } : { state }
    }
    case 'ask': {
      // Already held by the person (she took it first): the request rides on her hold; the why becomes the request's.
      const state: TabControl = { holder: 'user', paused: t.paused, why: e.ask.kind === 'login' ? 'login' : 'asked', ask: e.ask }
      return t.ask ? { state, settle: { id: t.ask.id, outcome: 'dismissed' } } : { state }
    }
    case 'askTimeout':
      if (t.ask?.id !== e.id) return { state: t }
      return { state: { ...withoutAsk(t), askExpired: true }, settle: { id: e.id, outcome: 'timeout' } }
    case 'askDismissed':
      if (t.ask?.id !== e.id) return { state: t }
      return { state: withoutAsk(t), settle: { id: e.id, outcome: 'dismissed' } }
    case 'pause':
      return { state: t.paused ? t : { ...t, paused: true } }
    case 'resume':
      return { state: t.paused ? { ...t, paused: false } : t }
    case 'popupOf':
      // A popup the person's tab opened (an OAuth window during a login) is hers too, from birth.
      return { state: e.opener.holder === 'user' ? { ...t, holder: 'user', why: 'popup' } : t }
  }
}

function withoutAsk(t: TabControl): TabControl {
  const { ask: _a, ...rest } = t
  return rest
}

/** The person holds the tab because the agent asked for help (login or any other kind). */
export function heldOnRequest(t: TabControl): boolean {
  return t.holder === 'user' && (t.why === 'login' || t.why === 'asked')
}

/**
 * Does handing the tab to the person need the clean hand-off (scripts out, service worker out, reload)? Rule 15, for EVERY
 * help request: the kind is the agent's word ("other" may still say "sign in"), so it never decides what the person is shielded
 * from. A request riding on a hold the person already has (she took it) does not reload under her hands; she saw the warning.
 */
export function needsCleanHandoff(before: TabControl, after: TabControl): boolean {
  return before.holder === 'agent' && heldOnRequest(after)
}

/**
 * Does handing the tab back reload it first? Every hand-back of a help request (rule 16, widened): whatever the person typed and
 * did not send (a 2FA code, a card) would be read by the agent's next snapshot. A manual take keeps the page as she left it
 * (she was warned, with "Recarregar limpo").
 */
export function reloadsOnGiveBack(t: TabControl): boolean {
  return heldOnRequest(t)
}

// ---- Tether.askUser's limits ----

/** The message's ceiling (the package already cuts at the same size). */
export const ASK_MESSAGE_MAX = 500
/** Open requests one agent may have at once, across its tabs (one per tab besides). */
export const ASKS_PER_AGENT = 3
export const ASK_TIMEOUT_DEFAULT_MS = 30 * 60_000
export const ASK_TIMEOUT_MIN_MS = 1_000
export const ASK_TIMEOUT_MAX_MS = 2 * 60 * 60_000

export interface AskInput { message: string; kind: AskKind; timeoutMs: number }

/**
 * Plain text: control characters (but the line break) out, whitespace runs folded, trimmed, cut at the ceiling. Markup is
 * never interpreted downstream (the interface writes it as text), so `<b>` stays the four characters it is.
 */
export function cleanAskMessage(v: unknown): string {
  if (typeof v !== 'string') return ''
  return v.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]+/g, ' ')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, ASK_MESSAGE_MAX)
}

/** The request's parameters checked against the limits; a string is the refusal's reason. */
export function checkAsk(params: { message?: unknown; kind?: unknown; timeoutMs?: unknown }, open: { tab: boolean; agent: number }): AskInput | string {
  const message = cleanAskMessage(params.message)
  if (message === '') return 'the message must say what you need'
  if (open.tab) return 'this tab already has an open request'
  if (open.agent >= ASKS_PER_AGENT) return `at most ${ASKS_PER_AGENT} open requests per agent`
  const kind: AskKind = params.kind === 'login' ? 'login' : 'other'
  const raw = typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs) ? params.timeoutMs : ASK_TIMEOUT_DEFAULT_MS
  const timeoutMs = Math.min(ASK_TIMEOUT_MAX_MS, Math.max(ASK_TIMEOUT_MIN_MS, Math.floor(raw)))
  return { message, kind, timeoutMs }
}

/** The named error the gate answers with, per state, to a command of the agent on a tab it does not have. */
export function heldError(c: Exclude<Control, 'agent'>): { code: string; message: string } {
  return c === 'user'
    ? { code: 'TAB_WITH_USER', message: 'TAB_WITH_USER: the person has this tab; wait for Tether.tabStateChanged before acting' }
    : { code: 'TAB_PAUSED', message: 'TAB_PAUSED: this tab is paused by the person; wait for Tether.tabStateChanged before acting' }
}

// ---- the interface's texts (design §12a) ----

export const controlTexts = (agent: string) => ({
  agent: `${agent} usando`,
  /** The bar of a tab whose agent exited (its chip says the same). */
  ended: `${agent} encerrado`,
  user: 'Com você',
  paused: 'Pausada',
  take: 'Assumir o controle',
  giveBack: `Devolver ao ${agent}`,
  ignored: `O ${agent} está usando esta página. Assumir o controle?`,
  ask: (message: string) => `${agent} pede sua ajuda: ${message}`,
  done: `Pronto, devolver ao ${agent}`,
  waiting: `${agent} espera você devolver a página`,
  expired: `O ${agent} desistiu de esperar. Devolver mesmo assim?`,
  scripts: `O ${agent} pode ter deixado scripts nesta página. Para digitar senha, use Recarregar limpo.`,
  cleanReload: 'Recarregar limpo',
  pauseAll: 'Pausar todas as guias',
  resumeAll: 'Retomar todas',
  pauseAgent: `Pausar as guias do ${agent}`,
  resume: 'Retomar',
})
