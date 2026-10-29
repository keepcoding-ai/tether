// The narrow API the preload exposes to the renderer as `window.tether` (contextBridge).
// Shared by the preload (implements it) and the renderer (consumes it).
import type { Event as DaemonEvent, Notice, Reply, Request } from '../../src/daemon/protocol.ts'

/** A request without the `id`: the main process numbers them. */
export type RequestBody = Request extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never

export type ConnectionState = { connected: true; pipe: string; pid: number } | { connected: false; pipe: string; error: string }

export type CloseChoice = 'stop' | 'detach' | 'cancel'

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
  openExternal(url: string): void
  readClipboard(): Promise<string>
  writeClipboard(text: string): void
}

declare global {
  interface Window { tether: TetherApi }
}
