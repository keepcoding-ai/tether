// The quick-open extension's channels between its renderer and main sides (the bus `ext:quick-open:<channel>`,
// app/shared/ext-ipc.ts). They replace the core's bespoke `quickopen:search/refresh/end` channels. Main validates every
// argument: they come from the renderer.
import type { QuickOpenResult } from '../../app/shared/quick-open.ts'

export interface QuickOpenChannels {
  invoke: {
    /**
     * The files under the pane's opening folder (the notes folder without one) ranked for the query, with the recently
     * opened ones (`recent`, absolute paths, newest first) on top. Null when a newer search replaced this one before it ran.
     */
    search: (paneCwd: string | undefined, query: string, recent: string[]) => QuickOpenResult | null
  }
  send: {
    /** The box opened: a new search session, main lists the root now. */
    refresh: (paneCwd: string | undefined) => void
    /** The box closed: main drops the session's list and cache. */
    end: () => void
  }
}
