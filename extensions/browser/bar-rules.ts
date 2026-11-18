// What the bar of a tab shows (pure; the renderer only draws it): the owner pill (who has the tab and what is going on, in
// one phrase and one tone; during a help request it also opens and collapses the card), the "Sua vez" card of an open help
// request (collapsed: gone entirely, the page never covered), the notices under the bar (a list: a click the shield
// refused, the scripts warning after a manual take and the refused popups can show together) and the bar's actions, which
// are the tab menu's actions (tab-actions.ts) with the bar's own pins per state:
//   agent using  → "Assumir" highlighted, "Pausar" as an icon
//   paused       → "Retomar" highlighted
//   help request → "Pronto, devolver" highlighted, "Não consigo ajudar" with text (the card repeats both)
//   ran out      → "Devolver mesmo assim" highlighted
//   person holds → "Devolver ao ‹agente›" highlighted, "Recarregar limpo" with text
//   agent ended  → nothing pinned (the menu keeps what is left)
// Closing is never pinned on the bar: the tab has its ×.
import type { MenuPin } from '../../app/renderer/ext-api.ts'
import { askCardTexts, controlTexts, type TabControl } from './control-rules.ts'
import { POPUPS_REFUSED, shortName, type TabFactId } from './rules.ts'
import { type TabAction, type TabActionId, tabActions } from './tab-actions.ts'

export type OwnerTone = 'agent' | 'ask' | 'you' | 'paused' | 'ended'

export interface TabViewInput {
  /** Main's word on the tab's control; undefined before it answered (the tab starts with the agent). */
  control?: Pick<TabControl, 'holder' | 'paused' | 'why' | 'askExpired'> & { ask?: { id: string; message: string } }
  /** Main has the tab (a pane back from layout.json has none until it is shown). */
  loaded: boolean
  /** The owner's name as the texts use it, and whether it lives. */
  agent: { name: string; alive: boolean }
  /** The person clicked the shield a moment ago. */
  ignored: boolean
  /** Windows the page tried to open past the limit. */
  popupsRefused: number
  /** The help request whose card the person collapsed (by id: a new request opens expanded). */
  collapsedAsk?: string
  /** The agent acted a moment ago (the pill's live dot). */
  acting: boolean
}

export type NoticeKind = 'ignored' | 'scripts' | 'popups'
export interface TabNotice {
  kind: NoticeKind
  text: string
  action?: { id: TabActionId; label: string }
}

export interface AskCard extends ReturnType<typeof askCardTexts> {
  id: string
  /** The agent's message, plain text. */
  message: string
  collapsed: boolean
  done: string
  decline: string
}

export interface TabView {
  /**
   * The pill. `short` is its phrase on a narrow pane (the name, "Com você", "Pausada", "Encerrado"; same tone). While a request
   * is open it carries `toggle` (it opens or collapses the card: "▾ ver pedido" with the card collapsed, the word dropped on a
   * narrow pane; "▴" with it open); otherwise a click goes to the agent.
   */
  owner: { tone: OwnerTone; text: string; short: string; live: boolean; toggle?: { mark: string; word: string; title: string } }
  ask?: AskCard
  notices: TabNotice[]
  /** The tab menu's actions with the bar's pins. */
  actions: TabAction[]
  /** History and reload answer only while the person holds a loaded tab. */
  nav: boolean
}

/** The facts behind the address's ⓘ, in the popover's order; the ⓘ carries a dot while the list is not empty. */
export function tabFacts(f: { cookies: number; persistentLogins: boolean; debug: boolean; addressLost: boolean }): TabFactId[] {
  const out: TabFactId[] = []
  if (f.cookies > 0) out.push('cookies')
  if (!f.persistentLogins) out.push('memory')
  if (f.debug) out.push('debug')
  if (f.addressLost) out.push('address')
  return out
}

export function tabView(i: TabViewInput): TabView {
  const name = shortName(i.agent.name)
  const t = controlTexts(name)
  const holder = i.control?.holder ?? 'agent'
  const paused = i.control?.paused ?? false
  const alive = i.agent.alive
  const ask = holder === 'user' ? i.control?.ask : undefined
  const expired = holder === 'user' && !ask && !!i.control?.askExpired
  const using = i.loaded && holder === 'agent' && !paused

  const card = askCardTexts(name)
  const collapsed = !!ask && i.collapsedAsk === ask.id
  const [tone, text]: [OwnerTone, string] = holder === 'user'
    ? ask ? ['ask', t.userAsked] : ['you', expired ? t.userExpired : alive ? t.user : t.userEnded]
    : !alive ? ['ended', t.ended] : paused ? ['paused', t.paused] : ['agent', i.loaded ? t.agent : name]
  const short = tone === 'agent' ? name : tone === 'ask' || tone === 'you' ? t.user : tone === 'paused' ? t.paused : t.endedShort
  const owner: TabView['owner'] = {
    tone, text, short, live: tone === 'agent' && i.loaded && i.acting,
    ...(ask ? { toggle: collapsed ? { mark: card.showAsk, word: card.showAskWord, title: card.showAskTitle } : { mark: card.hideAsk, word: '', title: card.hideAskTitle } } : {}),
  }

  const notices: TabNotice[] = []
  if (using && i.ignored) notices.push({ kind: 'ignored', text: t.ignored, action: { id: 'take', label: t.take } })
  if (holder === 'user' && i.control?.why === 'taken') notices.push({ kind: 'scripts', text: t.scripts })
  if (i.popupsRefused > 0) notices.push({ kind: 'popups', text: POPUPS_REFUSED })

  const barPin = (a: TabAction): MenuPin | undefined => {
    if (!alive || a.id === 'close') return undefined
    if (holder === 'user') {
      if (a.id === 'give-back') return 'highlight'
      if (a.id === 'decline') return 'primary'
      if (a.id === 'clean-reload') return ask || expired ? undefined : 'primary'
      return undefined
    }
    if (a.id === 'resume') return 'highlight'
    if (a.id === 'take') return using ? 'highlight' : undefined
    if (a.id === 'pause') return 'icon'
    return undefined
  }
  const actions = tabActions({ holder, paused, loaded: i.loaded, agentAlive: alive, asking: !!ask, expired }, name).map(a => {
    const { pin: _menuPin, ...rest } = a
    const pin = barPin(a)
    return pin ? { ...rest, pin } : rest
  })

  return {
    owner,
    ...(ask ? { ask: { ...card, id: ask.id, message: ask.message, collapsed, done: t.done, decline: t.decline } } : {}),
    notices,
    actions,
    nav: i.loaded && holder === 'user',
  }
}
