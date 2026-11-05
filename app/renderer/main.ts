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
import { CommandRegistry, type CommandContext } from './commands.ts'
import { DUPLICATE_LABEL, duplicateRequest, EMPTY_SUFFIX, NEW_FRAME_LABEL, NEW_PANEL_LABEL, PLACEMENT_LABEL, shortcutOf, SPLIT_EMPTY_LABEL, type Direction, type Target } from './create.ts'
import { editorKeyOwner, terminalKeyOwner } from './key-capture.ts'
import { defineTheme, monaco } from './monaco.ts'
import { NotePanel, NoteTab, type NoteHost, type NoteSnapshot } from './note-panel.ts'
import { paneCwdOfNote } from './note-rules.ts'
import { cleanNoteName, isNotePanelId, newNotePanelId, NOTE_COMPONENT, NOTE_TAB, noteDirOf, noteTitle, withNote } from '../shared/notes.ts'
import { EMPTY_COMPONENT, EMPTY_TAB, EMPTY_TITLE, isEmptyPanelId, newEmptyPanelId, withEmpty, type EmptyOrigin } from '../shared/empty.ts'
import { EmptyPanel, EmptyTab, type EmptyHost, type EmptySnapshot } from './empty-panel.ts'
import { type Choice, rememberProfile } from './chooser-rules.ts'
import { Chooser, type ChooserHost, type ChooserSnapshot, type ChooserState } from './chooser.ts'
import { CommandPalette } from './palette.ts'
import { QuickOpen, quickOpenFailedSituation } from './quick-open.ts'
import type { PaletteMode } from './palette-rules.ts'
import { type Desk, type DeskHost, transferFrame, transferPanel } from './desk.ts'
import { DeskSet } from './desk-set.ts'
import { DeskSwitch, type DeskAttention } from './desk-switch.ts'
import { deskTokens, readDeskColor } from './desks.ts'
import { DEFAULT_UI, type UiSettings } from '../shared/ui-settings.ts'
import { cycleDesk, deskAt, neighbourDesk } from './desks.ts'
import { askDialog, dialogOpen } from './dialog.ts'
import { Drawer } from './drawer.ts'
import { CLOSED, closeDrawer, countAttention, escAction, focusAfterClose, openDrawer, quickCwd, type DrawerState } from './drawer-rules.ts'
import { badgeParts, buttonTitle, forgetEndedSituation, groupClosed, headerText, type ClosedGroups } from './closed-slots.ts'
import { icon, KIND_ICON, type IconName } from './icons.ts'
import { openMoveDialog } from './move-dialog.ts'
import { buildTree, DRAWER_SCOPE, type FrameViewJSON, type MoveMode, type MoveOp, type ScopeModel } from './move-rules.ts'
import { drawerOf, emptyLayout, isPersonChange, type LayoutV2, migrateLayout, orphanedPanels, planRestore } from './layout.ts'
import { detailsLabel, detailsOpen, withDetails } from './pane-details.ts'
import { hintOf, QueueOrder, sameHint, type PaneHint } from './loading.ts'
import { TabStripActions } from './tab-strip.ts'
import { effectiveStatus, KIND_LABEL, SlotTab, STATUS_LABEL, TerminalPanel, panelTitle, type PanelAction, type PanelHost, type SlotError } from './panel.ts'
import { defaultOf, ProfileManager } from './profiles.ts'
import { shortcutHint, terminalInputOf } from './shortcuts.ts'
import { closeDeskSituation, closePanelSituation, folderName, moveFailedSituation, NO_PROFILE, noteConflictSituation, noteGitignoreSituation, quitAllSituation, relaunchFailedSituation, reloadAllSituation, switchProfileFailedSituation, switchProfileSituation, switchProfileUnconfirmedSituation } from './situations.ts'
import { loadTerminalFonts, TerminalThemeDialog, terminalFontsLoaded } from './terminal-theme.ts'
import { restartDaemonSituation, trayFirstCloseSituation } from './tray-situations.ts'

const COMPONENT = 'terminal'
const TAB = 'slot-tab'
const SAVE_DEBOUNCE_MS = 300

