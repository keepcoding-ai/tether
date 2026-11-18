// The narrow API the preload exposes to the renderer as `window.tether` (contextBridge).
// Shared by the preload (implements it) and the renderer (consumes it).
import type { AttentionState, MuteChoice } from './os-notify.ts'
import type { Event as DaemonEvent, Notice, Profile, ProfileInput, Reply, Request } from '../../src/daemon/protocol.ts'
import type { AskRequest, Confirmations, DialogAnswer } from './dialog.ts'
import type { FontSizeCommand } from './font.ts'
import type { TerminalAppearance } from './terminal-theme.ts'
import type { ThemeSetting, ThemeState } from './theme.ts'
import type { UiSettings } from './ui-settings.ts'
import type { FileTarget } from './file-open.ts'
import type { PerfSnapshot } from '../../src/core/perf.ts'
import type { ProbeSummary } from './probe-app.ts'
import type { RendererPerf, RendererReport } from './perf-renderer.ts'
import type { KeybindingsFileState } from './keybindings.ts'
import type { ResolvedPath } from './vscode-terminal-link-detector.ts'
import type { ExtTransport } from './ext-ipc.ts'
import type { PlaceMessage, ReleaseMessage, SurfaceEvent } from './surface-panel-rules.ts'
import type { ExtensionsSettings, SettingSchema, SettingValue } from './vscode-configuration-registry.ts'
import type { SettingsError } from './settings-file.ts'
import type { ExtensionSummary } from '../../extensions/types.ts'

/** A change of one extension setting (`extensions.<id>.<key>` of settings.json). */
/** One setting as the settings page lists it: its full key (the storage path), schema, value in force, and whether the file sets it. */

/** The tether:// association with the OS, as the person reads it (app/main/protocol-association.ts). */
export interface LinkAssociation {
  isMine: boolean
  /** What opens a link today (executable and script); undefined when nothing does. */
  current?: string | undefined
  /** What "this tether" is. */
  mine: string
}

export interface SettingEntry { key: string; node: string; nodeTitle: string; schema: SettingSchema; value: SettingValue; configured: boolean }
/** settings:list: every registered setting in page order, and the file's parse errors (none when it is valid or absent). */
export interface SettingsList { entries: SettingEntry[]; errors: SettingsError[] }
/** settings:set / settings:reset: refused for an unknown key, an invalid value, or a file that does not parse. */
export type SettingWriteResult = { ok: true } | { ok: false; message: string }
/** settings:file: the file as main knows it (text null when it does not exist). */
export interface SettingsFileState { path: string; text: string | null; errors: SettingsError[] }
export interface ExtSettingChange { id: string; key: string; value: SettingValue }
/** Main's side of the "Extensões" screen: its manifests, the disabled list, and what failed to activate there. */
export interface MainExtensionsList { manifests: ExtensionSummary[]; disabled: string[]; failed: { id: string; error: string }[] }

export type { Profile, ProfileInput }

/** What main learned of an HTML preview's page (app/main/html-preview-main.ts): the files of its folder it loaded and what the policy refused. */
export interface PreviewReport { partition: string; files: string[]; blocked: Array<{ url: string; reason: string }> }
/** A chord pressed inside the page (the guest cannot reach the app's key handling): the app replays it. */
export interface PreviewKey { partition: string; key: string; code: string; control: boolean; shift: boolean; alt: boolean; meta: boolean }

export type MainCommand = 'quit-all' | 'restore-confirmations' | 'restart-daemon' | 'reload-all' | 'relaunch-app' | 'toggle-devtools' | 'toggle-fullscreen'

