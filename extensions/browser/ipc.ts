// The browser extension's channels between its renderer and main sides (E2: the tab registry; E4: the local-network question).
import type { ClosedTab } from './closed-rules.ts'
import type { ControlView } from './control.ts'
import type { DownloadEntry, UploadAsk } from './files-rules.ts'
import type { LocalNetworkAsk } from './local-network-rules.ts'
import type { PageDialogAsk, PageKey } from './page-rules.ts'
import type { ActionKind, MainAgentView } from './pad-rules.ts'
import type { SavedTab, TabInfo } from './tab-rules.ts'
import type { TabBlocked } from './tabs.ts'

export interface BrowserStatus {
  /** False when the tabs' partition is in memory (the cookie-encryption fuse is off): "logins não são guardados". */
  persistentLogins: boolean
}

/** What `go` did: navigated, the address may not open, the tab is not hers to drive (not held by her), or it is gone. */
export type GoOutcome = 'ok' | 'bad-url' | 'not-held' | 'no-tab'

/** What `give` did: tab-rules.ts `giveVerdict`'s refusals, or 'failed' (the agent's new tab did not open or load; hers stays hers). */
/** What `openForAgent` did: the agent is gone or full, or 'failed' (the tab did not open or its shield did not rise; it was closed). */
export type OpenForAgentOutcome = 'ok' | 'no-agent' | 'full' | 'failed'
export type GiveOutcome ='ok' | 'no-tab' | 'not-hers' | 'no-agent' | 'full' | 'failed'

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
    /**
     * The person opens a tab of her own (owner PERSON_OWNER, held by her from birth): the address she gave, or the blank page.
     * Her gesture is the consent a local address needs. Null when it could not open (bad address, the owner's ceiling).
     */
    openForPerson: (url?: string, tabId?: string) => TabInfo | null
    /**
     * A tab born the agent `slotId`'s (the Regency's "+ Novo" > Navegador for an agent): `newTabId` is named by the interface so
     * its pane is drawn where it was asked for. Born on the blank page under the agent's rules (shield up and checked, no way
     * back); anything failing closes what opened ('failed'): no half-made tab.
     */
    openForAgent: (slotId: string, newTabId: string) => OpenForAgentOutcome
    /**
     * The person typed an address in the bar of a tab she holds (hers, or an agent's she took) and pressed Enter. Validated in
     * main (http/https only; `https://` added without a scheme); typing it is the consent a local address needs.
     */
    go: (tabId: string, raw: string) => GoOutcome
    /**
     * "Entregar a um agente…": the agent `slotId` gets a new tab `newTabId` (named by the interface, so its pane takes the place of
     * hers) at her tab's address, a fresh page with nothing of hers; once it loaded, her tab closes. Any failure first leaves her
     * tab with her ('failed').
     */
    give: (tabId: string, slotId: string, newTabId: string) => GiveOutcome
    /** The brake on a set of tabs (all, or one agent's): the interface knows which, loaded or not. */
    pauseTabs: (tabIds: string[]) => void
    resumeTabs: (tabIds: string[]) => void
    /** E12: the agents' real life, from the slots (main.agents): the interface's "encerrado" follows it, not the open panes. */
    agents: () => MainAgentView[]
    /** E14: "Sair de todas as contas": cookies and storage of the tabs' partition cleared, open tabs reloaded. */
    logoutAll: () => void
    /** E13: every agent's downloaded files ("Baixados"). */
    downloads: () => DownloadEntry[] | Promise<DownloadEntry[]>
    /** E13: "Mostrar na pasta": the system's file browser on the file (never opens the file). */
    showDownload: (slotId: string, name: string) => void
    /** E13: the upload questions still waiting, and the person's answer ('allow'; anything else refuses). */
    uploadOpen: () => UploadAsk[]
    uploadAnswer: (id: string, choice: string) => void
    /** F3: the dialogs of the pages she holds still waiting for her (the renderer asks when it starts). */
    pageDialogOpen: () => PageDialogAsk[]
    /** F3: her answer in the pane's band (OK: accept true; a prompt's text); ignored unless she still holds the tab. */
    pageDialogAnswer: (id: string, accept: boolean, text?: string) => void
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
    /** F3: a page she holds opened a JavaScript dialog: the band of its pane shows it (never the agents' question queue). */
    pageDialog: (ask: PageDialogAsk) => void
    /** F3: that dialog is gone (the page closed it, the tab left her or closed). */
    pageDialogClosed: (id: string) => void
    /** F3: Ctrl+T or Ctrl+L typed in a page she holds (the keyboard is back on the interface). */
    pageKey: (tabId: string, key: PageKey) => void
  }
}

/**
 * Every invoke channel, at run time: the app registers them all before the browser process is up (app/main/browser-host.ts), so
 * the renderer's first calls wait for it instead of finding no handler. The type keeps the list whole.
 */
export const BROWSER_INVOKES = [
  'list', 'get', 'restore', 'close', 'reopen', 'status', 'localNetworkOpen', 'localNetworkAnswer', 'controls', 'take', 'giveBack', 'decline',
  'cleanReload', 'pause', 'resume', 'back', 'forward', 'reload', 'pauseTabs', 'resumeTabs', 'agents', 'logoutAll', 'downloads',
  'showDownload', 'uploadOpen', 'uploadAnswer', 'closedList', 'reopenClosed', 'clearClosed', 'openForPerson', 'openForAgent', 'go', 'give',
  'pageDialogOpen', 'pageDialogAnswer',
] as const satisfies readonly (keyof BrowserChannels['invoke'])[]
type Missing = Exclude<keyof BrowserChannels['invoke'], (typeof BROWSER_INVOKES)[number]>
const whole: [Missing] extends [never] ? true : Missing = true
void whole