const slots = new Map<string, SlotState>()
const panels = new Map<string, TerminalPanel>()
const tabs = new Map<string, SlotTab>()
/** The note panes (F5): no slot behind them, a file each (app/renderer/note-panel.ts). */
const notes = new Map<string, NotePanel>()
const noteTabs = new Map<string, NoteTab>()
/** The empty panes (F5): a reserved place with the chooser inside (app/renderer/empty-panel.ts). */
const empties = new Map<string, EmptyPanel>()
/** Removes the editor actions registered as commands by the last note that got the focus. */
let editorCommandsOff: (() => void) | undefined
/** Error of the last refused `start` per slot (the daemon does not store `already-open` / `unconfirmed`). */
const startErrors = new Map<string, SlotError>()
/** Slots with a `start` request in flight. */
const pendingStarts = new Set<string>()
let desks: DeskSet
let strip: DeskSwitch
/** Chrome preferences (settings.json `ui`). */
let ui: UiSettings = DEFAULT_UI
let drawer: Drawer
/** Open/closed and the pane that gets the keyboard back (app/renderer/drawer-rules.ts). Never persisted: the app starts with the drawer closed. */
let drawerState: DrawerState = CLOSED
/** The element that had the keyboard when the drawer opened, for when it was not a pane. */
let drawerReturnEl: HTMLElement | undefined
/** When the last Esc that counts toward a double Esc happened (a shell at its prompt, inside the drawer). */
let lastEsc: number | undefined
/** The drawer's default shell is being created. */
let quickShellBusy = false
/** The whole file as last loaded; what the app keeps in memory (desks, drawer) is rewritten from the live state. */
let layoutFile: LayoutV2 = emptyLayout()
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
const appearanceReady: Promise<void> = window.tether.getTerminalAppearance().then(async a => { appearance = a; await loadTerminalFonts(a) })
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
  return { pane: !!currentDesk().activePanel, desks: desks.desks.length, drawerOpen: drawer.isOpen, focus }
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
    if (ev.key === 'Escape' && !ev.ctrlKey && !ev.altKey && !ev.shiftKey && !ev.metaKey) return drawerEscapeInTerminal(panel)
    // Line editing (macOS: Cmd/Option + arrows, Backspace; Shift+Enter everywhere in an agent pane): bytes for the prompt, not app chords.
    const seq = terminalInputOf(ev, slots.get(panel.slotId)?.kind !== 'shell')
    if (seq !== undefined) {
      ev.preventDefault()
      panel.sendInput(seq)
      return true
    }
    // App shortcuts: keep xterm from sending them as input; the event still bubbles to the document listener,
    // which runs the command. Plain Ctrl+letter stays the terminal's unless key-capture.ts lists it.
    // (Clipboard chords are the panel's own: shortcuts.ts PANE_SHORTCUTS.)
    return terminalKeyOwner(ev).owner === 'app'
  },
  getScheme: () => theme.scheme,
  getAppearance: () => appearance,
  onSwitchProfile: id => { void switchProfile(id) },
  onToggleDetails: id => togglePaneDetails(id),
  onOpenFolder: id => openFolder(id),
  onCopyFolder: id => copyFolder(id),
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
  // The note editors: one theme for every Monaco editor, rebuilt from the tokens just painted.
  monaco.editor.setTheme(defineTheme(state.scheme))
  themeDialog?.refresh()
  for (const li of document.querySelectorAll<HTMLElement>('#app-menu li[data-theme], #theme-menu li[data-theme]')) li.setAttribute('aria-checked', String(li.dataset.theme === state.setting))
  const btn = $('btn-theme')
  btn.replaceChildren(icon(state.setting === 'light' ? 'sun' : state.setting === 'dark' ? 'moon' : 'circle-half'))
  btn.title = `Tema: ${THEME_LABEL[state.setting]}`
}

const THEME_LABEL: Record<ThemeState['setting'], string> = { light: 'Claro', auto: 'Automático', dark: 'Escuro' }

/** Applies the chrome preferences: the desk colour line and its check in the ≡ menu. */
function applyUi(next: UiSettings): void {
  ui = next
  document.body.classList.toggle('desk-line', ui.deskLine)
  document.querySelector('#app-menu li[data-command="ui.desk-line"]')?.setAttribute('aria-checked', String(ui.deskLine))
}

// ---------- terminal appearance ----------

