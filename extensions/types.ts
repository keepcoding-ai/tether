// The extension model (F9): an extension is a folder extensions/<id>/ with manifest.ts and up to three entries
// (renderer.ts, main.ts, daemon.ts), each exporting `activate(api)` that returns the disposables of what it registered.
// Discovery is static: one committed index per host (index.renderer.ts, index.main.ts, index.daemon.ts); a unit test
// fails when a folder's entry is missing from its index (test/unit/ext.index.test.ts). Pure: read by all three hosts.
//
// The manifest mirrors the `contributes` of a VS Code extension's package.json (e.g. extensions/markdown-language-features
// @7faf984: commands, keybindings, menus, configuration, customEditors): what the core needs to know before (or without)
// activating the extension is declared here as data; the behaviour (command handlers, pane factories, IPC handlers) is
// registered by `activate`. Availability is a VS Code-style `when` string (app/shared/vscode-contextkey.ts), so the
// manifest stays data; the only functions are a pane type's pure `owns`/`optionsOf` (its layout.json identity).
import type { IDisposable } from '../app/shared/vscode-lifecycle.ts'
import type { SettingSchema } from '../app/shared/vscode-configuration-registry.ts'

export type Host = 'renderer' | 'main' | 'daemon'
export const HOSTS: readonly Host[] = ['renderer', 'main', 'daemon']

/** The keyboard scopes of the key table (app/renderer/shortcuts.ts `Where`); the person's keybindings.json names them. */
export type KeyScope = 'window' | 'terminal' | 'note'

/** A command the extension contributes (VS Code `contributes.commands`); `activate` gives it its handler. Ids never change: keybindings.json names them. */
export interface CommandContribution {
  command: string
  title: string
  /** The palette's group (VS Code `category`). */
  category: string
  /** An icon name of app/renderer/icons.ts. */
  icon: string
  /**
   * When it can run (VS Code `enablement`/`when`): a context key expression over the core's keys — the active pane's
   * flags ('markdown.note', 'markdown.preview', 'keybindings.screen'), `focus` (terminal | editor | none), `pane`,
   * `paneType`, `desks`, `drawerOpen` — e.g. 'markdown.note', 'focus == editor', '!drawerOpen && pane'. Unavailable
   * commands are greyed out in the ≡ menu, hidden from the palette, and skipped by their chords.
   */
  when?: string
  /** An unavailable command's single key passes to the target instead of being swallowed. */
  keepKeyWhenUnavailable?: boolean
}

/** A default keybinding (VS Code `contributes.keybindings`), in the key table's format: `ctrl` is the app modifier. */
export interface KeybindingContribution {
  key: string
  command: string
  where?: readonly KeyScope[]
  /** A Ctrl that stays Ctrl on the Mac. */
  literal?: boolean
}

/** An item of the ≡ menu (VS Code `contributes.menus`); the core fixes the order of the groups. */
export interface MenuItemContribution {
  command: string
  group: string
  order?: number
  label?: string
  icon?: string
  kind?: 'radio' | 'checkbox'
  /** A checkbox checked while this extension's boolean setting is on (VS Code's `toggled`). */
  toggled?: string
}

/** What a pane is in layout.json, without dockview: its id, title and params. */
export interface SavedPaneShape {
  id: string
  title?: string | undefined
  params?: Record<string, unknown> | undefined
}

/** The dockview options a pane is (re)created with (a structural subset of dockview's AddPanelOptions). */
export interface PaneOptionsShape {
  id: string
  component: string
  tabComponent?: string
  title?: string
  params?: Record<string, unknown>
  renderer?: 'always' | 'onlyWhenVisible'
}

/**
 * A pane type's identity in layout.json (VS Code `contributes.customEditors`: the view type is declared, the provider is
 * registered on activation). The core reads it even when the extension is off, so a saved pane of the type keeps its
 * place, id and params (a placeholder stands in) instead of being taken for a slot. Never renamed once released.
 */
export interface PaneTypeContribution {
  id: string
  /** The prefix of its pane ids ('note:' ⇒ 'note:…'). */
  idPrefix: string
  /** The dockview content and tab component names saved in layout.json. */
  component: string
  tabComponent: string
  /** Among types sharing a prefix, whether this one owns the saved pane. */
  owns?(pane: SavedPaneShape): boolean
  /** The dockview options of a pane from its saved state (moving a pane between desks rebuilds it from these). */
  optionsOf(pane: SavedPaneShape): PaneOptionsShape
  /**
   * Where a pane of this type may live. 'desk': always the general area (a desk or the drawer), never a pad: opening it
   * from a pad lands on the Foco de Mesa, and "Mover…" offers no pad. Screens like the settings have it. Default: anywhere.
   */
  affinity?: 'desk'
}

/** A group of the chooser (the "Novo painel" list and the empty pane): a heading with its items. */
export interface ChooserGroupContribution {
  id: string
  label: string
  icon: string
}

/** An item of the chooser; `activate` resolves it into the pane to add (TetherUi.chooser). */
export interface ChooserItemContribution {
  /** The item's kind; its list id is `kind:<id>`. Unique across extensions. */
  id: string
  group: string
  name: string
  hint: string
  icon: string
  /** Aliases the search matches (folded, never shown). */
  keywords: readonly string[]
  /** What the open button says: "Criar <name>" or "Abrir <name>". */
  button: { verb: 'create' | 'open'; name: string }
}

