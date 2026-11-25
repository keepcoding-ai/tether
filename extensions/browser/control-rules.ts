// The pure rules of who has a tab (Tether Browser E7, design §3.3, §6, §12b rules 14-16). Two separate bits per tab: who
// HOLDS it (the agent, by default, or the person: she took it, or the agent asked for help) and whether it is PAUSED (the
// brake: one tab, all of them, all of one agent's). What the agent sees is one of three: `user` while the person holds it
// (pausing does not take a tab from her hands), else `paused` while paused, else `agent`. Outside `agent` the gate refuses
// every command of the agent on that tab and holds (drops) every event of it; only the `Tether.*` methods answer.
// A help request (`Tether.askUser`) puts the tab in the person's hands at once and waits until she hands it back (`returned`),
// until its time runs out (`timeout`: the tab stays with her, the bar says the agent gave up), until she says she cannot help
// (`declined`: the tab goes back to the agent, as on a hand-back), or until the tab closes or the agent gives up (`dismissed`).
// A hand-back or a decline may carry a short note of hers to the agent (plain text, cleaned as the request's message).

export type Control = 'agent' | 'user' | 'paused'
export type AskKind = 'login' | 'other'
export type AskOutcome = 'returned' | 'declined' | 'timeout' | 'dismissed'

/** How a help request ended, and the person's note when she wrote one (only on `returned` and `declined`). */
export interface AskAnswer {
  outcome: AskOutcome
  note?: string
}

/** The open help request of a tab (at most one). */
export interface TabAsk {
  id: string
  message: string
  kind: AskKind
}

export interface TabControl {
  holder: 'agent' | 'user'
  paused: boolean
  /**
   * Why the person holds it: she took it, the agent asked (login or other), the tab is a popup of a tab she holds, or the tab is
   * her own (`own`: she opened it; it has no agent to hand back to, and it is never paused).
   */
  why?: 'taken' | 'asked' | 'login' | 'popup' | 'own'
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
  if (t.why === 'own') return 'the person\'s own tab'
  if (t.holder === 'user') return t.why === 'asked' || t.why === 'login' ? 'the person is helping, as you asked' : t.why === 'popup' ? 'opened from a tab the person holds' : 'the person took control'
  return t.paused ? 'paused by the person' : undefined
}

export type ControlEvent =
  | { type: 'take' }
  | { type: 'giveBack'; note?: unknown }
  | { type: 'decline'; note?: unknown }
  | { type: 'ask'; ask: TabAsk }
  | { type: 'askTimeout'; id: string }
  | { type: 'askDismissed'; id: string }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'popupOf'; opener: TabControl }
  | { type: 'own' }
  | { type: 'give' }

/** What a transition settles besides the new state: the help request it ends, and how. */
export interface Transition {
  state: TabControl
  settle?: { id: string } & AskAnswer
}

/** The person's own tab, from birth: she holds it, it is not paused, and nothing ever changes that. */
export const OWN: TabControl = { holder: 'user', paused: false, why: 'own' }

