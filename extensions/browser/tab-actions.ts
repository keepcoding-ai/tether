// The actions on one tab (pure): the single definition the tab menu (right-click, the strip's "⋯"), the tab's × and each row
// of the pad "Guias" read, so the same action has the same name, icon and rule everywhere. The renderer runs them through one
// function (renderer.ts `runTabAction`). Who has the tab decides what is offered: the person takes a tab the agent holds and
// hands back one she holds; the brake (pause/resume) is a separate bit and works on a tab not loaded yet (E12); "Recarregar
// limpo" only on a tab she holds. Closing a tab the agent is using asks first, in the app's own dialog. While a help request is
// open the hand-back reads "Pronto, devolver" and "Não consigo ajudar" (decline) follows it; after the request ran out the
// hand-back reads "Devolver mesmo assim".
import type { DialogSpec } from '../../app/shared/dialog.ts'
import type { MenuPin } from '../../app/renderer/ext-api.ts'
import { controlTexts } from './control-rules.ts'

export type TabActionId = 'take' | 'give-back' | 'decline' | 'pause' | 'resume' | 'clean-reload' | 'close'

/** What the actions depend on: who holds the tab, the brake, whether main has it loaded, whether its agent lives. */
export interface TabActionState {
  holder: 'agent' | 'user'
  paused: boolean
  /** Main has the tab (a pane back from layout.json has none until it is shown). */
  loaded: boolean
  agentAlive: boolean
  /** A help request of the agent is open on the tab (the person holds it on request). */
  asking?: boolean
  /** The last help request ran out and the tab was not handed back yet. */
  expired?: boolean
  /** The person's own tab: no agent behind it, so nothing to take, hand back, pause or clean; only close (no question). */
  own?: boolean
}

export interface TabAction {
  id: TabActionId
  icon: string
  label: string
  danger?: boolean
  /** How the bar shows it (see MenuPin); undefined stays in the menu only. */
  pin?: MenuPin
}

/** One icon per action, the same in the menu and the pad. */
export const TAB_ACTION_ICON: Record<TabActionId, string> = {
  take: 'hand-grabbing', 'give-back': 'arrow-u-up-left', decline: 'x-circle', pause: 'pause', resume: 'play', 'clean-reload': 'arrow-clockwise', close: 'x',
}

export const CLOSE_TAB = 'Fechar guia'
export const CLOSE_TAB_SITUATION = 'browser.close-tab'

/** The agent is using the tab now: it holds it, unpaused, alive, and main has the tab. */
export function agentUsing(s: TabActionState): boolean {
  return !s.own && s.loaded && s.holder === 'agent' && !s.paused && s.agentAlive
}

/** Closing asks first only while the agent is using the tab (the label then ends in "…", as every action that asks). */
export const closeNeedsConfirm = agentUsing

/** The tab's actions in order: who has it, the brake, the clean reload, close (always last). */
export function tabActions(s: TabActionState, agent: string): TabAction[] {
  const t = controlTexts(agent)
  const out: TabAction[] = []
  const add = (id: TabActionId, label: string, danger?: boolean, pin?: MenuPin): void => { out.push({ id, icon: TAB_ACTION_ICON[id], label, ...(danger ? { danger } : {}), ...(pin ? { pin } : {}) }) }
  if (s.own) { add('close', CLOSE_TAB, true, 'icon'); return out }
  if (s.holder === 'user') {
    const asking = !!s.asking && s.agentAlive
    add('give-back', asking ? t.done : s.expired ? t.giveBackAnyway : t.giveBack, false, s.agentAlive ? 'highlight' : undefined)
    if (asking) add('decline', t.decline)
  } else if (s.loaded) add('take', t.take, false, s.agentAlive ? 'icon' : undefined)
  // An ended agent has no brake: nobody answers on its tabs.
  // Held by the person, the brake stays in the menu only (the bar keeps the hand back and ×).
  if (s.agentAlive) add(s.paused ? 'resume' : 'pause', s.paused ? t.resume : t.pause, false, s.holder === 'user' ? undefined : 'icon')
  if (s.holder === 'user' && s.loaded) add('clean-reload', t.cleanReload)
  add('close', closeNeedsConfirm(s) ? `${CLOSE_TAB}…` : CLOSE_TAB, true, 'icon')
  return out
}

// ---- "Entregar a um agente…": her own tab goes to an agent (the tab menu, the bar's "⋯", the pad's row) ----

export const GIVE_TAB = 'Entregar a um agente…'
export const GIVE_TAB_ICON = 'robot'
export const GIVE_TAB_SITUATION = 'browser.give-tab'

