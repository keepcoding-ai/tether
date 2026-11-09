// The browser extension's channels between its renderer and main sides (E2: the tab registry; E4: the local-network question).
import type { ControlView } from './control.ts'
import type { LocalNetworkAsk } from './local-network-rules.ts'
import type { ActionKind } from './pad-rules.ts'
import type { SavedTab, TabInfo } from './tab-rules.ts'
import type { TabBlocked } from './tabs.ts'

export interface BrowserStatus {
  /** False when the tabs' partition is in memory (the cookie-encryption fuse is off): "logins não são guardados". */
  persistentLogins: boolean
}

export interface BrowserChannels {
  invoke: {
    list: () => TabInfo[]
    get: (tabId: string) => TabInfo | null
    /** Brings back a tab saved in layout.json (the person showed it): created again with its id and owner, its address loaded. */
    restore: (saved: SavedTab) => TabInfo | null
    close: (tabId: string) => void
    status: () => BrowserStatus
    /** The local-network questions still waiting for the person (the renderer asks when it starts). */
    localNetworkOpen: () => LocalNetworkAsk[]
    /** The person's answer to one question: 'once', 'always' or 'deny' (anything else refuses). */
    localNetworkAnswer: (id: string, choice: string) => void
    /** E7: who has each tab, and the person's actions on it. */
    controls: () => ControlView[]
    take: (tabId: string) => void
    giveBack: (tabId: string) => void
    cleanReload: (tabId: string) => void
    pause: (tabId: string) => void
    resume: (tabId: string) => void
    /** E9: the history buttons of the bar (only while the person holds the tab). */
    back: (tabId: string) => void
    forward: (tabId: string) => void
    reload: (tabId: string) => void
    pauseAll: () => void
    resumeAll: () => void
    pauseAgent: (slotId: string) => void
    resumeAgent: (slotId: string) => void
  }
  events: {
    /** A tab was created or changed (title, address, loading). */
    tab: (info: TabInfo) => void
    closed: (tabId: string) => void
    /** A request of the tab was refused by the network filter (reason and destination origin only). */
    blocked: (event: TabBlocked) => void
    /** An agent asks to open a local address: ask the person (one question at a time). */
    localNetworkAsk: (ask: LocalNetworkAsk) => void
    /** A question no longer needs an answer (its tab closed). */
    localNetworkCancelled: (id: string) => void
    /** E7: a tab's control changed (held, paused, a help request opened, ran out or ended). */
    control: (view: ControlView) => void
    /** E9: the agent acted on the tab (its dot lights for a moment). */
    activity: (tabId: string, kind: ActionKind) => void
  }
}
