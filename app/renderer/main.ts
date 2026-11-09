// Renderer entry: dockview grid of terminal panels (panel id === slotId), toolbar, new-panel dialog,
// keyboard shortcuts, layout persistence, the "closed slots" menu, and the start/resume flow of each
// panel (auto-start of exited slots on launch, the unconfirmed choice, error actions).
import { type AddPanelOptions, type DockviewTheme, type IDockviewPanel, type SerializedDockview } from 'dockview-core'
import type { Event as DaemonEvent, Profile, SlotKind, SlotState } from '../../src/daemon/protocol.ts'
import type { ConnectionState } from '../shared/api.ts'
import type { AskRequest, Confirmations } from '../shared/dialog.ts'
import { stepFontSize, type FontSizeCommand } from '../shared/font.ts'
import { DEFAULT_APPEARANCE, type TerminalAppearance } from '../shared/terminal-theme.ts'
import { normalizeTheme, type ThemeState } from '../shared/theme.ts'
import { appCommands, type CommandHost } from './app-commands.ts'
import { installBuilderGuard, isBuilder, onBuilderChange, setBuilder } from './builder-mode.ts'
import { commandFromContribution, CommandRegistry, type CommandContext } from './commands.ts'
import { DUPLICATE_LABEL, duplicateRequest, EMPTY_SUFFIX, NEW_FRAME_LABEL, NEW_PANEL_LABEL, PLACEMENT_LABEL, SPLIT_EMPTY_LABEL, type Direction, type Target } from './create.ts'
import { terminalKeyOwner } from './key-capture.ts'
import { ChordDispatcher, scopeOf as keyScopeOf } from './chord-dispatch.ts'
import { ChordPill } from './chord-pill.ts'
import { mergeKeybindings, parseKeybindingsFile, type FixedBinding, type KbCommandInfo, type KeybindingsFileInfo } from './keybindings-rules.ts'
import type { KeybindingsFileState } from '../shared/keybindings.ts'
import { EMPTY_COMPONENT, EMPTY_TAB, EMPTY_TITLE, newEmptyPanelId, withEmpty, type EmptyOrigin } from '../shared/empty.ts'
import { EmptyPanel, EmptyTab, type EmptyHost, type EmptySnapshot } from './empty-panel.ts'
import { type Choice, contributeChooser, rememberProfile } from './chooser-rules.ts'
import { Chooser, type ChooserHost, type ChooserSnapshot, type ChooserState } from './chooser.ts'
import { CommandPalette, type PaletteModeProvider } from './palette.ts'
import { fileOpenFailedSituation, openFile, type OpenFileOptions } from './file-open.ts'
import type { PaletteMode } from './palette-rules.ts'
import { type Desk, type DeskHost, transferFrame, transferPanel } from './desk.ts'
import { DeskSet } from './desk-set.ts'
import { DeskSwitch, type DeskAttention } from './desk-switch.ts'
import { deskTokens, readDeskColor } from './desks.ts'
import { DEFAULT_UI, DIM_LEVELS, type UiSettings } from '../shared/ui-settings.ts'
import { cycleDesk, deskAt, neighbourDesk } from './desks.ts'
import { askDialog, dialogOpen } from './dialog.ts'
import { Drawer } from './drawer.ts'
import { FramesPad } from './frames-pad.ts'
import { CLOSED, closeDrawer, countAttention, escAction, focusAfterClose, openDrawer, quickCwd, type DrawerState } from './drawer-rules.ts'
import { badgeParts, buttonTitle, forgetEndedSituation, groupClosed, headerText, type ClosedGroups } from './closed-slots.ts'
import { icon, KIND_ICON, type IconName } from './icons.ts'
import { BRAND } from '../shared/brand.ts'
import { StatusRegistry } from './status-rules.ts'
import { StatusBar } from './status-bar.ts'
import { openMoveDialog } from './move-dialog.ts'
import { buildTree, DRAWER_SCOPE, type FrameViewJSON, type MoveMode, type MoveOp, type ScopeModel } from './move-rules.ts'
import { drawerOf, emptyLayout, isPersonChange, type Layout, migrateLayout, orphanedPanels, planRestore } from './layout.ts'
import { SideBars } from './sidebars.ts'
import { otherSide, PadRegistry, padToggleCommand, SIDE_LABEL } from './sidebar-rules.ts'
import { detailsLabel, detailsOpen, withDetails } from './pane-details.ts'
import { hintOf, QueueOrder, sameHint, type PaneHint } from './loading.ts'
import { TabStripActions } from './tab-strip.ts'
import { liveTypeOf, PaneRegistry, type ClosedEntry, type PaneLayout, type PaneType } from './pane-registry.ts'
import { emptyLayout as emptyPaneLayout, extensionsLayout, terminalLayout, TERMINAL_COMPONENT, TERMINAL_TAB } from './core-pane-layouts.ts'
import { activateExtensions } from '../shared/ext-activation.ts'
import { registerAgentUi } from './agent-ui.ts'
import type { ChoiceResolution, ContextMenuEntry, FileOpener, PadHost, PadType, TetherUi } from './ext-api.ts'
import { DisabledPane, DisabledTab, type DisabledPaneHost } from './disabled-pane.ts'
import { extensions } from '../../extensions/index.renderer.ts'
import type { ExtensionManifest } from '../../extensions/types.ts'
import { DisposableStore, toDisposable, type IDisposable } from '../shared/vscode-lifecycle.ts'
import { uiIpc } from '../shared/ext-ipc.ts'
import { CORE_SETTINGS } from '../shared/core-settings.ts'
import { generateSettingsSchema } from '../shared/settings-schema.ts'
import { monaco, setSettingsSchema } from './monaco.ts'
import { installMonacoLinks } from './monaco-links.ts'
import { openLink, setLinkHandler, type LinkOrigin } from './link-open.ts'
import type { LinkTarget } from '../shared/links.ts'
import { ConfigurationRegistry, readExtensionsSettings, withSetting, writeExtensionsSettings, type ExtensionsSettings, type SettingValue } from '../shared/vscode-configuration-registry.ts'
import { MenuId, flatItems, type MenuItem as RegistryMenuItem } from '../shared/vscode-menu-registry.ts'
import { appMenuHtml, coreMenuRegistry, menuItemOf } from './app-menu.ts'
import { attachSubmenus } from './menu-submenus.ts'
import { compareFolders, deriveFolders, EMPTY_WORKSPACE, folderOf, isEmptyChange, moveFolder, openFolder as openWorkspaceFolder, pathKey, pinnedInOrder, readWorkspace, togglePin, unpinFolder, workspaceCommands, type PaneSource, type ProjectFolder, type WorkspaceState } from './workspace.ts'
import type { PaneInfo } from './ext-api.ts'
import { ExtensionsPanel, ExtensionsTab, type ExtensionsHost } from './extensions-panel.ts'
import { extensionRows } from './extensions-list.ts'
import { EXTENSIONS_COMPONENT, EXTENSIONS_TAB, EXTENSIONS_TITLE, newExtensionsPanelId } from '../shared/extensions-screen.ts'
import { effectiveStatus, KIND_LABEL, SlotTab, STATUS_LABEL, TerminalPanel, panelTitle, type PanelAction, type PanelHost, type SlotError } from './panel.ts'
import { defaultOf, ProfileManager } from './profiles.ts'
import { chordOn, contributeKeybindings, formatKeys, keybindingEntries, keyTable, KeyTable, PANE_SHORTCUTS, setKeyTable, shortcutHint, TERMINAL_INPUTS, terminalInputOf, type Keybinding } from './shortcuts.ts'
import { closedTabSituation, missingTabSituation } from './situations.ts'
import { noteUrl, parseTetherUrl, tabUrl } from '../shared/tether-url.ts'
import { closeDeskSituation, closePanelSituation, folderName, moveFailedSituation, NO_PROFILE, quitAllSituation, relaunchFailedSituation, reloadAllSituation, switchProfileFailedSituation, switchProfileSituation, switchProfileUnconfirmedSituation } from './situations.ts'
import { loadTerminalFonts, TerminalThemeDialog, terminalFontsLoaded } from './terminal-theme.ts'
import { restartDaemonSituation, trayFirstCloseSituation } from './tray-situations.ts'

const COMPONENT = TERMINAL_COMPONENT
const TAB = TERMINAL_TAB
const SAVE_DEBOUNCE_MS = 300

const slots = new Map<string, SlotState>()
const panels = new Map<string, TerminalPanel>()
const tabs = new Map<string, SlotTab>()
/** The empty panes (F5): a reserved place with the chooser inside (app/renderer/empty-panel.ts). */
const empties = new Map<string, EmptyPanel>()
/** The "Atalhos de teclado" screens (F5, delivery 5; one is the rule, the map keeps the layout honest). */
const extensionsPanels = new Map<string, ExtensionsPanel>()
/** Every kind of pane (F9): the registry main.ts and the extensions register into (see "pane types" below). */
const paneTypes = new PaneRegistry<PaneType>()
/** What extensions follow through TetherUi.theme: every theme applied, every terminal appearance painted. */
const themeListeners = new Set<(scheme: ThemeState['scheme']) => void>()
const appearanceListeners = new Set<(a: TerminalAppearance) => void>()
/** The chooser items extensions contribute, by item id: what picking one opens (TetherUi.chooser). */
const chooserResolvers = new Map<string, (cwd: string) => Promise<ChoiceResolution>>()
/** The panes standing in for a disabled extension's saved panes (app/renderer/disabled-pane.ts). */
const placeholders = new Map<string, DisabledPane>()
/** Error of the last refused `start` per slot (the daemon does not store `already-open` / `unconfirmed`). */
const startErrors = new Map<string, SlotError>()
/** Slots with a `start` request in flight. */
const pendingStarts = new Set<string>()
let desks: DeskSet
let strip: DeskSwitch
/** Chrome preferences (settings.json `ui`). */
let ui: UiSettings = DEFAULT_UI
let drawer: Drawer
/** The side bars and their pads (F10): the pads the extensions declare, what each shows, and the two bars on screen. */
const padRegistry = new PadRegistry()
/** The top bar's status icons the extensions declare and register (TetherUi.status), and the bar that draws them. */
const statusRegistry = new StatusRegistry()
let statusBar: StatusBar | undefined
const padTypes = new Map<string, PadType>()
let sidebars: SideBars | undefined
/** The live frames of the `frames: true` pads (one per global pad, one per desk for a desk pad): places panes live, like the desks and the drawer. */
const framePads = new Set<FramesPad>()
/**
 * The pad whose frames hold the window's one focused frame; undefined while the desks (or the drawer) have it. Follows
 * where the keyboard or the pointer goes (followFocus): new panes, the shortcuts, Ctrl+K arrows and the F6 signals use it.
 */
let focusedPad: FramesPad | undefined

function setFocusedPad(pad: FramesPad | undefined): void {
  if (pad === focusedPad) return
  focusedPad = pad
  for (const d of desks.desks) desks.desk(d.id)?.paintFocus()
  for (const p of framePads) p.desk.paintFocus()
}

/** Focus or a press inside a pad's frames gives that pad the focused frame; inside the desks, the desks take it back. The drawer leaves it as it is. */
function followFocus(ev: Event): void {
  const t = ev.target as Element | null
  const box = t?.closest?.('.pad-frames')
  if (box) { const pad = [...framePads].find(p => p.element === box); if (pad?.isVisible) setFocusedPad(pad); return }
  if (t?.closest?.('#dock')) setFocusedPad(undefined)
}
/** Open/closed and the pane that gets the keyboard back (app/renderer/drawer-rules.ts). Never persisted: the app starts with the drawer closed. */
let drawerState: DrawerState = CLOSED
/** The element that had the keyboard when the drawer opened, for when it was not a pane. */
let drawerReturnEl: HTMLElement | undefined
/** When the last Esc that counts toward a double Esc happened (a shell at its prompt, inside the drawer). */
let lastEsc: number | undefined
/** The drawer's default shell is being created. */
let quickShellBusy = false
/** The whole file as last loaded; what the app keeps in memory (desks, drawer) is rewritten from the live state. */
let layoutFile: Layout = emptyLayout()
let layoutRestored = false
let saveTimer: ReturnType<typeof setTimeout> | undefined
let connection: ConnectionState | undefined
/** The daemon answered and `slots` holds its list: panes attach and the loading stages move on. */
let daemonIsReady = false
let resolveDaemonReady: () => void = () => {}
const daemonReadyPromise = new Promise<void>(r => { resolveDaemonReady = r })
/** The renderer's view of the daemon's start queue (positions for "Na fila (Nº n)"). */
const queue = new QueueOrder()
/** The layout file read at startup and painted at once (before the daemon answers); pruned once it does. */
let geometry: Promise<ReturnType<typeof migrateLayout>> | undefined
/** What is painted now; main owns the setting and pushes every change (user choice or OS switch). */
let theme: ThemeState = { setting: 'auto', scheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' }
/** The terminal appearance in force (preset, font, weight, size, line height); main owns the file and echoes every change. */
let appearance: TerminalAppearance = DEFAULT_APPEARANCE
let themeDialog: TerminalThemeDialog
/** The saved appearance read and its font loaded: no panel opens before this, so xterm measures the real glyphs. */
const appearanceReady: Promise<void> = window.tether.getTerminalAppearance().then(async a => { appearance = a; await loadTerminalFonts(a); for (const l of appearanceListeners) l(a) })
/** Remembered dialog answers ("não perguntar de novo"); main owns the file and pushes every change. */
let confirmations: Confirmations = {}
/** The launch profiles (<home>/profiles.json), as last listed or pushed by the daemon's `profiles` event. */
let profiles: Profile[] = []
let profilesProblem: string | undefined
let manager: ProfileManager

// ---------- commands ----------
// Every action is a command (app/renderer/app-commands.ts); the ≡ menu, the chords and the palette read the registry.

const RECENT_COMMANDS_KEY = 'tether.commands.recent'
/** The last profiles opened through a chooser (ids, most recent first): the Recentes group and the initial highlight. */
const RECENT_PROFILES_KEY = 'tether.chooser.recent'
function loadRecentProfiles(): string[] {
  try { const v = JSON.parse(localStorage.getItem(RECENT_PROFILES_KEY) ?? '[]'); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [] } catch { return [] }
}
let recentProfiles: string[] = loadRecentProfiles()
function noteRecentProfile(id: string): void {
  recentProfiles = rememberProfile(recentProfiles, id)
  try { localStorage.setItem(RECENT_PROFILES_KEY, JSON.stringify(recentProfiles)) } catch { /* storage unavailable: recents live for the session */ }
}
/** The panes activated last (most recent first, a few): where the keyboard goes back to when a laid-out empty pane is left with Esc. */
const activeHistory: string[] = []
function noteActive(id: string | undefined): void {
  if (!id || activeHistory[0] === id) return
  activeHistory.unshift(id)
  if (activeHistory.length > 8) activeHistory.length = 8
}

/** Where the keyboard goes back to once a transient surface (the palette, a menu, a dialog, the toolbar) is left. */
const TRANSIENT_FOCUS = '#palette, .menu, #ctx-menu, dialog, #toolbar'

function focusOwnerOf(el: Element | null | undefined): CommandContext['focus'] {
  return el?.closest('.xterm') ? 'terminal' : el?.closest('[data-editor]') ? 'editor' : 'none'
}

/**
 * The last owner of the keyboard that was not transient. The palette's own field has the focus while it lists
 * the commands: the editor's actions (available with `focus === 'editor'`) must still count the note as focused.
 */
let focusOwner: CommandContext['focus'] = 'none'
document.addEventListener('focusin', ev => {
  const t = ev.target instanceof Element ? ev.target : null
  if (t?.closest(TRANSIENT_FOCUS)) return
  focusOwner = focusOwnerOf(t)
})

function commandContext(): CommandContext {
  const active = document.activeElement
  const transient = !active || active === document.body || active.closest(TRANSIENT_FOCUS)
  const focus = transient ? focusOwner : focusOwnerOf(active)
  const activeId = currentDesk().activePanel?.id
  // The active pane's type and its context flags (PaneType.contextFlags: 'markdown.note', 'keybindings.screen'…).
  const type = activeId ? liveTypeOf(paneTypes, activeId) : undefined
  const flags: ReadonlySet<string> = new Set(activeId ? type?.contextFlags?.(activeId) ?? [] : [])
  const keybindings = flags.has('keybindings.screen')
  const pad = sidebars?.current()
  return {
    pane: !!activeId, ...(type ? { paneType: type.id } : {}), flags, desks: desks.desks.length, drawerOpen: drawer.isOpen, focus, ...(keybindings ? { keybindings } : {}),
    pads: padRegistry.all().length, ...(pad ? { pad, padMoved: sidebars!.isMoved(pad) } : {}),
  }
}

const commands = new CommandRegistry(commandContext, {
  load: () => { try { const v = JSON.parse(localStorage.getItem(RECENT_COMMANDS_KEY) ?? '[]'); return Array.isArray(v) ? v : [] } catch { return [] } },
  save: ids => { try { localStorage.setItem(RECENT_COMMANDS_KEY, JSON.stringify(ids)) } catch { /* storage unavailable: recents live for the session */ } },
})
let palette: CommandPalette

const $ =<T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`elemento #${id} não existe`)
  return el as T
}

// ---------- dockview ----------

const host: PanelHost = {
  getSlot: id => slots.get(id),
  getStartError: id => startErrors.get(id),
  isStartPending: id => pendingStarts.has(id),
  onAction: (id, action) => { void onPanelAction(id, action) },
  onRename: (id, name) => { void renameSlot(id, name) },
  onKey: (ev, panel) => {
    if (ev.type !== 'keydown') return false
    if (ev.key === 'Escape' && !ev.ctrlKey && !ev.altKey && !ev.shiftKey && !ev.metaKey) return drawerEscapeInTerminal(panel) || builderEscape()
    // Line editing (macOS: Cmd/Option + arrows, Backspace; Shift+Enter everywhere in an agent pane): bytes for the prompt, not app chords.
    const seq = terminalInputOf(ev, slots.get(panel.slotId)?.kind !== 'shell')
    if (seq !== undefined) {
      ev.preventDefault()
      panel.sendInput(seq)
      return true
    }
    // App shortcuts never get here: the dispatcher (capture phase, setupUi) stops them before xterm. What arrives is
    // the terminal's, by the table's scopes, except the key the dispatcher let through on purpose (Ctrl+K twice = ^K),
    // which the single-key policy would read as the prefix again.
    // (Clipboard chords are the panel's own: shortcuts.ts PANE_SHORTCUTS.)
    if (ev === letThrough) return false
    return terminalKeyOwner(ev).owner === 'app'
  },
  getScheme: () => theme.scheme,
  getAppearance: () => appearance,
  onSwitchProfile: id => { void switchProfile(id) },
  onToggleDetails: id => togglePaneDetails(id),
  onOpenFolder: id => openFolder(id),
  onCopyFolder: id => copyFolder(id),
  onOpenLink: (id, target) => openLink(target, { slotId: id }),
  onTabMenu: (id, ev) => showTabMenu(id, ev.clientX, ev.clientY),
  isDaemonReady: () => daemonIsReady,
  daemonReady: () => daemonReadyPromise,
  fontsReady: () => appearanceReady,
  queuePosition: id => queue.position(id),
}

// ---------- font size ----------

/**
 * Keyboard and menu steps of the terminal font size. The size is the appearance's ("Tema do terminal"): main
 * stores it and echoes it back (onTerminalAppearance), which repaints every panel and refits it.
 */
function runFontSizeCommand(command: FontSizeCommand): void {
  const next = stepFontSize(appearance.fontSize, command)
  if (next === appearance.fontSize) return
  window.tether.setTerminalAppearance({ ...appearance, fontSize: next })
}

// ---------- theme ----------

/** Our one dockview theme (styles.css `.dv-theme-tether`): its colours are the tokens, which follow html[data-theme]. */
const DOCK_THEME: DockviewTheme = { name: 'tether', className: 'dv-theme-tether' }

/** Applies a theme state everywhere: CSS variables (html[data-theme]), dockview, every xterm, the toolbar select. */
function applyTheme(state: ThemeState): void {
  theme = state
  document.documentElement.dataset.theme = state.scheme
  for (const p of panels.values()) p.setAppearance(appearance, state.scheme)
  for (const l of themeListeners) l(state.scheme)
  themeDialog?.refresh()
  for (const li of document.querySelectorAll<HTMLElement>('#app-menu li[data-theme], #theme-menu li[data-theme]')) li.setAttribute('aria-checked', String(li.dataset.theme === state.setting))
  const btn = $('btn-theme')
  btn.replaceChildren(icon(state.setting === 'light' ? 'sun' : state.setting === 'dark' ? 'moon' : 'circle-half'))
  btn.title = `Tema: ${THEME_LABEL[state.setting]}`
}

const THEME_LABEL: Record<ThemeState['setting'], string> = { light: 'Claro', auto: 'Automático', dark: 'Escuro' }

/** --dpr = devicePixelRatio on the root, so styles.css can snap --desk-line-width to whole device pixels; kept current when
 * the window moves to a display with another scale or the zoom changes. */
function trackDpr(): void {
  const dpr = window.devicePixelRatio || 1
  document.documentElement.style.setProperty('--dpr', String(dpr))
  window.matchMedia(`(resolution: ${dpr}dppx)`).addEventListener('change', trackDpr, { once: true })
}
trackDpr()

/** Applies the chrome preferences: the desk colour line and its check in the ≡ menu. */
function applyUi(next: UiSettings): void {
  ui = next
  document.body.classList.toggle('desk-line', ui.deskLine)
  document.body.classList.toggle('tab-border', ui.tabBorder)
  document.body.classList.toggle('dim-unfocused', ui.dimUnfocused)
  for (const level of DIM_LEVELS) document.body.classList.toggle(`dim-${level}`, ui.dimLevel === level)
  // The radios show the level only while the dim is on.
  for (const li of document.querySelectorAll<HTMLElement>('#app-menu li[data-dim]')) li.setAttribute('aria-checked', String(ui.dimUnfocused && li.dataset.dim === ui.dimLevel))
  document.querySelector('#app-menu li[data-command="ui.tab-border"]')?.setAttribute('aria-checked', String(ui.tabBorder))
  document.querySelector('#app-menu li[data-command="ui.dim-unfocused"]')?.setAttribute('aria-checked', String(ui.dimUnfocused))
  document.querySelector('#app-menu li[data-command="ui.desk-line"]')?.setAttribute('aria-checked', String(ui.deskLine))
}

// ---------- terminal appearance ----------

/** Puts an appearance on every pane (and the dialog's sample); the font must be loaded already. */
function applyAppearance(a: TerminalAppearance): void {
  appearance = a
  for (const p of panels.values()) p.setAppearance(a, theme.scheme)
  for (const l of appearanceListeners) l(a)
  themeDialog?.refresh()
}

/** A change from the dialog: load the font first, paint, then persist (main echoes the normalized value). */
async function changeAppearance(a: TerminalAppearance): Promise<void> {
  await loadTerminalFonts(a)
  applyAppearance(a)
  window.tether.setTerminalAppearance(a)
}

/** Main pushed an appearance (the echo of ours, or another window's change): paint it once its font is loaded. */
async function onAppearance(a: TerminalAppearance): Promise<void> {
  if (!terminalFontsLoaded(a)) await loadTerminalFonts(a)
  if (JSON.stringify(a) !== JSON.stringify(appearance)) applyAppearance(a)
}

