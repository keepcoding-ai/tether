// The sync extension's bus (ext:sync:*): the renderer asks main for the state and for the three acts; main pushes every change.
// No credential crosses: the remote is masked by main before it leaves.
import type { SyncView } from './rules.ts'

export type ActOutcome = { ok: true; view: SyncView } | { ok: false; message: string }

export interface SyncChannels {
  invoke: {
    /** The state now (the runner's, with the remote, the machine and, before the first cycle, <home>/sync-last.json). */
    state(): Promise<SyncView>
    /** One cycle now, through the app's runner (a request during a cycle merges into the next one). */
    now(): Promise<ActOutcome>
    /** `tether sync connect <url> --from-app --json` in the runner's guarded cycle. */
    connect(url: string): Promise<ActOutcome>
    /** `tether sync disconnect`: the link goes, the files stay. */
    disconnect(): Promise<ActOutcome>
  }
  events: {
    /** The state changed (a cycle started or ended, the link came or went). */
    state(view: SyncView): void
  }
}
