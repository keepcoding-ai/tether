// The actions on one tab (pure): the single definition the tab menu (right-click, the strip's "⋯"), the tab's × and each row
// of the pad "Guias" read, so the same action has the same name, icon and rule everywhere. The renderer runs them through one
// function (renderer.ts `runTabAction`). Who has the tab decides what is offered: the person takes a tab the agent holds and
// hands back one she holds; the brake (pause/resume) is a separate bit and works on a tab not loaded yet (E12); "Recarregar
// limpo" only on a tab she holds. Closing a tab the agent is using asks first, in the app's own dialog.
import type { DialogSpec } from '../../app/shared/dialog.ts'
import type { MenuPin } from '../../app/renderer/ext-api.ts'
import { controlTexts } from './control-rules.ts'

export type TabActionId = 'take' | 'give-back' | 'pause' | 'resume' | 'clean-reload' | 'close'

/** What the actions depend on: who holds the tab, the brake, whether main has it loaded, whether its agent lives. */
export interface TabActionState {
  holder: 'agent' | 'user'
  paused: boolean
  /** Main has the tab (a pane back from layout.json has none until it is shown). */
  loaded: boolean
  agentAlive: boolean
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
  take: 'hand-grabbing', 'give-back': 'arrow-u-up-left', pause: 'pause', resume: 'play', 'clean-reload': 'arrow-clockwise', close: 'x',
}

export const CLOSE_TAB = 'Fechar guia'
export const CLOSE_TAB_SITUATION = 'browser.close-tab'

/** The agent is using the tab now: it holds it, unpaused, alive, and main has the tab. */
export function agentUsing(s: TabActionState): boolean {
  return s.loaded && s.holder === 'agent' && !s.paused && s.agentAlive
}

/** Closing asks first only while the agent is using the tab (the label then ends in "…", as every action that asks). */
export const closeNeedsConfirm = agentUsing

/** The tab's actions in order: who has it, the brake, the clean reload, close (always last). */
export function tabActions(s: TabActionState, agent: string): TabAction[] {
  const t = controlTexts(agent)
  const out: TabAction[] = []
  const add = (id: TabActionId, label: string, danger?: boolean, pin?: MenuPin): void => { out.push({ id, icon: TAB_ACTION_ICON[id], label, ...(danger ? { danger } : {}), ...(pin ? { pin } : {}) }) }
  if (s.holder === 'user') add('give-back', t.giveBack, false, s.agentAlive ? 'highlight' : undefined)
  else if (s.loaded) add('take', t.take, false, s.agentAlive ? 'icon' : undefined)
  // An ended agent has no brake: nobody answers on its tabs.
  // Held by the person, the brake stays in the menu only (the bar keeps the hand back and ×).
  if (s.agentAlive) add(s.paused ? 'resume' : 'pause', s.paused ? t.resume : t.pause, false, s.holder === 'user' ? undefined : 'icon')
  if (s.holder === 'user' && s.loaded) add('clean-reload', t.cleanReload)
  add('close', closeNeedsConfirm(s) ? `${CLOSE_TAB}…` : CLOSE_TAB, true, 'icon')
  return out
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
