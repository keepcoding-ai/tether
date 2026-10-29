// The narrow API the preload exposes to the renderer as `window.tether` (contextBridge).
// Shared by the preload (implements it) and the renderer (consumes it).
import type { Event as DaemonEvent, Notice, Profile, ProfileInput, Reply, Request } from '../../src/daemon/protocol.ts'
import type { ThemeSetting, ThemeState } from './theme.ts'

export type { Profile, ProfileInput }

/** A request without the `id`: the main process numbers them. */
export type RequestBody = Request extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never

export type ConnectionState = { connected: true; pipe: string; pid: number } | { connected: false; pipe: string; error: string }

export type CloseChoice = 'stop' | 'detach' | 'cancel'

/** The launch profiles; `problem` when the file had to be repaired or had entries skipped (show it, the backup is kept). */
export type ProfilesList = { profiles: Profile[]; problem?: string }
export type ProfileSaved = { ok: true; profile: Profile; warnings: string[] } | { ok: false; message: string }
export type ProfileDeleted = { ok: true } | { ok: false; message: string }

export interface TetherApi {
  /** Sends a request to the daemon; resolves with the daemon's reply (an `error` reply resolves, it does not throw). */
  request(body: RequestBody): Promise<Reply>
  /** Fire-and-forget keystrokes. */
  notice(notice: Notice): void
  onEvent(listener: (ev: DaemonEvent) => void): () => void
  onConnection(listener: (state: ConnectionState) => void): () => void
  /** Asks main to (re)connect to the daemon; the result arrives through onConnection. */
  reconnect(): void
  loadLayout(): Promise<unknown | null>
  saveLayout(layout: unknown): Promise<void>
  recentFolders(): Promise<string[]>
  rememberFolder(folder: string): Promise<void>
  /** Native folder picker; null when cancelled. */
  pickFolder(initial?: string): Promise<string | null>
  /** Native dialog: stop the agent, only close the panel, or cancel. */
  confirmClose(label: string): Promise<CloseChoice>
  /**
   * Launch profiles (<home>/profiles.json): through the daemon when connected (it validates and broadcasts a
   * `profiles` event to every client), straight from the file otherwise. A new slot takes one as `create.profileId`.
   */
  listProfiles(): Promise<ProfilesList>
  /** Create (no id) or edit (id) a profile; `ok: false` carries the validation errors in Portuguese. */
  saveProfile(profile: ProfileInput): Promise<ProfileSaved>
  deleteProfile(profileId: string): Promise<ProfileDeleted>
  openExternal(url: string): void
  readClipboard(): Promise<string>
  writeClipboard(text: string): void
  /** Current theme setting and the scheme it paints right now. */
  getTheme(): Promise<ThemeState>
  /** Persists the setting; the new state arrives through onTheme (also on every OS switch while `auto`). */
  setTheme(setting: ThemeSetting): void
  onTheme(listener: (state: ThemeState) => void): () => void
}

declare global {
  interface Window { tether: TetherApi }
}