/** A request without the `id`: the main process numbers them. */
/** The `perf:get` answer: the main process's ruler, the daemon's (null when absent or too old) and the round trip to it. */
export interface PerfGet { main: PerfSnapshot; daemon: PerfSnapshot | null; daemonRttMs: number | null
  /** Key->echo probe totals (TETHER_PROBE=1 only; absent when the probe is off). */
  probe?: ProbeSummary
  /** The renderer's always-on ruler (E4.0): frames, input latency, backlog, heartbeat, priority, echo by pane kind. */
  renderer?: RendererPerf }

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
  /** Copies layout.json to layout.v<version>.bak (1 by default): the renderer asks when it read an older file (v1 or v2), before the first write in the current version. */
  backupLayout(version?: 1 | 2 | 3): Promise<void>
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
  /** A tether:// link the app was started with or got before the renderer listened; after this call, links come through onTetherLink. */
  pendingTetherLink(): Promise<string | undefined>
  /** Which program opens tether:// links today, and whether it is this tether. */
  linkAssociation(): Promise<LinkAssociation>
  /** Makes this tether the one that opens tether:// links (the previous association is removed); the state after. */
  associateLinks(): Promise<LinkAssociation>
  /** A tether:// link followed while the app runs (app/shared/tether-url.ts). */
  onTetherLink(listener: (url: string) => void): () => void
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
  /** Menu "Exibir → Tema do tether…": main asks the renderer to open the dialog. */
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
  /** What opening a path means (app/main/file-open-main.ts): editor (text), system program (binary, too large), or nothing (missing, folder). */
  inspectFile(path: string): Promise<FileTarget>
  /** Opens a binary or too large file with the system's program (never one that would run). */
  openFileExternal(path: string): Promise<{ ok: true } | { ok: false; message: string }>
  /** Ctrl+click on terminal paths (app/main/terminal-links-main.ts): the first candidate that exists, read against the pane's opening folder `cwd`; null when none does. */
  resolveTerminalLink(cwd: string | undefined, candidates: string[]): Promise<ResolvedPath | null>
  /**
   * The user's keyboard shortcuts (<TETHER_HOME>/keybindings.json; the renderer owns the format, app/renderer/keybindings-rules.ts).
   * Main reads the text and reports every change on disk through `onKeybindingsChanged` (the shortcuts screen's own write included; the keybindings-screen extension writes it on its bus).
   */
  keybindingsRead(): Promise<KeybindingsFileState>
  onKeybindingsChanged(listener: (state: KeybindingsFileState) => void): () => void
  /** The extensions' IPC bus (app/shared/ext-ipc.ts): channels `ext:<id>:<channel>`; extensions use it through TetherUi.ipc. */
  ext: ExtTransport
  /** Native surfaces (app/main/surface-bridge.ts): where a pane's host element is and whether it is on screen, the surface let go, and what main tells back. */
  surfacePlace(msg: PlaceMessage): void
  surfaceRelease(msg: ReleaseMessage): void
  onSurfaceEvent(listener: (event: SurfaceEvent) => void): () => void
  /** The freeze (app/main/surface-bridge.ts): the page as JPEG bytes (null when it cannot be had); park (true) or back and painted (false). */
  surfaceCapture(msg: ReleaseMessage): Promise<Uint8Array | null>
  surfaceFreeze(msg: ReleaseMessage & { frozen: boolean }): Promise<boolean>
  /** settings.json's `extensions` object, read synchronously once before the renderer's extensions activate. */
  extSettingsSync(): ExtensionsSettings
  setExtSetting(id: string, key: string, value: SettingValue): void
  onExtSetting(listener: (change: ExtSettingChange) => void): () => void
  listMainExtensions(): Promise<MainExtensionsList>
  /** The "Extensões" toggle: on or off at the next start ("Reiniciar o app"); answers settings.json `extensions.disabled`. */
  setExtensionEnabled(id: string, on: boolean): Promise<string[]>
  /** The configuration registry's settings (app/main/main.ts settings:*): list, write one key, remove one key, the file, and its ensure-then-path for "Abrir settings.json". */
  settingsList(): Promise<SettingsList>
  settingsSet(key: string, value: SettingValue): Promise<SettingWriteResult>
  settingsReset(key: string): Promise<SettingWriteResult>
  settingsFile(): Promise<SettingsFileState>
  settingsOpen(): Promise<{ ok: true; path: string } | { ok: false; message: string }>
  /** The bell (top bar): recent attention notices and the temporary mute of the system toasts (app/shared/os-notify.ts). */
  attentionGet(): Promise<AttentionState>
  /** Performance ruler: main-process and daemon snapshots newer than `since` (wall-clock ms). */
  perfGet(since?: number): Promise<PerfGet>
  /** The renderer's ruler reports to the main (summary every 5 s when something happened; incidents at once). */
  perfReport(report: RendererReport): void
  /** Without a slot: every notice (the menu opened). With one: that slot's notice (its pane was visited). */
  attentionSeen(slotId?: string): void
  /** Mutes the toasts for a while; null lifts the mute. `notifications.os` is never touched. */
  attentionMute(choice: MuteChoice | null): void
  onAttention(listener: (state: AttentionState) => void): () => void
  /** The dotted keys that changed in settings.json (a write of ours or an edit on disk). */
  onSettingsChanged(listener: (keys: string[]) => void): () => void
  /** The file's parse errors changed (empty once it parses again). */
  onSettingsErrors(listener: (errors: SettingsError[]) => void): () => void
}

declare global {
  interface Window { tether: TetherApi }
}