/** The host of one desk's frames (or the drawer's): the same dockview options everywhere; a "+" acts in its own desk. */
function deskHost(scope: 'desk' | 'drawer' | FramesPad = 'desk'): DeskHost {
  return {
    dockviewOptions: () => ({
      defaultTabComponent: TAB,
      createComponent: ({ name }) => {
        const type = paneTypes.byComponent(name)
        if (!type) throw new Error(`tipo de painel desconhecido: ${name}`)
        return type.create()
      },
      createTabComponent: ({ name }) => {
        const type = paneTypes.byTab(name)
        if (!type?.createTab) throw new Error(`aba de painel desconhecida: ${name}`)
        return type.createTab()
      },
      // The tab strip measures its own overflow ("+N", tab-strip.ts): dockview's scroll-based list is off.
      disableTabsOverflowList: true,
      createRightHeaderActionComponent: () => new TabStripActions({
        describe: id => {
          const s = slots.get(id)
          return { icon: s ? KIND_ICON[s.kind] ?? 'terminal-window' : (liveTypeOf(paneTypes, id)?.icon as IconName | undefined) ?? 'question', label: findPanel(id)?.api.title ?? id, attention: !!s?.attention }
        },
        showHidden: (x, y, list, pick, opener) => showContextMenu(x, y, list.map(t => ({ icon: t.icon, label: t.label, attention: t.attention, run: () => pick(t.id) })), opener),
        paneMenu: (id, x, y, opener) => {
          menuOpener = opener
          // A pad that absorbs its header: its frame's "⋯" is the pad's menu too (the pad's items after the pane's).
          padSection = scope instanceof FramesPad && padRegistry.get(scope.padId)?.absorbsHeader ? scope.padId : undefined
          try { showTabMenu(id, x, y) } finally { padSection = undefined }
        },
        toggleDetails: id => togglePaneDetails(id),
        addTab: id => { newTabBeside(id) },
        canPreview: id => liveTypeOf(paneTypes, id)?.canPreviewSide?.(id) ?? false,
        previewSide: id => liveTypeOf(paneTypes, id)?.previewSide?.(id),
      }),
      createWatermarkComponent: () => {
        const el = document.createElement('div')
        el.className = 'watermark'
        el.innerHTML = `<p>Nenhum painel aberto.</p><p>${kbdHtml(shortcutHint('pane.new-tab'))} ou "+ ${NEW_PANEL_LABEL}" para abrir um terminal.</p>`
        return { element: el, init: () => {} }
      },
    }),
    // Only changes the person can make are saved: a hint or title the app updates is not one (isPersonChange).
    onLayoutChange: reasons => { if (isPersonChange(reasons)) scheduleSave() },
    onPanelsChange: () => {
      refreshClosedMenu(); renderStrip(); recomputeProjects()
      // A pad is never empty: its one frame shows the chooser ("O que abrir aqui?") when its last tab leaves.
      if (scope instanceof FramesPad) queueMicrotask(() => { if (scope.reseedIfEmpty()) scheduleSave(); scope.syncMenuHosted() })
    },
    singleFrame: scope instanceof FramesPad,
    onEdge: (target, op, frameId, at) => onEdge(target, op, frameId, at, scope === 'drawer' ? drawer.desk : scope instanceof FramesPad ? scope.desk : undefined),
    onActivePanelChange: () => { noteActive(currentDesk().activePanel?.id); markSeenIfWatched(); notifyActivePane() },
    // The desks always paint the Foco de Mesa (it changes only by a click/focus in a desk); a pad with the keyboard and
    // the open drawer paint a neutral outline on their frame instead, never the desk colour.
    focusKind: () => scope === 'drawer' ? 'drawer' : scope instanceof FramesPad ? (focusedPad === scope ? 'keyboard' : 'none') : 'foco',
    paneOptions: panel => paneTypes.optionsOf(panel),
    // A tab dragged here from another frame: the focused frame is where it landed (a pad's, or the desks'), and the keyboard follows it.
    onPaneDropped: id => {
      if (scope instanceof FramesPad) setFocusedPad(scope)
      else if (scope === 'desk') setFocusedPad(undefined)
      requestAnimationFrame(() => focusPane(id))
      refreshClosedMenu()
      renderStrip()
      scheduleSave()
    },
  }
}

function setupDock(): void {
  document.addEventListener('focusin', followFocus)
  document.addEventListener('pointerdown', followFocus, true)
  const bar = $('toolbar')
  strip = new DeskSwitch($('desk-switch'), bar, [bar.querySelector<HTMLElement>('.tb-left')!, bar.querySelector<HTMLElement>('.tb-right')!], {
    switchTo: id => desks.switchTo(id),
    create: () => { if (!drawer.isOpen) desks.create('after', desks.desks.at(-1)?.id) },
    rename: (id, name) => desks.rename(id, name),
    recolor: (id, color) => desks.recolor(id, color),
    menu: (id, x, y) => showDeskMenu(id, x, y),
    overflowMenu: (entries, x, y, pick, opener) => showContextMenu(x, y, entries.map(e => ({ icon: 'cards' as const, label: e.attention > 0 ? `${e.name} (${e.attention})` : e.name, run: () => pick(e.id) })), opener),
    hint: position => shortcutHint(`desk.go.${position}`),
    move: (id, to) => desks.move(id, to),
  })
  desks = new DeskSet($('dock'), {
    deskHost: () => deskHost(),
    onDesksChange: () => { renderStrip(); sidebars?.syncDesks(desks.desks.map(d => d.id)); scheduleSave() },
    onSwitch: () => { focusActivePane(); notifyActivePane() },
    paneOptions: panel => paneTypes.optionsOf(panel),
  }, DOCK_THEME)
  desks.fromEmpty()
  drawer = new Drawer($('drawer'), { deskHost: () => deskHost('drawer'), onMargin: () => setDrawerOpen(false) }, DOCK_THEME)
  sidebars = new SideBars($('workbench'), {
    pads: () => padRegistry.all(),
    padType: id => padTypes.get(id),
    activeDeskId: () => desks.activeDeskId,
    deskName: id => deskName(id),
    hint: id => commands.hint(id),
    onChange: () => scheduleSave(),
    onPadMenu: (id, x, y, opener) => showPadMenu(id, x, y, opener),
    padMenuItems: id => padCoreItems(id).map((e): ContextMenuEntry => e === SEP ? 'sep' : e),
    onFocusLost: () => { const a = currentDesk().activePanel; if (a) focusPane(a.id) },
  })
  padRegistry.onDidChange(() => sidebars?.render())
  sidebars.render()
}

/** A pad's menu (right-click on its icon, its header's "⋯"): open or close it, move it to the other side bar, back to its default side. */
function showPadMenu(id: string, x: number, y: number, opener?: HTMLElement): void {
  const items = padMenuEntries(id)
  if (items.length) showContextMenu(x, y, items, opener)
}

/** A pad's whole menu: its title as the heading, the core's items, then the view's own. */
function padMenuEntries(id: string): MenuEntry[] {
  const core = padCoreItems(id)
  if (!core.length) return []
  const items: MenuEntry[] = [{ heading: sidebars?.padTitle(id) ?? id }, ...core]
  // The pad's own items (the explorer's "Seguir" and "Revelar" toggles) come after the core's.
  const own = sidebars?.shownView(id)?.menu?.() ?? []
  if (own.length) items.push(SEP, ...own.map((e): MenuEntry => e === 'sep' ? SEP : { ...e, icon: e.icon as IconName }))
  return items
}

/** The core's items of a pad's menu: open or close it, move it to the other side bar, back to its default side. */
function padCoreItems(id: string): (MenuItem | typeof SEP)[] {
  const bars = sidebars
  const pad = padRegistry.get(id)
  const side = bars?.sideOf(id)
  if (!bars || !pad || !side) return []
  const open = bars.isOpen(id)
  const items: (MenuItem | typeof SEP)[] = [
    { icon: open ? 'x' : (pad.icon as IconName), label: open ? `Fechar ${pad.title}` : `Abrir ${pad.title}`, run: () => bars.toggle(id) },
    SEP,
    { icon: side === 'left' ? 'arrow-line-right' : 'arrow-line-left', label: `Mover para a barra ${SIDE_LABEL[otherSide(side)]}`, run: () => bars.move(id) },
  ]
  if (bars.isMoved(id)) items.push({ icon: 'arrow-counter-clockwise', label: `Restaurar posição padrão (barra ${SIDE_LABEL[pad.defaultSide]})`, run: () => bars.restore(id) })
  return items
}

/** "Ctrl+Shift+T" as <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd>. */
function kbdHtml(hint: string): string {
  return hint.split('+').map(k => `<kbd>${k}</kbd>`).join('+')
}

// ---------- projects (F8): the window's workspace folders (app/renderer/workspace.ts holds the rules) ----------

/** win32 and darwin compare paths without case (the daemon's canonicalDir keeps the disk's spelling). */
const CASE_INSENSITIVE = /^(win|mac)/i.test(navigator.platform)
/** What layout.json keeps: the pinned roots. */
let workspaceState: WorkspaceState = EMPTY_WORKSPACE
let projectFolders: ProjectFolder[] = []
let currentProject: string | undefined
const workspaceListeners = new Set<(folders: readonly ProjectFolder[]) => void>()
const activePaneListeners = new Set<(info: PaneInfo | undefined) => void>()
let lastActivePane: string | undefined

function paneSources(): PaneSource[] {
  // The creation folder (`folder`), not `cwd`: the binding's folder moves with a `cd` reported by a later SessionStart.
  return allPanels().map(p => { const s = slots.get(p.id); return s ? { id: p.id, kind: s.kind, cwd: s.folder ?? s.cwd } : { id: p.id } })
}

/** Re-derives the folders from the panes, the slots and the pinned roots; listeners hear only a real change. */
function recomputeProjects(): void {
  if (!desks) return // the first desk is still being built
  const next = deriveFolders(projectFolders, workspaceState, paneSources(), CASE_INSENSITIVE)
  const change = compareFolders(projectFolders, next, CASE_INSENSITIVE)
  projectFolders = next
  if (currentProject && !next.some(f => pathKey(f.path, CASE_INSENSITIVE) === pathKey(currentProject!, CASE_INSENSITIVE))) currentProject = undefined
  if (!isEmptyChange(change)) for (const l of workspaceListeners) l(projectFolders)
}

function setWorkspace(state: WorkspaceState): void {
  if (state === workspaceState) return
  workspaceState = state
  recomputeProjects()
  scheduleSave()
}

/** Open = open and pin; opening an open folder only makes sure it is pinned (no message). */
function openProject(path: string): void {
  setWorkspace(openWorkspaceFolder(workspaceState, path, CASE_INSENSITIVE))
}

function moveProject(path: string, dir: 'up' | 'down'): void {
  projectFolders = moveFolder(projectFolders, path, dir, CASE_INSENSITIVE)
  workspaceState = pinnedInOrder(projectFolders)
  for (const l of workspaceListeners) l(projectFolders)
  scheduleSave()
}

function describePane(id: string | undefined): PaneInfo | undefined {
  if (!id || !findPanel(id)) return undefined
  const slot = slots.get(id)
  const cwd = paneCwdOf(id)
  const file = liveTypeOf(paneTypes, id)?.fileOf?.(id)
  const pad = framePadOf(id)
  const place = inDrawer(id) ? 'Gaveta' : pad ? padRegistry.get(pad.padId)?.title ?? 'Prancheta' : deskName(desks.deskOf(id) ?? desks.activeDeskId)
  return { id, type: liveTypeOf(paneTypes, id)?.id ?? 'unknown', ...(cwd ? { cwd } : {}), ...(file ? { file } : {}), ...(slot && slot.kind !== 'shell' ? { agent: slot.kind } : {}), place }
}

function notifyActivePane(): void {
  // The Foco de Mesa's pane: a pad or the drawer taking the keyboard does not change what the explorer's "Seguir" follows.
  const id = desks.active.activePanel?.id
  if (id === lastActivePane) return
  lastActivePane = id
  const info = describePane(id)
  for (const l of activePaneListeners) l(info)
}

/** The file to write: every desk (with its per-desk pads), the drawer and the side bars as mounted now. */
function layoutJSON(): Layout {
  const live = desks.toJSON()
  const deskList = live.desks.map(d => { const pads = sidebars?.deskPads(d.id); return pads ? { ...d, pads } : d })
  return { ...layoutFile, v: 3, desks: deskList, activeDesk: live.activeDesk, drawer: drawer.toJSON(), sidebars: sidebars?.toJSON() ?? layoutFile.sidebars, workspace: workspaceState }
}

function scheduleSave(): void {
  if (!layoutRestored) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { saveTimer = undefined; void window.tether.saveLayout(layoutJSON()) }, SAVE_DEBOUNCE_MS)
}

/**
 * Adds the pane of a slot: relative to `reference` at `target`'s level (in the reference's desk or the drawer), or in
 * the active group of the active frame of where the user is (the drawer while it is open, else the visible desk).
 * `into` forces the drawer.
 */
function addPanel(slot: SlotState, target?: Target, reference?: string, into?: 'drawer'): IDockviewPanel {
  slots.set(slot.slotId, slot)
  return addPaneOptions(slotPanelOptions(slot), target, reference, into)
}

/** The dockview options of a slot's pane. */
function slotPanelOptions(slot: SlotState): AddPanelOptions {
  return { id: slot.slotId, component: COMPONENT, tabComponent: TAB, title: panelTitle(slot), params: { slotId: slot.slotId, hint: hintOf(slot) } }
}

/** The dockview options of an empty pane (a fresh id), suggesting `cwd` in its chooser; `origin` says what Esc does in it. */
function emptyPanelOptions(cwd: string | undefined, origin: EmptyOrigin = 'layout'): AddPanelOptions {
  return { id: newEmptyPanelId(), component: EMPTY_COMPONENT, tabComponent: EMPTY_TAB, title: EMPTY_TITLE, params: withEmpty(cwd, origin) }
}

/** Adds any pane (slot, note, empty) relative to `reference` at `target`'s level, in its desk or the drawer; `into` forces the drawer. */
function addPaneOptions(options: AddPanelOptions, target?: Target, reference?: string, into?: 'drawer'): IDockviewPanel {
  // No reference: the focused pad's frames, when a pad has the focus (and the drawer is closed) — except for a file being
  // opened, which goes to the Foco de Mesa (fileTargetDesk).
  const pad = into === 'drawer' ? undefined : reference ? framePadOf(reference) : !drawer.isOpen && !openingFile ? padInFocus() : undefined
  const useDrawer = into === 'drawer' || (reference ? inDrawer(reference) : drawer.isOpen)
  const panel = (pad ? pad.desk : useDrawer ? drawer.desk : desks).addPanel(options, target, reference)
  panel.api.setActive()
  return panel
}

/** The pane's opening folder: a terminal's cwd, a note's repository, an empty pane's suggestion; undefined for none. */
function paneCwdOf(id: string | undefined): string | undefined {
  if (!id) return undefined
  return liveTypeOf(paneTypes, id)?.cwdOf?.(id)
}

/**
 * Closing a panel puts the situation to the user (app/renderer/situations.ts) unless an answer was
 * remembered for it. `ask: false` is for the overlay's own "Fechar painel" card, whose consequence is
 * already written on it: nothing is running, so the panel just goes (the slot stays in "Slots fechados").
 */
async function closePanel(slotId: string, opts: { ask?: boolean } = {}): Promise<void> {
  const panel = findPanel(slotId)
  if (!panel) return
  const slot = slots.get(slotId)
  rememberClosed(slotId)
  if (!slot) { removeAnyPanel(panel); return }
  const spec = closePanelSituation(slot)
  let choice: string | undefined = opts.ask === false ? 'detach' : confirmations[spec.situation]
  // Only an answer the spec can remember is honoured: a destructive one never runs without asking.
  if (choice !== 'detach' && choice !== spec.remember?.choice) choice = undefined
  if (!choice) {
    const answer = await askDialog(spec)
    choice = answer.choice
    if (answer.remember && spec.remember) {
      confirmations = { ...confirmations, [spec.situation]: spec.remember.choice }
      window.tether.rememberConfirmation(spec.situation, spec.remember.choice)
    }
  }
  if (choice === 'cancel') return
  if (choice === 'stop') await window.tether.request({ t: 'stop', slotId })
  if (choice === 'forget') await window.tether.request({ t: 'forget', slotId })
  const still = findPanel(slotId) // `forget` makes the daemon say `removed`, which may already have taken the panel
  if (still) removeAnyPanel(still)
}

/** Main asks for a situation to be put to the user (menu items live in main; the dialog lives here). */
async function onAsk(req: AskRequest): Promise<void> {
  switch (req.situation) {
    case 'quit-all': {
      const answer = await askDialog(quitAllSituation(req.slots ?? [...slots.values()]))
      window.tether.answer(req.askId, answer)
      return
    }
    case 'restart-daemon': {
      const answer = await askDialog(restartDaemonSituation(req.slots ?? [...slots.values()]))
      window.tether.answer(req.askId, answer)
      return
    }
    case 'tray-first-close': {
      const answer = await askDialog(trayFirstCloseSituation())
      window.tether.answer(req.askId, answer)
      return
    }
    case 'reload-all': {
      // What the person sees is what is at stake: the slots behind open panels, not every slot on disk.
      const open = [...slots.values()].filter(s => findPanel(s.slotId))
      const answer = await askDialog(reloadAllSituation(open))
      window.tether.answer(req.askId, answer)
      return
    }
    case 'relaunch-failed': {
      const answer = await askDialog(relaunchFailedSituation(req.message ?? 'O próximo processo do app não pôde ser iniciado.'))
      window.tether.answer(req.askId, answer)
      return
    }
  }
}

function renderSlot(slotId: string): void {
  panels.get(slotId)?.render()
  tabs.get(slotId)?.render()
}

// ---------- desks ----------

/** How many panes of a desk finished their turn / wait for the user. */
function deskAttention(deskId: string): DeskAttention {
  const out = { done: 0, waiting: 0 }
  // A desk pad's panes are the desk's: its badge counts them too.
  for (const p of [...(desks.desk(deskId)?.panels ?? []), ...[...framePads].filter(x => x.deskId === deskId).flatMap(x => x.desk.panels)]) {
    const a = slots.get(p.id)?.attention
    if (a === 'done') out.done++
    else if (a === 'waiting') out.waiting++
  }
  return out
}

function renderStrip(): void {
  if (!strip || !desks) return
  strip.render(desks.desks, desks.activeDeskId, deskAttention)
  const active = desks.desks.find(d => d.id === desks.activeDeskId)
  // On the workbench: the line spans the window (over the side bars) and the pads' frames take the colour for the F6 outline.
  if (active) $('workbench').style.setProperty('--desk-line-color', deskTokens(active.color).fill)
  renderDrawerButton()
}

/** The pane the user is looking at: the active pane of the visible desk (the drawer's while it is open), with the window focused. */
function watchedPane(): string | undefined {
  if (!document.hasFocus() || document.visibilityState !== 'visible') return undefined
  return currentDesk().activePanel?.id
}

/** Attention on the pane in front of the user is already seen: tell the daemon (it clears it for every client). */
function markSeenIfWatched(): void {
  const id = watchedPane()
  if (id && slots.get(id)?.attention) void window.tether.request({ t: 'seen', slotId: id })
}

/** The keyboard to a pane, whatever it is: a terminal or a note. */
function focusPane(id: string): void {
  const own = panels.get(id) ?? empties.get(id) ?? extensionsPanels.get(id)
  if (own) { own.focus(); return }
  liveTypeOf(paneTypes, id)?.focus?.(id)
}

/** After a desk switch: the keyboard goes to the desk's active pane (and its badge, if any, is seen). */
function focusActivePane(): void {
  const active = desks.activePanel
  // Deferred, and never over a desk being renamed in the strip (a double-click switches first, then renames).
  if (active) requestAnimationFrame(() => { if (!(document.activeElement as Element | null)?.closest('#desk-switch, #desk-colors')) focusPane(active.id) })
  renderStrip()
  markSeenIfWatched()
}

function deskName(id: string): string {
  return desks.desks.find(d => d.id === id)?.name ?? id
}

function isLiveSlot(s: SlotState): boolean {
  return s.status === 'running' || s.status === 'starting' || s.status === 'queued'
}

/**
 * Closing a desk. An empty desk just closes. With panes, the app's dialog asks: move them to the neighbour
 * desk (safe, default), or stop what runs and close the panes (their slots stay under "Slots fechados").
 */
async function closeDesk(id: string): Promise<void> {
  if (desks.desks.length <= 1) return
  // The desk's pads go with it: their panes are the desk's panes for this question (same dialog, same answers).
  const deskPads = [...framePads].filter(p => p.deskId === id)
  const panes = [...(desks.desk(id)?.panels ?? []), ...deskPads.flatMap(p => p.desk.panels)]
  if (panes.length > 0) {
    const neighbour = neighbourDesk(desks.desks, id)!
    const states = panes.map(p => slots.get(p.id)).filter((s): s is SlotState => s !== undefined)
    const answer = await askDialog(closeDeskSituation(deskName(id), states, deskName(neighbour)))
    if (answer.choice === 'move') {
      // Frame by frame, so the split layouts travel along; whatever is left goes pane by pane.
      for (const frameId of [...(desks.desk(id)?.frameIds ?? [])]) desks.moveFrame(id, frameId, neighbour)
      for (const p of [...(desks.desk(id)?.panels ?? [])]) desks.movePanel(p.id, neighbour)
      // A desk pad's frames go into the neighbour's same pad (created for it if it never showed).
      for (const pad of deskPads) {
        const target = sidebars?.viewOf(pad.padId, neighbour)
        if (!(target instanceof FramesPad)) continue
        for (const frameId of [...pad.desk.frameIds]) if (pad.desk.frames.get(frameId)?.dock.panels.length) transferFrame(pad.desk, target.desk, frameId)
        for (const p of [...pad.desk.panels]) transferPanel(pad.desk, target.desk, p.id, paneTypes.optionsOf(p))
      }
    } else if (answer.choice === 'stop') {
      await Promise.all(states.filter(isLiveSlot).map(s => window.tether.request({ t: 'stop', slotId: s.slotId })))
    } else return
  }
  desks.remove(id)
  refreshClosedMenu()
}

/** Right-click on a desk chip. */
function showDeskMenu(id: string, x: number, y: number): void {
  const index = desks.desks.findIndex(d => d.id === id)
  const items: MenuItem[] = [
    { icon: 'pencil-simple', label: 'Renomear', run: () => strip.startRename(id) },
    { icon: 'palette', label: 'Cor…', run: () => strip.pickColor(id, desks.desks[index]?.color ?? 'blue', x, y) },
    { icon: 'arrow-line-left', label: 'Nova mesa antes', run: () => { desks.create('before', id) } },
    { icon: 'arrow-line-right', label: 'Nova mesa depois', run: () => { desks.create('after', id) } },
  ]
  if (index > 0) items.push({ icon: 'arrow-line-left', label: 'Mover para a esquerda', run: () => desks.move(id, index - 1) })
  if (index < desks.desks.length - 1) items.push({ icon: 'arrow-line-right', label: 'Mover para a direita', run: () => desks.move(id, index + 1) })
  if (index > 1) items.push({ icon: 'arrow-line-left', label: 'Mover para o início', run: () => desks.move(id, 0) })
  if (index < desks.desks.length - 2) items.push({ icon: 'arrow-line-right', label: 'Mover para o fim', run: () => desks.move(id, desks.desks.length - 1) })
  if (desks.desks.length > 1) items.push({ icon: 'x', label: 'Fechar mesa…', danger: true, run: () => { void closeDesk(id) } })
  showContextMenu(x, y, items)
}

function movePaneToDesk(slotId: string, to: string): void {
  if (desks.movePanel(slotId, to)) { refreshClosedMenu(); renderStrip() }
}

