// Feed B: how another extension (the Regency's "+ Novo") creates a browser tab on a chosen desk without moving the person.
// Pure: no DOM, no import of the renderer host. The browser extension publishes the two gestures in `activate`; with the browser
// off the feed is inactive and every call answers `no-browser`. The same pattern as channels/renderer/embed.ts.

/** Why a tab was not made. */
export type NewTabOutcome =
  | { ok: true; tabId: string }
  | { ok: false; why: 'no-browser' | 'no-desk' | 'no-agent' | 'full' | 'failed' }

/** What the browser extension gives the feed while it is on. */
export interface BrowserEmbedSource {
  /** A tab of her own ("Você") on `deskId`, at `url` when given. The visible desk, the active pane and the keyboard stay as they are. */
  newTab(opts: { url?: string; deskId: string }): Promise<NewTabOutcome>
  /** A tab born the agent's on `deskId`, shield up before any navigation; failing, nothing is left open. */
  newTabFor(slotId: string, opts: { deskId: string }): Promise<NewTabOutcome>
}

export interface BrowserEmbedFeed {
  /** The browser is on and publishing in this process. */
  readonly active: boolean
  newTab: BrowserEmbedSource['newTab']
  newTabFor: BrowserEmbedSource['newTabFor']
}

export interface BrowserEmbedPublisher extends BrowserEmbedFeed {
  /** Turns the feed on with `source`, replacing any earlier one; the handle turns it off (if it is still the current one). */
  publish(source: BrowserEmbedSource): { dispose(): void }
}

const OFF: NewTabOutcome = { ok: false, why: 'no-browser' }

export function createBrowserEmbeds(): BrowserEmbedPublisher {
  let source: BrowserEmbedSource | undefined
  return {
    get active() { return source !== undefined },
    newTab: opts => source ? source.newTab(opts) : Promise.resolve(OFF),
    newTabFor: (slotId, opts) => source ? source.newTabFor(slotId, opts) : Promise.resolve(OFF),
    publish(next) {
      source = next
      return { dispose: () => { if (source === next) source = undefined } }
    },
  }
}

export const browserEmbeds: BrowserEmbedPublisher = createBrowserEmbeds()
