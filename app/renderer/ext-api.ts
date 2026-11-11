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
import type { ProfileOption } from './profile-options.ts'
import type { AttentionHandle, AttentionRaise, Badge } from './seal-rules.ts'
import type { Brand } from '../shared/brand.ts'
import type { StatusHandle, StatusItem } from './status-rules.ts'
import type { SurfaceBinding } from './surface-host.ts'
import type { AgentPane } from './agent-panes.ts'
import type { FrameSnapshot, PanelFrameTree } from './panel-frames.ts'

/** Why a panel frame became loose: the person closed its panel, or the panel went by itself. */
export type LooseCause = 'closed' | 'lost'

export type { IDisposable as Disposable } from '../shared/vscode-lifecycle.ts'
export type { PaneType } from './pane-registry.ts'
export type { PaletteModeProvider, PaletteSearch } from './palette.ts'
export type { ProjectFolder } from './workspace.ts'
export type { AgentUi } from './agent-ui.ts'
export type { AgentPane, PanePlace } from './agent-panes.ts'
export type { Badge, AttentionHandle, AttentionRaise } from './seal-rules.ts'
export type { Brand } from '../shared/brand.ts'
export type { SurfaceBinding, SurfaceHostState, SurfaceShieldEvent } from './surface-host.ts'
export type { StatusBadge, StatusHandle, StatusItem, StatusState } from './status-rules.ts'
export type { FrameDeskGroup, FrameFilter, FramePane, FrameSnapshot, PanelFrameRow, PanelFrameTree } from './panel-frames.ts'

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
/**
 * How a menu item sits outside the menu, where a view shows the menu's items as a bar of actions (the panel-pad-manager's
 * rows): 'icon' = the icon alone, 'primary' = icon and label, 'highlight' = icon and label in the accent color. Unset =
 * only in the menu.
 */
export type MenuPin = 'icon' | 'primary' | 'highlight'
export type ContextMenuEntry = { icon: string; label: string; run(): void; danger?: boolean; disabled?: boolean; checked?: boolean; pin?: MenuPin } | 'sep'
/**
 * Whose eyes a tab menu is for. 'manager': a view that lists panels (open or with their tab closed) apart from their tabs;
 * the menu then starts with how to reach the tab ("Focar guia"; for a closed one "Trazer de volta") and does not activate
 * the pane.
 */
export interface TabMenuOptions { from?: 'manager' }

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
  /** The focusable panel this view belongs to (scope 'panel'). */
  readonly panelId?: string
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

/** The id of the destination option picked in the chooser (the note's 'project', 'home', 'other'). */
export type ChooserDestination = string

/**
 * One destination option of a chooser item. `edit`: the chooser's folder field is the destination's folder, editable
 * (with `suffix`, the folders added after it, shown grey after the text). `fixed`: the field shows `fixedFolder`, read
 * only, and its folder button calls `configure` instead of browsing.
 */
export interface ChooserDestinationOption {
  id: string
  label: string
  title?: string
  folder: 'edit' | 'fixed'
  suffix?: readonly string[]
  /** The tooltip of the folder button of a `fixed` option. */
  configureTitle?: string
}

/**
 * The destination choices of a chooser item (only the note's "Nova nota" has them): a row of options above the folder
 * field while the item is highlighted; other items keep the band as it is.
 */