function moveFrameToDesk(slotId: string, to: string): void {
  const from = desks.deskOf(slotId)
  const frame = desks.frameOf(slotId)
  if (from && frame && desks.moveFrame(from, frame.id, to)) { refreshClosedMenu(); renderStrip() }
}

// ---------- the drawer ----------

/** The Desk new panes go to and the shortcuts act on: the drawer's while it is open, else the focused pad's frames, else the visible desk. */
function currentDesk(): Desk {
  return drawer?.isOpen ? drawer.desk : padInFocus()?.desk ?? desks.active
}

/**
 * Where a file opens (the explorer, Ctrl+P, a terminal link, the extensions' openers): the Foco de Mesa — the visible
 * desk's focused frame — never a pad, even while a pad has the keyboard. The open drawer is the exception: the desks
 * are inert behind it, so a file opened from inside it lands in the drawer's focused frame.
 */
function fileTargetDesk(): Desk {
  return drawer?.isOpen ? drawer.desk : desks.active
}

/** True while an opener runs for a file (openWithOpeners): `ui.panes.activeId` and a pane opened with no reference then mean the Foco de Mesa. */
let openingFile = false

/** The pad holding the focused frame, while it is on screen. */
function padInFocus(): FramesPad | undefined {
  return focusedPad?.isVisible ? focusedPad : undefined
}

/** A pane lives in one place: a desk, the drawer or a pad's frames. */
function findPanel(slotId: string): IDockviewPanel | undefined {
  return desks.getPanel(slotId) ?? drawer?.desk.getPanel(slotId) ?? framePadOf(slotId)?.desk.getPanel(slotId) // the drawer does not exist yet while the first desk is built
}

function allPanels(): IDockviewPanel[] {
  return [...desks.panels, ...(drawer?.desk.panels ?? []), ...[...framePads].flatMap(p => p.desk.panels)]
}

/** The pad whose frames hold a pane. */
function framePadOf(slotId: string): FramesPad | undefined {
  for (const p of framePads) if (p.desk.getPanel(slotId)) return p
  return undefined
}

/** The live frames of a pad (of a desk, for a desk pad). */
function framePadFor(padId: string, deskId: string | undefined): FramesPad | undefined {
  for (const p of framePads) if (p.padId === padId && p.deskId === deskId) return p
  return undefined
}

/** The view of a `frames: true` pad: a Desk hosted like the drawer's, seeded with an empty pane when it has no state. */
function newFramesPad(host: PadHost): FramesPad {
  return new FramesPad(host, {
    deskHost: pad => deskHost(pad),
    seed: pad => { pad.desk.addPanel(emptyPanelOptions(paneCwdOf(currentDesk().activePanel?.id))) },
    focusPane: id => focusPane(id),
    onCreate: pad => { framePads.add(pad) },
    onHidden: pad => { if (focusedPad === pad) setFocusedPad(undefined) },
    onDispose: pad => { if (focusedPad === pad) setFocusedPad(undefined); framePads.delete(pad); refreshClosedMenu() },
  }, DOCK_THEME)
}

function inDrawer(slotId: string): boolean {
  return drawer?.desk.getPanel(slotId) !== undefined
}

function removeAnyPanel(panel: IDockviewPanel): void {
  const pad = framePadOf(panel.id)
  if (pad) pad.desk.removePanel(panel)
  else if (drawer?.desk.getPanel(panel.id)) drawer.desk.removePanel(panel)
  else desks.removePanel(panel)
}

/** The parts of the window behind the drawer: inert while it is open, so the keyboard cannot wander into them. */
const BEHIND_DRAWER = ['toolbar', 'dock', 'sidebar-left', 'sidebar-right', 'pads']

function drawerAttention(): DeskAttention {
  return countAttention(drawer.desk.panels.map(p => slots.get(p.id)?.attention))
}

/** The toolbar button: expanded state, the number of panes, and the attention badge of the drawer's panes. */
function renderDrawerButton(): void {
  if (!drawer) return
  const btn = $('btn-drawer')
  const badge = $('drawer-badge')
  const att = drawerAttention()
  const total = att.done + att.waiting
  badge.hidden = total === 0
  badge.className = `cnt desk-badge drawer-badge ${att.waiting > 0 ? 'waiting' : 'done'}`
  badge.textContent = String(total)
  btn.setAttribute('aria-expanded', String(drawer.isOpen))
  const n = drawer.desk.panels.length
  // The invitation shows when nothing is in the drawer and no quick shell is on its way (that one has the stage).
  drawer.setEmpty(n === 0 && !quickShellBusy)
  const what = n === 0 ? 'vazia' : n === 1 ? '1 painel' : `${n} painéis`
  const waiting = att.waiting > 0 ? ` · ${att.waiting} esperando você` : ''
  const done = att.done > 0 ? ` · ${att.done} terminou` : ''
  btn.title = `Gaveta (${shortcutHint('drawer.toggle')}): ${what}${waiting}${done}. Um espaço rápido, compartilhado por todas as mesas; fechada, os agentes dela seguem rodando.`
}

/** The pane that has the keyboard now, if it is one of the desks'. */
function focusedDeskPane(): string | undefined {
  const slotId = (document.activeElement as Element | null)?.closest?.('.panel')?.getAttribute('data-slot-id')
  return slotId && desks.getPanel(slotId) ? slotId : desks.activePanel?.id
}

/** Opens or closes the drawer. Closing never stops anything; the focus goes back to the pane that had it. */
function setDrawerOpen(open: boolean): void {
  if (open === drawer.isOpen || (open && !layoutRestored)) return
  lastEsc = undefined
  if (open) {
    drawerReturnEl = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    drawerState = openDrawer(drawerState, focusedDeskPane())
    // Menus of the toolbar belong to the desks behind: they close, they do not stay floating over the drawer.
    $('app-menu').hidden = true
    $('btn-menu').setAttribute('aria-expanded', 'false')
    $('closed-list').hidden = true
    closeToolbarPopups()
  } else {
    drawerState = closeDrawer(drawerState)
  }
  for (const id of BEHIND_DRAWER) $(id).toggleAttribute('inert', open)
  document.body.classList.toggle('drawer-open', open)
  drawer.setOpen(open)
  renderStrip()
  if (open) {
    if (drawer.desk.panels.length === 0) { void quickShell(); renderDrawerButton() }
    requestAnimationFrame(focusDrawer)
  } else {
    requestAnimationFrame(restoreFocusAfterClose)
  }
  markSeenIfWatched()
}

function focusDrawer(): void {
  if (!drawer.isOpen) return
  const active = drawer.desk.activePanel
  if (active) focusPane(active.id)
  else $('drawer-pill').focus() // an empty drawer: the keyboard sits on its bar, where Esc closes
}

function restoreFocusAfterClose(): void {
  if (drawer.isOpen) return
  const target = focusAfterClose(drawerState.returnTo, id => desks.getPanel(id) !== undefined, desks.activePanel?.id)
  if (target) {
    desks.getPanel(target)?.api.setActive()
    focusPane(target)
    return
  }
  if (drawerReturnEl?.isConnected) drawerReturnEl.focus()
}

/**
 * An empty drawer opens a shell (it is a quick desk: Ctrl+` and you are typing), in the folder of the pane you
 * came from. Without a shell profile or a folder, or if the daemon refuses, the chooser opens instead.
 */
async function quickShell(): Promise<void> {
  if (quickShellBusy) return
  quickShellBusy = true
  try {
    if (profiles.length === 0) await loadProfiles()
    const profile = defaultOf(profiles, 'shell')
    const recent = await window.tether.recentFolders()
    const cwd = quickCwd({ paneCwd: slots.get(drawerState.returnTo ?? '')?.cwd, profileCwd: profile?.cwd, recent: recent[0] })
    if (!drawer.isOpen || drawer.desk.panels.length > 0) return // closed or filled meanwhile
    if (!profile || !cwd) { void openNewDialog({ kind: 'shell' }); return }
    const reply = await window.tether.request({ t: 'create', kind: 'shell', cwd, start: true, profileId: profile.id })
    if (reply.t === 'error' || !reply.slot) { void openNewDialog({ kind: 'shell', cwd }); return }
    addPanel(reply.slot, undefined, undefined, 'drawer')
  } finally {
    quickShellBusy = false
    renderDrawerButton()
  }
}

/** Something up that owns Esc: a dialog, a menu, an editor field. */
function escBlocked(): boolean {
  return dialogOpen() || manager.open || themeDialog.open
    || document.querySelector('dialog[open], #ctx-menu, #desk-colors, input.desk-rename') !== null
    || !$('app-menu').hidden || !$('closed-list').hidden
}

/**
 * Esc inside a terminal of the drawer (app/renderer/drawer-rules.ts holds the rule). Returns true when the key
 * was the drawer's (swallowed, the drawer closes); false hands it to the program, remembering it as a first Esc.
 */
function drawerEscapeInTerminal(panel: TerminalPanel): boolean {
  if (!drawer.isOpen || !inDrawer(panel.slotId)) return false
  const now = performance.now()
  const action = escAction({
    open: true,
    blocked: escBlocked(),
    focus: {
      in: 'terminal',
      kind: slots.get(panel.slotId)?.kind ?? 'claude', // unknown: treated as an agent, whose Esc is never taken
      programOwnsScreen: panel.term.buffer.active.type === 'alternate' || panel.term.modes.mouseTrackingMode !== 'none',
    },
    now,
    lastEsc,
  })
  lastEsc = action === 'arm' ? now : undefined
  if (action !== 'close') return false
  setDrawerOpen(false)
  return true
}

/** Esc anywhere but a terminal (the drawer's header, its empty state): closes the drawer. */
function drawerEscapeOutside(ev: KeyboardEvent): void {
  if (ev.defaultPrevented || !drawer.isOpen || (ev.target as Element | null)?.closest?.('.xterm')) return
  if (escAction({ open: true, blocked: escBlocked(), focus: { in: 'chrome' }, now: performance.now(), lastEsc: undefined }) !== 'close') return
  ev.preventDefault()
  setDrawerOpen(false)
}

// Moving work between the desks and the drawer: a pane (or its whole frame) is removed from one and added to the
// other, the process is never touched (transferPanel / transferFrame in app/renderer/desk.ts).

function afterDrawerMove(): void {
  refreshClosedMenu()
  renderStrip()
  scheduleSave()
}

function movePaneToDrawer(slotId: string): void {
  const source = desks.desk(desks.deskOf(slotId) ?? '')
  const panel = source?.getPanel(slotId)
  if (source && panel && transferPanel(source, drawer.desk, slotId, desks.paneOptions(panel))) afterDrawerMove()
}

function moveFrameToDrawer(slotId: string): void {
  const source = desks.desk(desks.deskOf(slotId) ?? '')
  const frame = source?.frameOf(slotId)
  if (source && frame && transferFrame(source, drawer.desk, frame.id)) afterDrawerMove()
}

/** Out of the drawer and into the visible desk; the drawer closes and the moved pane gets the keyboard. */
function surfaceFromDrawer(slotId: string): void {
  afterDrawerMove()
  drawerState = { ...drawerState, returnTo: slotId }
  setDrawerOpen(false)
}

function movePaneFromDrawer(slotId: string): void {
  const panel = drawer.desk.getPanel(slotId)
  if (panel && transferPanel(drawer.desk, desks.active, slotId, desks.paneOptions(panel))) surfaceFromDrawer(slotId)
}

function moveFrameFromDrawer(slotId: string): void {
  const frame = drawer.desk.frameOf(slotId)
  if (frame && transferFrame(drawer.desk, desks.active, frame.id)) surfaceFromDrawer(slotId)
}

// ---------- "Mover…" (app/renderer/move-dialog.ts draws it, move-rules.ts maps the placement to an op) ----------

/** The Desk of a scope of the dialog: the drawer's, or a desk's. */
/** A pad's scope in "Mover…": `pad:<pad id>` (global) or `pad:<pad id>@<desk id>`, the same as its Desk's meta id. */
function padScope(padId: string, deskId: string | undefined): string {
  return `pad:${padId}${deskId ? `@${deskId}` : ''}`
}

/** The frames pad a scope names, created if it never showed (a fresh pad's seeded empty pane is dropped: a pane is on its way). */
function scopePad(scope: string): FramesPad | undefined {
  if (!scope.startsWith('pad:')) return undefined
  const [padId = '', deskId] = scope.slice(4).split('@')
  const live = framePadFor(padId, deskId)
  if (live) return live
  const view = sidebars?.viewOf(padId, deskId)
  if (!(view instanceof FramesPad)) return undefined
  for (const p of [...view.desk.panels]) if (empties.has(p.id)) view.desk.removePanel(p)
  return view
}

function scopeDesk(scope: string): Desk | undefined {
  return scope === DRAWER_SCOPE ? drawer.desk : scope.startsWith('pad:') ? scopePad(scope)?.desk : desks.desk(scope)
}

function scopeOf(slotId: string): string | undefined {
  if (inDrawer(slotId)) return DRAWER_SCOPE
  const pad = framePadOf(slotId)
  return pad ? padScope(pad.padId, pad.deskId) : desks.deskOf(slotId)
}

/** The frames pads "Mover…" offers: the current desk's desk pads and the global pads. */
function movePads(): { id: string; padId: string; name: string; icon: string; desk: Desk | undefined }[] {
  return padRegistry.all().filter(p => p.frames).map(p => {
    const deskId = p.scope === 'desk' ? desks.activeDeskId : undefined
    return { id: padScope(p.id, deskId), padId: p.id, name: p.title, icon: p.icon, desk: framePadFor(p.id, deskId)?.desk }
  })
}

/** The destination tree from the live desks, frames and drawer. */
function moveTree(): ScopeModel[] {
  const framesOf = (d: Desk | undefined): { id: string; view: FrameViewJSON }[] =>
    (d?.frameIds ?? []).flatMap(id => { const f = d!.frames.get(id); return f ? [{ id, view: f.dock.toJSON() as unknown as FrameViewJSON }] : [] })
  return buildTree({
    drawer: { frames: framesOf(drawer.desk) },
    pads: movePads().map(p => ({ id: p.id, name: p.name, icon: p.icon, frames: framesOf(p.desk) })),
    desks: desks.desks.map(d => ({ id: d.id, name: d.name, color: d.color, frames: framesOf(desks.desk(d.id)) })),
    currentDesk: desks.activeDeskId,
    titleOf: id => findPanel(id)?.api.title,
  })
}

/** "Mover…" for a pane (pane ⋯ menu, right-click, the ≡ menu for the active pane, the drawer's tabs). */
async function openMove(slotId: string, mode?: MoveMode): Promise<void> {
  if (dialogOpen()) return
  const scope = scopeOf(slotId)
  const frame = scope ? scopeDesk(scope)?.frameOf(slotId) : undefined
  if (!scope || !frame) return
  const op = await openMoveDialog({
    scopes: moveTree(),
    source: { slotId, title: findPanel(slotId)?.api.title ?? slotId, scope, frameId: frame.id },
    paneIcon: id => { const kind = slots.get(id)?.kind; return kind ? KIND_ICON[kind] ?? 'terminal-window' : (liveTypeOf(paneTypes, id)?.icon as IconName | undefined) ?? 'question' },
    ...(mode ? { mode } : {}),
  })
  if (op) await runMove(op, slotId)
}

const DOCK_POSITION = { left: 'left', right: 'right', above: 'top', below: 'bottom', within: 'center' } as const

/**
 * Runs a move. A pane is removed and re-added (its terminal detaches and attaches again: same slot, process, PID
 * and scrollback; the daemon is never asked to do anything), or moved by dockview inside its own frame; a frame is
 * taken (its dockview JSON) and loaded elsewhere. Any failure puts things back where they were; whatever happens,
 * every pane that was open is still open afterwards (a lost one is re-added to where it came from). The result is
 * saved as a person's change.
 */
async function runMove(op: MoveOp, slotId: string): Promise<boolean> {
  const before = allPanels().map(p => ({ id: p.id, options: desks.paneOptions(p), scope: scopeOf(p.id) }))
  let error: string | undefined
  try { applyMove(op) } catch (err) { error = err instanceof Error ? err.message : String(err) }
  for (const p of before) {
    if (findPanel(p.id)) continue
    console.error(`mover: o painel ${p.id} sumiu; reaberto onde estava`)
    try { (scopeDesk(p.scope ?? '') ?? desks.active).addPanel(p.options) } catch (err) { console.error(`mover: não foi possível reabrir ${p.id}`, err) }
    error ??= 'Um painel não chegou ao destino.'
  }
  refreshClosedMenu()
  renderStrip()
  scheduleSave()
  if (error) {
    await askDialog(moveFailedSituation(error))
    return false
  }
  // Out of the drawer onto the desk behind it: the drawer closes and the moved pane gets the keyboard.
  if (op.from === DRAWER_SCOPE && op.scope === desks.activeDeskId && drawer.isOpen) {
    drawerState = { ...drawerState, returnTo: slotId }
    setDrawerOpen(false)
    return true
  }
  // Into a pad: it opens on its side bar, so the pane is seen where it went.
  const pad = scopePad(op.scope)
  if (pad && !drawer.isOpen) sidebars?.open(pad.padId, false)
  const visible = op.scope === (drawer.isOpen ? DRAWER_SCOPE : desks.activeDeskId) || (!!pad && !drawer.isOpen)
  if (visible && op.op.startsWith('pane')) { findPanel(slotId)?.api.setActive(); focusPane(slotId) }
  return true
}

/** One move (throws, having put things back, when it cannot be done). */
function applyMove(op: MoveOp): void {
  const source = scopeDesk(op.from)
  const target = scopeDesk(op.scope)
  if (!source || !target) throw new Error('A mesa de destino não existe mais.')
  if (op.op === 'pane-beside' || op.op === 'pane-new-frame') {
    const panel = source.getPanel(op.slotId)
    const srcFrame = source.frameOf(op.slotId)
    if (!panel || !srcFrame) throw new Error('O painel não está mais lá.')
    if (op.op === 'pane-beside') {
      const frame = target.frames.get(op.frameId)
      const ref = frame?.dock.getPanel(op.reference)
      if (!frame || !ref) throw new Error('O quadro de destino mudou; abra o Mover… de novo.')
      if (frame === srcFrame) {
        // Same frame: dockview moves the pane itself (nothing is re-created).
        panel.api.moveTo({ group: ref.group, position: DOCK_POSITION[op.direction] })
      } else {
        const direction = op.direction
        movePaneOut(source, srcFrame, panel, options => { frame.dock.addPanel(Object.assign({}, options, { position: { referencePanel: op.reference, direction } }) as AddPanelOptions) })
      }
      target.focusFrame(frame.id)
    } else {
      movePaneOut(source, srcFrame, panel, options => {
        const frame = target.frameForNew(op.direction)
        frame.dock.addPanel(options)
        target.focusFrame(frame.id)
      })
    }
    return
  }
  if (!source.frames.has(op.frameId)) throw new Error('O quadro não está mais lá.')
  if (op.op === 'frame-beside' && !target.frames.has(op.referenceFrame)) throw new Error('O quadro de destino mudou; abra o Mover… de novo.')
  const view = source.takeFrame(op.frameId)!
  try {
    const frame = op.op === 'frame-beside' ? target.addFrameBeside(op.referenceFrame, op.direction) : target.frameForNew(op.direction)
    target.loadView(frame, view)
    target.focusFrame(frame.id)
  } catch (err) {
    console.error(`mover quadro ${op.frameId}: falhou, voltando ao lugar de origem`, err)
    // The emptied frame is still there (it goes in a microtask): the frame comes back into it, else at the edge.
    const back = source.frames.get(op.frameId)
    if (back && back.dock.panels.length === 0) source.loadView(back, view)
    else source.putFrame(view)
    throw err
  }
}

/** Removes a pane and runs `add` elsewhere; if that throws, the pane goes back to its group (or its frame, or its desk). */
function movePaneOut(source: Desk, srcFrame: NonNullable<ReturnType<Desk['frameOf']>>, panel: IDockviewPanel, add: (options: AddPanelOptions) => void): void {
  const options = desks.paneOptions(panel)
  const groupId = panel.group.id
  source.removePanel(panel)
  try { add(options) } catch (err) {
    console.error(`mover painel ${panel.id}: falhou, voltando ao lugar de origem`, err)
    const group = srcFrame.dock.groups.find(g => g.id === groupId)
    if (group) srcFrame.dock.addPanel(Object.assign({}, options, { position: { referenceGroup: group } }) as AddPanelOptions)
    else if (source.frames.has(srcFrame.id)) srcFrame.dock.addPanel(options)
    else source.addPanel(options)
    throw err
  }
}

/** Custom name of a slot (empty removes it): the daemon stores it in the slot's meta and broadcasts the state. */
async function renameSlot(slotId: string, name: string): Promise<void> {
  const reply = await window.tether.request({ t: 'rename-slot', slotId, name })
  if (reply.t === 'error') { console.error(`não foi possível renomear o painel ${slotId}: ${reply.message}`); return }
  if (reply.slot) applyState(reply.slot)
}

// ---------- starting slots ----------

/** Sends `start`; a refusal (unconfirmed, already-open, …) stays on the panel until the slot comes up. */
async function startSlot(slotId: string, choice?: 'resume' | 'new'): Promise<void> {
  if (pendingStarts.has(slotId)) return
  pendingStarts.add(slotId)
  startErrors.delete(slotId)
  renderSlot(slotId)
  const reply = await window.tether.request({ t: 'start', slotId, ...(choice ? { choice } : {}) })
  pendingStarts.delete(slotId)
  if (reply.t === 'error') startErrors.set(slotId, { code: reply.code, message: reply.message })
  else if (reply.slot) applyState(reply.slot)
  renderSlot(slotId)
}

/** Starts every open panel whose slot is exited (the daemon queues agents beyond 3 at once). Unconfirmed ones wait for the user. */
function autoStartPanels(): void {
  for (const panel of allPanels()) {
    const slot = slots.get(panel.id)
    if (slot && effectiveStatus(slot) === 'exited') void startSlot(slot.slotId)
  }
}

async function onPanelAction(slotId: string, action: PanelAction): Promise<void> {
  switch (action) {
    case 'start': return startSlot(slotId)
    case 'resume': return startSlot(slotId, 'resume')
    case 'new': return startSlot(slotId, 'new')
    case 'close': return closePanel(slotId, { ask: false })
    case 'pick-folder': return moveToFolder(slotId)
  }
}

/** The slot's folder is gone: open a fresh slot of the same kind in a folder the user picks, in the same place of the grid. */
async function moveToFolder(slotId: string): Promise<void> {
  const slot = slots.get(slotId)
  const panel = findPanel(slotId)
  if (!slot || !panel) return
  const folder = await window.tether.pickFolder()
  if (!folder) return
  const reply = await window.tether.request({ t: 'create', kind: slot.kind, cwd: folder, start: true, ...profileOf(slot) })
  if (reply.t === 'error' || !reply.slot) {
    startErrors.set(slotId, { code: reply.t === 'error' ? reply.code : 'bad-request', message: reply.t === 'error' ? reply.message : 'o daemon não devolveu o slot' })
    renderSlot(slotId)
    return
  }
  await window.tether.rememberFolder(folder)
  addPanel(reply.slot, { level: 'pane', placement: 'within' }, slotId)
  removeAnyPanel(panel)
  await window.tether.request({ t: 'forget', slotId })
}

// ---------- daemon events / state ----------

