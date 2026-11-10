// The pure rules of the pad "Guias" (Tether Browser E11, design §5.3, §12a): which tabs go on top (the ones with the person),
// how the rest are grouped by agent, the counts the controls and the icon show, and the sentence for an agent's last action.
// The view (renderer.ts) feeds these what it knows (the panes, the agents, who has each tab) and only draws the answer.
import type { DialogSpec } from '../../app/shared/dialog.ts'
import type { Control } from './control-rules.ts'
import { shortName } from './rules.ts'

/** What the pad knows of one tab. `place` is the desk the pane is in now (the Browser desk, or where the person took it). */
export interface PadTab {
  tabId: string
  ownerSlotId: string
  title: string
  url: string
  control: Control
  /** A help request is open, or ran out and was not handed back. */
  asking: boolean
  expired: boolean
  place?: string
}

/** The agent as the pad needs it; undefined when no pane shows it (it was closed). */
export interface PadAgentInfo { name: string; alive: boolean }

export interface PadGroup {
  slotId: string
  name: string
  /** The agent exited, or its pane is gone: nobody answers on these tabs. */
  ended: boolean
  /** The group's tabs that are not on top (the ones with the person are). */
  tabs: PadTab[]
  /** Every tab of the agent, the top ones too (what "Pausar as guias do ‹agente›" and "Fechar as guias do ‹agente›" act on). */
  total: number
  paused: number
}

export interface PadModel {
  /** The tabs with the person, in the order the tabs are given. */
  withPerson: PadTab[]
  groups: PadGroup[]
  total: number
  paused: number
  /** Tabs of agents that ended. */
  endedTabs: number
  /** The icon's number: tabs with the person or asking for help. */
  attention: number
  asking: number
}

/** True while the person holds the tab (she took it, the agent asked, or it is a popup of one she holds). */
export const withPerson = (t: Pick<PadTab, 'control' | 'asking'>): boolean => t.control === 'user' || t.asking

/** What main knows of an agent's slot (`main.agents`): the slot's own name and whether its process lives. */
export interface MainAgentView { slotId: string; name: string; alive: boolean }

/**
 * The agent as the interface tells it. Whether it LIVES is main's word (the slot's real state): a closed pane does not make an
 * agent ended, and an agent with no slot at all is. The name is the pane's when one shows the agent, else the slot's. Until main
 * has answered once (`known` false) the pane's word stands, so nothing is called ended by guess. A slot main does not know is ended
 * (it is gone), with a neutral name when no pane shows it either.
 */
export function resolveAgent(
  pane: PadAgentInfo | undefined, slot: MainAgentView | undefined, known: boolean,
): PadAgentInfo | undefined {
  if (!known) return pane
  return { name: pane?.name ?? slot?.name ?? 'Agente', alive: !!slot && slot.alive }
}

export const isEnded = (agent: PadAgentInfo | undefined): boolean => !agent || !agent.alive

/**
 * The pad's model. `tabs` come in the order the panes are on screen: the owners go in the order of their first tab, and each
 * agent's tabs keep theirs. `only` keeps one agent's tabs ("Ver guias do ‹agente›").
 */
export function buildPad(tabs: readonly PadTab[], agentOf: (slotId: string) => PadAgentInfo | undefined, only?: string): PadModel {
  const kept = only === undefined ? tabs : tabs.filter(t => t.ownerSlotId === only)
  const order: string[] = []
  const bySlot = new Map<string, PadTab[]>()
  for (const t of kept) {
    const list = bySlot.get(t.ownerSlotId)
    if (list) list.push(t)
    else { bySlot.set(t.ownerSlotId, [t]); order.push(t.ownerSlotId) }
  }
  const groups: PadGroup[] = order.map(slotId => {
    const all = bySlot.get(slotId)!
    const agent = agentOf(slotId)
    return {
      slotId, name: shortName(agent?.name), ended: isEnded(agent), tabs: all.filter(t => !withPerson(t)),
      total: all.length, paused: all.filter(t => t.control === 'paused').length,
    }
  })
  const top = kept.filter(withPerson)
  return {
    withPerson: top, groups, total: kept.length, paused: kept.filter(t => t.control === 'paused').length,
    endedTabs: groups.reduce((n, g) => n + (g.ended ? g.total : 0), 0), attention: top.length, asking: kept.filter(t => t.asking).length,
  }
}

/** The tabs of agents that ended, for "Fechar guias de agentes encerrados". */
export function endedTabIds(tabs: readonly PadTab[], agentOf: (slotId: string) => PadAgentInfo | undefined): string[] {
  return tabs.filter(t => isEnded(agentOf(t.ownerSlotId))).map(t => t.tabId)
}

// ---- the agent's last action, in words ----

export type ActionKind = 'typing' | 'clicking' | 'scrolling' | 'navigating' | 'reading' | 'acting'

/** How long an action counts as what the agent is doing now. */
export const ACTION_FRESH_MS = 8_000

/**
 * The coarse kind of an agent's command, from the CDP method the gatekeeper saw (never its parameters but the wheel/mouse type).
 * What the pad says of it is only this kind and the tab's own host: nothing of what was typed or clicked.
 */