export interface ChooserDestinations {
  options: readonly ChooserDestinationOption[]
  /** What comes selected (the last one used), a folder for the field (a remembered `edit` folder), and a warning when the last one could not be kept. */
  initial(): Promise<{ id: string; folder?: string; warning?: string }>
  /** The folder a `fixed` option shows. */
  fixedFolder(id: string): Promise<string>
  /** The folder button of a `fixed` option. */
  configure(id: string): void
}

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
    /** The Foco de Mesa's active pane (the visible desk's, or the open drawer's), never a pad's. */
    deskActiveId(): string | undefined
    /** A pane's opening folder (a terminal's cwd, a note's repository…). */
    cwdOf(id: string | undefined): string | undefined
    /** The keyboard to a pane. */
    focus(id: string): void
    /** Brings a pane to the front wherever it lives (its desk comes forward, the drawer or its pad opens, its tab is activated) and focuses it. */
    reveal(id: string): void
    /** "Copiar link do painel": a tether:// link that brings the pane back from anywhere. */
    copyLink(id: string): void
    /** Draws the eye to a pane's tab with a short pulse (bring it up first: `reveal`). */
    attention(id: string): void
    /** Closes a pane without a slot behind it (remembered for "reabrir o último painel fechado"). */
    close(id: string): void
    /**
     * The pane's tab menu at page coordinates, by the `opener` button when given (it reads aria-expanded and gets the focus
     * back). With `from: 'manager'` the same menu comes after "Focar guia" and "Fechar guia" (its only primaries). A pane
     * that is not live has no menu: a closed owner's frame is mounted first (`pads.panelFrames.mount`).
     */
    showTabMenu(id: string, x: number, y: number, opener?: HTMLElement, opts?: TabMenuOptions): void
    /** The items `showTabMenu` shows, as data (one source for the menu and any bar of actions built from it). */
    tabMenuEntries(id: string, opts?: TabMenuOptions): ContextMenuEntry[]
    /** "Novo painel…" next to a pane (in `cwd` when given), and its label. */
    newPanelDialog(reference: string, opts?: { cwd?: string }): void
    readonly newPanelLabel: string
    /** "Mover…" for a pane. */
    move(id: string): void
    /**
     * From a `dragstart` on any element: the drag the pane's own tab would start, so wherever a tab can be dropped (a
     * frame, its edges, a pad, the drawer) this drag can too. False when the pane is not in a frame.
     */
    beginDrag(id: string, ev: DragEvent): boolean
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
    /** Opens the settings page on one setting (its full key): the page comes forward, scrolls to it and focuses it. */
    reveal(key: string): void
    /** The settings page's side of `reveal` (one handler; the last registered wins). */
    onReveal(handler: (key: string) => void): IDisposable
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
  /**
   * The AI agents (F9 §4.8). `register` tells how the app names and draws an agent the daemon side of this extension registers;
   * the rest is a read-only view of the agents' panes (never plain shells), keyed by `slotId`, the daemon's id of the slot,
   * the same one `TetherMain.agents` and the daemon use and the one that survives a restart. `name` is what the pane's tab
   * shows; `alive` is false once the process ended; the place is where the pane is now. The interface gives an agent no colour
   * of its own, so there is none here.
   */
  agents: {
    register(ui: AgentUi): IDisposable
    /** Every agent pane in the window (desks, system desks, the drawer, the pads), in no particular order. */
    list(): readonly AgentPane[]
    get(slotId: string): AgentPane | undefined
    /** A pane appeared, was renamed, moved (desk, drawer, pad), changed profile, exited or went away (then with `alive: false`). */
    onDidChange(listener: (pane: AgentPane) => void): IDisposable
    /**
     * Brings the agent's pane to the front: its desk (a system desk too) comes forward, the drawer or its pad opens, its tab is
     * activated and focused. An agent that exited is not restarted. False when no pane shows that slot.
     */
    focus(slotId: string): boolean
    /**
     * Rows an extension adds to the tab menu of an agent's pane, before "Fechar painel…". The provider gets the pane's slot id
     * and returns its rows (none: an empty list); it runs each time the menu opens.
     */
    tabMenu(provider: (slotId: string) => ContextMenuEntry[]): IDisposable
  }
  /** The profile editor. */
  profiles: {
    /** Adds a checkbox to the editor for AI-agent profiles; the value lives in `profile.extensions.<this id>.<key>`. */
    registerOption(option: ProfileOption): IDisposable
  }
  chooser: {
    /** Resolves the manifest's chooser item `itemId` (`contributes.chooser.items`) once the person picks it. */
    resolve(itemId: string, fn: (cwd: string, destination?: ChooserDestination) => Promise<ChoiceResolution>): IDisposable
    /** The destination choices of the item `itemId` (the chooser shows them while it is highlighted). */
    destinations(itemId: string, destinations: ChooserDestinations): IDisposable
  }
  /**
   * The top bar's status icons (left of the connection icon). The manifest declares the icon (`contributes.status`); this
   * registers what it says. `register` returns the disposable with `update()`: call it when the title, badge, state or
   * popover content changed.
   */
  status: {
    register(item: StatusItem): StatusHandle
  }
  /**
   * The extension's own system desks (`contributes.systemDesks`; a desk of another extension, or an undeclared id, throws).
   * The core mounts and shows the desk; what goes in it is the extension's: open a pane there with `panes.open` while it is
   * the visible desk (a `reference` pane of the desk also works), since `open` without a reference adds to the visible desk.
   */
  /**
   * Attention seals on panes (the same seal the terminals have: on the pane's tab and on its desk's pill, with the message in
   * their tooltips). Any pane may be warned, an agent's too; the extension owns only the seals it raised, and they go with it.
   * Normal: the seal goes out when the pane is seen. `sticky`: seeing it does not clear it, only `resolve()` (or dispose) does.
   * Clicking the seal tells `onDidActivate` of the seal's handle; with no listener, the core brings the pane forward.
   */
  attention: {
    raise(opts: AttentionRaise): AttentionHandle
  }
  systemDesks: {
    /** The badge on this system desk's pill (count, attention flag, tooltip); an empty badge or a zero count clears it. */
    setBadge(id: string, badge: Badge | undefined): void
    /** Enters the desk, or, when it is the visible one, goes back to the queue desk the person came from. */
    toggle(id: string): void
    /**
     * Adds a pane to this system desk without showing it: the desk is not entered, the pane does not become the active tab
     * (the first pane of an empty frame is its only tab). `reference` (a pane of the desk) puts it in that pane's group, at
     * `index` among its tabs; without one, in the desk's active frame, last.
     */
    addPane(id: string, options: AddPanelOptions, where?: { reference?: string; index?: number }): IDockviewPanel
    /** Is it the visible desk now. */
    isActive(id: string): boolean
    /** A system desk was entered (`active: true`) or left (`false`); the listener is released with the extension. */
    onDidChangeActive(listener: (e: { id: string; active: boolean }) => void): IDisposable
  }
  /**
   * Native surfaces (the extension's main side creates them, TetherMain.surfaces; the id reaches the pane over the
   * extension's own channel). attach ties the surface to a pane's element: the core keeps the view on the element's
   * rectangle while the element is on screen (its desk is the visible one, its tab the active one, its drawer or pad open,
   * the window not minimized) and hides it otherwise, also on its own when the element is removed. Only the extension's
   * own surfaces can be attached. Dispose when the pane goes; the surface is never destroyed by it (a pane moved between
   * desks attaches the same surface to its new element). The binding reports the effective rectangle and scale (draw the
   * bands around it) and, with the shield on (Surface.setInputShield, main side), where the person tried to click.
   */
  surfaces: {
    attach(surfaceId: string, element: HTMLElement): SurfaceBinding
    /**
     * Freezes every shown surface (each swapped for a picture of itself, the page alive behind) until disposed: for an
     * overlay of the extension's own that is modal or that the person opened. Never for a passing notice or a tooltip (the
     * person may be typing in the page). Holds nest with the core's (palette, menus, dialogs, drawer, drags).
     */
    freezeWhile(reason: string): IDisposable
  }
  /** The side bars' pads (F10). */
  pads: {
    /** What a pad of the manifest shows. */
    register(type: PadType): IDisposable
    /** Opens a pad on its side bar (a no-op when it is shown). */
    open(id: string): void
    /** The badge on this pad's icon in the side bar (count, attention flag, tooltip); an empty badge or a zero count clears it. */
    setBadge(id: string, badge: Badge | undefined): void
    /**
     * The view of a pad declared `frames: true`: a full Desk of frames (tabs, empty panes, "+", splits, any pane type)
     * that the core knows as a place panes live (found, moved, pruned, listed, focused like a desk's).
     */
    frames(host: PadHost): PadView
    /**
     * The panel pad's frames (one per focusable panel, holding panes of any kind), alive or loose (app/renderer/panel-frames.ts).
     * The core keeps them; the panel-pad-manager extension manages them. Keys: `<pad id>@<panel id>`.
     */
    panelFrames: {
      tree(): PanelFrameTree
      /** The frames may have changed (a pane opened or closed somewhere, an operation ran). */
      onDidChange(listener: () => void): IDisposable
      /**
       * A frame with content just became loose: its panel closed. `cause` is 'closed' when the person closed the panel
       * (its tab's ×, "Fechar painel…"), 'lost' when it went by itself (the slot was removed, the daemon forgot it).
       */
      onDidLoose(listener: (key: string, cause: LooseCause) => void): IDisposable
      /**
       * Whether a loose frame's panel can be brought back (its slot still exists in the tetherd: reopening resumes it),
       * with the words the manager shows either way.
       */
      revivable(key: string): { ok: boolean; reason: string }
      /** Brings a loose frame's panel back (the frame follows it, being its own). False when it cannot. */
      revive(key: string): boolean
      /** Closes frames; the snapshot brings them back (`restore`). */
      close(keys: readonly string[]): FrameSnapshot
      restore(snapshot: FrameSnapshot): void
      /** A live frame to the front: its panel comes forward and its pad opens. */
      show(key: string): void
      /**
       * Mounts a frame's view (built from its saved state when it never showed) so its panes are live panes: their menu,
       * drag (`panes.beginDrag`) and close work. A loose frame's owner stays closed. False when the key names no frame.
       */
      mount(key: string): boolean
    }
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