function applyState(slot: SlotState): void {
  slots.set(slot.slotId, slot)
  queue.update(slot.slotId, slot.status === 'queued')
  if (slot.status === 'running' || slot.status === 'starting' || slot.status === 'queued') startErrors.delete(slot.slotId)
  const panel = findPanel(slot.slotId)
  if (panel) {
    const title = panelTitle(slot)
    if (panel.title !== title) panel.api.setTitle(title)
    updateHint(slot)
  }
  // Every queued pane's position may have moved.
  for (const id of slots.keys()) if (id !== slot.slotId && slots.get(id)?.status === 'queued') panels.get(id)?.render()
  renderSlot(slot.slotId)
  refreshClosedMenu()
  renderStrip()
  if (slot.attention && slot.slotId === watchedPane()) void window.tether.request({ t: 'seen', slotId: slot.slotId })
  recomputeProjects() // the slot's kind or folder may have changed
}

function onDaemonEvent(ev: DaemonEvent): void {
  switch (ev.t) {
    case 'data': panels.get(ev.slotId)?.write(ev.data); break
    case 'profiles': setProfiles(ev.profiles, undefined); break
    case 'state': applyState(ev.slot); break
    case 'removed': {
      slots.delete(ev.slotId)
      startErrors.delete(ev.slotId)
      const panel = findPanel(ev.slotId)
      if (panel) removeAnyPanel(panel)
      refreshClosedMenu()
      renderStrip()
      break
    }
  }
}

async function refreshSlots(): Promise<void> {
  const reply = await window.tether.request({ t: 'list' })
  if (reply.t === 'error') throw new Error(reply.message)
  slots.clear()
  queue.clear()
  for (const s of reply.slots ?? []) { slots.set(s.slotId, s); queue.update(s.slotId, s.status === 'queued') }
}

/** Shows or hides a pane's header details; the state is a layout param, saved with the layout. */
/** "Abrir pasta no Explorer": main checks that the folder exists and is a directory; a failure is only logged (a missing folder already shows its own situation). */
function openFolder(slotId: string): void {
  const slot = slots.get(slotId)
  if (!slot) return
  void window.tether.openPath(slot.cwd).then(r => { if (!r.ok) console.warn(`open folder: ${r.message}`) })
}

/** "Copiar pasta": the slot's folder to the clipboard. */
function copyFolder(slotId: string): void {
  const slot = slots.get(slotId)
  if (slot) window.tether.writeClipboard(slot.cwd)
}

function togglePaneDetails(slotId: string): void {
  const panel = findPanel(slotId)
  if (!panel) return
  panel.api.updateParameters(withDetails(panel.params, !detailsOpen(panel.params)))
  scheduleSave()
}

/** Keeps the pane's layout hint (kind, folder, profile) in step with the slot, so the next launch paints it before the daemon answers. */
function updateHint(slot: SlotState): void {
  const panel = findPanel(slot.slotId)
  if (!panel) return
  const params = (panel.params ?? {}) as { slotId?: string; hint?: PaneHint }
  const hint = hintOf(slot)
  if (sameHint(params.hint, hint)) return
  panel.api.updateParameters({ ...params, slotId: slot.slotId, hint })
}

/**
 * Loads <home>/layout.json: a v1 file (one dockview) is migrated to v2 (one desk, one frame, the old JSON as that
 * frame's view) and backed up as layout.v1.bak before the first v2 write. Panes the daemon no longer knows are
 * pruned frame by frame; a frame whose JSON is refused still reopens every pane it named (Desk.loadView).
 */
async function restoreLayout(): Promise<void> {
  const result = await (geometry ?? paintGeometry())
  // Pruning is for display only (planRestore): a pane whose slot the daemon does not list right now is not a
  // change the person made, an empty list prunes nothing, and nothing here writes layout.json.
  const { layout, orphaned } = planRestore(result?.layout ?? null, new Set(slots.keys()), id => paneTypes.isSlotless(id))
  if (layout) {
    layoutFile = layout
    // The geometry painted at startup had every pane of the file; only when the daemon does not list some is the
    // desk rebuilt from the pruned JSON (the same loss-proof path: grid refused → frames side by side, frame
    // refused → panes one by one). Nothing is attached yet, so the rebuild loses nothing.
    if (orphaned.length) { desks.load(layout); drawer.load(drawerOf(layout)); sidebars?.load(layout.sidebars, layout.desks) }
    // A v1 file is copied to layout.v1.bak now; layout.json itself stays v1 until the person changes something.
    // A v2 file is copied to layout.v2.bak the same way: an older build reads only v2.
    if (result?.migrated) await window.tether.backupLayout()
    else if (result?.from === 2) await window.tether.backupLayout(2)
  } else {
    layoutFile = emptyLayout()
  }
  // Only what the person does from here on is saved; a slot missing from the daemon's list is not a change of theirs.
  if (orphaned.length) console.warn('painéis sem slot no tetherd, fora da tela até a próxima ação:', orphaned)
  await discardPendingSave()
  workspaceState = readWorkspace(layoutFile.workspace)
  layoutRestored = true
  recomputeProjects()
  // Panes that predate the hint get it now (saved with the next change the person makes).
  for (const panel of allPanels()) { const s = slots.get(panel.id); if (s) updateHint(s) }
  refreshClosedMenu()
}

/**
 * Paints the whole geometry from <home>/layout.json at once — desks, frames, panes, tabs, titles, profile
 * pills — without waiting for the daemon or the fonts: each pane shows its loading stage until its terminal
 * is attached. Pruning (panes the daemon no longer knows) waits for the daemon (restoreLayout).
 */
function paintGeometry(): Promise<ReturnType<typeof migrateLayout>> {
  geometry ??= window.tether.loadLayout().then(raw => {
    const result = migrateLayout(raw)
    if (result && !layoutRestored) { desks.load(result.layout); drawer.load(drawerOf(result.layout)); sidebars?.load(result.layout.sidebars, result.layout.desks) }
    return result
  }, err => { console.error('layout.json ilegível', err); return null })
  return geometry!
}

/**
 * Drops the save scheduled by layout changes the app made on its own (restore, reconnection), not the person.
 * dockview emits onDidLayoutChange from a microtask, so this waits a macrotask before clearing the timer.
 */
async function discardPendingSave(): Promise<void> {
  await new Promise(r => setTimeout(r, 0))
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = undefined }
}

// ---------- connection ----------

async function onConnection(state: ConnectionState): Promise<void> {
  connection = state
  const conn = $('conn')
  renderConnection()
  if (!state.connected) {
    conn.replaceChildren(icon('plugs'))
    conn.className = 'ib conn off'
    $('overlay-msg').textContent = `${state.error} (${state.pipe})`
    $('overlay').hidden = false
    return
  }
  conn.replaceChildren(icon('plugs-connected'))
  conn.className = 'ib conn on'
  $('overlay').hidden = true
  startErrors.clear()
  await refreshSlots()
  if (!layoutRestored) {
    await restoreLayout()
    daemonIsReady = true
    resolveDaemonReady()
    for (const p of panels.values()) p.render()
    for (const t of tabs.values()) t.render()
  } else {
    // Reconnected (the daemon was restarted): hide panels it no longer knows, re-attach the rest. An empty
    // list is not trusted, and hiding is not a change the person made: the saved layout stays as it was.
    for (const id of orphanedPanels(allPanels().map(p => p.id), new Set(slots.keys()), id => paneTypes.isSlotless(id))) {
      const panel = findPanel(id)
      if (panel) removeAnyPanel(panel)
    }
    await discardPendingSave()
    for (const p of panels.values()) { p.render(); void p.reattach() }
    recomputeProjects()
    for (const t of tabs.values()) t.render()
    refreshClosedMenu()
  }
  autoStartPanels()
}

// ---------- closed slots menu ----------

/** The running slot whose "Esquecer" is waiting for the inline confirmation (one at a time). */
let askingForget: string | undefined
/** Slots with a forget in flight (the daemon may wait for a young Claude before killing it). */
const forgetting = new Set<string>()

function closedGroups(): ClosedGroups {
  return groupClosed(slots.values(), id => findPanel(id) !== undefined)
}

function closedButton(cls: string, label: string, iconName?: IconName, title?: string): HTMLButtonElement {
  const b = document.createElement('button')
  b.className = cls
  if (iconName) b.append(icon(iconName))
  if (label) b.append(document.createTextNode(label))
  if (title) b.title = title
  return b
}

function closedGroupTitle(text: string, count: number): HTMLElement {
  const gt = document.createElement('div'); gt.className = 'cl-gt'
  const label = document.createElement('span'); label.textContent = text
  const n = document.createElement('span'); n.className = 'n'; n.textContent = String(count)
  gt.append(label, n)
  return gt
}

function closedRow(s: SlotState, group: 'running' | 'ended'): HTMLElement {
  const row = document.createElement('div')
  row.className = `cl-row ${group}`
  row.dataset.slot = s.slotId
  if (group === 'running' && askingForget === s.slotId) row.classList.add('asking')
  const led = document.createElement('span'); led.className = 'led'
  const kind = document.createElement('span'); kind.className = `kind ${s.kind}`; kind.append(icon(KIND_ICON[s.kind] ?? 'terminal-window'))
  const tx = document.createElement('div'); tx.className = 'tx'
  const title = document.createElement('span'); title.className = 'tt'; title.textContent = panelTitle(s)
  const cwd = document.createElement('span'); cwd.className = 'cw'; cwd.textContent = s.cwd; cwd.title = s.cwd
  tx.append(title, cwd)
  const acts = document.createElement('div'); acts.className = 'acts'
  const open = group === 'running'
    ? closedButton('open primary', 'Abrir', 'arrow-square-out', `Abrir em um painel (${KIND_LABEL[s.kind]} segue rodando)`)
    : closedButton('open', 'Reabrir', 'arrow-clockwise', `Reabrir o painel (${KIND_LABEL[s.kind]}, ${STATUS_LABEL[effectiveStatus(s)]})`)
  open.addEventListener('click', ev => { ev.stopPropagation(); $('closed-list').hidden = true; $('btn-closed').setAttribute('aria-expanded', 'false'); openSlot(s.slotId) })
  const trash = closedButton('ic forget', '', 'trash', group === 'running' ? 'Encerrar e esquecer' : 'Esquecer')
  trash.setAttribute('aria-label', group === 'running' ? 'Encerrar e esquecer o slot' : 'Esquecer o slot')
  trash.addEventListener('click', ev => {
    ev.stopPropagation()
    if (group === 'running') { askingForget = s.slotId; refreshClosedMenu() } // kills a live process: ask first
    else void forgetClosed(s.slotId)
  })
  acts.append(open, trash)
  const cf = document.createElement('div'); cf.className = 'cf'
  const msg = document.createElement('span'); msg.className = 'm'; msg.textContent = 'Encerra o processo. Esquecer?'
  const cancel = closedButton('cancel', 'Cancelar')
  cancel.addEventListener('click', ev => { ev.stopPropagation(); askingForget = undefined; refreshClosedMenu() })
  const yes = closedButton('danger confirm', 'Esquecer')
  yes.disabled = forgetting.has(s.slotId)
  yes.addEventListener('click', ev => { ev.stopPropagation(); void forgetClosed(s.slotId) })
  cf.append(msg, cancel, yes)
  row.append(led, kind, tx, acts, cf)
  return row
}

/** Forgets a slot through the daemon (it kills by identity and waits for a young Claude, as the other forget paths do). */
async function forgetClosed(slotId: string): Promise<void> {
  if (forgetting.has(slotId)) return
  forgetting.add(slotId)
  try {
    await window.tether.request({ t: 'forget', slotId })
  } finally {
    forgetting.delete(slotId)
    if (askingForget === slotId) askingForget = undefined
    refreshClosedMenu()
  }
}

/** "Esquecer todos os encerrados": asked once; only the slots still ended when the answer comes are forgotten. */
async function forgetAllEnded(): Promise<void> {
  const count = closedGroups().ended.length
  if (count === 0 || dialogOpen()) return
  $('closed-list').hidden = true
  $('btn-closed').setAttribute('aria-expanded', 'false')
  const answer = await askDialog(forgetEndedSituation(count))
  if (answer.choice !== 'forget') return
  const ids = closedGroups().ended.map(s => s.slotId)
  await Promise.all(ids.map(id => forgetClosed(id)))
}

function refreshClosedMenu(): void {
  const list = $('closed-list')
  const g = closedGroups()
  if (askingForget && !g.running.some(s => s.slotId === askingForget)) askingForget = undefined
  const badge = badgeParts(g)
  $('closed-count-run').textContent = badge.running
  $('closed-count-end').textContent = badge.ended
  const btn = $('btn-closed')
  btn.title = buttonTitle(g)
  btn.setAttribute('aria-label', buttonTitle(g))
  // Keep the scroll of the ended list across the live re-renders.
  const scroll = list.querySelector('.cl-ended')?.scrollTop ?? 0
  list.replaceChildren()

  const hd = document.createElement('div'); hd.className = 'cl-hd'
  if (g.running.length > 0) {
    const rn = document.createElement('span'); rn.className = 'rn'; rn.textContent = `${g.running.length} rodando`
    hd.append(rn)
    if (g.ended.length > 0) hd.append(document.createTextNode(` · ${g.ended.length} ${g.ended.length === 1 ? 'encerrado' : 'encerrados'}`))
  } else {
    hd.textContent = headerText(g)
  }
  list.append(hd)
  if (g.running.length === 0 && g.ended.length === 0) return

  if (g.running.length > 0) {
    const grp = document.createElement('div'); grp.className = 'cl-run'; grp.dataset.group = 'running'
    grp.append(closedGroupTitle('Rodando sem painel', g.running.length), ...g.running.map(s => closedRow(s, 'running')))
    list.append(grp)
  }
  if (g.ended.length > 0) {
    const grp = document.createElement('div'); grp.className = 'cl-ended'; grp.dataset.group = 'ended'
    grp.append(closedGroupTitle('Encerrados', g.ended.length), ...g.ended.map(s => closedRow(s, 'ended')))
    list.append(grp)
    grp.scrollTop = scroll
    const ft = document.createElement('div'); ft.className = 'cl-ft'
    const all = closedButton('fb forget-all', 'Esquecer todos os encerrados', 'trash')
    all.addEventListener('click', ev => { ev.stopPropagation(); void forgetAllEnded() })
    ft.append(all)
    list.append(ft)
  }
}

/** Opens a panel for a slot the daemon knows; an exited slot is started (an unconfirmed one shows the choice). */
function openSlot(slotId: string): void {
  const s = slots.get(slotId)
  if (!s) return
  // A pane of the drawer opens the drawer; any other brings the user back to the desks (and to the pane's desk).
  const inside = drawer.desk.getPanel(slotId)
  if (inside) {
    setDrawerOpen(true)
    if (effectiveStatus(s) === 'exited') void startSlot(s.slotId)
    inside.api.setActive()
    return
  }
  if (drawer.isOpen) setDrawerOpen(false)
  // A pane of a pad: its desk (for a desk pad) comes forward and the pad opens on its side bar.
  const pad = framePadOf(slotId)
  if (pad) {
    if (pad.deskId && pad.deskId !== desks.activeDeskId) desks.switchTo(pad.deskId)
    sidebars?.open(pad.padId, false)
    if (effectiveStatus(s) === 'exited') void startSlot(s.slotId)
    pad.desk.getPanel(slotId)?.api.setActive()
    setFocusedPad(pad)
    requestAnimationFrame(() => focusPane(slotId))
    return
  }
  setFocusedPad(undefined)
  const deskId = desks.deskOf(slotId)
  if (deskId && deskId !== desks.activeDeskId) desks.switchTo(deskId)
  const panel = desks.getPanel(slotId) ?? addPanel(s)
  if (effectiveStatus(s) === 'exited') void startSlot(s.slotId)
  panel.api.setActive()
}

/**
 * A pane to the front and focused, wherever it lives — any desk, the drawer, a pad (of a desk or global): a slot's pane
 * through openSlot (which also restarts an ended agent), any other the same way: its place opens, its tab is activated.
 */
function revealPane(id: string): void {
  if (slots.has(id)) { openSlot(id); requestAnimationFrame(() => focusPane(id)); return }
  const panel = findPanel(id)
  if (!panel) return
  if (drawer.desk.getPanel(id)) {
    setDrawerOpen(true)
  } else {
    if (drawer.isOpen) setDrawerOpen(false)
    const pad = framePadOf(id)
    if (pad) {
      if (pad.deskId && pad.deskId !== desks.activeDeskId) desks.switchTo(pad.deskId)
      sidebars?.open(pad.padId, false)
      setFocusedPad(pad)
    } else {
      setFocusedPad(undefined)
      const deskId = desks.deskOf(id)
      if (deskId && deskId !== desks.activeDeskId) desks.switchTo(deskId)
    }
  }
  panel.api.setActive()
  requestAnimationFrame(() => focusPane(id))
}

// ---------- tether:// links (app/shared/tether-url.ts) ----------

/** The link of a pane: a note's names its file (it survives closing the note and reopens it), any other pane its id. */
function paneLinkOf(id: string): string {
  const type = liveTypeOf(paneTypes, id)
  const file = type?.linkFileOf?.(id)
  return file ? noteUrl(file) : tabUrl(id)
}

/** "Copiar link do painel": a tether:// link that brings this pane back from anywhere. */
function copyPaneLink(id: string): void {
  window.tether.writeClipboard(paneLinkOf(id))
}

/**
 * A tether:// link was followed (from the OS, or Ctrl+click inside the app): the place it names comes to the front,
 * searched everywhere in the app. A pane closed but still known is offered back; an unknown one is said so. A note's
 * link reveals the note open on that file or opens it.
 */
async function followTetherLink(url: string): Promise<void> {
  const link = parseTetherUrl(url)
  if (!link) return
  if (link.kind === 'note') {
    const root = link.path.replace(/[\\/][^\\/]*$/, '')
    void openFile(fileOpenHost, link.path, { side: false, root })
    return
  }
  if (findPanel(link.id)) { revealPane(link.id); return }
  const slot = slots.get(link.id)
  if (slot) {
    const answer = await askDialog(closedTabSituation(slot.name ?? folderName(slot.cwd)))
    if (answer.choice === 'reopen') revealPane(link.id)
    return
  }
  void askDialog(missingTabSituation())
}

// Links from the OS: the one the app started with (or that came while the window was loading), then each one as it comes.
void daemonReadyPromise.then(async () => {
  window.tether.onTetherLink(url => { void followTetherLink(url) })
  const pending = await window.tether.pendingTetherLink()
  if (pending) void followTetherLink(pending)
})

// ---------- switching a panel's profile ----------

/** Slots with a `set-profile` request in flight (the dialog is not offered twice). */
const pendingSwitches = new Set<string>()

/**
 * "Trocar perfil…": the dialog lists this agent's profiles; "agora" restarts the agent on the same session
 * (the daemon waits for its minimum age and refuses with `unconfirmed` when the session is not known, which
 * gets its own dialog), "na próxima abertura" only rewrites the slot's meta.
 */
async function switchProfile(slotId: string): Promise<void> {
  const slot = slots.get(slotId)
  if (!slot || pendingSwitches.has(slotId) || dialogOpen()) return
  if (profiles.length === 0) await loadProfiles()
  const answer = await askDialog(switchProfileSituation(slot, profiles))
  if (answer.choice === 'cancel' || !answer.option) return
  const profileId = answer.option === NO_PROFILE ? null : answer.option
  const name = profileId ? (profiles.find(p => p.id === profileId)?.name ?? profileId) : 'Sem perfil'
  await sendSetProfile(slot, profileId, name, answer.choice === 'now')
}

async function sendSetProfile(slot: SlotState, profileId: string | null, name: string, restart: boolean): Promise<void> {
  const { slotId } = slot
  pendingSwitches.add(slotId)
  try {
    const reply = await window.tether.request({ t: 'set-profile', slotId, profileId, restart })
    if (reply.t === 'ok') { if (reply.slot) applyState(reply.slot); return }
    const current = slots.get(slotId) ?? slot
    if (reply.code === 'unconfirmed') {
      const next = await askDialog(switchProfileUnconfirmedSituation(current, name))
      if (next.choice === 'next') await sendSetProfile(current, profileId, name, false)
      return
    }
    // The restart itself failed after the switch (session gone, already open…): the panel overlay shows that state.
    if (restart && current.status === 'error') return
    await askDialog(switchProfileFailedSituation(current, reply.message))
  } finally {
    pendingSwitches.delete(slotId)
  }
}

// ---------- tab context menu ----------

interface MenuItem { icon: IconName; label: string; run(): void; danger?: boolean; attention?: boolean; disabled?: boolean; checked?: boolean }
/** A thin line between groups of items. */
const SEP = 'sep' as const
/** A line naming what the items under it act on (a pad's title over its items); not an item. */
interface MenuHeading { heading: string }
type MenuEntry = MenuItem | MenuHeading | typeof SEP

/**
 * The pad whose items the next context menu appends (its title, then close, move…): set by the "⋯" of a frame inside a
 * pad that absorbs its header, around the pane menu it opens, whichever pane type draws that menu.
 */
let padSection: string | undefined

/** The button that opens the next context menu when the opener cannot be passed (the "⋯" goes through showTabMenu). */
let menuOpener: HTMLElement | undefined

/**
 * A floating menu at (x, y), closed by a click anywhere else, Esc, or picking an item. `opener` is the button that
 * opened it: it reads aria-expanded while the menu is up, and Esc (or a pick that leaves nothing focused) gives the
 * focus back to it. Keys: Up/Down (wrapping), Home/End, Enter/Space, Esc, Tab (closes).
 */
