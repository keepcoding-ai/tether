// The browser extension's channels between its renderer and main sides (E2: the tab registry; E4: the local-network question).
import type { ClosedTab } from './closed-rules.ts'
import type { ControlView } from './control.ts'
import type { DownloadEntry, UploadAsk } from './files-rules.ts'
import type { LocalNetworkAsk } from './local-network-rules.ts'
import type { ActionKind, MainAgentView } from './pad-rules.ts'
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
    /**
     * The person closed the tab (`by` 'cleanup': the ended agents' "Fechar todas"); it enters the closed history. `saved` is the
     * pane's saved tab, for a tab back from layout.json that main never loaded.
     */
    close: (tabId: string, by?: 'user' | 'cleanup', saved?: SavedTab) => void
    /** The closed history ("Fechadas"), newest first, the expiry applied. */
    closedList: () => ClosedTab[]
    /** "Reabrir": a new tab with the entry's address, held by the person; the entry leaves the history. */
    reopenClosed: (id: string) => TabInfo | null
    /** "Limpar histórico". */
    clearClosed: () => void
    /** "Reabrir" of a tab in the crash state: created again with its id, owner and address. */
    reopen: (tabId: string) => TabInfo | null
    status: () => BrowserStatus
    /** The local-network questions still waiting for the person (the renderer asks when it starts). */
    localNetworkOpen: () => LocalNetworkAsk[]
    /** The person's answer to one question: 'once', 'always' or 'deny' (anything else refuses). */
    localNetworkAnswer: (id: string, choice: string) => void
    /** E7: who has each tab, and the person's actions on it. */
    controls: () => ControlView[]
    take: (tabId: string) => void
    /** The person hands the tab back; on a help request her optional note goes to the agent with the answer. */
    giveBack: (tabId: string, note?: string) => void
    /** "Não consigo ajudar": the help request ends declined (with her optional note) and the tab goes back to the agent. */
    decline: (tabId: string, note?: string) => void
    cleanReload: (tabId: string) => void
    pause: (tabId: string) => void
    resume: (tabId: string) => void
    /** E9: the history buttons of the bar (only while the person holds the tab). */
    back: (tabId: string) => void
    forward: (tabId: string) => void
    reload: (tabId: string) => void
    /** The brake on a set of tabs (all, or one agent's): the interface knows which, loaded or not. */
    pauseTabs: (tabIds: string[]) => void
    resumeTabs: (tabIds: string[]) => void
    /** E12: the agents' real life, from the slots (main.agents): the interface's "encerrado" follows it, not the open panes. */
    agents: () => MainAgentView[]
    /** E14: "Sair de todas as contas": cookies and storage of the tabs' partition cleared, open tabs reloaded. */
    logoutAll: () => void
    /** E13: every agent's downloaded files ("Baixados"). */
    downloads: () => DownloadEntry[]
    /** E13: "Mostrar na pasta": the system's file browser on the file (never opens the file). */
    showDownload: (slotId: string, name: string) => void
    /** E13: the upload questions still waiting, and the person's answer ('allow'; anything else refuses). */
    uploadOpen: () => UploadAsk[]
    uploadAnswer: (id: string, choice: string) => void
  }
  events: {
    /** A tab was created or changed (title, address, loading). */
    tab: (info: TabInfo) => void
    closed: (tabId: string) => void
    /** The closed history changed: the whole list again. */
    closedHistory: (list: ClosedTab[]) => void
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
    /** E12: an agent appeared, was renamed, exited or went away (alive false). */
    agent: (agent: MainAgentView) => void
    /** E13: a download finished: the whole list again. */
    downloads: (list: DownloadEntry[]) => void
    /** E13: an agent asks to send a file to a page: ask the person (one question at a time, with the other questions). */
    uploadAsk: (ask: UploadAsk) => void
    /** E13: an upload question no longer needs an answer (its tab closed or left the agent). */
    uploadCancelled: (id: string) => void
  }
}

/**
 * Every invoke channel, at run time: the app registers them all before the browser process is up (app/main/browser-host.ts), so
 * the renderer's first calls wait for it instead of finding no handler. The type keeps the list whole.
 */
export const BROWSER_INVOKES = [
  'list', 'get', 'restore', 'close', 'reopen', 'status', 'localNetworkOpen', 'localNetworkAnswer', 'controls', 'take', 'giveBack', 'decline',
  'cleanReload', 'pause', 'resume', 'back', 'forward', 'reload', 'pauseTabs', 'resumeTabs', 'agents', 'logoutAll', 'downloads',
  'showDownload', 'uploadOpen', 'uploadAnswer', 'closedList', 'reopenClosed', 'clearClosed',
] as const satisfies readonly (keyof BrowserChannels['invoke'])[]
type Missing = Exclude<keyof BrowserChannels['invoke'], (typeof BROWSER_INVOKES)[number]>
const whole: [Missing] extends [never] ? true : Missing = true
void whole
