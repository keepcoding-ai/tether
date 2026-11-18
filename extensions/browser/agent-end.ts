// An agent whose slot is removed for good takes its tabs with it (the rule is closed-rules.ts `tabsToCloseOnEnd`). The trigger is
// the removal alone: an agent that exits (restart in place, a stop to resume later) or a daemon that is lost keeps its tabs.
import type { AgentRemoval, MainAgents } from '../../app/main/ext-api.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { tabsToCloseOnEnd } from './closed-rules.ts'

export interface AgentEndTabs {
  list(): ReadonlyArray<{ tabId: string; ownerSlotId: string }>
  /** Who holds the tab and whether a help request is open on it. */
  controlOf(tabId: string): { holder: 'agent' | 'user'; asking: boolean }
  /** Closes the tab the way the interface's close does: into the history first, then gone. */
  close(tabId: string, removal: AgentRemoval): void
}

export function closeTabsOnAgentRemoved(agents: Pick<MainAgents, 'onDidRemove'>, tabs: AgentEndTabs): IDisposable {
  return agents.onDidRemove(removal => {
    for (const t of tabsToCloseOnEnd(tabs.list(), removal.slotId, tabs.controlOf)) tabs.close(t.tabId, removal)
  })
}
