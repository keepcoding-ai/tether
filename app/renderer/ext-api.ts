// `TetherUi`: what the renderer offers an extension's `activate` (F9). It grows per slice (study §3.2): 0a the pane-type
// registry; 0b the IPC bus to the extension's main side, its settings and the ≡ menu; slice 1 (the note) what a pane
// kind needs from the workbench: open/find/focus/close panes, the tab menu, commands with handlers, dialogs, the theme
// and the terminal font, file openers, the chooser's items, the shortcuts screen's fixed rows, and test hooks. Every
// registration returns a disposable (app/shared/vscode-lifecycle.ts).
import type { AddPanelOptions, IDockviewPanel } from 'dockview-core'
import type { ChannelMap, UiIpc } from '../shared/ext-ipc.ts'
import type { SettingValue } from '../shared/vscode-configuration-registry.ts'
import type { MenuItem } from '../shared/vscode-menu-registry.ts'
import type { IDisposable } from '../shared/vscode-lifecycle.ts'
import type { DialogAnswer, DialogSpec } from '../shared/dialog.ts'
import type { TerminalAppearance } from '../shared/terminal-theme.ts'
import type { ColorScheme } from '../shared/theme.ts'
import type { Command, CommandContext, RunSource } from './commands.ts'
import type { Target } from './create.ts'
import type { FixedBinding } from './keybindings-panel.ts'
import type { PaneType } from './pane-registry.ts'
import type { OpenFileOptions } from './quick-open.ts'

export type { IDisposable as Disposable } from '../shared/vscode-lifecycle.ts'
export type { PaneType } from './pane-registry.ts'

/** A row of a context menu (the tab menu): an item, or 'sep' for a thin line between groups. */
export type ContextMenuEntry = { icon: string; label: string; run(): void; danger?: boolean } | 'sep'

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
}

export interface PadView {
  readonly element: HTMLElement
  /** The keyboard into the pad (it was opened from the keyboard, or its icon was clicked). */
  focus(): void
  serialize?(): unknown
  /** Shown or hidden (its side bar opened or closed, its desk switched); it keeps its size either way. */
  setVisible?(visible: boolean): void
  dispose(): void
}

/** What a chooser item resolves into: the pane to add (and what runs once it is there), nothing (cancelled), or an error to show. */
export type ChoiceResolution = { options: AddPanelOptions; after?: () => Promise<void> } | { error: string } | undefined

export interface TetherUi {
  /** The extension's id. */
  readonly id: string
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
    /** Closes a pane without a slot behind it (remembered for "reabrir o último painel fechado"). */
    close(id: string): void
    /** The pane's tab menu at page coordinates (the type's own `tabMenu`). */
    showTabMenu(id: string, x: number, y: number): void
    /** "Novo painel…" next to a pane, and its label. */
    newPanelDialog(reference: string): void
    readonly newPanelLabel: string
    /** "Mover…" for a pane. */
    move(id: string): void
  }
  commands: {
    /** Commands with everything in code (an editor's own actions, registered while it has the focus). */
    register(...commands: Command[]): IDisposable
    /** The handler of a command the manifest declares (`contributes.commands`: title, category, icon, enablement). */
    registerCommand(id: string, run: (source?: RunSource) => void): IDisposable
    /** Every registered command id. */
    ids(): string[]
  }
  /** The extension's channels to its main side (`ext:<id>:<channel>`), typed by its channel map. */
  ipc<C extends ChannelMap>(): UiIpc<C>
  /** The extension's settings (`extensions.<id>.<key>` of settings.json), normalized by its manifest's schema. */
  settings: {
    get<T extends SettingValue>(key: string): T | undefined
    set(key: string, value: SettingValue): void
    onChange(key: string, listener: (value: SettingValue) => void): IDisposable
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
  }
  chooser: {
    /** Resolves the manifest's chooser item `itemId` (`contributes.chooser.items`) once the person picks it. */
    resolve(itemId: string, fn: (cwd: string) => Promise<ChoiceResolution>): IDisposable
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
  /** Rows the shortcuts screen lists but cannot change (an editor's own keys). */
  keybindings: { fixedBindings(provider: () => FixedBinding[]): IDisposable }
  shell: {
    writeClipboard(text: string): void
    openPath(path: string): Promise<{ ok: true } | { ok: false; message: string }>
    openExternal(url: string): void
  }
  /** Test hooks: `window.__tether.ext.<id>.<name>` (and flat on `window.__tether` when the name is free). */
  test: { expose(name: string, value: unknown): void }
}
