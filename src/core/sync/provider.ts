// Sync provider: how the persistent sync folder travels to a remote and back. The engine writes the folder
// and calls the provider; a provider knows nothing about what the files mean. Git is the first one; a plain
// folder provider (Drive/Dropbox) can implement the same interface later.

export interface ConnectResult {
  /** True when the remote has no content yet (the first machine's case). */
  remoteEmpty: boolean
}

export interface PullConflict {
  /** Path relative to the sync folder, '/' separators. */
  path: string
  /** True when a local version existed and was copied to the trash before the remote version won. */
  trashed: boolean
}

export interface PullResult {
  /** Paths ('/' separators) that changed in the folder because of the pull. */
  changed: string[]
  conflicts: PullConflict[]
}

export interface PushResult {
  pushed: boolean
  /** `behind`: the remote moved on; pull and try again. Absent when there was simply nothing to send. */
  reason?: 'behind'
}

export interface ProviderStatus {
  connected: boolean
  /** The remote location with any embedded credentials masked. */
  url?: string
  /** Files with pending local changes (not yet committed). */
  dirty: number
  /** Commits not yet published / not yet merged, measured against the last fetch (no network). */
  ahead: number
  behind: number
}

export interface SyncProvider {
  kind: string
  /** Prepares the folder for the remote; idempotent. */
  connect(): Promise<ConnectResult>
  /** Brings the remote into the folder. Conflicts: the remote wins, the local version goes to the trash. */
  pull(): Promise<PullResult>
  /** Publishes what the folder has. Never forces. */
  push(): Promise<PushResult>
  status(): Promise<ProviderStatus>
  /** Drops the link to the remote; the files stay. */
  disconnect(): Promise<void>
}

export type SyncErrorCode = 'git-missing' | 'auth' | 'network' | 'git'

export class SyncError extends Error {
  readonly code: SyncErrorCode
  constructor(code: SyncErrorCode, message: string) {
    super(message)
    this.name = 'SyncError'
    this.code = code
  }
}