export function transition(t: TabControl, e: ControlEvent): Transition {
  if (e.type === 'own') return { state: t.why === 'own' && !t.paused && !t.ask ? t : OWN }
  // She hands her own tab to an agent ("Entregar a um agente…"): from now on it is an agent's tab like any other, with the agent,
  // unpaused. Any other tab is not hers to give: nothing changes.
  if (e.type === 'give') return { state: t.why === 'own' ? INITIAL : t }
  // Her own tab has no agent: no hand-back, no brake, no help request (one is dismissed at once), no popup rule.
  if (t.why === 'own') return e.type === 'ask' ? { state: t, settle: { id: e.ask.id, outcome: 'dismissed' } } : { state: t }
  switch (e.type) {
    case 'take':
      return { state: t.holder === 'user' ? t : { ...t, holder: 'user', why: 'taken' } }
    case 'giveBack':
    case 'decline': {
      // "Não consigo ajudar" hands the tab back too; without an open request it is a plain hand-back.
      const state: TabControl = { holder: 'agent', paused: t.paused }
      if (!t.ask) return { state }
      const note = cleanAskNote(e.note)
      return { state, settle: { id: t.ask.id, outcome: e.type === 'decline' ? 'declined' : 'returned', ...(note ? { note } : {}) } }
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
 * Does the clean hand-off leave this `Page.addScriptToEvaluateOnNewDocument` in place? Only a script with no code: it runs
 * nothing in the person's turn and only makes its named world exist in every new document. The client's own machinery needs
 * it (playwright-core registers `source: ''` with its utility world once per session, at attach, and never again): removed,
 * every later document lacks the world and whatever waits for it (the page's title, a read) waits forever.
 */
export function handoffKeepsScript(params: { source?: unknown; [key: string]: unknown }): boolean {
  return typeof params.source === 'string' && params.source.trim() === ''
}

/**
 * Does handing the tab back reload it first? Every hand-back of a help request (rule 16, widened): whatever the person typed and
 * did not send (a 2FA code, a card) would be read by the agent's next snapshot. A manual take keeps the page as she left it
 * (she was warned, with "Recarregar limpo").
 */
export function reloadsOnGiveBack(t: TabControl): boolean {
  return heldOnRequest(t)
}

/**
 * Does handing her own tab to an agent reload it first (and drop its history)? Always: rule 16 in the other direction. Whatever
 * she typed and did not send (a form, a code) would be read by the agent's first snapshot, and a page she left in the history
 * would come back with its fields filled when the agent goes back. The agent sees the tab only after this.
 */
export function reloadsOnGive(before: TabControl): boolean {
  return before.why === 'own'
}

// ---- Tether.askUser's limits ----

/** The message's ceiling (the package already cuts at the same size). */
export const ASK_MESSAGE_MAX = 500
/** Open requests one agent may have at once, across its tabs (one per tab besides). */
export const ASKS_PER_AGENT = 3
export const ASK_TIMEOUT_DEFAULT_MS = 30 * 60_000
export const ASK_TIMEOUT_MIN_MS = 1_000
export const ASK_TIMEOUT_MAX_MS = 2 * 60 * 60_000

/** The ceiling of the person's note on a hand-back or a decline (the package cuts at the same size). */
export const ASK_NOTE_MAX = 500

export interface AskInput { message: string; kind: AskKind; timeoutMs: number }

export const cleanAskMessage = (v: unknown): string => cleanPlainText(v, ASK_MESSAGE_MAX)
/** The person's note to the agent, cleaned the same way as the agent's message; '' when there is none. */
export const cleanAskNote = (v: unknown): string => cleanPlainText(v, ASK_NOTE_MAX)

/**
 * Plain text: control characters (but the line break) out, whitespace runs folded, trimmed, cut at the ceiling. Markup is
 * never interpreted downstream (the interface writes it as text), so `<b>` stays the four characters it is.
 */
function cleanPlainText(v: unknown, max: number): string {
  if (typeof v !== 'string') return ''
  return v.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]+/g, ' ')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max)
}

/**
 * The request's parameters checked against the limits; a string is the refusal's reason. A request open on the tab that
 * belongs to the same asker (`own`) is replaced by the new one (it ends `dismissed`): a client may drop a call without ever
 * cancelling it, and the orphan would otherwise lock the tab. It no longer counts toward the asker's limit either. A request
 * of another asker on the tab is refused.
 */
export function checkAsk(params: { message?: unknown; kind?: unknown; timeoutMs?: unknown }, open: { tab: boolean; agent: number; own?: boolean }): AskInput | string {
  const message = cleanAskMessage(params.message)
  if (message === '') return 'the message must say what you need'
  const replaces = open.tab && open.own === true
  if (open.tab && !replaces) return 'this tab already has an open request'
  if (open.agent - (replaces ? 1 : 0) >= ASKS_PER_AGENT) return `at most ${ASKS_PER_AGENT} open requests per agent`
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
  /** The pill of an ended agent on a narrow pane. */
  endedShort: 'Encerrado',
  user: 'Com você',
  /** The owner pill while a help request is open, and after it ran out. */
  userAsked: `Com você · pedido do ${agent}`,
  userExpired: `Com você · ${agent} desistiu de esperar`,
  userEnded: `Com você · ${agent} encerrado`,
  paused: 'Pausada',
  take: 'Assumir',
  giveBack: `Devolver ao ${agent}`,
  ignored: `O ${agent} está usando esta página, por isso o seu clique não chegou.`,
  done: 'Pronto, devolver',
  decline: 'Não consigo ajudar',
  giveBackAnyway: 'Devolver mesmo assim',
  waiting: `${agent} espera você devolver a página`,
  scripts: `O ${agent} pode ter deixado scripts nesta página. Antes de digitar uma senha, use Recarregar limpo.`,
  cleanReload: 'Recarregar limpo',
  pauseAll: 'Pausar todas as guias',
  resumeAll: 'Retomar todas',
  pauseAgent: `Pausar as guias do ${agent}`,
  pause: 'Pausar',
  resume: 'Retomar',
})

/** The texts of the "Sua vez" card (a help request open on the tab). */
export const askCardTexts = (agent: string) => ({
  tag: 'SUA VEZ',
  title: `O ${agent} precisa de você`,
  hint: 'Faça isto aqui mesmo, nesta guia. Enquanto ela está com você, o agente não vê nem mexe em nada.',
  /** Writing to the agent is secondary: a discreet link opens the note box, whose text rides on either answer. */
  write: `Escrever ao ${agent}`,
  say: `Mensagem ao ${agent}`,
  placeholder: 'Ex.: não tenho acesso a essa conta · entrei, mas pediu 2FA',
  collapse: 'recolher',
  /** The owner pill's toggle while a request is open: the collapsed card disappears and the pill brings it back. */
  showAsk: '▾',
  /** Dropped on a narrow pane, where the pill keeps the mark alone. */
  showAskWord: 'ver pedido',
  showAskTitle: 'Ver o pedido',
  hideAsk: '▴',
  hideAskTitle: 'Recolher o pedido',
})

/**
 * The line of a pending help request where the person looks (the seals, the badges, the tray): "‹Agente› pede ajuda em ‹site›:
 * ‹mensagem›". A request that ran out and was not handed back says the agent waits for the page.
 */
export function helpLine(agent: string, host: string, ask: { message: string } | undefined): string {
  if (!ask) return controlTexts(agent).waiting
  return host ? `${agent} pede ajuda em ${host}: ${ask.message}` : `${agent} pede ajuda: ${ask.message}`
}