function showContextMenu(x: number, y: number, items: MenuEntry[], explicitOpener?: HTMLElement): void {
  const opener = explicitOpener ?? menuOpener
  menuOpener = undefined
  const active = document.activeElement
  const owner = opener ?? (active instanceof HTMLElement && active !== document.body ? active : undefined)
  document.getElementById('ctx-menu')?.remove()
  const menu = document.createElement('ul')
  menu.id = 'ctx-menu'; menu.className = 'menu'; menu.setAttribute('role', 'menu')
  opener?.setAttribute('aria-expanded', 'true')
  const close = (refocus: boolean): void => {
    menu.remove(); document.removeEventListener('click', onDoc, true); document.removeEventListener('keydown', onKey, true)
    opener?.setAttribute('aria-expanded', 'false')
    if (refocus && owner?.isConnected) owner.focus()
  }
  const onDoc = (ev: Event): void => { if (!menu.contains(ev.target as Node)) close(false) }
  const onKey = (ev: KeyboardEvent): void => {
    const lis = [...menu.querySelectorAll<HTMLElement>('li[role^=menuitem]')]
    const i = lis.indexOf(document.activeElement as HTMLElement)
    if (ev.key === 'Escape') { ev.preventDefault(); close(true) }
    else if (ev.key === 'Tab') { ev.preventDefault(); close(true) }
    else if (ev.key === 'ArrowDown') { ev.preventDefault(); lis[(i + 1) % lis.length]?.focus() }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); lis[(i - 1 + lis.length) % lis.length]?.focus() }
    else if (ev.key === 'Home') { ev.preventDefault(); lis[0]?.focus() }
    else if (ev.key === 'End') { ev.preventDefault(); lis[lis.length - 1]?.focus() }
    else if ((ev.key === 'Enter' || ev.key === ' ') && i >= 0) { ev.preventDefault(); lis[i]!.click() }
  }
  if (padSection) { const id = padSection; padSection = undefined; items = [...items, SEP, ...padMenuEntries(id)] }
  for (const item of items) {
    if (item === SEP) { const sep = document.createElement('li'); sep.className = 'sep'; sep.setAttribute('role', 'separator'); menu.append(sep); continue }
    if ('heading' in item) { const hd = document.createElement('li'); hd.className = 'hd'; hd.setAttribute('role', 'presentation'); hd.textContent = item.heading; menu.append(hd); continue }
    const li = document.createElement('li'); li.setAttribute('role', item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'); li.tabIndex = -1
    if (item.checked !== undefined) li.setAttribute('aria-checked', String(item.checked))
    if (item.danger) li.classList.add('danger')
    if (item.disabled) li.setAttribute('aria-disabled', 'true')
    li.append(icon(item.icon), document.createTextNode(item.label))
    if (item.checked) li.append(icon('check', 'ctx-check'))
    if (item.attention) { const dot = document.createElement('span'); dot.className = 'attn-dot'; dot.setAttribute('aria-label', 'pede atenção'); li.append(dot) }
    li.addEventListener('click', ev => {
      ev.stopPropagation()
      if (item.disabled) return
      close(false); item.run()
      // The item left nothing focused (it did not open a dialog or move to a pane): back to the opener.
      if (document.activeElement === document.body && owner?.isConnected) owner.focus()
    })
    menu.append(li)
  }
  document.body.append(menu)
  // Keep it on screen: measure, then clamp to the window.
  const r = menu.getBoundingClientRect()
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`
  document.addEventListener('click', onDoc, true)
  document.addEventListener('keydown', onKey, true)
  menu.querySelector<HTMLElement>('li[role^=menuitem]')?.focus()
}

/**
 * The pane menu: right-click on a tab and the "⋯" at the tab strip's right end (one source). Grouped: open
 * next to it, name and profile, the status bar and its folder entries, where it lives, close.
 */
function showTabMenu(slotId: string, x: number, y: number): void {
  const slot = slots.get(slotId)
  const panel = findPanel(slotId)
  if (!slot) {
    if (empties.has(slotId)) { panel?.api.setActive(); showEmptyMenu(slotId, x, y); return }
    // Any other kind of pane shows its type's own menu (an extension's: the note, the previews, a placeholder).
    const type = liveTypeOf(paneTypes, slotId)
    if (!type?.tabMenu) return
    panel?.api.setActive()
    type.tabMenu(slotId, x, y)
    return
  }
  panel?.api.setActive()
  showContextMenu(x, y, [
    { icon: 'plus', label: NEW_PANEL_LABEL, run: () => { void openNewDialog({ reference: slotId }) } },
    { icon: 'copy', label: `${DUPLICATE_LABEL} ${PLACEMENT_LABEL.right}`, run: () => { void duplicatePanel(slotId, { level: 'pane', placement: 'right' }) } },
    { icon: 'copy', label: `${DUPLICATE_LABEL} ${PLACEMENT_LABEL.below}`, run: () => { void duplicatePanel(slotId, { level: 'pane', placement: 'below' }) } },
    { icon: 'square-half', label: 'Novo painel na borda do quadro…', run: () => { void openNewDialog({ reference: slotId, target: { level: 'frame', placement: 'right' } }) } },
    { icon: 'columns', label: `${NEW_FRAME_LABEL}…`, run: () => { void openNewDialog({ reference: slotId, target: { level: 'desk', placement: 'right' } }) } },
    SEP,
    { icon: 'pencil-simple', label: 'Renomear…', run: () => tabs.get(slotId)?.startRename() },
    { icon: 'sliders-horizontal', label: 'Trocar perfil…', run: () => { void switchProfile(slotId) } },
    SEP,
    { icon: 'rows', label: detailsLabel(detailsOpen(panel?.params)), run: () => togglePaneDetails(slotId) },
    { icon: 'link', label: 'Copiar link do painel', run: () => copyPaneLink(slotId) },
    { icon: 'copy', label: 'Copiar pasta', run: () => copyFolder(slotId) },
    { icon: 'folder-open', label: 'Abrir pasta no Explorer', run: () => openFolder(slotId) },
    SEP,
    { icon: 'arrow-square-out', label: 'Mover…', run: () => { void openMove(slotId) } },
    SEP,
    { icon: 'x', label: 'Fechar painel…', run: () => { void closePanel(slotId) } },
  ])
}

/** The empty pane's tab menu: new things next to it, where it lives, close. */
function showEmptyMenu(id: string, x: number, y: number): void {
  showContextMenu(x, y, [
    { icon: 'plus', label: NEW_PANEL_LABEL, run: () => { void openNewDialog({ reference: id }) } },
    { icon: 'plus', label: `${SPLIT_EMPTY_LABEL} ${PLACEMENT_LABEL.right} ${EMPTY_SUFFIX}`, run: () => { void splitEmpty({ level: 'pane', placement: 'right' }, 'layout', id) } },
    { icon: 'plus', label: `${SPLIT_EMPTY_LABEL} ${PLACEMENT_LABEL.below} ${EMPTY_SUFFIX}`, run: () => { void splitEmpty({ level: 'pane', placement: 'below' }, 'layout', id) } },
    SEP,
    { icon: 'arrow-square-out', label: 'Mover…', run: () => { void openMove(id) } },
    SEP,
    { icon: 'x', label: 'Fechar', run: () => { const p = findPanel(id); if (p) removeAnyPanel(p) } },
  ])
}

// ---------- empty panes (F5) ----------
// An empty pane is a reserved place with the chooser inside (app/renderer/empty-panel.ts). It is born beside a
// pane (the chord, the palette), at a frame's or the desk's edge (the palette, the chooser's "Vazio"), or in a new
// desk; it lives in layout.json like any pane and comes back after a restart. Picking something in it replaces it
// in the same group and at the same index.

/** An empty pane relative to `reference` (the active pane when absent), suggesting that pane's folder. `add`: born from a "+" (Esc closes it). */
function addEmptyPanel(target?: Target, reference?: string, cwd = paneCwdOf(reference), origin: EmptyOrigin = 'layout'): IDockviewPanel {
  const panel = addPaneOptions(emptyPanelOptions(cwd, origin), target, reference)
  scheduleSave()
  requestAnimationFrame(() => focusPane(panel.id))
  return panel
}

/** The "+" of a group's tab strip: an empty pane as a new tab beside `reference`, a request in progress (origin `add`). */
function newTabBeside(reference: string): IDockviewPanel {
  return addEmptyPanel({ level: 'pane', placement: 'within' }, reference, paneCwdOf(reference), 'add')
}

/** Ctrl+Shift+T: a new empty tab in the active group; with no pane at all, simply the first pane (still a request: Esc closes it). */
function newTab(): void {
  const reference = currentDesk().activePanel?.id
  if (reference && findPanel(reference)) newTabBeside(reference)
  else addEmptyPanel(undefined, undefined, undefined, 'add')
}

/** The keyboard/palette/menu form: an empty pane relative to the active pane (with none, simply the first). `add` from the chord (a request), `layout` otherwise. */
function splitEmpty(target: Target, origin: EmptyOrigin = 'layout', reference = currentDesk().activePanel?.id): void {
  const stillThere = reference && findPanel(reference) ? reference : undefined
  addEmptyPanel(stillThere ? target : undefined, stillThere, paneCwdOf(stillThere), origin)
}

/** "Nova mesa vazia": a desk after the current one with one empty pane (the active pane's folder suggested). */
function newEmptyDesk(): void {
  if (drawer.isOpen) return
  const cwd = paneCwdOf(currentDesk().activePanel?.id)
  desks.create('after')
  addEmptyPanel(undefined, undefined, cwd)
}

/**
 * Resolves what the person picked in a chooser into the pane to add: a slot created by the daemon, an empty pane, or
 * what an extension's item resolves into (a note file prepared or picked). `undefined` when nothing is to be added (a file dialog cancelled, a note
 * already open and now focused); `{ error }` with the message to show in the chooser.
 */
async function resolveChoice(choice: Choice, cwd: string): Promise<{ options: AddPanelOptions; after?: () => Promise<void> } | { error: string } | undefined> {
  if (choice.profile) {
    const reply = await window.tether.request({ t: 'create', kind: choice.profile.agent, cwd, start: true, profileId: choice.profile.id })
    if (reply.t === 'error' || !reply.slot) return { error: reply.t === 'error' ? reply.message : 'o daemon não devolveu o slot' }
    await window.tether.rememberFolder(cwd)
    noteRecentProfile(choice.profile.id)
    slots.set(reply.slot.slotId, reply.slot)
    return { options: slotPanelOptions(reply.slot) }
  }
  if (choice.kind === 'empty') {
    if (cwd) await window.tether.rememberFolder(cwd)
    return { options: emptyPanelOptions(cwd || undefined) }
  }
  // An item an extension contributes (the note's "Nova nota", "Abrir nota…"): its own resolver.
  const resolve = chooserResolvers.get(choice.kind)
  if (!resolve) return { error: 'Este item vem de uma extensão que não está ligada.' }
  const r = await resolve(cwd)
  if (r && !('error' in r) && cwd) await window.tether.rememberFolder(cwd)
  return r
}

/** What every chooser (inside a pane, in the popup) needs from the renderer. */
const chooserHost: ChooserHost = {
  profiles: () => profiles,
  recentProfiles: () => recentProfiles,
  recentFolders: () => window.tether.recentFolders(),
  pickFolder: initial => window.tether.pickFolder(initial),
  openProfiles: id => openProfiles(id),
}

/** What the empty panes need from the renderer. */
const emptyHost: EmptyHost = {
  ...chooserHost,
  fill: async (panel, choice, cwd) => {
    const r = await resolveChoice(choice, cwd)
    if (!r) return undefined
    if ('error' in r) return r.error
    const old = findPanel(panel.id)
    // The pane went away while the daemon answered: what was chosen still opens, where the person is.
    const replaced = old ? (inDrawer(panel.id) ? drawer.desk : desks).replacePanel(panel.id, r.options) : undefined
    const added = replaced ?? addPaneOptions(r.options)
    added.api.setActive()
    scheduleSave()
    requestAnimationFrame(() => focusPane(added.id))
    if (r.after) { await r.after(); focusPane(added.id) }
    return undefined
  },
  cancel: (panel, origin) => {
    const p = findPanel(panel.id)
    if (!p) return
    if (origin === 'add') {
      // A request in progress is withdrawn: the pane goes, the keyboard lands on what the group shows next.
      removeAnyPanel(p)
      requestAnimationFrame(() => { const a = currentDesk().activePanel; if (a) focusPane(a.id) })
      return
    }
    // Laid out on purpose: the pane stays; the keyboard goes back to the pane that had it before.
    const back = activeHistory.find(id => id !== panel.id && findPanel(id))
    if (back) { findPanel(back)?.api.setActive(); focusPane(back) }
    else (document.activeElement as HTMLElement | null)?.blur()
  },
  expand: (panel, state) => { void openNewDialog({ context: { panel, state } }) },
  onCwdChange: panel => {
    const p = findPanel(panel.id)
    if (!p) return
    p.api.updateParameters(withEmpty(panel.cwd || undefined, panel.origin))
    scheduleSave()
  },
  onTabMenu: (id, ev) => showTabMenu(id, ev.clientX, ev.clientY),
  onClose: id => { const p = findPanel(id); if (p) removeAnyPanel(p) },
}

/**
 * What following a link means, for every surface (app/renderer/link-open.ts): http(s) goes to the browser, a folder opens
 * in the Explorer, a file opens the way Ctrl+P opens it — from a terminal in the clicked pane's tab group (from a pad's
 * terminal in the Foco de Mesa), at the line and column the link names.
 */
function followLink(target: LinkTarget, origin: LinkOrigin): void {
  if (target.kind === 'external') { window.tether.openExternal(target.url); return }
  if (target.kind === 'tether') { void followTetherLink(target.url); return }
  if (target.kind !== 'file') return
  if (target.isDirectory) {
    void window.tether.openPath(target.path).then(r => { if (!r.ok) void askDialog(fileOpenFailedSituation(r.message)) })
    return
  }
  const slotId = origin.slotId
  const reference = slotId && !framePadOf(slotId) ? slotId : undefined
  const root = (slotId ? paneCwdOf(slotId) : undefined) ?? origin.baseDir ?? ''
  void openFile(fileOpenHost, target.path, { side: false, root, ...(reference ? { reference } : {}), ...(target.position ? { position: target.position } : {}) })
}
setLinkHandler(followLink)
installMonacoLinks()

// ---------- opening a file ----------
// Ctrl+P (the quick-open extension), a terminal link and the extensions' "abrir o arquivo-fonte" open a file through the
// openers extensions register (TetherUi.openers; the note's: an .html as its preview, any other text file as a note).
const fileOpeners: FileOpener[] = []
const openedListeners = new Set<(path: string) => void>()
/** Who follows a rename made by an extension (a note whose file moved). */
const renameListeners = new Set<(e: { from: string; to: string }) => void>()

function openWithOpeners(path: string, opts: OpenFileOptions): void {
  const opener = fileOpeners.find(o => o.canOpen(path, opts))
  if (opener) {
    const reference = opts.reference ?? fileTargetDesk().activePanel?.id
    openingFile = true
    try { opener.open(path, { ...opts, ...(reference ? { reference } : {}) }) } finally { openingFile = false }
    return
  }
  void askDialog(fileOpenFailedSituation(`Nenhuma extensão ligada abre este arquivo: ${path}. A extensão Nota abre arquivos de texto; veja em Extensões.`))
}

const fileOpenHost = {
  openText: openWithOpeners,
  notify: (message: string) => { void askDialog(fileOpenFailedSituation(message)) },
  opened: (path: string) => { for (const l of openedListeners) l(path) },
}

/** What the box shows for text without `>`: the quick-open extension's mode, when it is on. */
let paletteMode: PaletteModeProvider | undefined

/** Closes a pane with no slot behind it (a note, a preview, a screen): remembered for "reabrir", then removed. */
function closeSlotless(id: string): void {
  const panel = findPanel(id)
  rememberClosed(id)
  if (panel) removeAnyPanel(panel)
}


// ---------- reopen the last closed pane (Ctrl+Shift+T) ----------
// What closing leaves behind, newest last: a slot (it stays in the tetherd, "Rodando sem painel" / "Encerrados", and
// reopening RESUMES it, as the closed-slots menu does) or what another pane type keeps (a note's file). Reopening takes
// the newest that still makes sense (the slot still exists and has no pane; the note is not open).
// Each pane type says what it leaves (PaneType.closedEntry).
const closedPanes: ClosedEntry[] = []

function rememberClosed(id: string): void {
  const entry = liveTypeOf(paneTypes, id)?.closedEntry?.(id)
  if (!entry) return
  const i = closedPanes.findIndex(c => c.key === entry.key)
  if (i !== -1) closedPanes.splice(i, 1)
  closedPanes.push(entry)
  if (closedPanes.length > 50) closedPanes.shift()
}

function reopenClosed(): void {
  while (closedPanes.length) if (closedPanes.pop()!.reopen()) return
}

// ---------- profiles ----------

/** The slot's profile for a new slot that should launch the same way; nothing when the profile is gone. */
function profileOf(slot: SlotState): { profileId?: string } {
  return slot.profileId && profiles.some(p => p.id === slot.profileId) ? { profileId: slot.profileId } : {}
}

function setProfiles(list: Profile[], problem: string | undefined): void {
  profiles = list
  profilesProblem = problem
  if (manager.open) manager.refresh()
  popupChooser?.render()
  for (const e of empties.values()) e.renderProfiles()
}

async function loadProfiles(): Promise<void> {
  const r = await window.tether.listProfiles()
  setProfiles(r.profiles, r.problem)
}

function openProfiles(id?: string): void {
  const dlg = $<HTMLDialogElement>('dlg-new')
  if (dlg.open) dlg.close()
  manager.show(id)
}

// ---------- "Novo painel…" in focus mode: the chooser in a popup ----------

/**
 * `reference`: the pane the "Onde" row is relative to (the active one when absent); `target`: what the row starts
 * on (a tab in the reference's group by default). Without any pane there is nothing to be relative to: no row, and
 * the new pane is simply the first. `context`: opened from an empty pane's ⤢; the popup shows the pane as a chip,
 * has no "Onde" (the pane IS the place), and hands the pick, or the state on cancel, back to that pane.
 */
interface NewPanelOptions { kind?: SlotKind; profileId?: string; cwd?: string; reference?: string; target?: Target; context?: { panel: EmptyPanel; state: ChooserState } }

let popupChooser: Chooser | undefined
let popupCancel: (() => void) | undefined

/** The reference as its tab reads: the slot's title, a note's file name, "Vazio"; never an internal id. */
function paneDisplayName(id: string): string {
  const slot = slots.get(id)
  return slot ? panelTitle(slot) : findPanel(id)?.api.title ?? id
}

function closeNewDialog(): void {
  const dlg = $<HTMLDialogElement>('dlg-new')
  if (dlg.open) dlg.close()
  popupChooser?.dispose()
  popupChooser = undefined
  popupCancel = undefined
}

async function openNewDialog(opts: NewPanelOptions = {}): Promise<void> {
  const dlg = $<HTMLDialogElement>('dlg-new')
  if (profiles.length === 0) await loadProfiles()
  popupChooser?.dispose()
  const ctx = opts.context
  const chip = $('new-context')
  chip.hidden = !ctx
  if (ctx) {
    const ctxPad = framePadOf(ctx.panel.id)
    const where = inDrawer(ctx.panel.id) ? 'Gaveta' : ctxPad ? padRegistry.get(ctxPad.padId)?.title ?? 'Prancheta' : deskName(desks.deskOf(ctx.panel.id) ?? desks.activeDeskId)
    $('new-context-name').textContent = ctx.state.folder ? `${where} · ${folderName(ctx.state.folder)}` : where
  }
  // The reference is fixed when the popup opens: the active pane may change underneath (a slot exits) but the
  // person chose "where" looking at this one.
  const reference = ctx ? undefined : opts.reference && findPanel(opts.reference) ? opts.reference : currentDesk().activePanel?.id
  const wanted = opts.profileId ? profiles.find(p => p.id === opts.profileId) : undefined
  const recent = await window.tether.recentFolders()
  const folder = ctx ? ctx.state.folder : opts.cwd ?? paneCwdOf(reference) ?? recent[0] ?? ''
  const chooser = new Chooser(chooserHost, {
    mode: 'popup',
    origin: 'add',
    folder,
    ...(!ctx && reference ? { where: { refName: paneDisplayName(reference), initial: opts.target ?? { level: 'pane', placement: 'within' } } } : {}),
    offerEmpty: !ctx,
    state: ctx ? ctx.state : { ...(wanted ? { highlight: wanted.id } : {}), touched: !!opts.cwd },
    onOpen: async (choice, cwd, where) => {
      if (ctx) {
        const error = await emptyHost.fill(ctx.panel, choice, cwd)
        if (error) return error
        closeNewDialog()
        return undefined
      }
      const r = await resolveChoice(choice, cwd)
      if (!r) return undefined // a file dialog cancelled (the chooser stays), or a note already open (now focused)
      if ('error' in r) return r.error
      closeNewDialog()
      const stillThere = reference && findPanel(reference) ? reference : undefined
      const added = addPaneOptions(r.options, stillThere ? where : undefined, stillThere)
      scheduleSave()
      requestAnimationFrame(() => focusPane(added.id))
      if (r.after) { await r.after(); focusPane(added.id) }
      return undefined
    },
    onCancel: () => {
      const state = popupChooser?.snapshot()
      closeNewDialog()
      // Back to the pane's own chooser, where it was.
      if (ctx && state && findPanel(ctx.panel.id)) { ctx.panel.setState({ query: state.query, highlight: state.highlight, folder: state.folder, touched: state.touched }); findPanel(ctx.panel.id)?.api.setActive(); ctx.panel.focus() }
    },
  })
  popupChooser = chooser
  popupCancel = () => chooser.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  $('new-chooser').replaceChildren(chooser.element)
  if (!dlg.open) dlg.showModal()
  chooser.focus()
}

// ---------- "Duplicar painel" ----------

/**
 * A new panel launched like `slotId` (agent, profile, folder), placed beside it. It is a new session: the
 * daemon's `create` carries no binding, so Claude/soul start a fresh conversation in the same folder with
 * the same profile. When the daemon refuses (folder gone, profile gone…), the chooser opens prefilled in
 * the same place so the user can still get a panel there.
 */
async function duplicatePanel(slotId: string, target: Target): Promise<void> {
  const slot = slots.get(slotId)
  if (!slot || !findPanel(slotId)) return
  const reply = await window.tether.request(duplicateRequest(slot, profiles))
  if (reply.t === 'error' || !reply.slot) {
    void openNewDialog({ kind: slot.kind, profileId: slot.profileId, cwd: slot.cwd, reference: slotId, target })
    return
  }
  if (!findPanel(slotId)) { addPanel(reply.slot).api.setActive(); return } // the source went away meanwhile
  addPanel(reply.slot, target, slotId).api.setActive()
}

/** The keyboard/toolbar form: duplicates the focused panel; with no panel there is nothing to duplicate, so the chooser opens. */
async function duplicateActive(target: Target): Promise<void> {
  const active = currentDesk().activePanel
  if (!active || !slots.has(active.id)) { void openNewDialog({ target }); return }
  await duplicatePanel(active.id, target)
}

// ---------- builder mode ----------

/**
 * The builder mode (builder-mode.ts) for the window: the toolbar button shows it (aria-pressed). Entering takes the
 * keyboard out of a pane (the content is inert: keys must not reach a terminal behind the dim). The mode belongs to the
 * window, not to a desk: a desk switch, the drawer or a pad keeps it on, so several places can be built in one go.
 */
function setupBuilder(): void {
  const btn = $('btn-builder')
  btn.addEventListener('click', () => commandHost.toggleBuilder())
  onBuilderChange(on => {
    btn.setAttribute('aria-pressed', String(on))
    const active = document.activeElement
    if (on && active instanceof HTMLElement && active.closest('.frame')) active.blur()
  })
  installBuilderGuard({ onFrameDoubleClick: frame => leaveBuilderInto(frame) })
}

/** Leaves the builder mode; the keyboard goes back to the current place's active pane. */
function leaveBuilder(): void {
  if (!isBuilder()) return
  setBuilder(false)
  const id = currentDesk().activePanel?.id
  if (id) requestAnimationFrame(() => focusPane(id))
}

/** A double click on a frame in the builder mode: leaves it with that frame in focus (its active pane takes the keyboard). */
function leaveBuilderInto(frame: HTMLElement): void {
  const places = [...desks.desks.map(d => desks.desk(d.id)), drawer.desk, ...[...framePads].map(p => p.desk)]
  for (const desk of places) {
    const frameId = desk?.frameIdAt(frame)
    if (!desk || !frameId) continue
    const pad = [...framePads].find(p => p.desk === desk)
    if (pad) setFocusedPad(pad)
    else if (desk !== drawer.desk) setFocusedPad(undefined)
    desk.focusFrame(frameId)
    setBuilder(false)
    const id = desk.frames.get(frameId)?.dock.activePanel?.id
    if (id) requestAnimationFrame(() => focusPane(id))
    return
  }
  leaveBuilder()
}

/** Esc for the builder mode, once nothing above it (a dialog, a menu, a popup) wants the key. True when it left the mode. */
function builderEscape(): boolean {
  if (!isBuilder() || escBlocked()) return false
  leaveBuilder()
  return true
}

/**
 * A "+" at a border (builder mode): the frame's active pane (or the desk's) is the reference. A click ADDS an empty pane there
 * (the chooser inside it, the reference's folder suggested; Esc closes it). The right-click menu: the same, duplicate
 * the reference there (the one place that still clones without asking, and the name says so), the chooser in focus mode.
 */
function onEdge(target: Target, op: 'add' | 'menu', frameId: string | undefined, at: { x: number; y: number }, scope: Desk = currentDesk()): void {
  const reference = (frameId ? scope.frames.get(frameId)?.dock.activePanel?.id : undefined) ?? scope.activePanel?.id
  const add = (): void => {
    // A pad's frames with no pane left: the new pane goes into them, not where the user was.
    if (!reference && scope !== currentDesk() && [...framePads].some(p => p.desk === scope)) {
      const panel = scope.addPanel(emptyPanelOptions(paneCwdOf(currentDesk().activePanel?.id), 'add'), target)
      panel.api.setActive(); scheduleSave(); requestAnimationFrame(() => focusPane(panel.id))
      return
    }
    addEmptyPanel(target, reference, paneCwdOf(reference), 'add')
  }
  if (op === 'add') { add(); return }
  const slot = reference ? slots.get(reference) : undefined
  const items: MenuEntry[] = [{ icon: 'plus', label: target.level === 'desk' ? 'Novo quadro aqui' : 'Novo painel aqui', run: add }]
  if (slot && reference) items.push({ icon: 'copy', label: `Duplicar ${panelTitle(slot)} aqui`, run: () => { void duplicatePanel(reference, target) } })
  items.push(SEP, { icon: 'arrows-out-simple', label: `${NEW_PANEL_LABEL} (modo foco)`, run: () => { void openNewDialog({ reference, target }) } })
  showContextMenu(at.x, at.y, items)
}

// ---------- in-app menu ----------
// The native menu bar is hidden (autoHideMenuBar) and Alt does not reach it from a terminal: the same commands
// live behind the toolbar's menu button. Theme and "voltar a perguntar" talk to main; quit-all asks through onAsk.

/** What the app's commands do (app/renderer/app-commands.ts declares them over this host). */
const commandHost: CommandHost = {
  newPanel: opts => { void openNewDialog(opts) },
  newTab: () => newTab(),
  duplicateActive: target => { void duplicateActive(target) },
  splitEmpty: (target, origin) => splitEmpty(target, origin),
  newEmptyDesk: () => newEmptyDesk(),
  activePane: () => { const a = currentDesk().activePanel; return a && (slots.has(a.id) || liveTypeOf(paneTypes, a.id)) ? a.id : undefined },
  renamePane: id => { const type = liveTypeOf(paneTypes, id); if (type?.rename) type.rename(id); else tabs.get(id)?.startRename() },
  switchProfile: id => { if (slots.has(id)) void switchProfile(id) },
  toggleDetails: id => { if (slots.has(id)) togglePaneDetails(id) },
  copyLink: id => copyPaneLink(id),
  copyFolder: id => { const f = liveTypeOf(paneTypes, id)?.folderOf?.(id); if (f) window.tether.writeClipboard(f); else if (slots.has(id)) copyFolder(id) },
  openFolder: id => { const f = liveTypeOf(paneTypes, id)?.folderOf?.(id); if (f) void window.tether.openPath(f); else if (slots.has(id)) openFolder(id) },
  movePane: id => { void openMove(id) },
  closePane: id => { void closePanel(id) },
  createDesk: side => { desks.create(side) },
  cycleDesk: step => desks.switchTo(cycleDesk(desks.desks, desks.activeDeskId, step)),
  moveActiveDesk: where => {
    const last = desks.desks.length - 1
    const at = desks.desks.findIndex(d => d.id === desks.activeDeskId)
    if (at < 0) return
    const to = where === 'left' ? at - 1 : where === 'right' ? at + 1 : where === 'first' ? 0 : last
    if (to !== at && to >= 0 && to <= last) desks.move(desks.activeDeskId, to)
  },
  goToDesk: position => { const id = deskAt(desks.desks, position); if (id) desks.switchTo(id) },
  toggleBuilder: () => { if (isBuilder()) leaveBuilder(); else setBuilder(true) },
  deskActions: () => { const r = document.querySelector('#desk-switch .seg.on')?.getBoundingClientRect(); showDeskMenu(desks.activeDeskId, r?.left ?? 200, (r?.bottom ?? 40) + 4) },
  closeDesk: () => { void closeDesk(desks.activeDeskId) },
  toggleDrawer: () => setDrawerOpen(!drawer.isOpen),
  quickShell: () => { void quickShell() },
  setTheme: setting => window.tether.setTheme(normalizeTheme(setting)),
  toggleDeskLine: () => window.tether.setUi({ ...ui, deskLine: !ui.deskLine }),
  toggleTabBorder: () => window.tether.setUi({ ...ui, tabBorder: !ui.tabBorder }),
  toggleDimUnfocused: () => window.tether.setUi({ ...ui, dimUnfocused: !ui.dimUnfocused }),
  setDimLevel: level => window.tether.setUi({ ...ui, dimUnfocused: true, dimLevel: level }),
  openTerminalTheme: () => themeDialog.show(),
  fontSize: command => runFontSizeCommand(command),
  openProfiles: () => openProfiles(),
  restoreConfirmations: () => window.tether.command('restore-confirmations'),
  closeWindow: () => window.tether.closeWindow(),
  quitAll: () => window.tether.command('quit-all'),
  restartDaemon: () => window.tether.command('restart-daemon'),
  reloadAll: () => window.tether.command('reload-all'),
  relaunchApp: () => window.tether.command('relaunch-app'),
  toggleDevTools: () => window.tether.command('toggle-devtools'),
  toggleFullscreen: () => window.tether.command('toggle-fullscreen'),
  showPalette: (mode, query) => palette.show(mode, query),
  reopenClosed: () => reopenClosed(),
  cycleTab: step => {
    const active = currentDesk().activePanel
    if (!active) return
    const list = active.group.panels
    const next = list[(list.indexOf(active) + step + list.length) % list.length]
    if (next && next !== active) { next.api.setActive(); requestAnimationFrame(() => focusPane(next.id)) }
  },
  goToTab: position => {
    const active = currentDesk().activePanel
    if (!active) return
    const list = active.group.panels
    const next = position === 'last' ? list[list.length - 1] : list[position - 1]
    if (next && next !== active) { next.api.setActive(); requestAnimationFrame(() => focusPane(next.id)) }
  },
  focusNeighbour: direction => focusNeighbour(direction),
  closeFrameTabs: () => {
    const active = currentDesk().activePanel
    if (!active) return
    void (async () => { for (const p of [...active.group.panels]) await closePanel(p.id) })()
  },
  showExtensions: () => openExtensions(),
  toggleSideBar: side => sidebars?.toggleSide(side),
  moveCurrentPad: () => { const id = sidebars?.current(); if (id) sidebars!.move(id) },
  restoreCurrentPad: () => { const id = sidebars?.current(); if (id) sidebars!.restore(id) },
}

/** Something modal of ours is up: app chords stay quiet (the palette has its own keys). */
function modalOpen(): boolean {
  return $<HTMLDialogElement>('dlg-new').open || manager.open || themeDialog.open || dialogOpen() || palette.open
}

/** Ctrl+K Ctrl+arrows: the visible pane whose box is next to the active one's in that direction (across frames; the drawer when it is open). */
function focusNeighbour(direction: Direction): void {
  const desk = currentDesk()
  const active = desk.activePanel
  if (!active) return
  // Across the desk and the pads on screen (the drawer alone while it is open): the boxes decide who is next.
  const pool = drawer.isOpen ? drawer.desk.panels : [...desks.active.panels, ...[...framePads].filter(p => p.isVisible).flatMap(p => p.desk.panels)]
  const rectOf = (p: IDockviewPanel): DOMRect => p.group.element.getBoundingClientRect()
  const a = rectOf(active)
  const ax = a.left + a.width / 2, ay = a.top + a.height / 2
  let best: { panel: IDockviewPanel; score: number } | undefined
  for (const p of pool) {
    if (p.group === active.group || p.group.activePanel !== p) continue
    const r = rectOf(p)
    if (r.width === 0 || r.height === 0) continue
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2
    const primary = direction === 'right' ? cx - ax : direction === 'left' ? ax - cx : direction === 'below' ? cy - ay : ay - cy
    if (primary <= 1) continue
    const secondary = direction === 'right' || direction === 'left' ? Math.abs(cy - ay) : Math.abs(cx - ax)
    const score = primary + secondary * 0.3
    if (!best || score < best.score) best = { panel: p, score }
  }
  if (!best) return
  best.panel.api.setActive()
  requestAnimationFrame(() => focusPane(best!.panel.id))
}

// ---------- keyboard shortcuts: the table, the file, the screen (F5, delivery 5) ----------
// The table in force is shortcuts.ts' defaults with <TETHER_HOME>/keybindings.json laid over (keybindings-rules.ts). Main
// hands the text over at start and on every change on disk; the screen writes the smallest file for what it changed
// and applies the table at once (the watcher's echo re-reads the same thing).

let keybindingsFile: KeybindingsFileInfo = { path: '', warnings: [] }
const keybindingsFileListeners = new Set<() => void>()

function applyKeybindingsFile(state: KeybindingsFileState): void {
  const file: typeof keybindingsFile = { path: state.path, warnings: [] }
  let entries: ReturnType<typeof parseKeybindingsFile> extends infer R ? (R extends { ok: true; entries: infer E } ? E : never) : never = []
  if (state.text !== null) {
    const parsed = parseKeybindingsFile(state.text)
    if (!parsed.ok) file.error = { message: parsed.message, ...(parsed.line ? { line: parsed.line } : {}) }
    else { entries = parsed.entries; file.warnings.push(...parsed.warnings) }
  }
  const known = new Set(commands.all().map(c => c.id))
  const merged = mergeKeybindings(entries, known)
  file.warnings.push(...merged.warnings)
  keybindingsFile = file
  setKeyTable(new KeyTable(merged.bindings))
  paintKeyHints()
  for (const l of [...keybindingsFileListeners]) { try { l() } catch (err) { console.error('onDidChangeFile', err) } }
}

/** The shortcuts screen (an extension) changed the table: in force now; it writes the file, and the watcher's echo re-reads it. */
function applyKeybindings(bindings: Keybinding[]): void {
  setKeyTable(new KeyTable(bindings))
  paintKeyHints()
}

/** The hints that read the table (menus, tooltips): painted at start and again when the table changes. */
function paintKeyHints(): void {
  const menu = document.getElementById('app-menu')
  if (menu) for (const li of menu.querySelectorAll<HTMLElement>('li[data-command]')) {
    li.querySelector('kbd')?.remove()
    const hint = commands.hint(li.dataset.command!)
    if (hint) { const kbd = document.createElement('kbd'); kbd.textContent = hint; li.append(kbd) }
  }
  const quick = $('drawer-empty-quick').querySelector('.de-kbd')
  if (quick) quick.innerHTML = kbdHtml(shortcutHint('drawer.toggle'))
  const hint = (level: Target['level'], direction: Direction): string => shortcutHint(`pane.duplicate.${level}.${direction}`) || '—'
  const dupTitle = `${DUPLICATE_LABEL} ${PLACEMENT_LABEL.right} (${hint('pane', 'right')}): outro painel com o mesmo perfil e a mesma pasta, numa sessão nova. Setas com os mesmos modificadores duplicam para os outros lados; ${hint('frame', 'right')} na borda do quadro; ${hint('desk', 'right')} num quadro novo.`
  $('btn-duplicate').title = dupTitle
  $('drawer-duplicate').title = dupTitle
  const builderKey = shortcutHint('desk.builder')
  $('btn-builder').title = `Montar a mesa${builderKey ? ` (${builderKey})` : ''}: os "+" nas bordas dos quadros e da mesa; o conteúdo fica esmaecido e as abas só arrastam. Esc ou clique duplo num quadro saem.`
  const newTab = shortcutHint('pane.new-tab')
  $('btn-new').title = `${NEW_PANEL_LABEL}: escolha o perfil, a pasta e onde abrir.${newTab ? ` ${newTab} abre uma aba vazia no grupo ativo, com o seletor dentro.` : ''}`
  renderStrip()
}

/** Rows the screen lists but cannot change, from extensions (the note editor's own keys). */
const fixedBindingProviders: (() => FixedBinding[])[] = []

/** Every command of the registry (the editor's own actions left out) as the shortcuts screen lists it. */
const keybindingCommands = (): KbCommandInfo[] => commands.all().filter(c => !c.id.startsWith('editor.')).map(c => ({ id: c.id, title: c.title, ...(c.group ? { group: c.group } : {}), ...(c.danger ? { danger: true } : {}), ...(c.displayChord ? { displayChord: c.displayChord } : {}) }))

function allFixedBindings(): FixedBinding[] {
  const native: FixedBinding[] = commands.all().filter(c => c.displayChord).map(c => ({ command: c.id, title: c.title, group: c.group ?? 'App', keys: [chordOn({ chord: c.displayChord! })!], where: ['window', 'terminal', 'note'], source: 'nativo' }))
  const pane: FixedBinding[] = [
    { command: 'terminal.copy', title: 'Copiar (com seleção; sem ela é o ^C do programa)', group: 'Terminal', keys: [chordOn(PANE_SHORTCUTS[0]!) ?? chordOn(PANE_SHORTCUTS[1]!)!], where: ['terminal'], source: 'painel' },
    { command: 'terminal.copy-always', title: 'Copiar a seleção', group: 'Terminal', keys: [chordOn(PANE_SHORTCUTS[2]!)!], where: ['terminal'], source: 'painel' },
    { command: 'terminal.paste', title: 'Colar (Ctrl+V sem texto manda o ^V ao Claude Code: imagem)', group: 'Terminal', keys: [chordOn(PANE_SHORTCUTS[3]!) ?? chordOn(PANE_SHORTCUTS[4]!)!], where: ['terminal'], source: 'painel' },
    { command: 'terminal.paste-always', title: 'Colar', group: 'Terminal', keys: [chordOn(PANE_SHORTCUTS[5]!)!], where: ['terminal'], source: 'painel' },
    { command: 'terminal.newline', title: 'Nova linha sem enviar (Claude Code)', group: 'Terminal', keys: [chordOn(TERMINAL_INPUTS[0]!) ?? chordOn(TERMINAL_INPUTS[1]!)!], where: ['terminal'], source: 'painel' },
  ].filter(f => f.keys[0]) as FixedBinding[]
  const contributed: FixedBinding[] = []
  for (const provide of fixedBindingProviders) {
    try { contributed.push(...provide()) } catch (err) { console.warn(`fixed keybindings: ${err instanceof Error ? err.message : String(err)}`) }
  }
  return [...native, ...pane, ...contributed]
}

/** The "Extensões" screen as a tab of the active group (one screen: a second call brings it forward and refreshes it). */
function openExtensions(): void {
  const existing = extensionsPanels.keys().next().value as string | undefined
  if (existing && findPanel(existing)) {
    findPanel(existing)!.api.setActive()
    void extensionsPanels.get(existing)?.refresh()
    requestAnimationFrame(() => focusPane(existing))
    return
  }
  const reference = currentDesk().activePanel?.id
  const options: AddPanelOptions = { id: newExtensionsPanelId(), component: EXTENSIONS_COMPONENT, tabComponent: EXTENSIONS_TAB, title: EXTENSIONS_TITLE, params: {} }
  const panel = addPaneOptions(options, reference && findPanel(reference) ? { level: 'pane', placement: 'within' } : undefined, reference && findPanel(reference) ? reference : undefined)
  scheduleSave()
  requestAnimationFrame(() => focusPane(panel.id))
}

const extensionsHost: ExtensionsHost = {
  rows: async () => {
    const main = await window.tether.listMainExtensions()
    return extensionRows([{ manifests: extensions.map(e => e.manifest), failed: rendererActivation.failed }, main], main.disabled, rendererActivation.disabled)
  },
  setEnabled: async (id, on) => { await window.tether.setExtensionEnabled(id, on) },
  relaunch: () => window.tether.command('relaunch-app'),
  onTabMenu: (id, ev) => showTabMenu(id, ev.clientX, ev.clientY),
  onClose: id => { void closePanel(id) },
}

const dispatcher = new ChordDispatcher({
  modalOpen,
  editorChord: (first, second) => { const id = currentDesk().activePanel?.id; return !!id && !!liveTypeOf(paneTypes, id)?.editorChord?.(id, first, second) },
})
let pill: ChordPill
/** The keydown the dispatcher let through to the terminal (Ctrl+K twice = ^K): the panel's own policy must not take it back. */
let letThrough: KeyboardEvent | undefined

/** The ≡ menu: every item names a command; the hint, the greying and the run come from the registry. */
/** The ≡ checkboxes an extension's setting drives (MenuItem.toggled): their check follows the setting. */
function syncMenuChecks(): void {
  for (const item of flatItems(menuRegistry.build(MenuId.App))) {
    if (!item.toggled) continue
    document.querySelector(`#app-menu li[data-command="${item.command}"]`)?.setAttribute('aria-checked', String(item.toggled()))
  }
}