/** Offered on her own tab once main has it (a pane back from layout.json has nothing to reload yet). */
export const canGive = (s: TabActionState): boolean => !!s.own && s.loaded

/** The agent picker's texts (the core's list picker, the rows the tether uses to give a pane). */
export const GIVE_PICK = {
  title: (title: string): string => `Entregar «${title}» a um agente`,
  placeholder: 'Buscar agente…',
  empty: 'Nenhum agente vivo para receber a guia',
}

/** An agent as the picker shows it (the core's `agents.list()` row). */
export interface GiveAgent { slotId: string; name: string; kind?: string; alive: boolean; deskTitle?: string; inDrawer?: boolean; placed?: false }

/**
 * The picker's rows: live agents only, by name, each with its engine's icon, initial and hue (the owner pill's colour) and where
 * it lives, plus the emblem its tab wears, the way the tether lists agents to give a pane to.
 */
export function giveItems<E>(agents: readonly GiveAgent[], hue: (slotId: string) => number, emblemOf?: (slotId: string) => E | undefined): {
  value: string; label: string; detail?: string; engine?: string; icon: string; letter: string; hue: number; emblem?: E
}[] {
  return agents.filter(a => a.alive).sort((a, b) => a.name.localeCompare(b.name)).map(a => {
    const where = a.placed === false ? 'sem guia' : a.inDrawer ? 'na Gaveta' : a.deskTitle ? `na mesa ${a.deskTitle}` : ''
    const emblem = emblemOf?.(a.slotId)
    return {
      value: a.slotId, label: a.name, icon: 'robot', letter: a.name.trim().charAt(0).toUpperCase() || '?', hue: hue(a.slotId),
      ...(where ? { detail: where } : {}), ...(a.kind ? { engine: a.kind } : {}), ...(emblem ? { emblem } : {}),
    }
  })
}

/** The one-line question before giving: what changes for her (the page reloads, her logins go along with the tab). */
export function giveTabDialog(agent: string, title: string): DialogSpec {
  return {
    situation: GIVE_TAB_SITUATION,
    tone: 'warn',
    icon: GIVE_TAB_ICON,
    title: `Entregar esta guia a ${agent}?`,
    message: 'A página recarrega e as contas em que você entrou ficam com ele.',
    context: { icon: 'globe-simple', name: title || 'Guia', lines: [] },
    choices: [
      { id: 'cancel', icon: 'globe-simple', label: 'Manter comigo', consequence: 'Nada muda: a guia continua sua.', tone: 'safe' },
      { id: 'give', icon: GIVE_TAB_ICON, label: 'Entregar', consequence: `A guia passa a ser de ${agent}; você pode assumir de volta quando quiser.`, tone: 'neutral' },
    ],
    defaultChoice: 'cancel',
    escChoice: 'cancel',
  }
}

/** The give did not happen (the agent's new tab did not open or load, or the tab was no longer hers to give): hers stays hers. */
export function giveFailedDialog(agent: string, outcome: string): DialogSpec {
  const why = outcome === 'failed' ? 'A guia nova não abriu a página a tempo.'
    : outcome === 'no-agent' ? `${agent} não está mais vivo.`
    : outcome === 'full' ? `${agent} já tem guias demais.`
    : 'A guia não estava mais com você.'
  return {
    situation: 'browser.give-failed',
    tone: 'warn',
    icon: 'shield-warning',
    title: `A guia não foi entregue a ${agent}`,
    message: `${why} Nada mudou: a guia continua sua.`,
    choices: [{ id: 'ok', icon: 'check', label: 'Entendi', consequence: 'A guia continua com você.', tone: 'safe' }],
  }
}

/** The question before closing a tab the agent is using. */
export function closeTabDialog(agent: string, title: string): DialogSpec {
  return {
    situation: CLOSE_TAB_SITUATION,
    tone: 'warn',
    icon: 'globe-simple',
    title: `Fechar a guia que o ${agent} está usando?`,
    message: `O ${agent} perde esta página no meio do que está fazendo.`,
    context: { icon: 'globe-simple', name: title || 'Guia', lines: [] },
    choices: [
      { id: 'cancel', icon: 'globe-simple', label: 'Manter aberta', consequence: `Nada muda: o ${agent} continua usando a guia.`, tone: 'safe' },
      { id: 'close', icon: 'x', label: CLOSE_TAB, consequence: 'A guia fecha e a página some para o agente.', tone: 'destructive' },
    ],
    defaultChoice: 'cancel',
    escChoice: 'cancel',
  }
}