/** Puts an appearance on every pane (and the dialog's sample); the font must be loaded already. */
function applyAppearance(a: TerminalAppearance): void {
  appearance = a
  for (const p of panels.values()) p.setAppearance(a, theme.scheme)
  for (const n of notes.values()) n.setAppearance(a)
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
function deskHost(scope: 'desk' | 'drawer' = 'desk'): DeskHost {
  return {
    dockviewOptions: () => ({
      defaultTabComponent: TAB,
      createComponent: ({ name }) => {
        if (name === EMPTY_COMPONENT) {
          const empty = new EmptyPanel(emptyHost)
          const init = empty.init.bind(empty)
          empty.init = params => { init(params); empties.set(empty.id, empty) }
          const dispose = empty.dispose.bind(empty)
          empty.dispose = () => { dispose(); if (empties.get(empty.id) === empty) empties.delete(empty.id) }
          return empty
        }
        if (name === NOTE_COMPONENT) {
          const note = new NotePanel(noteHost)
          const init = note.init.bind(note)
          note.init = params => { init(params); notes.set(note.id, note) }
          const dispose = note.dispose.bind(note)
          note.dispose = () => { dispose(); if (notes.get(note.id) === note) notes.delete(note.id) }
          return note
        }
        const panel = new TerminalPanel(host)
        const init = panel.init.bind(panel)
        panel.init = params => { init(params); panels.set(panel.slotId, panel) }
        const dispose = panel.dispose.bind(panel)
        panel.dispose = () => { dispose(); if (panels.get(panel.slotId) === panel) panels.delete(panel.slotId) }
        return panel
      },
      createTabComponent: ({ name }) => {
        if (name === EMPTY_TAB) return new EmptyTab(emptyHost)
        if (name === NOTE_TAB) {
          const tab = new NoteTab(noteHost, id => notes.get(id)?.dirty ?? false)
          const init = tab.init.bind(tab)
          tab.init = params => { init(params); noteTabs.set(params.api.id, tab) }
          const dispose = tab.dispose.bind(tab)
          tab.dispose = () => { dispose(); for (const [id, t] of noteTabs) if (t === tab) noteTabs.delete(id) }
          return tab
        }
        const tab = new SlotTab(host, id => { void closePanel(id) })
        const init = tab.init.bind(tab)
        tab.init = params => { init(params); tabs.set(params.api.id, tab) }
        const dispose = tab.dispose.bind(tab)
        tab.dispose = () => { dispose(); for (const [id, t] of tabs) if (t === tab) tabs.delete(id) }
        return tab
      },
      // The tab strip measures its own overflow ("+N", tab-strip.ts): dockview's scroll-based list is off.
      disableTabsOverflowList: true,
      createRightHeaderActionComponent: () => new TabStripActions({
        describe: id => {
          const s = slots.get(id)
          return { icon: s ? KIND_ICON[s.kind] : notes.has(id) ? 'note-pencil' : empties.has(id) ? 'plus' : 'question', label: findPanel(id)?.api.title ?? id, attention: !!s?.attention }
        },
        showHidden: (x, y, list, pick, opener) => showContextMenu(x, y, list.map(t => ({ icon: t.icon, label: t.label, attention: t.attention, run: () => pick(t.id) })), opener),
        paneMenu: (id, x, y, opener) => { menuOpener = opener; showTabMenu(id, x, y) },
        toggleDetails: id => togglePaneDetails(id),
        addTab: id => { newTabBeside(id) },
      }),
      createWatermarkComponent: () => {
        const el = document.createElement('div')
        el.className = 'watermark'
        el.innerHTML = `<p>Nenhum painel aberto.</p><p>${kbdHtml(shortcutHint({ op: 'new-tab' }))} ou "+ ${NEW_PANEL_LABEL}" para abrir um terminal.</p>`
        return { element: el, init: () => {} }
      },
    }),
    // Only changes the person can make are saved: a hint or title the app updates is not one (isPersonChange).
    onLayoutChange: reasons => { if (isPersonChange(reasons)) scheduleSave() },
    onPanelsChange: () => { refreshClosedMenu(); renderStrip() },
    onEdge: (target, op, frameId, at) => onEdge(target, op, frameId, at, scope === 'drawer' ? drawer.desk : undefined),
    onActivePanelChange: () => { noteActive(currentDesk().activePanel?.id); markSeenIfWatched() },
  }
}

function setupDock(): void {
  const bar = $('toolbar')
  strip = new DeskSwitch($('desk-switch'), bar, [bar.querySelector<HTMLElement>('.tb-left')!, bar.querySelector<HTMLElement>('.tb-right')!], {
    switchTo: id => desks.switchTo(id),
    create: () => { if (!drawer.isOpen) desks.create('after', desks.desks.at(-1)?.id) },
    rename: (id, name) => desks.rename(id, name),
    recolor: (id, color) => desks.recolor(id, color),
    menu: (id, x, y) => showDeskMenu(id, x, y),
    overflowMenu: (entries, x, y, pick, opener) => showContextMenu(x, y, entries.map(e => ({ icon: 'cards' as const, label: e.attention > 0 ? `${e.name} (${e.attention})` : e.name, run: () => pick(e.id) })), opener),
    hint: position => shortcutHint({ op: 'desk-go', position }),
  })
  desks = new DeskSet($('dock'), {
    deskHost: () => deskHost(),
    onDesksChange: () => { renderStrip(); scheduleSave() },
    onSwitch: () => focusActivePane(),
    paneOptions: panel => isNotePanelId(panel.id)
      ? { id: panel.id, component: NOTE_COMPONENT, tabComponent: NOTE_TAB, title: panel.title ?? panel.id, params: panel.params ?? {} }
      : isEmptyPanelId(panel.id)
        ? { id: panel.id, component: EMPTY_COMPONENT, tabComponent: EMPTY_TAB, title: EMPTY_TITLE, params: panel.params ?? withEmpty(undefined) }
        : { id: panel.id, component: COMPONENT, tabComponent: TAB, title: panel.title ?? panel.id, params: panel.params ?? { slotId: panel.id } },
  }, DOCK_THEME)
  desks.fromEmpty()
  drawer = new Drawer($('drawer'), { deskHost: () => deskHost('drawer'), onMargin: () => setDrawerOpen(false) }, DOCK_THEME)
}

/** "Ctrl+Shift+T" as <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd>. */
function kbdHtml(hint: string): string {
  return hint.split('+').map(k => `<kbd>${k}</kbd>`).join('+')
}

/** The file to write: every desk and the drawer as mounted now. */
function layoutJSON(): LayoutV2 {
  return { ...layoutFile, v: 2, ...desks.toJSON(), drawer: drawer.toJSON() }
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

/** The dockview options of a note's pane (a fresh id). */
function notePanelOptions(path: string): AddPanelOptions {
  return { id: newNotePanelId(), component: NOTE_COMPONENT, tabComponent: NOTE_TAB, title: noteTitle(path), params: withNote(undefined, { path }) }
}

/** The dockview options of an empty pane (a fresh id), suggesting `cwd` in its chooser; `origin` says what Esc does in it. */
function emptyPanelOptions(cwd: string | undefined, origin: EmptyOrigin = 'layout'): AddPanelOptions {
  return { id: newEmptyPanelId(), component: EMPTY_COMPONENT, tabComponent: EMPTY_TAB, title: EMPTY_TITLE, params: withEmpty(cwd, origin) }
}

/** Adds any pane (slot, note, empty) relative to `reference` at `target`'s level, in its desk or the drawer; `into` forces the drawer. */
function addPaneOptions(options: AddPanelOptions, target?: Target, reference?: string, into?: 'drawer'): IDockviewPanel {
  const useDrawer = into === 'drawer' || (reference ? inDrawer(reference) : drawer.isOpen)
  const panel = (useDrawer ? drawer.desk : desks).addPanel(options, target, reference)
  panel.api.setActive()
  return panel
}

/** The pane's opening folder: a terminal's cwd, a note's repository, an empty pane's suggestion; undefined for none. */
function paneCwdOf(id: string | undefined): string | undefined {
  if (!id) return undefined
  const slot = slots.get(id)
  if (slot) return slot.cwd
  const note = notes.get(id)
  if (note) return note.cwd ?? paneCwdOfNote(note.path)
  return empties.get(id)?.cwd || undefined
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
  for (const p of desks.desk(deskId)?.panels ?? []) {
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
  if (active) $('dock').style.setProperty('--desk-line-color', deskTokens(active.color).fill)
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
  (panels.get(id) ?? notes.get(id) ?? empties.get(id))?.focus()
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
  const panes = desks.desk(id)?.panels ?? []
  if (panes.length > 0) {
    const neighbour = neighbourDesk(desks.desks, id)!
    const states = panes.map(p => slots.get(p.id)).filter((s): s is SlotState => s !== undefined)
    const answer = await askDialog(closeDeskSituation(deskName(id), states, deskName(neighbour)))
    if (answer.choice === 'move') {
      // Frame by frame, so the split layouts travel along; whatever is left goes pane by pane.
      for (const frameId of [...(desks.desk(id)?.frameIds ?? [])]) desks.moveFrame(id, frameId, neighbour)
      for (const p of [...(desks.desk(id)?.panels ?? [])]) desks.movePanel(p.id, neighbour)
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

/** The Desk new panes go to and the shortcuts act on: the drawer's while it is open, else the visible desk. */
function currentDesk(): Desk {
  return drawer?.isOpen ? drawer.desk : desks.active
}

/** A pane lives in one place: a desk or the drawer. */
function findPanel(slotId: string): IDockviewPanel | undefined {
  return desks.getPanel(slotId) ?? drawer?.desk.getPanel(slotId) // the drawer does not exist yet while the first desk is built
}

function allPanels(): IDockviewPanel[] {
  return [...desks.panels, ...(drawer?.desk.panels ?? [])]
}

function inDrawer(slotId: string): boolean {
  return drawer?.desk.getPanel(slotId) !== undefined
}

function removeAnyPanel(panel: IDockviewPanel): void {
  if (drawer?.desk.getPanel(panel.id)) drawer.desk.removePanel(panel)
  else desks.removePanel(panel)
}

/** The parts of the window behind the drawer: inert while it is open, so the keyboard cannot wander into them. */
const BEHIND_DRAWER = ['toolbar', 'dock']

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
  badge.className = `drawer-badge ${att.waiting > 0 ? 'waiting' : 'done'}`
  badge.textContent = String(total)
  btn.setAttribute('aria-expanded', String(drawer.isOpen))
  const n = drawer.desk.panels.length
  // The invitation shows when nothing is in the drawer and no quick shell is on its way (that one has the stage).
  drawer.setEmpty(n === 0 && !quickShellBusy)
  const what = n === 0 ? 'vazia' : n === 1 ? '1 painel' : `${n} painéis`
  const waiting = att.waiting > 0 ? ` · ${att.waiting} esperando você` : ''
  const done = att.done > 0 ? ` · ${att.done} terminou` : ''
  btn.title = `Gaveta (${shortcutHint({ op: 'drawer-toggle' })}): ${what}${waiting}${done}. Um espaço rápido, compartilhado por todas as mesas; fechada, os agentes dela seguem rodando.`
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
    desks.active.hidePlus()
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
function scopeDesk(scope: string): Desk | undefined {
  return scope === DRAWER_SCOPE ? drawer.desk : desks.desk(scope)
}

function scopeOf(slotId: string): string | undefined {
  return inDrawer(slotId) ? DRAWER_SCOPE : desks.deskOf(slotId)
}

/** The destination tree from the live desks, frames and drawer. */
function moveTree(): ScopeModel[] {
  const framesOf = (d: Desk | undefined): { id: string; view: FrameViewJSON }[] =>
    (d?.frameIds ?? []).flatMap(id => { const f = d!.frames.get(id); return f ? [{ id, view: f.dock.toJSON() as unknown as FrameViewJSON }] : [] })
  return buildTree({
    drawer: { frames: framesOf(drawer.desk) },
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
    paneIcon: id => { const kind = slots.get(id)?.kind; return kind ? KIND_ICON[kind] : notes.has(id) ? 'note-pencil' : empties.has(id) ? 'plus' : 'question' },
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
  const visible = op.scope === (drawer.isOpen ? DRAWER_SCOPE : desks.activeDeskId)
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
  const { layout, orphaned } = planRestore(result?.layout ?? null, new Set(slots.keys()))
  if (layout) {
    layoutFile = layout
    // The geometry painted at startup had every pane of the file; only when the daemon does not list some is the
    // desk rebuilt from the pruned JSON (the same loss-proof path: grid refused → frames side by side, frame
    // refused → panes one by one). Nothing is attached yet, so the rebuild loses nothing.
    if (orphaned.length) { desks.load(layout); drawer.load(drawerOf(layout)) }
    // A v1 file is copied to layout.v1.bak now; layout.json itself stays v1 until the person changes something.
    if (result?.migrated) await window.tether.backupLayout()
  } else {
    layoutFile = emptyLayout()
  }
  // Only what the person does from here on is saved; a slot missing from the daemon's list is not a change of theirs.
  if (orphaned.length) console.warn('painéis sem slot no tetherd, fora da tela até a próxima ação:', orphaned)
  await discardPendingSave()
  layoutRestored = true
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
    if (result && !layoutRestored) { desks.load(result.layout); drawer.load(drawerOf(result.layout)) }
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
    for (const id of orphanedPanels(allPanels().map(p => p.id), new Set(slots.keys()))) {
      const panel = findPanel(id)
      if (panel) removeAnyPanel(panel)
    }
    await discardPendingSave()
    for (const p of panels.values()) { p.render(); void p.reattach() }
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
  const kind = document.createElement('span'); kind.className = `kind ${s.kind}`; kind.append(icon(KIND_ICON[s.kind]))
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
  const deskId = desks.deskOf(slotId)
  if (deskId && deskId !== desks.activeDeskId) desks.switchTo(deskId)
  const panel = desks.getPanel(slotId) ?? addPanel(s)
  if (effectiveStatus(s) === 'exited') void startSlot(s.slotId)
  panel.api.setActive()
}

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

interface MenuItem { icon: IconName; label: string; run(): void; danger?: boolean; attention?: boolean }
/** A thin line between groups of items. */
const SEP = 'sep' as const
type MenuEntry = MenuItem | typeof SEP

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
    const lis = [...menu.querySelectorAll<HTMLElement>('li[role=menuitem]')]
    const i = lis.indexOf(document.activeElement as HTMLElement)
    if (ev.key === 'Escape') { ev.preventDefault(); close(true) }
    else if (ev.key === 'Tab') { ev.preventDefault(); close(true) }
    else if (ev.key === 'ArrowDown') { ev.preventDefault(); lis[(i + 1) % lis.length]?.focus() }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); lis[(i - 1 + lis.length) % lis.length]?.focus() }
    else if (ev.key === 'Home') { ev.preventDefault(); lis[0]?.focus() }
    else if (ev.key === 'End') { ev.preventDefault(); lis[lis.length - 1]?.focus() }
    else if ((ev.key === 'Enter' || ev.key === ' ') && i >= 0) { ev.preventDefault(); lis[i]!.click() }
  }
  for (const item of items) {
    if (item === SEP) { const sep = document.createElement('li'); sep.className = 'sep'; sep.setAttribute('role', 'separator'); menu.append(sep); continue }
    const li = document.createElement('li'); li.setAttribute('role', 'menuitem'); li.tabIndex = -1
    if (item.danger) li.classList.add('danger')
    li.append(icon(item.icon), document.createTextNode(item.label))
    if (item.attention) { const dot = document.createElement('span'); dot.className = 'attn-dot'; dot.setAttribute('aria-label', 'pede atenção'); li.append(dot) }
    li.addEventListener('click', ev => {
      ev.stopPropagation(); close(false); item.run()
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
  menu.querySelector<HTMLElement>('li[role=menuitem]')?.focus()
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
    if (!notes.has(slotId)) return
    panel?.api.setActive()
    showNoteMenu(slotId, x, y)
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
    { icon: 'copy', label: 'Copiar pasta', run: () => copyFolder(slotId) },
    { icon: 'folder-open', label: 'Abrir pasta no Explorer', run: () => openFolder(slotId) },
    SEP,
    { icon: 'arrow-square-out', label: 'Mover…', run: () => { void openMove(slotId) } },
    SEP,
    { icon: 'x', label: 'Fechar painel…', run: () => { void closePanel(slotId) } },
  ])
}

/** The note's tab menu: new things next to it, the file (rename, save as, its folder), where it lives, close. */
function showNoteMenu(id: string, x: number, y: number): void {
  const note = notes.get(id)
  if (!note) return
  showContextMenu(x, y, [
    { icon: 'plus', label: NEW_PANEL_LABEL, run: () => { void openNewDialog({ reference: id }) } },
    { icon: 'note-pencil', label: 'Nova nota', run: () => { void newNote() } },
    SEP,
    { icon: 'pencil-simple', label: 'Renomear…', run: () => noteTabs.get(id)?.startRename() },
    { icon: 'floppy-disk', label: 'Salvar nota como…', run: () => { void saveNoteAs(id) } },
    { icon: 'copy', label: 'Copiar caminho da nota', run: () => window.tether.writeClipboard(note.path) },
    { icon: 'folder-open', label: 'Abrir pasta da nota no Explorer', run: () => { void window.tether.openPath(noteDirOf(note.path)).then(r => { if (!r.ok) console.warn(`open folder: ${r.message}`) }) } },
    SEP,
    { icon: 'arrow-square-out', label: 'Mover…', run: () => { void openMove(id) } },
    SEP,
    { icon: 'x', label: 'Fechar nota', run: () => closeNote(id) },
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
 * Resolves what the person picked in a chooser into the pane to add: a slot created by the daemon, a note file
 * prepared or picked, or an empty pane. `undefined` when nothing is to be added (a file dialog cancelled, a note
 * already open and now focused); `{ error }` with the message to show in the chooser.
 */
async function resolveChoice(choice: Choice, cwd: string): Promise<{ options: AddPanelOptions; after?: () => Promise<void> } | { error: string } | undefined> {
  if (choice.kind === 'profile') {
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
  if (choice.kind === 'note-new') {
    const prepared = await window.tether.notePrepare(cwd || undefined)
    if (cwd) await window.tether.rememberFolder(cwd)
    const after = prepared.askGitignore ? async (): Promise<void> => {
      const answer = await askDialog(noteGitignoreSituation(prepared.askGitignore!))
      await window.tether.noteGitignore(prepared.askGitignore!, answer.choice === 'add')
    } : undefined
    return { options: notePanelOptions(prepared.path), ...(after ? { after } : {}) }
  }
  const picked = await window.tether.notePickOpen(cwd || undefined)
  if (!picked) return undefined
  const existing = noteByPath(picked)
  if (existing) { findPanel(existing.id)?.api.setActive(); existing.focus(); return undefined }
  return { options: notePanelOptions(picked) }
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

// ---------- notes (F5) ----------
// A note is a pane with a file instead of a slot (app/renderer/note-panel.ts). Its text is written by the panel
// itself; here live the ways a note is born (new, opened from the disk), its file operations through the tab, and
// what the layout keeps of it (the view state goes to the pane params and is saved with the layout).

/** What the panels need from the renderer. */
const noteHost: NoteHost = {
  getScheme: () => theme.scheme,
  getAppearance: () => appearance,
  onFocus: (panel, focused) => {
    // The actions stay registered while the focus is on a transient surface (the palette lists them); the next
    // focused note replaces them, and a disposed note removes its own.
    if (focused) { editorCommandsOff?.(); editorCommandsOff = commands.register(...panel.commands()); editorCommandsOwner = panel }
    else if (editorCommandsOwner === panel && !panel.editor) { editorCommandsOff?.(); editorCommandsOff = undefined; editorCommandsOwner = undefined }
  },
  onViewChange: panel => {
    const p = findPanel(panel.id)
    if (!p) return
    const view = panel.viewState()
    p.api.updateParameters(withNote(p.params, { path: panel.path, ...(view ? { view } : {}) }))
    scheduleSave()
  },
  onDirtyChange: panel => noteTabs.get(panel.id)?.render(),
  askConflict: panel => askDialog(noteConflictSituation(panel.path)).then(a => (a.choice === 'reload' ? 'reload' : 'keep')),
  onTabMenu: (id, ev) => showTabMenu(id, ev.clientX, ev.clientY),
  onRename: (id, name) => { void renameNote(id, name) },
  onClose: id => closeNote(id),
}
let editorCommandsOwner: NotePanel | undefined

/** Adds the pane of a note (in the reference's group by default, or at `target` relative to it). */
function addNotePanel(path: string, reference?: string, target?: Target): IDockviewPanel {
  const panel = addPaneOptions(notePanelOptions(path), target, reference)
  scheduleSave()
  return panel
}

/** The folder a new note belongs to: the active pane's opening folder (a terminal's cwd; a note's own repository; an empty pane's suggestion), or none. */
function paneCwdForNote(): string | undefined {
  return paneCwdOf(currentDesk().activePanel?.id)
}

/** "Nova nota": a file under the active pane's folder (`.tether/notes/`), opened beside it; in a git repository, the `.gitignore` question once. */
async function newNote(): Promise<void> {
  const reference = currentDesk().activePanel?.id
  const prepared = await window.tether.notePrepare(paneCwdForNote())
  const panel = addNotePanel(prepared.path, reference)
  requestAnimationFrame(() => focusPane(panel.id))
  if (prepared.askGitignore) {
    const answer = await askDialog(noteGitignoreSituation(prepared.askGitignore))
    await window.tether.noteGitignore(prepared.askGitignore, answer.choice === 'add')
    focusPane(panel.id)
  }
}

/** The open note showing `path`, if any (paths compared case-insensitively: Windows). */
function noteByPath(path: string): NotePanel | undefined {
  const key = path.toLowerCase()
  for (const n of notes.values()) if (n.path.toLowerCase() === key) return n
  return undefined
}

/** "Abrir nota…": the OS file dialog; a file already open is focused instead of opened twice. */
async function openNote(path?: string): Promise<void> {
  const reference = currentDesk().activePanel?.id
  const picked = path ?? await window.tether.notePickOpen(paneCwdForNote())
  if (!picked) return
  const existing = noteByPath(picked)
  if (existing) { findPanel(existing.id)?.api.setActive(); existing.focus(); return }
  const panel = addNotePanel(picked, reference)
  requestAnimationFrame(() => focusPane(panel.id))
}

/**
 * Quick Open's text file: in the focused pane's tab group (or beside it), as a note tab that remembers the root it
 * was opened from (the next Ctrl+P from it searches the same folder); a tab already showing the file is focused.
 */
function openQuickOpenFile(path: string, opts: { side: boolean; position?: { line: number; column?: number }; root: string }): void {
  const existing = noteByPath(path)
  if (existing) {
    findPanel(existing.id)?.api.setActive()
    existing.focus()
    if (opts.position) existing.reveal(opts.position)
    return
  }
  const reference = currentDesk().activePanel?.id
  const options = { ...notePanelOptions(path), params: withNote(undefined, { path, ...(opts.root ? { cwd: opts.root } : {}) }) }
  const panel = addPaneOptions(options, opts.side ? { level: 'pane', placement: 'right' } : undefined, reference)
  scheduleSave()
  if (opts.position) notes.get(panel.id)?.reveal(opts.position)
  requestAnimationFrame(() => focusPane(panel.id))
}

const quickOpen = new QuickOpen({
  paneCwd: () => paneCwdOf(currentDesk().activePanel?.id),
  openText: openQuickOpenFile,
  notify: message => { void askDialog(quickOpenFailedSituation(message)) },
})

/** "Salvar nota como…": the OS save dialog; the note moves to the chosen file (the old one stays as it was). */
async function saveNoteAs(id = activeNoteId()): Promise<void> {
  const note = id ? notes.get(id) : undefined
  if (!note) return
  const picked = await window.tether.notePickSaveAs(note.path)
  if (!picked || picked === note.path) { note.focus(); return }
  await note.saveAs(picked)
  noteTabs.get(note.id)?.render()
  note.focus()
}

/** The active pane when it is a note (the keyboard's last owner when the active pane is not conclusive). */
function activeNoteId(): string | undefined {
  const active = currentDesk().activePanel
  if (active && notes.has(active.id)) return active.id
  if (editorCommandsOwner && notes.has(editorCommandsOwner.id)) return editorCommandsOwner.id
  return undefined
}

/** The tab's rename: the file is renamed in its folder (`.md` added when missing); a refusal keeps the old name. */
async function renameNote(id: string, typed: string): Promise<void> {
  const note = notes.get(id)
  const name = cleanNoteName(typed)
  if (!note || !name || name === noteTitle(note.path)) return
  const dir = noteDirOf(note.path)
  const sep = note.path.includes('\\') ? '\\' : '/'
  const to = dir ? `${dir}${sep}${name}` : name
  const r = await window.tether.noteRename(note.path, to)
  if (!r.ok) { console.warn(`renomear nota: ${r.message}`); return }
  note.setPath(to)
  noteTabs.get(id)?.render()
}

/** The tab's ×: the pane goes (its text is already on disk; the panel flushes what is pending). */
function closeNote(id: string): void {
  const panel = findPanel(id)
  if (panel) removeAnyPanel(panel)
}

/** Main's watcher saw the file change: the note that shows it decides (reload, keep, or ask). */
function onNoteChanged(path: string): void {
  const note = noteByPath(path)
  if (note) void note.onExternalChange()
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
    const where = inDrawer(ctx.panel.id) ? 'Gaveta' : deskName(desks.deskOf(ctx.panel.id) ?? desks.activeDeskId)
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

/**
 * A "+" near a border: the frame's active pane (or the desk's) is the reference. A click ADDS an empty pane there
 * (the chooser inside it, the reference's folder suggested; Esc closes it). The right-click menu: the same, duplicate
 * the reference there (the one place that still clones without asking, and the name says so), the chooser in focus mode.
 */
function onEdge(target: Target, op: 'add' | 'menu', frameId: string | undefined, at: { x: number; y: number }, scope: Desk = currentDesk()): void {
  const reference = (frameId ? scope.frames.get(frameId)?.dock.activePanel?.id : undefined) ?? scope.activePanel?.id
  const add = (): void => { addEmptyPanel(target, reference, paneCwdOf(reference), 'add') }
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
  activePane: () => { const a = currentDesk().activePanel; return a && (slots.has(a.id) || notes.has(a.id) || empties.has(a.id)) ? a.id : undefined },
  renamePane: id => (notes.has(id) ? noteTabs.get(id)?.startRename() : tabs.get(id)?.startRename()),
  switchProfile: id => { if (slots.has(id)) void switchProfile(id) },
  toggleDetails: id => { if (slots.has(id)) togglePaneDetails(id) },
  copyFolder: id => { const n = notes.get(id); if (n) window.tether.writeClipboard(noteDirOf(n.path)); else if (slots.has(id)) copyFolder(id) },
  openFolder: id => { const n = notes.get(id); if (n) void window.tether.openPath(noteDirOf(n.path)); else if (slots.has(id)) openFolder(id) },
  movePane: id => { void openMove(id) },
  closePane: id => { void closePanel(id) },
  createDesk: side => { desks.create(side) },
  cycleDesk: step => desks.switchTo(cycleDesk(desks.desks, desks.activeDeskId, step)),
  goToDesk: position => { const id = deskAt(desks.desks, position); if (id) desks.switchTo(id) },
  deskActions: () => { const r = document.querySelector('#desk-switch .seg.on')?.getBoundingClientRect(); showDeskMenu(desks.activeDeskId, r?.left ?? 200, (r?.bottom ?? 40) + 4) },
  closeDesk: () => { void closeDesk(desks.activeDeskId) },
  toggleDrawer: () => setDrawerOpen(!drawer.isOpen),
  quickShell: () => { void quickShell() },
  setTheme: setting => window.tether.setTheme(normalizeTheme(setting)),
  toggleDeskLine: () => window.tether.setUi({ ...ui, deskLine: !ui.deskLine }),
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
  showPalette: mode => palette.show(mode),
  newNote: () => { void newNote() },
  openNote: () => { void openNote() },
  saveNoteAs: () => { void saveNoteAs() },
}

/** Something modal of ours is up: app chords stay quiet (the palette has its own keys). */
function modalOpen(): boolean {
  return $<HTMLDialogElement>('dlg-new').open || manager.open || themeDialog.open || dialogOpen() || palette.open
}

/** The ≡ menu: every item names a command; the hint, the greying and the run come from the registry. */
function setupMenu(): void {
  const btn = $('btn-menu')
  const menu = $('app-menu')
  const items = [...menu.querySelectorAll<HTMLElement>('li[data-command]')]
  for (const li of items) {
    const id = li.dataset.command!
    if (!commands.get(id)) throw new Error(`menu item without a command: ${id}`)
    const hint = commands.hint(id)
    if (hint) { const kbd = document.createElement('kbd'); kbd.textContent = hint; li.append(kbd) }
  }
  const toggle = (open: boolean): void => {
    menu.hidden = !open
    btn.setAttribute('aria-expanded', String(open))
    if (open) menu.querySelector<HTMLElement>('li[role^=menuitem]')?.focus()
  }
  btn.addEventListener('click', ev => {
    ev.stopPropagation()
    // Items whose command is unavailable now (no active pane, a single desk…) are greyed out, not hidden.
    const ctx = commandContext()
    for (const li of items) li.setAttribute('aria-disabled', String(!commands.isAvailable(commands.get(li.dataset.command!)!, ctx)))
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
    const li = (ev.target as HTMLElement).closest<HTMLElement>('li[role^=menuitem]')
    if (li) { ev.stopPropagation(); run(li) }
  })
  menu.addEventListener('keydown', ev => {
    const items = [...menu.querySelectorAll<HTMLElement>('li[role^=menuitem]')]
    const i = items.indexOf(document.activeElement as HTMLElement)
    if (ev.key === 'Escape') { ev.preventDefault(); toggle(false); btn.focus() }
    else if (ev.key === 'ArrowDown') { ev.preventDefault(); items[(i + 1) % items.length]?.focus() }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus() }
    else if (ev.key === 'Home') { ev.preventDefault(); items[0]?.focus() }
    else if (ev.key === 'End') { ev.preventDefault(); items[items.length - 1]?.focus() }
    else if (ev.key === 'Tab') toggle(false)
    else if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); if (i >= 0) run(items[i]!) }
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
  $('drawer-empty-new').querySelector('.de-kbd')!.remove() // "Novo painel…" has no chord now (Ctrl+Shift+T is the new empty tab)
  $('drawer-empty-quick').querySelector('.de-kbd')!.innerHTML = kbdHtml(shortcutHint({ op: 'drawer-toggle' }))
  $('drawer-duplicate').addEventListener('click', () => { void duplicateActive({ level: 'pane', placement: 'right' }) })
  $('drawer-close').addEventListener('click', () => setDrawerOpen(false))
  $('btn-profiles').addEventListener('click', () => openProfiles())
  commands.register(...appCommands(commandHost))
  palette = new CommandPalette($<HTMLDialogElement>('palette'), commands, quickOpen)
  setupMenu()
  const dup = $('btn-duplicate')
  const hint = (level: Target['level'], direction: Direction): string => shortcutHint({ op: 'duplicate', level, direction })
  dup.title = `${DUPLICATE_LABEL} ${PLACEMENT_LABEL.right} (${hint('pane', 'right')}): outro painel com o mesmo perfil e a mesma pasta, numa sessão nova. Setas com os mesmos modificadores duplicam para os outros lados; ${hint('frame', 'right')} na borda do quadro; ${hint('desk', 'right')} num quadro novo.`
  dup.addEventListener('click', () => { void duplicateActive({ level: 'pane', placement: 'right' }) })
  $('btn-new').title = `${NEW_PANEL_LABEL}: escolha o perfil, a pasta e onde abrir. ${shortcutHint({ op: 'new-tab' })} abre uma aba vazia no grupo ativo, com o seletor dentro.`
  $('btn-retry').addEventListener('click', () => window.tether.reconnect())
  setupThemeMenu()
  setupConnectionPopover()
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

  // The keyboard dispatch: a chord names a shortcut op (shortcuts.ts), the op names a command (the registry), the
  // command decides whether it is available now. Inside a terminal the key-capture policy applies first, the same
  // one the panel used to keep xterm away from the key (a key xterm kept, such as Ctrl+K, is never run here).
  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') { drawerEscapeOutside(ev); return }
    const target = ev.target instanceof Element ? ev.target : undefined
    // Inside a note's editor the editor's chords win (key-capture.ts editorKeyOwner); Monaco already stopped the ones it handled.
    const shortcut = target?.closest('.xterm') ? (o => o.owner === 'app' ? o.shortcut : undefined)(terminalKeyOwner(ev))
      : target?.closest('[data-editor]') ? (o => o.owner === 'app' ? o.shortcut : undefined)(editorKeyOwner(ev))
      : shortcutOf(ev)
    if (!shortcut) return
    if (modalOpen()) return
    const command = commands.byShortcut(shortcut)
    if (!command) return
    ev.preventDefault()
    if (command.ignoreRepeat && ev.repeat) return // a held chord is one toggle
    void commands.run(command.id, 'key')
  })
  // Back to the window: the pane in front of the user is seen.
  window.addEventListener('focus', () => markSeenIfWatched())
  document.addEventListener('visibilitychange', () => markSeenIfWatched())
  // The page goes (window closed, reload): every note's pending text is written.
  window.addEventListener('beforeunload', () => { for (const n of notes.values()) n.flush() })
  window.tether.onNoteChanged(onNoteChanged)
}

// Test hooks (Playwright reads these through page.evaluate).
declare global {
  interface Window {
    __tether: {
      /** The layout as it would be saved (v2: desks → frames → panes). */
      layout(): LayoutV2
      /** A frame's dockview JSON (the active frame when no id is given). */
      frameLayout(frameId?: string): SerializedDockview | undefined
      frameIds(): string[]
      activeFrameId(): string | undefined
      frameOf(slotId: string): string | undefined
      panelIds(): string[]
      activeId(): string | undefined
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
      /** Asks to close a panel exactly as the tab's × does (dialog included). */
      closePanel(slotId: string): void
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
      /** The note panes: file, text, what is on disk, cursor, selections, scroll, focus. */
      notes(): NoteSnapshot[]
      note(id: string): NoteSnapshot | undefined
      /** "Nova nota" as the command does (beside the active pane, the folder rule applied). */
      newNote(): Promise<void>
      /** Opens a note by path, as "Abrir nota…" does after the file dialog. */
      openNote(path: string): Promise<void>
      /** The ids of the editor actions registered as commands right now. */
      editorCommandIds(): string[]
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
    layout: () => layoutJSON(),
    frameLayout: frameId => (frameId ? desks.frames.get(frameId) : desks.activeFrame)?.dock.toJSON(),
    frameIds: () => desks.frameIds,
    activeFrameId: () => desks.activeFrame?.id,
    frameOf: slotId => desks.frameOf(slotId)?.id,
    panelIds: () => desks.panels.map(p => p.id),
    activeId: () => desks.activePanel?.id,
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
    closePanel: slotId => { void closePanel(slotId) },
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
    notes: () => [...notes.values()].map(n => n.snapshot()),
    note: id => notes.get(id)?.snapshot(),
    newNote,
    openNote: path => openNote(path),
    editorCommandIds: () => commands.all().filter(c => c.id.startsWith('editor.')).map(c => c.id),
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
}

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