export function actionKindOf(method: string, mouseType?: unknown): ActionKind {
  switch (method) {
    case 'Input.insertText': case 'Input.dispatchKeyEvent': case 'Input.imeSetComposition': return 'typing'
    case 'Input.dispatchMouseEvent': return mouseType === 'mouseWheel' ? 'scrolling' : 'clicking'
    case 'Input.dispatchTouchEvent': case 'Input.synthesizeTapGesture': return 'clicking'
    case 'Input.synthesizeScrollGesture': return 'scrolling'
    case 'Page.navigate': case 'Page.reload': case 'Page.navigateToHistoryEntry': return 'navigating'
    case 'Page.captureScreenshot': case 'Page.getFrameTree': case 'Page.getLayoutMetrics': case 'Page.printToPDF': return 'reading'
    default: return /^(Accessibility|DOM|DOMSnapshot|CSS)\./.test(method) ? 'reading' : 'acting'
  }
}

export interface LastAction { kind: ActionKind; at: number }

/** The host of an address ("github.com"), '' when there is none. */
export function hostOf(url: string): string {
  try { return new URL(url).host } catch { return '' }
}

/** The address as the pad's row writes it: no scheme, no query, cut. */
export function shortAddress(url: string, max = 48): string {
  let out = url
  try { const u = new URL(url); out = u.protocol === 'http:' || u.protocol === 'https:' ? `${u.host}${u.pathname === '/' ? '' : u.pathname}` : url } catch { /* not an address */ }
  return out.length <= max ? out : `${out.slice(0, max - 1)}…`
}

const VERB: Record<ActionKind, string> = {
  typing: 'digitando', clicking: 'clicando', scrolling: 'rolando a página', navigating: 'navegando', reading: 'lendo a página', acting: 'agindo',
}

/**
 * The sentence for what the agent is doing on a tab: "digitando em github.com", "esperando você", "Pausada". With the agent
 * having the tab and no fresh action to tell, "sem ação agora".
 */
export function lastActionText(i: { control: Control; asking: boolean; expired: boolean; ended: boolean; name: string; url: string; action?: LastAction; now: number }): string {
  if (i.asking) return 'esperando você'
  if (i.expired) return `${i.name} desistiu de esperar`
  if (i.control === 'user') return 'com você'
  if (i.control === 'paused') return 'pausada'
  if (i.ended) return `${i.name} encerrado`
  if (!i.action || i.now - i.action.at > ACTION_FRESH_MS) return 'sem ação agora'
  const host = hostOf(i.url)
  return host ? `${VERB[i.action.kind]} em ${host}` : VERB[i.action.kind]
}

// ---- where the person is taken when a help request is pending (E12) ----

/** The tab a click on the Browser pill or the pad's icon leads to: the oldest help request still open; undefined when none. */
export function oldestAsking(order: readonly { tabId: string; at: number }[]): string | undefined {
  let best: { tabId: string; at: number } | undefined
  for (const o of order) if (!best || o.at < best.at) best = o
  return best?.tabId
}

// ---- the icon's badge ----

export function padBadge(m: PadModel): { count: number; attention: boolean; tooltip: string } | undefined {
  if (m.attention === 0) return undefined
  const tooltip = m.asking > 0
    ? `${m.asking} ${m.asking === 1 ? 'guia pede' : 'guias pedem'} sua ajuda`
    : `${m.attention} ${m.attention === 1 ? 'guia está' : 'guias estão'} com você`
  return { count: m.attention, attention: m.asking > 0, tooltip }
}

// ---- the pad's texts (design §5.3, §12a) ----

export const PAD_LOGOUT_ALL = 'Sair de todas as contas'
export const PAD_LOGOUT_CONFIRM = 'Todos os agentes perdem o acesso às contas logadas.'
export const PAD_WITH_YOU = 'Com você'
export const PAD_CLOSE_ENDED = 'Fechar guias de agentes encerrados'
export const padCloseEnded = (n: number): string => `${PAD_CLOSE_ENDED} (${n})`
export const padResumeAgent = (name: string): string => `Retomar as guias do ${name}`
export const padCloseAgent = (name: string): string => `Fechar as guias do ${name}`
export const padSeeAgent = (name: string): string => `Ver guias do ${name}`
export const PAD_SHOW_ALL = 'Mostrar todas'
export const padFiltered = (name: string): string => `Guias do ${name}`
export const PAD_NONE_OF_AGENT = 'Este agente não tem guias abertas.'
export const padWhere = (place: string): string => `Em ${place}`

export const LOGOUT_SITUATION = 'browser-logout-all'

/** The confirmation of "Sair de todas as contas" (design §12a, §4.2): the one question before the logins of every agent go. */
export function logoutDialog(): DialogSpec {
  return {
    situation: LOGOUT_SITUATION,
    tone: 'warn',
    icon: 'shield-warning',
    title: PAD_LOGOUT_ALL,
    message: PAD_LOGOUT_CONFIRM,
    choices: [
      { id: 'cancel', icon: 'globe-simple', label: 'Cancelar', consequence: 'Nada muda: as contas continuam logadas.', tone: 'safe' },
      { id: 'logout', icon: 'trash', label: PAD_LOGOUT_ALL, consequence: 'Cookies e armazenamento das guias são apagados e as guias abertas recarregam.', tone: 'destructive' },
    ],
    defaultChoice: 'cancel',
    escChoice: 'cancel',
  }
}

/**
 * The count the Browser pill's badge adds. The pill already counts the seals of the panes that sit in the Browser desk (the core
 * adds `pillMark`: seals + badge), and a help request seals its tab's pane: counting those again in the badge showed 2 for one
 * request. The badge counts only the requests whose tab pane is NOT in the Browser desk (moved to another desk, or not drawn
 * yet), which no seal of this desk counts; the flag keeps the pill lit either way.
 */
export function pillBadgeCount(waiting: readonly { paneInBrowserDesk: boolean }[]): number {
  return waiting.filter(w => !w.paneInBrowserDesk).length
}