function setupMenu(): void {
  const btn = $('btn-menu')
  const menu = $('app-menu')
  const entries = menuRegistry.build(MenuId.App)
  menu.innerHTML = appMenuHtml(entries, id => commands.get(id)?.title)
  for (const el of menu.querySelectorAll<HTMLElement>('[data-icon]')) el.replaceChildren(icon(el.dataset.icon as IconName))
  const items = [...menu.querySelectorAll<HTMLElement>('li[data-command]')]
  // The registry's items in the rendered order: an item with `when` is hidden while it does not hold.
  const conditional = flatItems(entries).map((item, i) => ({ item, li: items[i]! })).filter(x => x.item.when)
  for (const li of items) {
    const id = li.dataset.command!
    if (!commands.get(id)) throw new Error(`menu item without a command: ${id}`)
  }
  // The key hints are painted by paintKeyHints (they follow the table).
  const submenus = attachSubmenus(menu)
  const toggle = (open: boolean): void => {
    submenus.closeAll()
    menu.hidden = !open
    btn.setAttribute('aria-expanded', String(open))
    if (open) {
      // The menu's CSS max-height reads the room below its top, so a short window scrolls the menu instead of clipping it.
      menu.style.setProperty('--menu-top', `${menu.getBoundingClientRect().top}px`)
      menu.scrollTop = 0
      menu.querySelector<HTMLElement>('li[role^=menuitem]')?.focus()
    }
  }
  btn.addEventListener('click', ev => {
    ev.stopPropagation()
    // Items whose command is unavailable now (no active pane, a single desk…) are greyed out, not hidden.
    const ctx = commandContext()
    for (const li of items) li.setAttribute('aria-disabled', String(!commands.isAvailable(commands.get(li.dataset.command!)!, ctx)))
    for (const { item, li } of conditional) li.hidden = !(item.when as (c: CommandContext) => boolean)(ctx)
    syncMenuChecks()
    toggle(menu.hidden)
  })
  document.addEventListener('click', ev => { if (!menu.hidden && !menu.contains(ev.target as Node)) toggle(false) })
  for (const li of menu.querySelectorAll<HTMLElement>('li[role^=menuitem]')) li.tabIndex = -1
  const run = (li: HTMLElement): void => {
    if (li.getAttribute('aria-disabled') === 'true') return
    toggle(false)
    if (li.dataset.command) void commands.run(li.dataset.command, 'menu')
  }
  menu.addEventListener('click', ev => {
    if (submenus.handleClick(ev)) { ev.stopPropagation(); return }
    const li = (ev.target as HTMLElement).closest<HTMLElement>('li[role^=menuitem]')
    if (li) { ev.stopPropagation(); run(li) }
  })
  menu.addEventListener('keydown', ev => {
    // Arrows, Home/End and the submenus' open/close (ArrowRight/Enter, ArrowLeft/Escape) are the submenu controller's.
    if (submenus.handleKey(ev)) return
    const active = document.activeElement as HTMLElement
    if (ev.key === 'Escape') { ev.preventDefault(); toggle(false); btn.focus() }
    else if (ev.key === 'Tab') toggle(false)
    else if ((ev.key === 'Enter' || ev.key === ' ') && active.matches('li[role^=menuitem]')) { ev.preventDefault(); run(active) }
  })
}

// ---------- toolbar: theme menu and connection popover ----------

/** The theme icon's menu (Claro · Automático · Escuro): same look and keys as the ≡ menu. */
function setupThemeMenu(): void {
  const btn = $('btn-theme')
  const menu = $('theme-menu')
  const items = (): HTMLElement[] => [...menu.querySelectorAll<HTMLElement>('li[data-theme]')]
  for (const li of items()) li.tabIndex = -1
  const toggle = (open: boolean): void => {
    menu.hidden = !open
    btn.setAttribute('aria-expanded', String(open))
    if (open) (menu.querySelector<HTMLElement>('li[aria-checked="true"]') ?? items()[0])?.focus()
  }
  btn.setAttribute('aria-controls', 'theme-menu')
  btn.addEventListener('click', ev => { ev.stopPropagation(); toggle(menu.hidden) })
  document.addEventListener('click', ev => { if (!menu.hidden && !menu.contains(ev.target as Node)) toggle(false) })
  const pick = (li: HTMLElement): void => { toggle(false); window.tether.setTheme(normalizeTheme(li.dataset.theme ?? 'auto')) }
  menu.addEventListener('click', ev => { const li = (ev.target as HTMLElement).closest<HTMLElement>('li[data-theme]'); if (li) { ev.stopPropagation(); pick(li) } })
  menu.addEventListener('keydown', ev => {
    const list = items()
    const i = list.indexOf(document.activeElement as HTMLElement)
    if (ev.key === 'Escape') { ev.preventDefault(); toggle(false); btn.focus() }
    else if (ev.key === 'ArrowDown') { ev.preventDefault(); list[(i + 1) % list.length]?.focus() }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus() }
    else if (ev.key === 'Home') { ev.preventDefault(); list[0]?.focus() }
    else if (ev.key === 'End') { ev.preventDefault(); list[list.length - 1]?.focus() }
    else if (ev.key === 'Tab') toggle(false)
    else if ((ev.key === 'Enter' || ev.key === ' ') && i >= 0) { ev.preventDefault(); pick(list[i]!); btn.focus() }
  })
}

/** The connection icon's popover: shows on hover, and stays open on click until a click outside or Esc. */
function setupConnectionPopover(): void {
  const wrap = $('conn-wrap')
  const btn = $('conn')
  wrap.addEventListener('mouseenter', () => renderConnection())
  btn.addEventListener('click', ev => {
    ev.stopPropagation()
    const open = !wrap.classList.contains('pinned')
    renderConnection()
    wrap.classList.toggle('pinned', open)
    btn.setAttribute('aria-expanded', String(open))
    if (open) statusBar?.close()
  })
  document.addEventListener('click', ev => { if (!wrap.contains(ev.target as Node)) { wrap.classList.remove('pinned'); btn.setAttribute('aria-expanded', 'false') } })
  btn.setAttribute('aria-controls', 'conn-pop')
  document.addEventListener('keydown', ev => {
    if (ev.key !== 'Escape' || !wrap.classList.contains('pinned')) return
    const inside = wrap.contains(document.activeElement) && document.activeElement !== btn
    wrap.classList.remove('pinned'); btn.setAttribute('aria-expanded', 'false')
    if (inside) btn.focus() // the focus was on a button inside the popover, which is about to disappear
  }, true)
  $('conn-restart').addEventListener('click', ev => { ev.stopPropagation(); closeToolbarPopups(); window.tether.command('restart-daemon') })
}

function closeToolbarPopups(): void {
  statusBar?.close()
  $('conn-wrap').classList.remove('pinned')
  $('conn').setAttribute('aria-expanded', 'false')
  $('theme-menu').hidden = true
  $('btn-theme').setAttribute('aria-expanded', 'false')
}

