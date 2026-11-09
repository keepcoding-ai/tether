// `TetherUi`: what the renderer offers an extension's `activate` (F9). It grows per slice (study §3.2): 0a the pane-type
// registry; 0b the IPC bus to the extension's main side, its settings and the ≡ menu; slice 1 (the note) what a pane
// kind needs from the workbench: open/find/focus/close panes, the tab menu, commands with handlers, dialogs, the theme
// and the terminal font, file openers, the chooser's items, the shortcuts screen's fixed rows, and test hooks. Every
// registration returns a disposable (app/shared/vscode-lifecycle.ts).
import type { AddPanelOptions, IDockviewPanel } from 'dockview-core'
import type { ChannelMap, UiIpc } from '../shared/ext-ipc.ts'
import type { SettingValue } from '../shared/vscode-configuration-registry.ts'
import type { SettingsError } from '../shared/settings-file.ts'
import type { SettingsFileState, SettingsList, SettingWriteResult } from '../shared/api.ts'
import type { MenuItem } from '../shared/vscode-menu-registry.ts'
import type { IDisposable } from '../shared/vscode-lifecycle.ts'
import type { DialogAnswer, DialogSpec } from '../shared/dialog.ts'
import type { TerminalAppearance } from '../shared/terminal-theme.ts'
import type { ColorScheme } from '../shared/theme.ts'
import type { Command, CommandContext, RunSource } from './commands.ts'
import type { Target } from './create.ts'
import type { FixedBinding, KbCommandInfo, KeybindingsFileInfo } from './keybindings-rules.ts'
import type { Keybinding, KeyTable } from './shortcuts.ts'
import type { PaletteModeProvider } from './palette.ts'
import type { PaneType } from './pane-registry.ts'
import type { OpenFileOptions } from './file-open.ts'
import type { ProjectFolder } from './workspace.ts'
import type { AgentUi } from './agent-ui.ts'
import type { Brand } from '../shared/brand.ts'
import type { StatusHandle, StatusItem } from './status-rules.ts'

export type { IDisposable as Disposable } from '../shared/vscode-lifecycle.ts'
export type { PaneType } from './pane-registry.ts'
export type { PaletteModeProvider, PaletteSearch } from './palette.ts'
export type { ProjectFolder } from './workspace.ts'
export type { AgentUi } from './agent-ui.ts'
export type { Brand } from '../shared/brand.ts'
export type { StatusBadge, StatusHandle, StatusItem, StatusState } from './status-rules.ts'

/** A pane as an extension sees it (F8): its type, its opening folder, and the agent kind behind it ('claude'… never 'shell'). */
export interface PaneInfo {
  id: string
  /** The pane type's id ('terminal', 'note'…). */
  type: string
  cwd?: string
  /** The file a note or a preview shows (its type's `fileOf`). */
  file?: string
  /** The slot's kind when it is an AI agent (a plain terminal has none). */
  agent?: string
  /** Where it lives: the desk's name, 'Gaveta', or the pad's title. */
  place?: string
}

/** A row of a context menu (the tab menu): an item, or 'sep' for a thin line between groups. */
export type ContextMenuEntry = { icon: string; label: string; run(): void; danger?: boolean; disabled?: boolean; checked?: boolean } | 'sep'

/**
 * Who opens a file (VS Code's EditorResolverService: editors register for the resources they take). Ctrl+P, a
 * terminal link and "abrir o arquivo-fonte" ask the openers in registration order; the first that can, opens it.
 */
export interface FileOpener {
  id: string
  canOpen(path: string, opts: OpenFileOptions): boolean
  open(path: string, opts: OpenFileOptions): void
}

/**
 * What a pad shows (F10): the manifest declares the pad (`contributes.pads`), `activate` registers its type. The core creates
 * one view per window (scope 'global') or per desk (scope 'desk', created when that desk first shows it or has a saved
 * state), keeps every view mounted at its side bar's width while hidden (a closed pad or another desk's: nothing it holds
 * is resized or detached), and asks `serialize` when it saves layout.json.
 */
