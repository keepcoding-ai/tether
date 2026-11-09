// The browser extension's channels between its renderer and main sides (E2: the tab registry; E4: the local-network question).
import type { LocalNetworkAsk } from './local-network-rules.ts'
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
  }
}