/** Fills the connection popover from the last connection state and the slots. */
function renderConnection(): void {
  const state = connection
  if (!state) return
  $('conn-pipe').textContent = state.pipe
  $('conn').title = state.connected ? `tetherd conectado (${state.pipe})` : `tetherd desconectado (${state.pipe})`
  $('conn-state').textContent = state.connected ? 'tetherd · conectado' : `tetherd · desconectado (${state.error})`
  $('conn-pid').textContent = state.connected ? String(state.pid) : '—'
  $('conn-version').textContent = state.connected ? state.version : '—'
  const all = [...slots.values()]
  const running = all.filter(isLiveSlot).length
  const waiting = all.filter(s => s.attention === 'waiting').length
  $('conn-agents').textContent = state.connected ? `${running} rodando · ${waiting} aguardando` : '—'
}

// ---------- wiring ----------

function setupUi(): void {
  // Static icons: <span data-icon="name"> in index.html becomes the inline SVG.
  for (const el of document.querySelectorAll<HTMLElement>('[data-icon]')) el.replaceChildren(icon(el.dataset.icon as IconName))
  $('btn-new').addEventListener('click', () => { void openNewDialog() })
  $('btn-drawer').addEventListener('click', () => setDrawerOpen(!drawer.isOpen))
  $('drawer-new').addEventListener('click', () => { void openNewDialog() })
  $('drawer-empty-new').addEventListener('click', () => { void openNewDialog() })
  $('drawer-empty-quick').addEventListener('click', () => { void quickShell() })
  $('drawer-pill').addEventListener('click', () => setDrawerOpen(false))
  $('drawer-empty-new').querySelector('.de-kbd')!.remove() // "Novo painel…" has no chord (Ctrl+N is the new empty tab)
  $('drawer-duplicate').addEventListener('click', () => { void duplicateActive({ level: 'pane', placement: 'right' }) })
  $('drawer-close').addEventListener('click', () => setDrawerOpen(false))
  $('btn-profiles').addEventListener('click', () => openProfiles())
  $('btn-extensions').addEventListener('click', () => openExtensions())
  commands.register(...appCommands(commandHost))
  commands.register(...workspaceCommands({
    pickAndOpen: () => { void window.tether.pickFolder(currentProject).then(f => { if (f) openProject(f) }) },
    toggleTarget: () => folderOf(projectFolders, paneCwdOf(currentDesk().activePanel?.id), CASE_INSENSITIVE) ?? projectFolders.find(f => f.path === currentProject),
    togglePin: path => setWorkspace(togglePin(workspaceState, path, CASE_INSENSITIVE)),
  }))
  palette = new CommandPalette($<HTMLDialogElement>('palette'), commands, () => paletteMode)
  setupMenu()
  $('btn-duplicate').addEventListener('click', () => { void duplicateActive({ level: 'pane', placement: 'right' }) })
  setupBuilder()
  paintKeyHints() // the tooltips and the menu hints that read the key table (painted again when the table changes)
  $('btn-retry').addEventListener('click', () => window.tether.reconnect())
  setupThemeMenu()
  setupConnectionPopover()
  statusBar = new StatusBar($('status-area'), statusRegistry, { contextMenu: (x, y, entries) => showContextMenu(x, y, entries.map(e => e === 'sep' ? SEP : { ...e, icon: e.icon as IconName })) })
  statusBar.render()
  // The popup's Esc (the dialog's own `cancel`, when the focus is outside the chooser), its × and a click on the backdrop all cancel the way the chooser does.
  const dlgNew = $<HTMLDialogElement>('dlg-new')
  dlgNew.addEventListener('cancel', ev => { ev.preventDefault(); popupCancel?.() })
  dlgNew.addEventListener('mousedown', ev => { if (ev.target === dlgNew) { ev.preventDefault(); popupCancel?.() } })
  $('btn-new-close').addEventListener('click', () => popupCancel?.())
  const closedBtn = $('btn-closed')
  const closedList = $('closed-list')
  closedBtn.addEventListener('click', ev => {
    ev.stopPropagation()
    closedList.hidden = !closedList.hidden
    closedBtn.setAttribute('aria-expanded', String(!closedList.hidden))
    if (closedList.hidden) { askingForget = undefined; refreshClosedMenu() }
  })
  document.addEventListener('click', ev => {
    if (closedList.contains(ev.target as Node)) return
    closedList.hidden = true
    closedBtn.setAttribute('aria-expanded', 'false')
    if (askingForget) { askingForget = undefined; refreshClosedMenu() }
  })

  // The keyboard dispatch (chord-dispatch.ts): a key in a scope (terminal, note, window) resolves through the key
  // table to a command id, or opens a two-key chord (the pill shows it). It runs in the CAPTURE phase so a key that
  // is the app's never reaches xterm or Monaco; what is not the app's passes untouched. Inside a note, a chord on an
  // arrow key stays the editor's (key-capture.ts editorKeyOwner), and the second key of a chord goes to the editor
  // first (monaco-chords.ts). The screen's own capture boxes (recording a key, searching by key) take every key.
  pill = new ChordPill({ titleOf: id => commands.get(id)?.title, groupOf: id => commands.get(id)?.group, showKeybindings: () => { void commands.run('keybindings.show', 'cli') } })
  document.addEventListener('keydown', ev => {
    const target = ev.target instanceof Element ? ev.target : undefined
    if (target?.closest('.kb-veil, .kb-live')) { if (dispatcher.waiting) { dispatcher.cancel(); pill.hide() } return }
    // A widget that handles a plain key itself says so (data-own-keys="F2 Delete": the explorer's tree renames and trashes
    // its row): the key is the widget's, unless a chord is pending or a modifier is held.
    const owner = target?.closest<HTMLElement>('[data-own-keys]')
    if (owner && !dispatcher.waiting && !ev.ctrlKey && !ev.altKey && !ev.metaKey && !ev.shiftKey && (owner.dataset.ownKeys ?? '').split(' ').includes(ev.key)) return
    const where = keyScopeOf(target)
    if (where === 'note' && !dispatcher.waiting && /^Arrow(Up|Down|Left|Right)$/.test(ev.code)) return
    const action = dispatcher.press(ev, where)
    const take = (): void => { ev.preventDefault(); ev.stopPropagation() }
    switch (action.type) {
      case 'pass': return
      case 'wait': take(); return
      case 'cancel': take(); pill.hide(); return
      case 'pass-prefix-key': letThrough = ev; pill.hide(); return
      case 'prefix': take(); pill.wait(action.first, action.next, where === 'terminal'); return
      case 'editor': {
        take(); pill.hide()
        const id = currentDesk().activePanel?.id
        if (id) liveTypeOf(paneTypes, id)?.runEditorChord?.(id, action.keys[0]!, ev)
        return
      }
      case 'unknown': take(); pill.unknown(action.keys); return
      case 'run': {
        const command = commands.get(action.command)
        const chord = action.keys.length > 1
        // A binding to a command that does not exist (a feature not built yet, an old file): a chord is swallowed and
        // told; a single key passes as if unbound.
        if (!command) { if (chord) { take(); pill.unknown(action.keys) } return }
        if (!commands.isAvailable(command)) {
          if (command.keepKeyWhenUnavailable && !chord) return
          take(); pill.hide(); return
        }
        take()
        if (command.ignoreRepeat && ev.repeat) return // a held key is one toggle
        if (chord) pill.done(action.keys, command.id); else pill.hide()
        void commands.run(command.id, 'key')
      }
    }
  }, true)
  // Esc outside a terminal closes the drawer (the dispatcher left it alone: no chord was pending); after it, the builder
  // mode's (a lower priority: an Esc the drawer, a popup, a menu or a dialog took never leaves the builder).
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape') drawerEscapeOutside(ev) })
  document.addEventListener('keydown', ev => {
    if (ev.key !== 'Escape' || ev.defaultPrevented || ev.ctrlKey || ev.altKey || ev.shiftKey || ev.metaKey) return
    if (builderEscape()) ev.preventDefault()
  })
  // A pending prefix does not survive a click or the window losing the focus.
  document.addEventListener('mousedown', () => { if (dispatcher.waiting) { dispatcher.cancel(); pill.hide() } }, true)
  window.addEventListener('blur', () => { dispatcher.cancel(); pill.hide() })
  window.tether.onKeybindingsChanged(applyKeybindingsFile)
  void window.tether.keybindingsRead().then(applyKeybindingsFile)
  // Back to the window: the pane in front of the user is seen.
  window.addEventListener('focus', () => markSeenIfWatched())
  document.addEventListener('visibilitychange', () => markSeenIfWatched())
}

// Test hooks (Playwright reads these through page.evaluate).
declare global {
  interface Window {
    __tether: {
      /** What each extension exposes (TetherUi.test.expose); a name no core hook has is also set flat here. */
      ext: Record<string, Record<string, unknown>>
      /** The status registry (e2e declares and registers a test icon through it). */
      status: StatusRegistry
      /** The layout as it would be saved (v3: desks → frames → panes, the side bars). */
      layout(): Layout
      /** The side bars (F10): each side's strip, open pad and widths; the live pad views. */
      sidebars(): ReturnType<SideBars['snapshot']> | undefined
      toggleSideBar(side: 'left' | 'right'): void
      togglePad(id: string): void
      /** Opens a file the way the explorer and the extensions do (TetherUi.openers.open): the core's file opening. */
      openFile(path: string): Promise<void>
      /** The live frames of the pads (F10b): which pad, which desk, its panes, shown or not. */
      padFrames(): { pad: string; desk?: string; panes: string[]; shown: boolean }[]
      /** Opens a slot as a pane in the shown frames of a pad (the active desk's, for a desk pad). */
      openSlotInPad(slotId: string, padId: string): void
      movePad(id: string): void
      restorePad(id: string): void
      /** A frame's dockview JSON (the active frame when no id is given). */
      frameLayout(frameId?: string): SerializedDockview | undefined
      frameIds(): string[]
      activeFrameId(): string | undefined
      /** The builder mode (builder-mode.ts): on or off, and switching it (leaving gives the keyboard back as the button does). */
      builder(): boolean
      setBuilder(on: boolean): void
      frameOf(slotId: string): string | undefined
      panelIds(): string[]
      /** The JSON language service's diagnostics of an open file (Monaco markers; severity 8 error, 4 warning). */
      modelMarkers(path: string): { severity: number; message: string; line: number }[]
      activeId(): string | undefined
      /** The pane new panes and the shortcuts act on: the drawer's, the focused pad's or the visible desk's active pane. */
      currentPane(): string | undefined
      slots(): SlotState[]
      text(slotId: string): string
      connection(): ConnectionState | undefined
      activate(slotId: string): void
      /** Opens a panel for a slot the daemon already has (as the "closed slots" menu does). */
      openSlot(slotId: string): void
      /** Feeds a slot state as if the daemon had sent it (screenshots of states the daemon cannot produce on demand). */
      applyState(slot: SlotState): void
      /** The theme state painted right now (setting + scheme). */
      theme(): ThemeState
      /** The xterm palette a panel is using (its `theme.background`, etc). */
      termTheme(slotId: string): Record<string, string | undefined> | undefined
      /** The xterm font options a panel is using, and which renderer it got. */
      termOptions(slotId: string): { fontFamily: string; fontWeight: number | string; fontWeightBold: number | string; fontSize: number; lineHeight: number; letterSpacing: number; minimumContrastRatio: number; renderer: string } | undefined
      /** The path link under the pointer in a terminal: underlined, hand pointer, and the pane's tooltip (empty without one). */
      linkHover(slotId: string): { underline: boolean; hand: boolean; title: string } | undefined
      /** The terminal appearance in force. */
      terminalAppearance(): TerminalAppearance
      /** Opens "Tema do terminal…" as the menu does. */
      openTerminalTheme(): void
      /** Whether the browser has the font face loaded (`document.fonts.check`). */
      fontLoaded(spec: string): boolean
      /** The dialog's sample terminal: its buffer text and options (undefined while the dialog is closed). */
      sample(): { text: string; fontFamily: string; background: string | undefined } | undefined
      /**
       * What a terminal canvas (WebGL renderer) actually painted: the top-left `maxW`×`maxH` CSS px as a PNG data
       * URL and how many of those pixels differ from the corner one. A window capture does not see a WebGL
       * canvas in the offscreen (hidden) window, so this is how tests look at the rendering.
       */
      paint(selector: string, maxW: number, maxH: number): { png: string; painted: number; width: number; height: number } | undefined
      /** Remembered dialog answers as the renderer sees them. */
      confirmations(): Confirmations
      /** The capsule: visible desks, the ones behind the "+N", the active one. */
      switchState(): { visible: string[]; hidden: string[]; active: string }
      /** The desk colour line: on/off (settings `ui.deskLine`). */
      deskLine(): boolean
      /** The other two signal modes: the folder-shaped outline on the focused pane and the dim of unfocused frames. */
      signals(): { tabBorder: boolean; dimUnfocused: boolean; dimLevel: string }
      /** Asks to close a panel exactly as the tab's × does (dialog included). */
      closePanel(slotId: string): void
      /** The projects (F8): the folders, the pinned roots, the current one. */
      workspace(): { folders: readonly ProjectFolder[]; pinned: { path: string }[]; current: string | undefined }
      openFolder(path: string): void
      unpinProject(path: string): void
      toggleProjectPin(path: string): void
      /** A known slot's pane on the visible desk, without starting it (an agent created with start:false stays still). */
      addSlotPane(slotId: string): void
      /** Closes a pane without asking (the slot stays, in "Slots fechados"). */
      detachPane(slotId: string): void
      describePane(id: string): PaneInfo | undefined
      /** The terminal font size in use (appearance.fontSize). */
      fontSize(): number
      /** Opens the tab's inline rename, as a double click does. */
      startRename(slotId: string): void
      /** The launch profiles as the renderer sees them. */
      profiles(): Profile[]
      /** Opens the profile manager (on a profile, or 'new'). */
      openProfiles(id?: string): void
      /** Opens "Trocar perfil…" for a panel, as the header pill does. */
      switchProfile(slotId: string): void
      /** "Duplicar painel" relative to a panel (pane / frame / desk level), as the menus and the "+" do. */
      duplicate(slotId: string, direction: Direction, level?: Target['level']): void
      /** The terminal's current selection text ('' when none). */
      selection(slotId: string): string
      /** The terminal's grid as xterm sized it (rows grow when the pane header collapses). */
      termSize(slotId: string): { cols: number; rows: number } | undefined
      /** Selects the first occurrence of `needle` in the terminal buffer (as a user would with the mouse); false when absent. */
      selectText(slotId: string, needle: string): boolean
      /** Cell size in CSS px (to aim the mouse at a given row/column). */
      cellSize(slotId: string): { width: number; height: number } | undefined
      /** Where the first occurrence of `needle` is on screen (viewport row/column), or undefined when absent or scrolled out. */
      screenPos(slotId: string, needle: string): { row: number; col: number } | undefined
      /** The mouse tracking mode the program asked for ('none' when it did not). */
      mouseMode(slotId: string): string | undefined
      /** Writes to the xterm as if the program had (tests: ConPTY does not forward every DECSET). */
      inject(slotId: string, data: string): void
      /** The row of desks with each desk's panes and attention counts, and the active desk. */
      desks(): { id: string; name: string; color: string; panes: string[]; attention: DeskAttention }[]
      activeDesk(): string
      deskOf(slotId: string): string | undefined
      switchDesk(id: string): void
      createDesk(side: 'before' | 'after', relativeTo?: string): string
      renameDesk(id: string, name: string): void
      recolorDesk(id: string, color: string): void
      moveDesk(id: string, to: number): void
      /** Closes a desk exactly as its menu does (the dialog included when it has panes). */
      closeDesk(id: string): void
      movePaneToDesk(slotId: string, deskId: string): void
      /** Opens the "Mover…" dialog for a pane. */
      openMove(slotId: string, mode?: MoveMode): void
      /** The dialog's destination tree as it would be built now. */
      moveTree(): ScopeModel[]
      moveFrameToDesk(slotId: string, deskId: string): void
      /** The drawer: open or not, its panes, the attention counts of its panes. */
      drawer(): { open: boolean; panes: string[]; frames: string[]; attention: DeskAttention }
      toggleDrawer(): void
      openDrawer(): void
      closeDrawer(): void
      inDrawer(slotId: string): boolean
      movePaneToDrawer(slotId: string): void
      movePaneFromDrawer(slotId: string): void
      moveFrameToDrawer(slotId: string): void
      moveFrameFromDrawer(slotId: string): void
      /** The command registry as the palette sees it: every command with its hint and whether it is available now. */
      commands(): { id: string; title: string; hint: string; available: boolean }[]
      /** Runs a command by id, as the CLI will (`tether run <id>`). */
      runCommand(id: string): Promise<'ran' | 'unknown' | 'unavailable'>
      /** The palette: open or not, its mode, the ids on screen in order, the field's text. */
      palette(): { open: boolean; mode?: PaletteMode; shown: string[]; input: string }
      /** Opens the palette as the chord does. */
      showPalette(mode?: PaletteMode): void
      /** The "Atalhos de teclado" screens, the chord pill and the key table (keys as the file writes them). */
      pill(): { state: string; text: string; continuations: number }
      keyTable(): { keys: string; command: string; where: string[]; source: string }[]
      closedPanes(): number
      /** The empty panes: id, the folder the chooser shows, the radio selected, focus, error. */
      empties(): EmptySnapshot[]
      empty(id: string): EmptySnapshot | undefined
      /** The popup's chooser ("Novo painel…" / focus mode), while open. */
      chooser(): ChooserSnapshot | undefined
      /** Ctrl+Shift+T: an empty tab (origin add) in the active group. */
      newTab(): void
      /** The tab index of a pane inside its group and the group's id (where a replacement must land). */
      tabIndex(id: string): number | undefined
      groupOf(id: string): string | undefined
    }
  }
}

function setupTestHooks(): void {
  window.__tether = {
    ext: extTestHooks,
    status: statusRegistry,
    layout: () => layoutJSON(),
    sidebars: () => sidebars?.snapshot(),
    toggleSideBar: side => sidebars?.toggleSide(side),
    togglePad: id => sidebars?.toggle(id),
    openFile: path => openFile(fileOpenHost, path, { side: false, root: '' }),
    padFrames: () => [...framePads].map(p => ({ pad: p.padId, ...(p.deskId ? { desk: p.deskId } : {}), panes: p.desk.panels.map(x => x.id), shown: p.isVisible })),
    openSlotInPad: (slotId, padId) => {
      const s = slots.get(slotId)
      const pad = sidebars?.viewOf(padId, desks.activeDeskId)
      if (!s || !(pad instanceof FramesPad) || findPanel(slotId)) return
      const ref = pad.desk.activePanel?.id
      const panel = addPanel(s, undefined, ref)
      panel.api.setActive()
    },
    movePad: id => sidebars?.move(id),
    restorePad: id => sidebars?.restore(id),
    frameLayout: frameId => (frameId ? desks.frames.get(frameId) : desks.activeFrame)?.dock.toJSON(),
    frameIds: () => desks.frameIds,
    builder: () => isBuilder(),
    setBuilder: on => { if (!on) leaveBuilder(); else setBuilder(true) },
    activeFrameId: () => desks.activeFrame?.id,
    frameOf: slotId => desks.frameOf(slotId)?.id,
    panelIds: () => desks.panels.map(p => p.id),
    /** The JSON language service's diagnostics of an open file (Monaco markers; severity 8 error, 4 warning). */
    modelMarkers: (path: string) => monaco.editor.getModelMarkers({ resource: monaco.Uri.file(path) }).map(m => ({ severity: m.severity, message: m.message, line: m.startLineNumber })),
    activeId: () => desks.activePanel?.id,
    currentPane: () => currentDesk().activePanel?.id,
    slots: () => [...slots.values()],
    text: slotId => {
      const p = panels.get(slotId)
      if (!p) return ''
      const buf = p.term.buffer.active
      const lines: string[] = []
      for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '')
      return lines.join('\n').replace(/\n+$/, '')
    },
    connection: () => connection,
    activate: slotId => findPanel(slotId)?.api.setActive(),
    openSlot,
    applyState,
    theme: () => theme,
    termTheme: slotId => panels.get(slotId)?.term.options.theme as Record<string, string | undefined> | undefined,
    termOptions: slotId => {
      const p = panels.get(slotId)
      if (!p) return undefined
      const o = p.term.options
      return { fontFamily: o.fontFamily!, fontWeight: o.fontWeight!, fontWeightBold: o.fontWeightBold!, fontSize: o.fontSize!, lineHeight: o.lineHeight!, letterSpacing: o.letterSpacing!, minimumContrastRatio: o.minimumContrastRatio!, renderer: p.renderer }
    },
    linkHover: slotId => {
      const p = panels.get(slotId)
      if (!p) return undefined
      // xterm keeps the hovered link's state in its (private) linkifier; a test is the only reader.
      type Decorations = { underline: boolean; pointerCursor: boolean }
      type Linkifier = { _currentLink?: { state?: { decorations?: Decorations } } }
      const holder = (p.term as unknown as { _core?: { _linkifier?: Linkifier & { value?: Linkifier } } })._core?._linkifier
      const d = (holder?.value ?? holder)?._currentLink?.state?.decorations
      return { underline: !!d?.underline, hand: !!d?.pointerCursor, title: p.term.element?.getAttribute('title') ?? '' }
    },
    terminalAppearance: () => appearance,
    openTerminalTheme: () => themeDialog.show(),
    fontLoaded: spec => document.fonts.check(spec),
    sample: () => {
      const t = themeDialog.sampleTerminal
      if (!t) return undefined
      const buf = t.buffer.active
      const lines: string[] = []
      for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '')
      return { text: lines.join('\n').replace(/\n+$/, ''), fontFamily: t.options.fontFamily!, background: t.options.theme?.background }
    },
    paint: (selector, maxW, maxH) => {
      // The WebGL addon appends its canvas after its 2D link layer: the last canvas is the one with the glyphs.
      const canvases = document.querySelectorAll<HTMLCanvasElement>(`${selector} canvas`)
      const src = canvases[canvases.length - 1]
      if (!src) return undefined
      const scale = src.width / Math.max(1, src.clientWidth)
      const width = Math.min(src.width, Math.round(maxW * scale))
      const height = Math.min(src.height, Math.round(maxH * scale))
      const out = document.createElement('canvas')
      out.width = width; out.height = height
      const ctx = out.getContext('2d')!
      ctx.drawImage(src, 0, 0, width, height, 0, 0, width, height)
      const px = ctx.getImageData(0, 0, width, height).data
      let painted = 0
      for (let i = 4; i < px.length; i += 4) if (px[i] !== px[0] || px[i + 1] !== px[1] || px[i + 2] !== px[2]) painted++
      return { png: out.toDataURL('image/png'), painted, width, height }
    },
    confirmations: () => confirmations,
    switchState: () => strip.state(),
    deskLine: () => ui.deskLine,
    signals: () => ({ tabBorder: ui.tabBorder, dimUnfocused: ui.dimUnfocused, dimLevel: ui.dimLevel }),
    closePanel: slotId => { void closePanel(slotId) },
    workspace: () => ({ folders: projectFolders, pinned: workspaceState.pinned, current: currentProject }),
    openFolder: path => openProject(path),
    unpinProject: path => setWorkspace(unpinFolder(workspaceState, path, CASE_INSENSITIVE)),
    toggleProjectPin: path => setWorkspace(togglePin(workspaceState, path, CASE_INSENSITIVE)),
    addSlotPane: slotId => { const s = slots.get(slotId); if (s && !findPanel(slotId)) addPanel(s).api.setActive() },
    detachPane: slotId => { void closePanel(slotId, { ask: false }) },
    describePane: id => describePane(id),
    fontSize: () => appearance.fontSize,
    startRename: slotId => tabs.get(slotId)?.startRename(),
    profiles: () => profiles,
    openProfiles,
    switchProfile: slotId => { void switchProfile(slotId) },
    duplicate: (slotId, direction, level = 'pane') => { void duplicatePanel(slotId, { level, placement: direction }) },
    selection: slotId => panels.get(slotId)?.term.getSelection() ?? '',
    termSize: slotId => { const t = panels.get(slotId)?.term; return t ? { cols: t.cols, rows: t.rows } : undefined },
    selectText: (slotId, needle) => {
      const term = panels.get(slotId)?.term
      if (!term) return false
      const buf = term.buffer.active
      for (let row = 0; row < buf.length; row++) {
        const col = (buf.getLine(row)?.translateToString(true) ?? '').indexOf(needle)
        if (col < 0) continue
        term.select(col, row, needle.length)
        return true
      }
      return false
    },
    screenPos: (slotId, needle) => {
      const term = panels.get(slotId)?.term
      if (!term) return undefined
      const buf = term.buffer.active
      for (let row = 0; row < buf.length; row++) {
        const col = (buf.getLine(row)?.translateToString(true) ?? '').indexOf(needle)
        if (col < 0) continue
        const screenRow = row - buf.viewportY
        return screenRow >= 0 && screenRow < term.rows ? { row: screenRow, col } : undefined
      }
      return undefined
    },
    mouseMode: slotId => panels.get(slotId)?.term.modes.mouseTrackingMode,
    inject: (slotId, data) => panels.get(slotId)?.term.write(data),
    desks: () => desks.desks.map(d => ({ ...d, panes: (desks.desk(d.id)?.panels ?? []).map(p => p.id), attention: deskAttention(d.id) })),
    activeDesk: () => desks.activeDeskId,
    deskOf: slotId => desks.deskOf(slotId),
    switchDesk: id => desks.switchTo(id),
    createDesk: (side, relativeTo) => desks.create(side, relativeTo),
    renameDesk: (id, name) => desks.rename(id, name),
    recolorDesk: (id, color) => desks.recolor(id, readDeskColor(color)),
    moveDesk: (id, to) => desks.move(id, to),
    closeDesk: id => { void closeDesk(id) },
    movePaneToDesk,
    openMove: (slotId, mode) => { void openMove(slotId, mode) },
    moveTree,
    moveFrameToDesk,
    drawer: () => ({ open: drawer.isOpen, panes: drawer.desk.panels.map(p => p.id), frames: drawer.desk.frameIds, attention: drawerAttention() }),
    toggleDrawer: () => setDrawerOpen(!drawer.isOpen),
    openDrawer: () => setDrawerOpen(true),
    closeDrawer: () => setDrawerOpen(false),
    inDrawer,
    movePaneToDrawer,
    movePaneFromDrawer,
    moveFrameToDrawer,
    moveFrameFromDrawer,
    commands: () => { const ctx = commandContext(); return commands.all().map(c => ({ id: c.id, title: c.title, hint: commands.hint(c), available: commands.isAvailable(c, ctx) })) },
    runCommand: id => commands.run(id, 'cli'),
    palette: () => ({ open: palette.open, mode: palette.mode, shown: palette.shown(), input: $<HTMLInputElement>('palette-input').value }),
    showPalette: (mode = 'commands') => palette.show(mode),
    pill: () => pill.snapshot(),
    keyTable: () => keyTable().bindings.map(b => ({ keys: formatKeys(b.keys), command: b.command, where: [...b.where], source: b.source })),
    closedPanes: () => closedPanes.length,
    empties: () => [...empties.values()].map(e => e.snapshot()),
    empty: id => empties.get(id)?.snapshot(),
    chooser: () => popupChooser?.snapshot(),
    newTab,
    tabIndex: id => { const p = findPanel(id); const i = p ? p.group.panels.indexOf(p) : -1; return i >= 0 ? i : undefined },
    groupOf: id => findPanel(id)?.group.id,
    cellSize: slotId => {
      const term = panels.get(slotId)?.term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } } } | undefined
      return term?._core?._renderService?.dimensions?.css?.cell
    },
  }
  // The extensions' hooks also sit flat on window.__tether (the e2e called them there before they moved), unless the core has the name.
  const flat = window.__tether as unknown as Record<string, unknown>
  for (const hooks of Object.values(extTestHooks)) for (const [name, value] of Object.entries(hooks)) if (!(name in flat)) flat[name] = value
}