export interface PadType {
  /** The id the manifest declares. */
  id: string
  create(host: PadHost): PadView
}

export interface PadHost {
  readonly padId: string
  /** The desk this view belongs to (scope 'desk'). */
  readonly deskId?: string
  /** What `serialize` returned when layout.json was last written (undefined the first time). */
  readonly state: unknown
  /** The view's state changed: layout.json is written soon (it calls `serialize`). */
  persist(): void
  /** The pad's title as its header shows it ('Prancheta da mesa · Soul': a desk pad carries its desk's name). */
  title(): string
  /** The core's items of the pad's menu (close, move to the other side bar, restore): for a view that merges them into its own menu. */
  menuItems(): ContextMenuEntry[]
  /**
   * A pad declared `absorbsHeader`: true while the view shows the pad's menu itself (in its own "⋯", with `menuItems`),
   * false (the default) to have the core float the pad's "⋯" in the top-right corner.
   */
  setMenuHosted(hosted: boolean): void
}

export interface PadView {
  readonly element: HTMLElement
  /** The keyboard into the pad (it was opened from the keyboard, or its icon was clicked). */
  focus(): void
  serialize?(): unknown
  /** Items the pad's menu (its header's "⋯", right-click on its icon) shows after the core's. */
  menu?(): ContextMenuEntry[]
  /** Shown or hidden (its side bar opened or closed, its desk switched); it keeps its size either way. */
  setVisible?(visible: boolean): void
  dispose(): void
}

/** What a chooser item resolves into: the pane to add (and what runs once it is there), nothing (cancelled), or an error to show. */
export type ChoiceResolution = { options: AddPanelOptions; after?: () => Promise<void> } | { error: string } | undefined