/**
 * A value moved once from where the core kept it into this extension (VS Code's ConfigurationMigrationRegistry): `from`
 * is a dotted path in settings.json ('ui.wordWrap'); `to` is a setting of the extension or a key of its stored state.
 * Main applies it at startup, also for a disabled extension, so the value is never lost.
 */
export interface MigrationContribution {
  from: string
  to: { setting: string } | { state: string }
}

/**
 * A pad ("prancheta") of a side bar (F10; VS Code's `contributes.viewsContainers` entry): the strip draws its icon before
 * activation, so it is data; `activate` registers what it shows (TetherUi.pads.register). Its id names it in layout.json
 * (which side it was moved to, whether it is open, its state) and is never renamed once released.
 */
export interface PadContribution {
  /** Lowercase, dotted, prefixed by the extension id: 'frame-pads.desk'. */
  id: string
  title: string
  /** An icon name of app/renderer/icons.ts. */
  icon: string
  /** The side bar it lives on until the person moves it. */
  defaultSide: 'left' | 'right'
  /** 'global': one view and one state for the window; 'desk': one per desk, swapped with the desk; 'panel': one per focusable panel, swapped with the focus. */
  scope: 'global' | 'desk' | 'panel'
  /** Its state is a frames layout (frames → panes): the core prunes it and lists its panes. */
  frames?: boolean
  /**
   * The view draws the pad's header itself (VS Code's view that contributes its own title bar): the core hides its header
   * row, so the content gains that row. The pad's title goes to its icon's tooltip and the head of its menu; the pad's
   * "⋯" floats in the content's top-right corner until the view says it shows the pad's menu itself
   * (PadHost.setMenuHosted), and comes back whenever it does not (an empty pad never loses its menu).
   */
  absorbsHeader?: boolean
  /** Order on its strip (lower first). */
  order?: number
}

/**
 * An icon of the top bar's status area (left of the connection icon): the core draws it from the manifest, `activate`
 * registers what it says and shows (TetherUi.status.register). Its id is never renamed once released.
 */
export interface StatusContribution {
  /** Lowercase, dotted, prefixed by the extension id: 'web-bridge.status'. */
  id: string
  /** An icon name of app/renderer/icons.ts. */
  icon: string
  /** Order on the bar (lower first, further from the connection icon). */
  order?: number
}

/**
 * A system desk ("mesa de sistema"): a complete desk outside the person's queue (no number, no rename, no reorder, not in
 * the cycle) with its own pill in the capsule, owned by the extension. The core knows nothing of what it holds. What the
 * desk holds is saved in layout.json `systemDesks` under `id` (so `id` is never renamed once released) and stays there,
 * unshown, while the extension is off; it comes back with the extension.
 */
export interface SystemDeskContribution {
  /** Lowercase, dotted, prefixed by the extension id: 'my-ext.main'. It is the key in layout.json, so it is unique across extensions by construction. */
  id: string
  /** The pill's label and the "Ir para <title>" command. */
  title: string
  /** An icon name of app/renderer/icons.ts; an unknown one draws the default. */
  icon?: string
  /** A hue name of the desk palette (app/shared/palette.ts); it tints the workbench line while the desk is shown. An unknown one draws the default hue. */
  color?: string
}

export interface ExtensionManifest {
  /** Stable, lowercase, no dot: `note`, `quick-open`, `claude`. Prefixes IPC channels, settings and test hooks. */
  id: string
  /** Semver, bumped by hand in the commit that changes the extension. Informative. */
  version: string
  displayName: string
  description?: string
  /** The processes this extension has an entry in; the index test checks it against the files. */
  hosts: readonly Host[]
  /** Can the person turn it off. */
  optional?: boolean
  /** Extensions that must activate first. */
  requires?: readonly string[]
  /** What the core needs before activation. */
  contributes?: {
    /** Pane types this extension registers: the layout knows they exist, even with the extension off. */
    paneTypes?: readonly PaneTypeContribution[]
    /** Settings (schema + default), stored in settings.json under `extensions.<id>.<key>`; read by every host it runs in. */
    settings?: Readonly<Record<string, SettingSchema>>
    commands?: readonly CommandContribution[]
    keybindings?: readonly KeybindingContribution[]
    menus?: { app?: readonly MenuItemContribution[] }
    chooser?: { groups: readonly ChooserGroupContribution[]; items: readonly ChooserItemContribution[] }
    migrations?: readonly MigrationContribution[]
    /** Pads of the side bars (F10). */
    pads?: readonly PadContribution[]
    /** Icons of the top bar's status area. */
    status?: readonly StatusContribution[]
    /** System desks: complete desks outside the queue, with a pill in the capsule. */
    systemDesks?: readonly SystemDeskContribution[]
  }
}

/** What another process needs to list an extension (plain data: it crosses IPC; a manifest may hold functions). */
export type ExtensionSummary = Pick<ExtensionManifest, 'id' | 'version' | 'displayName' | 'description' | 'hosts' | 'optional'>

export function summaryOf(m: ExtensionManifest): ExtensionSummary {
  return { id: m.id, version: m.version, displayName: m.displayName, ...(m.description ? { description: m.description } : {}), hosts: [...m.hosts], ...(m.optional ? { optional: true } : {}) }
}

/** One entry of a host's index: the manifest and that host's `activate`. */
export interface ExtensionEntry<Api> {
  manifest: ExtensionManifest
  activate(api: Api): IDisposable[] | void
  deactivate?(): void
}