// ---------- pane types (F9) ----------
// Every kind of pane registers here (app/renderer/pane-registry.ts): dockview's component factories, moving a pane,
// the restore's slotless rule, the tab strip's icon, the opening folder, the context flags and "reopen the last closed
// pane" all read the registry. Extensions register theirs through TetherUi.panes (app/renderer/ext-api.ts).

/** Keeps `map` in step with a pane's life: set on init (dockview gives the id there), removed on dispose. */
function tracked<T extends M & { init(params: never): void; dispose(): void }, M = T>(pane: T, map: Map<string, M>, key: () => string): T {
  const init = pane.init.bind(pane) as (params: never) => void
  pane.init = ((params: never) => { init(params); map.set(key(), pane) }) as T['init']
  const dispose = pane.dispose.bind(pane)
  pane.dispose = () => { dispose(); const k = key(); if (map.get(k) === pane) map.delete(k) }
  return pane
}

/** Keeps `map` (pane id → tab) in step with a tab's life. */
function trackedTab<T extends { init(params: never): void; dispose(): void }>(tab: T, map: Map<string, T>): T {
  const init = tab.init.bind(tab) as (params: { api: { id: string } }) => void
  tab.init = ((params: { api: { id: string } }) => { init(params); map.set(params.api.id, tab) }) as T['init']
  const dispose = tab.dispose.bind(tab)
  tab.dispose = () => { dispose(); for (const [id, t] of map) if (t === tab) map.delete(id) }
  return tab
}

function registerCorePaneTypes(): void {
  const live = (layout: PaneLayout, type: Omit<PaneType, keyof PaneLayout>): PaneType => ({ ...layout, ...type })
  paneTypes.register(live(emptyPaneLayout, {
    icon: 'plus',
    create: () => { const p: EmptyPanel = tracked(new EmptyPanel(emptyHost), empties, () => p.id); return p },
    createTab: () => new EmptyTab(emptyHost),
    has: id => empties.has(id),
    cwdOf: id => empties.get(id)?.cwd || undefined,
  }))
  paneTypes.register(live(extensionsLayout, {
    icon: 'puzzle-piece',
    create: () => { const p: ExtensionsPanel = tracked(new ExtensionsPanel(extensionsHost), extensionsPanels, () => p.id); return p },
    createTab: () => new ExtensionsTab(extensionsHost),
    has: id => extensionsPanels.has(id),
  }))
  paneTypes.register(live(terminalLayout, {
    icon: 'terminal',
    create: () => { const p: TerminalPanel = tracked(new TerminalPanel(host), panels, () => p.slotId); return p },
    createTab: () => trackedTab(new SlotTab(host, id => { void closePanel(id) }), tabs),
    has: id => slots.has(id),
    cwdOf: id => slots.get(id)?.cwd,
    // Reopening a slot resumes it, as the closed-slots menu does; it makes sense while the slot exists without a pane.
    closedEntry: id => slots.has(id) ? { key: `slot:${id}`, reopen: () => { if (!slots.has(id) || findPanel(id)) return false; openSlot(id); return true } } : undefined,
  }))
}

/** The extensions' renderer side (extensions/index.renderer.ts): activated once at startup, after the core types. */
// Their settings come from settings.json `extensions` (read synchronously once: activation cannot wait) and follow
// main's broadcasts; the ones listed in `extensions.disabled` are skipped (that takes effect at the next start).
const extensionStore = new DisposableStore()
const configuration = new ConfigurationRegistry()
let extSettings: ExtensionsSettings = { disabled: [], values: {} }
const extSettingListeners = new Map<string, Set<(value: SettingValue) => void>>()
/** The ≡ menu: the core's items and groups, plus what extensions contribute (built once by setupMenu). */
const menuRegistry = coreMenuRegistry()
let rendererActivation: { active: string[]; disabled: string[]; failed: { id: string; error: string }[] } = { active: [], disabled: [], failed: [] }

/** The JSON schema of the user's settings.json for the Monaco editor (app/shared/settings-schema.ts): re-generated whenever the registry changes. */
let settingsFilePath: string | undefined
function syncSettingsSchema(): void {
  const push = (path: string): void => setSettingsSchema(path, generateSettingsSchema([CORE_SETTINGS, ...configuration.getConfigurationNodes()]))
  if (settingsFilePath) push(settingsFilePath)
  else void window.tether.settingsFile().then(f => { settingsFilePath = f.path; push(f.path) }, () => {})
}
function onExtSetting(change: { id: string; key: string; value: SettingValue }): void {
  extSettings = withSetting(extSettings, change.id, change.key, change.value)
  for (const l of extSettingListeners.get(`${change.id}.${change.key}`) ?? []) l(configuration.read(extSettings, change.id, change.key) ?? change.value)
  syncMenuChecks()
}

/** What each extension registered, so a failed activation takes its declarative contributions back too. */
const contributionStores = new Map<string, DisposableStore>()
/** What extensions expose for the e2e (TetherUi.test.expose), merged into window.__tether by setupTestHooks. */
const extTestHooks: Record<string, Record<string, unknown>> = {}

/** The manifest's data the core needs before `activate`: default keys, ≡ items, chooser items. */
function contributeDeclared(manifest: ExtensionManifest, store: DisposableStore): void {
  const c = manifest.contributes
  if (!c) return
  if (c.keybindings?.length) {
    store.add(toDisposable(contributeKeybindings(keybindingEntries(c.keybindings))))
  }
  for (const m of c.menus?.app ?? []) {
    const toggled = m.toggled
    store.add(menuRegistry.appendMenuItem(MenuId.App, menuItemOf(m, toggled ? () => configuration.read(extSettings, manifest.id, toggled) === true : undefined)))
  }
  if (c.chooser) store.add(toDisposable(contributeChooser(c.chooser)))
  // Pads: the strip draws them from the manifest; each gets its own toggle command (VS Code registers an "open" command per view container).
  for (const s of c.status ?? []) store.add(statusRegistry.declare({ ...s, extension: manifest.id }))
  for (const p of c.pads ?? []) {
    store.add(padRegistry.register({ ...p, extension: manifest.id }))
    store.add(toDisposable(commands.register({
      id: padToggleCommand(p.id), title: `${p.title}: abrir ou fechar`, group: 'Barras laterais', icon: p.icon, ignoreRepeat: true,
      run: () => sidebars?.toggle(p.id),
    })))
  }
}

/**
 * A disabled (or failed) extension's pane types: a placeholder keeps each saved pane of them in its place, with its id
 * and params untouched, so the layout loses nothing and the pane comes back when the extension is on again.
 */
function registerPlaceholders(manifest: ExtensionManifest, failed: boolean): void {
  const placeholderHost: DisabledPaneHost = {
    extension: () => ({ name: manifest.displayName, failed }),
    showExtensions: () => openExtensions(),
    onTabMenu: (id, x, y) => showTabMenu(id, x, y),
    onClose: id => closeSlotless(id),
  }
  for (const t of manifest.contributes?.paneTypes ?? []) {
    if (paneTypes.get(t.id)) continue
    paneTypes.register({
      ...t, hasSlot: false, icon: 'puzzle-piece',
      create: () => { const p: DisabledPane = tracked(new DisabledPane(placeholderHost), placeholders, () => p.id); return p },
      createTab: () => new DisabledTab(placeholderHost),
      has: id => placeholders.has(id) && (!t.owns || paneTypes.bySaved({ id, params: findPanel(id)?.params }) === paneTypes.get(t.id)),
      focus: id => placeholders.get(id)?.focus(),
      tabMenu: (id, x, y) => showContextMenu(x, y, [
        { icon: 'puzzle-piece', label: 'Abrir Extensões', run: () => openExtensions() },
        SEP,
        { icon: 'arrow-square-out', label: 'Mover…', run: () => { void openMove(id) } },
        SEP,
        { icon: 'x', label: 'Fechar', run: () => closeSlotless(id) },
      ]),
    })
  }
}

function activateRendererExtensions(): void {
  // main hands over the parsed settings; reading them back through the file's own shape keeps the values (not just `disabled`).
  extSettings = readExtensionsSettings(writeExtensionsSettings(window.tether.extSettingsSync()))
  window.tether.onExtSetting(onExtSetting)
  for (const e of extensions) {
    const settings = e.manifest.contributes?.settings
    if (settings && !extSettings.disabled.includes(e.manifest.id)) extensionStore.add(configuration.registerConfiguration({ id: e.manifest.id, title: e.manifest.displayName, properties: settings }))
  }
  syncSettingsSchema()
  extensionStore.add(configuration.onDidChange(syncSettingsSchema))
  const apiFor = (id: string): TetherUi => {
    const manifest = extensions.find(e => e.manifest.id === id)!.manifest
    const own = extensionStore.add(new DisposableStore())
    contributionStores.set(id, own)
    contributeDeclared(manifest, own)
    const add = <T extends IDisposable>(d: T): T => own.add(d)
    return {
      id,
      brand: BRAND,
      panes: {
        register: type => add(paneTypes.register(type)),
        open: (options, where) => addPaneOptions(options, where?.target, where?.reference),
        find: paneId => findPanel(paneId),
        activeId: () => (openingFile ? fileTargetDesk() : currentDesk()).activePanel?.id,
        cwdOf: paneId => paneCwdOf(paneId),
        focus: paneId => focusPane(paneId),
        reveal: paneId => revealPane(paneId),
        copyLink: paneId => copyPaneLink(paneId),
        close: paneId => closeSlotless(paneId),
        showTabMenu: (paneId, x, y) => showTabMenu(paneId, x, y),
        newPanelDialog: (reference, opts) => { void openNewDialog({ reference, ...(opts?.cwd ? { cwd: opts.cwd } : {}) }) },
        newPanelLabel: NEW_PANEL_LABEL,
        move: paneId => { void openMove(paneId) },
        all: () => allPanels().map(p => describePane(p.id)).filter((x): x is PaneInfo => x !== undefined),
        describe: paneId => describePane(paneId),
        onDidChangeActive: listener => { activePaneListeners.add(listener); return add(toDisposable(() => { activePaneListeners.delete(listener) })) },
      },
      workspace: {
        folders: () => projectFolders,
        onDidChange: listener => { workspaceListeners.add(listener); return add(toDisposable(() => { workspaceListeners.delete(listener) })) },
        open: path => openProject(path),
        unpin: path => setWorkspace(unpinFolder(workspaceState, path, CASE_INSENSITIVE)),
        togglePin: path => setWorkspace(togglePin(workspaceState, path, CASE_INSENSITIVE)),
        move: (path, dir) => moveProject(path, dir),
        current: () => currentProject,
        setCurrent: path => { currentProject = path === undefined ? undefined : folderOf(projectFolders, path, CASE_INSENSITIVE)?.path },
        folderOf: absPath => folderOf(projectFolders, absPath, CASE_INSENSITIVE),
      },
      folders: {
        recent: () => window.tether.recentFolders(),
        pickFolder: initial => window.tether.pickFolder(initial),
        remember: path => { void window.tether.rememberFolder(path) },
      },
      commands: {
        register: (...list) => add(toDisposable(commands.register(...list))),
        registerCommand: (command, run) => {
          const declared = manifest.contributes?.commands?.find(c => c.command === command)
          if (!declared) throw new Error(`comando não declarado no manifesto de ${id}: ${command}`)
          return add(toDisposable(commands.register(commandFromContribution(declared, run))))
        },
        ids: () => commands.all().map(c => c.id),
        run: commandId => commands.run(commandId, 'menu'),
      },
      ipc: () => uiIpc(id, window.tether.ext),
      settings: {
        get: <T extends SettingValue>(key: string) => configuration.read(extSettings, id, key) as T | undefined,
        set: (key, value) => {
          const schema = configuration.schemaOf(id, key)
          const v = schema ? configuration.read({ disabled: [], values: { [id]: { [key]: value } } }, id, key)! : value
          window.tether.setExtSetting(id, key, v)
        },
        onChange: (key, listener) => {
          const full = `${id}.${key}`
          let set = extSettingListeners.get(full)
          if (!set) { set = new Set(); extSettingListeners.set(full, set) }
          set.add(listener)
          return add(toDisposable(() => { set.delete(listener) }))
        },
      },
      configuration: {
        all: () => window.tether.settingsList(),
        set: (key, value) => window.tether.settingsSet(key, value),
        reset: key => window.tether.settingsReset(key),
        onDidChange: listener => {
          const offKeys = window.tether.onSettingsChanged(keys => listener({ keys }))
          const offErrors = window.tether.onSettingsErrors(errors => listener({ keys: [], errors }))
          return add(toDisposable(() => { offKeys(); offErrors() }))
        },
        fileState: () => window.tether.settingsFile(),
        openFile: async () => {
          const r = await window.tether.settingsOpen()
          if (r.ok) await openFile(fileOpenHost, r.path, { side: false, root: '', source: true })
          else console.error(`settings.json: ${r.message}`)
        },
      },
      menus: {
        app: (item: RegistryMenuItem<CommandContext>) => add(menuRegistry.appendMenuItem(MenuId.App, item as RegistryMenuItem)),
        context: (x, y, entries: ContextMenuEntry[]) => showContextMenu(x, y, entries.map(e => e === 'sep' ? SEP : { ...e, icon: e.icon as IconName })),
      },
      layout: { scheduleSave: () => scheduleSave() },
      dialogs: { ask: spec => askDialog(spec) },
      theme: {
        scheme: () => theme.scheme,
        onChange: listener => { themeListeners.add(listener); return add(toDisposable(() => { themeListeners.delete(listener) })) },
        appearance: () => appearance,
        onAppearance: listener => { appearanceListeners.add(listener); return add(toDisposable(() => { appearanceListeners.delete(listener) })) },
      },
      openers: {
        register: opener => { fileOpeners.push(opener); return add(toDisposable(() => { const i = fileOpeners.indexOf(opener); if (i !== -1) fileOpeners.splice(i, 1) })) },
        open: (path, opts) => openFile(fileOpenHost, path, opts),
        onOpened: listener => { openedListeners.add(listener); return add(toDisposable(() => { openedListeners.delete(listener) })) },
      },
      palette: {
        registerMode: provider => { paletteMode = provider; return add(toDisposable(() => { if (paletteMode === provider) paletteMode = undefined })) },
        showMode: () => palette.show('default'),
      },
      agents: {
        register: ui => add(registerAgentUi(ui)),
      },
      chooser: {
        resolve: (itemId, fn) => {
          if (!manifest.contributes?.chooser?.items.some(i => i.id === itemId)) throw new Error(`item do seletor não declarado no manifesto de ${id}: ${itemId}`)
          chooserResolvers.set(itemId, fn)
          return add(toDisposable(() => { if (chooserResolvers.get(itemId) === fn) chooserResolvers.delete(itemId) }))
        },
      },
      status: {
        register: item => {
          if (!manifest.contributes?.status?.some(s => s.id === item.id)) throw new Error(`status não declarado no manifesto de ${id}: ${item.id}`)
          const handle = statusRegistry.register(item)
          add(handle)
          return handle
        },
      },
      pads: {
        register: type => {
          if (!manifest.contributes?.pads?.some(p => p.id === type.id)) throw new Error(`prancheta não declarada no manifesto de ${id}: ${type.id}`)
          padTypes.set(type.id, type)
          sidebars?.render()
          return add(toDisposable(() => { if (padTypes.get(type.id) === type) padTypes.delete(type.id) }))
        },
        open: padId => sidebars?.open(padId),
        frames: host => {
          if (!manifest.contributes?.pads?.some(p => p.id === host.padId && p.frames)) throw new Error(`prancheta sem quadros no manifesto de ${id}: ${host.padId}`)
          return newFramesPad(host)
        },
      },
      keybindings: {
        fixed: () => allFixedBindings(),
        commands: () => keybindingCommands(),
        table: () => keyTable(),
        apply: bindings => applyKeybindings(bindings),
        defaults: () => mergeKeybindings([], new Set(commands.all().map(c => c.id))).bindings,
        file: () => keybindingsFile,
        onDidChangeFile: listener => { keybindingsFileListeners.add(listener); return add(toDisposable(() => { keybindingsFileListeners.delete(listener) })) },
        fixedBindings: provider => { fixedBindingProviders.push(provider); return add(toDisposable(() => { const i = fixedBindingProviders.indexOf(provider); if (i !== -1) fixedBindingProviders.splice(i, 1) })) },
      },
      files: {
        didRename: (from, to) => { for (const l of [...renameListeners]) { try { l({ from, to }) } catch (err) { console.error('onDidRename', err) } } },
        onDidRename: listener => { renameListeners.add(listener); return add(toDisposable(() => { renameListeners.delete(listener) })) },
      },
      shell: {
        writeClipboard: text => window.tether.writeClipboard(text),
        openPath: path => window.tether.openPath(path),
        openExternal: url => window.tether.openExternal(url),
      },
      test: {
        expose: (name, value) => {
          (extTestHooks[id] ??= {})[name] = value
          const hooks = window.__tether as unknown as Record<string, unknown> | undefined
          if (hooks && !(name in hooks)) hooks[name] = value
        },
      },
    }
  }
  rendererActivation = activateExtensions(extensions, apiFor, extensionStore, extSettings.disabled)
  // A failed extension takes back what it declared (its keys, ≡ items, chooser items); a disabled or failed one leaves
  // placeholders for its saved panes.
  for (const f of rendererActivation.failed) contributionStores.get(f.id)?.dispose()
  for (const e of extensions) {
    const failed = rendererActivation.failed.some(f => f.id === e.manifest.id)
    if (failed || rendererActivation.disabled.includes(e.manifest.id)) registerPlaceholders(e.manifest, failed)
  }
}

registerCorePaneTypes()
activateRendererExtensions()
setupDock()
void paintGeometry()
manager = new ProfileManager({
  profiles: () => profiles,
  problem: () => profilesProblem,
  slots: () => [...slots.values()],
  pickFolder: initial => window.tether.pickFolder(initial),
  save: input => window.tether.saveProfile(input),
  delete: id => window.tether.deleteProfile(id),
  reload: loadProfiles,
})
themeDialog = new TerminalThemeDialog({
  appearance: () => appearance,
  scheme: () => theme.scheme,
  apply: a => { void changeAppearance(a) },
})
setupUi()
setupTestHooks()
void loadProfiles()
window.tether.onOpenProfiles(() => openProfiles())
window.tether.onOpenTerminalTheme(() => themeDialog.show())
window.tether.onTerminalAppearance(a => { void onAppearance(a) })
window.tether.onEvent(onDaemonEvent)
window.tether.onConnection(state => { void onConnection(state) })
window.tether.onTheme(applyTheme)
void window.tether.getTheme().then(applyTheme)
window.tether.onFontSizeCommand(runFontSizeCommand)
window.tether.onUi(applyUi)
void window.tether.getUi().then(applyUi)
window.tether.onConfirmations(c => { confirmations = c })
void window.tether.getConfirmations().then(c => { confirmations = c })
window.tether.onAsk(req => { void onAsk(req) })
// The tray menu picked a pane: wait for the layout to be restored (the window may have just been recreated), then focus it.
window.tether.onOpenDrawer(() => {
  void (async () => {
    for (let i = 0; i < 100 && !layoutRestored; i++) await new Promise(r => setTimeout(r, 100))
    setDrawerOpen(true)
  })()
})
window.tether.onFocusSlot(slotId => {
  void (async () => {
    for (let i = 0; i < 100 && !(layoutRestored && slots.has(slotId)); i++) await new Promise(r => setTimeout(r, 100))
    openSlot(slotId)
  })()
})