export interface TetherUi {
  /** The extension's id. */
  readonly id: string
  /** The product's identity (app/shared/brand.ts): name, slug, appId, accent, icon. */
  readonly brand: Brand
  panes: {
    register(type: PaneType): IDisposable
    /** Adds a pane relative to `reference` (the active pane by default) at `target`'s level; it becomes active. */
    open(options: AddPanelOptions, where?: { target?: Target; reference?: string }): IDockviewPanel
    find(id: string): IDockviewPanel | undefined
    /** The current desk's (or the open drawer's) active pane. */
    activeId(): string | undefined
    /** A pane's opening folder (a terminal's cwd, a note's repository…). */
    cwdOf(id: string | undefined): string | undefined
    /** The keyboard to a pane. */
    focus(id: string): void
    /** Brings a pane to the front wherever it lives (its desk comes forward, the drawer or its pad opens, its tab is activated) and focuses it. */
    reveal(id: string): void
    /** "Copiar link do painel": a tether:// link that brings the pane back from anywhere. */
    copyLink(id: string): void
    /** Closes a pane without a slot behind it (remembered for "reabrir o último painel fechado"). */
    close(id: string): void
    /** The pane's tab menu at page coordinates (the type's own `tabMenu`). */
    showTabMenu(id: string, x: number, y: number): void
    /** "Novo painel…" next to a pane (in `cwd` when given), and its label. */
    newPanelDialog(reference: string, opts?: { cwd?: string }): void
    readonly newPanelLabel: string
    /** "Mover…" for a pane. */
    move(id: string): void
    /** Every pane in the window (each desk, the drawer, the frames pads). */
    all(): readonly PaneInfo[]
    describe(id: string): PaneInfo | undefined
    /** The active pane (of the visible desk, the open drawer or the focused pad) changed. */
    onDidChangeActive(listener: (info: PaneInfo | undefined) => void): IDisposable
  }
  /**
   * The window's projects (F8; VS Code's IWorkspaceContextService): folders inferred from the AI agents' panes plus the
   * pinned ones, in order of arrival. The core owns them; an extension (the explorer) shows and edits them.
   */
  workspace: {
    folders(): readonly ProjectFolder[]
    onDidChange(listener: (folders: readonly ProjectFolder[]) => void): IDisposable
    /** Opens a folder as a project and pins it; idempotent (an open one just ends up pinned). */
    open(path: string): void
    /** Unpinned: it stays as inferred while agents reference it, else it closes. */
    unpin(path: string): void
    /** Pinned ↔ unpinned (an inferred folder is promoted in place). */
    togglePin(path: string): void
    move(path: string, dir: 'up' | 'down'): void
    /** The current project (set by "seguir" or a click), if it is still open. */
    current(): string | undefined
    setCurrent(path: string | undefined): void
    /** The project containing a path (the innermost one). */
    folderOf(absPath: string): ProjectFolder | undefined
  }
  /** The app's folders: the recent ones ("Novo painel" keeps them) and the native folder picker. */
  folders: {
    recent(): Promise<string[]>
    pickFolder(initial?: string): Promise<string | null>
    /** Puts a folder at the top of the recent ones. */
    remember(path: string): void
  }
  commands: {
    /** Commands with everything in code (an editor's own actions, registered while it has the focus). */
    register(...commands: Command[]): IDisposable
    /** The handler of a command the manifest declares (`contributes.commands`: title, category, icon, enablement). */
    registerCommand(id: string, run: (source?: RunSource) => void): IDisposable
    /** Every registered command id. */
    ids(): string[]
    /** Runs a command by id (a menu item calling another extension's command); 'unknown' when none is registered. */
    run(id: string): Promise<'ran' | 'unknown' | 'unavailable'>
  }
  /** The extension's channels to its main side (`ext:<id>:<channel>`), typed by its channel map. */
  ipc<C extends ChannelMap>(): UiIpc<C>
  /** The extension's settings (`extensions.<id>.<key>` of settings.json), normalized by its manifest's schema. */
  settings: {
    get<T extends SettingValue>(key: string): T | undefined
    set(key: string, value: SettingValue): void
    onChange(key: string, listener: (value: SettingValue) => void): IDisposable
  }
  /**
   * Every registered setting (core and extensions) by its full key, the storage path (`ui.deskLine`,
   * `extensions.note.minimap`): what the settings page lists and edits. Main is the writer; a write is refused for an
   * unknown key, an invalid value, or a settings.json that does not parse.
   */
  configuration: {
    all(): Promise<SettingsList>
    set(key: string, value: SettingValue): Promise<SettingWriteResult>
    /** Removes the key from settings.json (back to its default). */
    reset(key: string): Promise<SettingWriteResult>
    /** Keys changed in the file (any writer), or its parse errors changed (`errors` then set; empty once valid). */
    onDidChange(listener: (e: { keys: string[]; errors?: SettingsError[] }) => void): IDisposable
    fileState(): Promise<SettingsFileState>
    /** "Abrir settings.json": the file in an editor tab (an empty `{}` is created first when absent). */
    openFile(): Promise<void>
  }
  menus: {
    /** An item of the ≡ menu; the core fixes the group order (app/renderer/app-menu.ts APP_MENU_GROUPS). */
    app(item: MenuItem<CommandContext>): IDisposable
    /** A floating context menu at page coordinates. */
    context(x: number, y: number, entries: ContextMenuEntry[]): void
  }
  layout: {
    /** A pane's params changed (dockview's updateParameters): the layout is saved soon. */
    scheduleSave(): void
  }
  dialogs: { ask(spec: DialogSpec): Promise<DialogAnswer> }
  theme: {
    scheme(): ColorScheme
    /** Every theme application (the first one included). */
    onChange(listener: (scheme: ColorScheme) => void): IDisposable
    /** The terminal appearance in force (its font is the editors' and the previews' code font). */
    appearance(): TerminalAppearance
    /** A new appearance, painted once its font is loaded (the startup load included). */
    onAppearance(listener: (a: TerminalAppearance) => void): IDisposable
  }
  openers: {
    register(opener: FileOpener): IDisposable
    /** Opens a file as Ctrl+P does (checks it exists and is text; a binary goes to the system's program). */
    open(path: string, opts: OpenFileOptions): Promise<void>
    /** A file was opened, whoever asked (text in an opener, or by the system's program): for a history of opened files. */
    onOpened(listener: (path: string) => void): IDisposable
  }
  /** The command palette (Ctrl+Shift+P): extensions add the mode of text without `>`. */
  palette: {
    /** What the box shows for text without `>` (one extension at a time; the last registered wins). */
    registerMode(provider: PaletteModeProvider): IDisposable
    /** Opens the box in that mode (empty field), as the mode's chord does. */
    showMode(): void
  }
  /** How the app names and draws an agent the daemon side of this extension registers (F9 §4.8). */
  agents: {
    register(ui: AgentUi): IDisposable
  }
  chooser: {
    /** Resolves the manifest's chooser item `itemId` (`contributes.chooser.items`) once the person picks it. */
    resolve(itemId: string, fn: (cwd: string) => Promise<ChoiceResolution>): IDisposable
  }
  /**
   * The top bar's status icons (left of the connection icon). The manifest declares the icon (`contributes.status`); this
   * registers what it says. `register` returns the disposable with `update()`: call it when the title, badge, state or
   * popover content changed.
   */
  status: {
    register(item: StatusItem): StatusHandle
  }
  /** The side bars' pads (F10). */
  pads: {
    /** What a pad of the manifest shows. */
    register(type: PadType): IDisposable
    /** Opens a pad on its side bar (a no-op when it is shown). */
    open(id: string): void
    /**
     * The view of a pad declared `frames: true`: a full Desk of frames (tabs, empty panes, "+", splits, any pane type)
     * that the core knows as a place panes live (found, moved, pruned, listed, focused like a desk's).
     */
    frames(host: PadHost): PadView
  }
  /**
   * The key table and the person's keybindings.json, which stay the core's (the dispatcher honours the file with the
   * shortcuts screen off). `fixedBindings` registers rows the screen lists but cannot change (an editor's own keys); the
   * rest is what the screen reads and edits.
   */
  keybindings: {
    fixedBindings(provider: () => FixedBinding[]): IDisposable
    /** Every fixed row: the native menu's, the pane's clipboard keys, and the extensions'. */
    fixed(): FixedBinding[]
    /** Every command (the editor's own actions left out) as the screen lists it. */
    commands(): KbCommandInfo[]
    /** The key table in force. */
    table(): KeyTable
    /** The screen changed the table: in force at once (the extension writes the file). */
    apply(bindings: Keybinding[]): void
    /** Back to the defaults: in force at once; returns the bindings to write. */
    defaults(): Keybinding[]
    /** The file as the core last read it. */
    file(): KeybindingsFileInfo
    /** The file was read again (at start, after every change on disk, our own write included). */
    onDidChangeFile(listener: () => void): IDisposable
  }
  /**
   * File operations other extensions must follow (VS Code's IWorkingCopyFileService.onDidRunWorkingCopyFileOperation): the
   * explorer announces a rename it made on disk, the editors whose file was at (or under) `from` move to the new path.
   */
  files: {
    didRename(from: string, to: string): void
    onDidRename(listener: (e: { from: string; to: string }) => void): IDisposable
  }
  shell: {
    writeClipboard(text: string): void
    openPath(path: string): Promise<{ ok: true } | { ok: false; message: string }>
    openExternal(url: string): void
  }
  /** Test hooks: `window.__tether.ext.<id>.<name>` (and flat on `window.__tether` when the name is free). */
  test: { expose(name: string, value: unknown): void }
}
