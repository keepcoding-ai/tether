// The narrow API the preload exposes to the renderer as `window.tether` (contextBridge).
// Shared by the preload (implements it) and the renderer (consumes it).
import type { Event as DaemonEvent, Notice, Profile, ProfileInput, Reply, Request } from '../../src/daemon/protocol.ts'
import type { AskRequest, Confirmations, DialogAnswer } from './dialog.ts'
import type { FontSizeCommand } from './font.ts'
import type { TerminalAppearance } from './terminal-theme.ts'
import type { ThemeSetting, ThemeState } from './theme.ts'
import type { UiSettings } from './ui-settings.ts'
import type { QuickOpenResult, QuickOpenTarget } from './quick-open.ts'
import type { KeybindingsFileState } from './keybindings.ts'
import type { ResolvedPath } from './vscode-terminal-link-detector.ts'
import type { ExtTransport } from './ext-ipc.ts'
import type { ExtensionsSettings, SettingValue } from './vscode-configuration-registry.ts'
import type { ExtensionManifest } from '../../extensions/types.ts'

/** A change of one extension setting (`extensions.<id>.<key>` of settings.json). */
export interface ExtSettingChange { id: string; key: string; value: SettingValue }
/** Main's side of the "Extensões" screen: its manifests, the disabled list, and what failed to activate there. */
export interface MainExtensionsList { manifests: ExtensionManifest[]; disabled: string[]; failed: { id: string; error: string }[] }

export type { Profile, ProfileInput }

/** What main learned of an HTML preview's page (app/main/html-preview-main.ts): the files of its folder it loaded and what the policy refused. */
export interface PreviewReport { partition: string; files: string[]; blocked: Array<{ url: string; reason: string }> }
/** A chord pressed inside the page (the guest cannot reach the app's key handling): the app replays it. */
export interface PreviewKey { partition: string; key: string; code: string; control: boolean; shift: boolean; alt: boolean; meta: boolean }

export type MainCommand = 'quit-all' | 'restore-confirmations' | 'restart-daemon' | 'reload-all' | 'relaunch-app' | 'toggle-devtools' | 'toggle-fullscreen'

/** A request without the `id`: the main process numbers them. */
export type RequestBody = Request extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never

export type ConnectionState = { connected: true; pipe: string; pid: number; version: string } | { connected: false; pipe: string; error: string }

/** The launch profiles; `problem` when the file had to be repaired or had entries skipped (show it, the backup is kept). */
export type ProfilesList = { profiles: Profile[]; problem?: string }
export type ProfileSaved = { ok: true; profile: Profile; warnings: string[] } | { ok: false; message: string }
export type ProfileDeleted = { ok: true } | { ok: false; message: string }

