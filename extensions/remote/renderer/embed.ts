// Feed R: what another extension (the Regency's "Sistema") reads of the remote access and how it embeds the "Aparelhos"
// view. Pure at load: no DOM until `mount`, no import of the renderer host, nothing about its readers. The remote extension
// publishes in `activate`; with it off the feed is inactive (`summary()` is undefined, `element()` too). The same pattern as
// channels/renderer/embed.ts.

/** What the "Sistema" tab shows of the remote: the counts behind the section's tab and badge. */
export interface RemoteSummary {
  on: boolean
  /** Paired devices that are not revoked. */
  devices: number
  /** Connected now. */
  live: number
  /** A sentence of the state (the status icon's title). */
  text: string
}

export interface RemoteEmbedSource {
  summary(): RemoteSummary
  /** The "Aparelhos" view, made once and kept by the source (its own repaints). */
  element(): HTMLElement
  /** The view is on screen or not (the source polls faster only while it is). */
  setShown(on: boolean): void
  onDidChange(listener: () => void): { dispose(): void }
}

export interface RemoteEmbedFeed {
  readonly active: boolean
  summary(): RemoteSummary | undefined
  element(): HTMLElement | undefined
  setShown(on: boolean): void
  /** The summary changed, or the feed turned on or off. A listener lives across publications. */
  onDidChange(listener: () => void): { dispose(): void }
  /** Someone (the status icon) asks to show "Aparelhos": the Regency brings itself and the section forward. */
  reveal(): boolean
  onDidRequestReveal(listener: () => void): { dispose(): void }
}

export interface RemoteEmbedPublisher extends RemoteEmbedFeed {
  publish(source: RemoteEmbedSource): { dispose(): void }
}

export function createRemoteEmbeds(): RemoteEmbedPublisher {
  const listeners = new Set<() => void>()
  const revealers = new Set<() => void>()
  let source: RemoteEmbedSource | undefined
  let sub: { dispose(): void } | undefined
  const fire = (): void => { for (const l of [...listeners]) l() }
  return {
    get active() { return source !== undefined },
    summary: () => source?.summary(),
    element: () => source?.element(),
    setShown: on => source?.setShown(on),
    onDidChange(listener) {
      listeners.add(listener)
      return { dispose: () => { listeners.delete(listener) } }
    },
    reveal() {
      if (revealers.size === 0) return false
      for (const r of [...revealers]) r()
      return true
    },
    onDidRequestReveal(listener) {
      revealers.add(listener)
      return { dispose: () => { revealers.delete(listener) } }
    },
    publish(s) {
      sub?.dispose()
      source = s
      sub = s.onDidChange(fire)
      fire()
      return {
        dispose: () => {
          if (source !== s) return
          sub?.dispose()
          sub = undefined
          source = undefined
          fire()
        },
      }
    },
  }
}

/** The one feed of this renderer process. */
export const remoteEmbeds: RemoteEmbedPublisher = createRemoteEmbeds()
