// The narrow API the preload exposes to the renderer as `window.tether` (contextBridge).
// Shared by the preload (implements it) and the renderer (consumes it).
import type { Event as DaemonEvent, Notice, Profile, ProfileInput, Reply, Request } from '../../src/daemon/protocol.ts'
import type { AskRequest, Confirmations, DialogAnswer } from './dialog.ts'
import type { TerminalAppearance } from './terminal-theme.ts'
import type { ThemeSetting, ThemeState } from './theme.ts'

export type { Profile, ProfileInput }

export type MainCommand = 'quit-all' | 'restore-confirmations'

/** A request without the `id`: the main process numbers them. */
export type RequestBody = Request extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never

export type ConnectionState = { connected: true; pipe: string; pid: number } | { connected: false; pipe: string; error: string }

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
  /** Copies layout.json to layout.v1.bak: called once by the renderer, before the first write after a v1 → v2 migration. */
  backupLayout(): Promise<void>
  recentFolders(): Promise<string[]>
  rememberFolder(folder: string): Promise<void>
  /** The OS folder browser (the one native UI kept: it is the file system's); null when cancelled. */
  pickFolder(initial?: string): Promise<string | null>
  /**
   * Launch profiles (<home>/profiles.json): through the daemon when connected (it validates and broadcasts a
   * `profiles` event to every client), straight from the file otherwise. A new slot takes one as `create.profileId`.
   */
  listProfiles(): Promise<ProfilesList>
  /** Create (no id) or edit (id) a profile; `ok: false` carries the validation errors in Portuguese. */
  saveProfile(profile: ProfileInput): Promise<ProfileSaved>
  deleteProfile(profileId: string): Promise<ProfileDeleted>
  /** Menu "Exibir → Perfis de lançamento…": main asks the renderer to open the profile manager. */
  onOpenProfiles(listener: () => void): () => void
  /** In-app menu commands that live in main: "Sair e encerrar tudo…" (asks through onAsk) and "Voltar a perguntar". */
  command(cmd: MainCommand): void
  openExternal(url: string): void
  readClipboard(): Promise<string>
  writeClipboard(text: string): void
  /** Current theme setting and the scheme it paints right now. */
  getTheme(): Promise<ThemeState>
  /** Persists the setting; the new state arrives through onTheme (also on every OS switch while `auto`). */
  setTheme(setting: ThemeSetting): void
  onTheme(listener: (state: ThemeState) => void): () => void
  /** The terminal appearance (preset, font, weight, size, line height) as saved in settings.json, normalized. */
  getTerminalAppearance(): Promise<TerminalAppearance>
  /** Persists it; the normalized value comes back through onTerminalAppearance (to this and any other window). */
  setTerminalAppearance(appearance: TerminalAppearance): void
  onTerminalAppearance(listener: (appearance: TerminalAppearance) => void): () => void
  /** Menu "Exibir → Tema do terminal…": main asks the renderer to open the dialog. */
  onOpenTerminalTheme(listener: () => void): () => void
  /** Remembered dialog answers ("não perguntar de novo"); main pushes every change through onConfirmations. */
  getConfirmations(): Promise<Confirmations>
  rememberConfirmation(situation: string, choice: string): void
  onConfirmations(listener: (c: Confirmations) => void): () => void
  /** Main needs a situation put to the user (menu "Sair e encerrar tudo…"); the renderer answers with `answer`. */
  onAsk(listener: (req: AskRequest) => void): () => void
  answer(askId: number, answer: DialogAnswer): void
  /** Standalone dialog window (before the main window exists): the situation to show (app/renderer/situations.ts), and the way to answer it. */
  standaloneDialog(): Promise<string | null>
  answerStandalone(answer: DialogAnswer): void
  /** Standalone window: the height its content needs (the window is sized to the dialog). */
  standaloneSize(height: number): void
  /** The tray menu picked a pane: focus it (waits for the layout to be restored; opens it when it was closed). */
  onFocusSlot(listener: (slotId: string) => void): () => void
  /** Closes the window (keeps every slot running in the daemon). */
  closeWindow(): void
}

declare global {
  interface Window { tether: TetherApi }
}