/** A new note file, created empty; `askGitignore` names the repository whose `.gitignore` lacks `.tether/`. */
export type NotePrepared = { path: string; askGitignore?: string }
export type NoteRead = { ok: true; text: string; mtimeMs: number } | { ok: false; missing: boolean; message: string }
export type NoteWritten = { ok: true; mtimeMs: number } | { ok: false; message: string }
export type NoteRenamed = { ok: true } | { ok: false; message: string }

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
  /** Opens a folder in the file manager (Explorer). Validates that the path exists and is a directory; never runs anything. */
  openPath(path: string): Promise<{ ok: true } | { ok: false; message: string }>
  readClipboard(): Promise<string>
  writeClipboard(text: string): void
  /** Current theme setting and the scheme it paints right now. */
  getTheme(): Promise<ThemeState>
  /** Persists the setting; the new state arrives through onTheme (also on every OS switch while `auto`). */
  setTheme(setting: ThemeSetting): void
  onTheme(listener: (state: ThemeState) => void): () => void
  /** Menu "Exibir → Aumentar/Diminuir/Tamanho padrão": main asks the renderer to step the size (it owns the terminals; the size is appearance.fontSize). */
  onFontSizeCommand(listener: (command: FontSizeCommand) => void): () => void
  /** The terminal appearance (preset, font, weight, size, line height) as saved in settings.json, normalized. */
  getTerminalAppearance(): Promise<TerminalAppearance>
  /** Persists it; the normalized value comes back through onTerminalAppearance (to this and any other window). */
  setTerminalAppearance(appearance: TerminalAppearance): void
  onTerminalAppearance(listener: (appearance: TerminalAppearance) => void): () => void
  /** Menu "Exibir → Tema do terminal…": main asks the renderer to open the dialog. */
  onOpenTerminalTheme(listener: () => void): () => void
  /** Chrome preferences (settings.json `ui`), normalized. */
  getUi(): Promise<UiSettings>
  /** Persists them; the normalized value comes back through onUi. */
  setUi(ui: UiSettings): void
  onUi(listener: (ui: UiSettings) => void): () => void
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
  /** The tray menu's "Abrir gaveta": open the drawer (waits for the layout to be restored). */
  onOpenDrawer(listener: () => void): () => void
  /** Closes the window (keeps every slot running in the daemon). */
  closeWindow(): void
  /**
   * Notes (app/main/note-files.ts). `notePrepare` creates the empty file for a new note under the pane's folder
   * (`<cwd>/.tether/notes/`) or the person's (`~/.tether/notes/`). Reads and writes are by absolute path; a write is
   * atomic. `noteFlush` is the fire-and-forget write of a page going away (beforeunload cannot await).
   */
  notePrepare(paneCwd?: string): Promise<NotePrepared>
  noteRead(path: string): Promise<NoteRead>
  noteWrite(path: string, text: string): Promise<NoteWritten>
  noteFlush(path: string, text: string): void
  noteRename(from: string, to: string): Promise<NoteRenamed>
  /** Watches a note's file; `onNoteChanged` reports a change on disk (our own save included: the renderer compares). */
  noteWatch(path: string): void
  noteUnwatch(path: string): void
  onNoteChanged(listener: (path: string) => void): () => void
  /** The OS file dialogs (the agreed exception to the in-app dialogs for files): null when cancelled. */
  notePickOpen(initialDir?: string): Promise<string | null>
  notePickSaveAs(currentPath: string): Promise<string | null>
  /** The answer to "add .tether/ to .gitignore?" for a repository: add it, or remember the refusal for that repository. */
  noteGitignore(repoRoot: string, add: boolean): Promise<void>
  /**
   * Quick Open (app/main/quick-open-main.ts): the files under the pane's opening folder (the notes folder without
   * one) ranked for the query, with the recently opened ones (`recent`, absolute paths, newest first) on top.
   * Null when a newer search replaced this one before it ran.
   */
  quickOpenSearch(paneCwd: string | undefined, query: string, recent: string[]): Promise<QuickOpenResult | null>
  /** The box opened: a new search session, main lists the root now. */
  quickOpenRefresh(paneCwd: string | undefined): void
  /** The box closed: main drops the session's list and cache. */
  quickOpenEnd(): void
  /** What opening a path means: editor (text), system program (binary, too large), or nothing (missing, folder). */
  quickOpenInspect(path: string): Promise<QuickOpenTarget>
  /** Opens a binary or too large file with the system's program (never one that would run). */
  quickOpenExternal(path: string): Promise<{ ok: true } | { ok: false; message: string }>
  /** Ctrl+click on terminal paths (app/main/terminal-links-main.ts): the first candidate that exists, read against the pane's opening folder `cwd`; null when none does. */
  resolveTerminalLink(cwd: string | undefined, candidates: string[]): Promise<ResolvedPath | null>
  /**
   * The user's keyboard shortcuts (<TETHER_HOME>/keybindings.json; the renderer owns the format, app/renderer/keybindings-rules.ts).
   * Main reads and writes the text and reports every change on disk through `onKeybindingsChanged` (our own write included).
   */
  keybindingsRead(): Promise<KeybindingsFileState>
  keybindingsWrite(text: string): Promise<{ ok: true } | { ok: false; message: string }>
  onKeybindingsChanged(listener: (state: KeybindingsFileState) => void): () => void
  /** HTML previews, "Abrir no navegador": the page file with the system's program (only an existing .html file). */
  openHtmlInBrowser(path: string): Promise<{ ok: true } | { ok: false; message: string }>
  /** HTML previews: the files the isolated page loaded from its folder, and what was refused. */
  onHtmlPreviewReport(listener: (report: PreviewReport) => void): () => void
  /** HTML previews: a chord pressed inside the page, to be replayed on the pane. */
  onHtmlPreviewKey(listener: (key: PreviewKey) => void): () => void
  /** The extensions' IPC bus (app/shared/ext-ipc.ts): channels `ext:<id>:<channel>`; extensions use it through TetherUi.ipc. */
  ext: ExtTransport
  /** settings.json's `extensions` object, read synchronously once before the renderer's extensions activate. */
  extSettingsSync(): ExtensionsSettings
  setExtSetting(id: string, key: string, value: SettingValue): void
  onExtSetting(listener: (change: ExtSettingChange) => void): () => void
  listMainExtensions(): Promise<MainExtensionsList>
}

declare global {
  interface Window { tether: TetherApi }
}
