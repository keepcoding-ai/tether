// Renderer entry: dockview grid of terminal panels (panel id === slotId), toolbar, new-panel dialog,
// keyboard shortcuts, layout persistence, the "closed slots" menu, and the start/resume flow of each
// panel (auto-start of exited slots on launch, the unconfirmed choice, error actions).
import { themeDark, themeLight, type IDockviewPanel, type SerializedDockview } from 'dockview-core'
import type { Event as DaemonEvent, Profile, SlotKind, SlotState } from '../../src/daemon/protocol.ts'
import type { ConnectionState } from '../shared/api.ts'
import type { AskRequest, Confirmations } from '../shared/dialog.ts'
import { DEFAULT_APPEARANCE, type TerminalAppearance } from '../shared/terminal-theme.ts'
import { normalizeTheme, type ColorScheme, type ThemeState } from '../shared/theme.ts'
import { DUPLICATE_LABEL, duplicateRequest, LEVEL_HINT, LEVEL_LABEL, NEW_FRAME_LABEL, NEW_PANEL_LABEL, PLACEMENT_LABEL, shortcutOf, targetKey, targetOf, TARGETS, type Direction, type Placement, type Target } from './create.ts'
import { type Desk, type DeskHost, transferFrame, transferPanel } from './desk.ts'
import { DeskSet } from './desk-set.ts'
import { DeskStrip, type DeskAttention } from './desk-strip.ts'
import { cycleDesk, deskAt, neighbourDesk } from './desks.ts'
import { askDialog, dialogOpen } from './dialog.ts'
import { Drawer } from './drawer.ts'
import { CLOSED, closeDrawer, countAttention, escAction, focusAfterClose, openDrawer, quickCwd, type DrawerState } from './drawer-rules.ts'
import { icon, KIND_ICON, type IconName } from './icons.ts'
import { drawerOf, emptyLayout, type LayoutV2, migrateLayout, pruneLayoutV2 } from './layout.ts'
import { detailsLabel, detailsOpen, withDetails } from './pane-details.ts'
import { hintOf, QueueOrder, sameHint, type PaneHint } from './loading.ts'
import { effectiveStatus, KIND_LABEL, SlotTab, STATUS_LABEL, TerminalPanel, panelTitle, type PanelAction, type PanelHost, type SlotError } from './panel.ts'
import { defaultOf, ProfileManager, renderProfileGroups } from './profiles.ts'
import { LEVELS, shortcutHint, type AppShortcut } from './shortcuts.ts'
import { closeDeskSituation, closePanelSituation, folderName, NO_PROFILE, quitAllSituation, switchProfileFailedSituation, switchProfileSituation, switchProfileUnconfirmedSituation } from './situations.ts'
import { loadTerminalFonts, TerminalThemeDialog, terminalFontsLoaded } from './terminal-theme.ts'
import { restartDaemonSituation, trayFirstCloseSituation } from './tray-situations.ts'

const COMPONENT = 'terminal'
const TAB = 'slot-tab'
const SAVE_DEBOUNCE_MS = 300

const slots = new Map<string, SlotState>()
const panels = new Map<string, TerminalPanel>()
const tabs = new Map<string, SlotTab>()
/** Error of the last refused `start` per slot (the daemon does not store `already-open` / `unconfirmed`). */
const startErrors = new Map<string, SlotError>()
/** Slots with a `start` request in flight. */
const pendingStarts = new Set<string>()
let desks: DeskSet
let strip: DeskStrip
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
  onKey: (ev, panel) => {
    if (ev.type !== 'keydown') return false
    if (ev.key === 'Escape' && !ev.ctrlKey && !ev.altKey && !ev.shiftKey && !ev.metaKey) return drawerEscapeInTerminal(panel)
    // App shortcuts: keep xterm from sending them as input; the event still bubbles to the document listener.
    // (Clipboard chords are the panel's own: app/renderer/shortcuts.ts PANE_SHORTCUTS.)
    return shortcutOf(ev) !== undefined
  },
  getScheme: () => theme.scheme,
  getAppearance: () => appearance,
  onSwitchProfile: id => { void switchProfile(id) },
  onToggleDetails: id => togglePaneDetails(id),
  onTabMenu: (id, ev) => showTabMenu(id, ev.clientX, ev.clientY),
  isDaemonReady: () => daemonIsReady,
  daemonReady: () => daemonReadyPromise,
  fontsReady: () => appearanceReady,
  queuePosition: id => queue.position(id),
}

// ---------- theme ----------

const DOCK_THEME: Record<ColorScheme, typeof themeDark> = { dark: themeDark, light: themeLight }

/** Applies a theme state everywhere: CSS variables (html[data-theme]), dockview, every xterm, the toolbar select. */
function applyTheme(state: ThemeState): void {
  theme = state
  document.documentElement.dataset.theme = state.scheme
  desks.setTheme(DOCK_THEME[state.scheme])
  drawer?.setTheme(DOCK_THEME[state.scheme])
  for (const p of panels.values()) p.setAppearance(appearance, state.scheme)
  themeDialog?.refresh()
  $<HTMLSelectElement>('theme-select').value = state.setting
  for (const li of document.querySelectorAll<HTMLElement>('#app-menu li[data-theme]')) li.setAttribute('aria-checked', String(li.dataset.theme === state.setting))
}

// ---------- terminal appearance ----------

/** Puts an appearance on every pane (and the dialog's sample); the font must be loaded already. */
function applyAppearance(a: TerminalAppearance): void {
  appearance = a
  for (const p of panels.values()) p.setAppearance(a, theme.scheme)
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
      createComponent: () => {
        const panel = new TerminalPanel(host)
        const init = panel.init.bind(panel)
        panel.init = params => { init(params); panels.set(panel.slotId, panel) }
        const dispose = panel.dispose.bind(panel)
        panel.dispose = () => { dispose(); if (panels.get(panel.slotId) === panel) panels.delete(panel.slotId) }
        return panel
      },
      createTabComponent: () => {
        const tab = new SlotTab(host, id => { void closePanel(id) })
        const init = tab.init.bind(tab)
        tab.init = params => { init(params); tabs.set(params.api.id, tab) }
        const dispose = tab.dispose.bind(tab)
        tab.dispose = () => { dispose(); for (const [id, t] of tabs) if (t === tab) tabs.delete(id) }
        return tab
      },
      createWatermarkComponent: () => {
        const el = document.createElement('div')
        el.className = 'watermark'
        el.innerHTML = `<h1>tether</h1><p>Nenhum painel aberto.</p><p>${kbdHtml(shortcutHint({ op: 'choose' }))} ou "+ ${NEW_PANEL_LABEL}" para abrir um terminal.</p>`
        return { element: el, init: () => {} }
      },
    }),
    onLayoutChange: () => scheduleSave(),
    onPanelsChange: () => { refreshClosedMenu(); renderStrip() },
    onEdge: (target, op, frameId) => { void onEdge(target, op, frameId, scope === 'drawer' ? drawer.desk : undefined) },
    onActivePanelChange: () => markSeenIfWatched(),
  }
}

function setupDock(): void {
  strip = new DeskStrip($('desk-strip'), {
    switchTo: id => desks.switchTo(id),
    create: (side, relativeTo) => { desks.create(side, relativeTo || undefined) },
    rename: (id, name) => desks.rename(id, name),
    recolor: (id, color) => desks.recolor(id, color),
    move: (id, to) => desks.move(id, to),
    menu: (id, x, y) => showDeskMenu(id, x, y),
    hint: (what, position) => what === 'new' ? shortcutHint({ op: 'desk-new', side: 'after' }) : shortcutHint({ op: 'desk-go', position: position ?? 1 }),
  })
  desks = new DeskSet($('dock'), {
    deskHost: () => deskHost(),
    onDesksChange: () => { renderStrip(); scheduleSave() },
    onSwitch: () => focusActivePane(),
    paneOptions: panel => ({ id: panel.id, component: COMPONENT, tabComponent: TAB, title: panel.title ?? panel.id, params: panel.params ?? { slotId: panel.id } }),
  }, DOCK_THEME[theme.scheme])
  desks.fromEmpty()
  drawer = new Drawer($('drawer'), { deskHost: () => deskHost('drawer'), onBackdrop: () => setDrawerOpen(false) }, DOCK_THEME[theme.scheme])
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
  const useDrawer = into === 'drawer' || (reference ? inDrawer(reference) : drawer.isOpen)
  const panel = (useDrawer ? drawer.desk : desks).addPanel({
    id: slot.slotId,
    component: COMPONENT,
    tabComponent: TAB,
    title: panelTitle(slot),
    params: { slotId: slot.slotId, hint: hintOf(slot) },
  }, target, reference)
  panel.api.setActive()
  return panel
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

/** After a desk switch: the keyboard goes to the desk's active pane (and its badge, if any, is seen). */
function focusActivePane(): void {
  const active = desks.activePanel
  // Deferred, and never over a desk being renamed in the strip (a double-click switches first, then renames).
  if (active) requestAnimationFrame(() => { if (!(document.activeElement as Element | null)?.closest('#desk-strip, #desk-colors')) panels.get(active.id)?.focus() })
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
    { icon: 'palette', label: 'Cor…', run: () => strip.pickColor(id, desks.desks[index]?.color ?? 0, x, y) },
    { icon: 'arrow-line-left', label: 'Nova mesa antes', run: () => { desks.create('before', id) } },
    { icon: 'arrow-line-right', label: 'Nova mesa depois', run: () => { desks.create('after', id) } },
  ]
  if (index > 0) items.push({ icon: 'arrow-line-left', label: 'Mover para a esquerda', run: () => desks.move(id, index - 1) })
  if (index < desks.desks.length - 1) items.push({ icon: 'arrow-line-right', label: 'Mover para a direita', run: () => desks.move(id, index + 1) })
  if (desks.desks.length > 1) items.push({ icon: 'x', label: 'Fechar mesa…', danger: true, run: () => { void closeDesk(id) } })
  showContextMenu(x, y, items)
}

/** "Mover para a mesa…": the other desks, plus a new desk after the last one. */
function showMoveMenu(x: number, y: number, move: (to: string) => void): void {
  const from = desks.activeDeskId
  const items: MenuItem[] = desks.desks.filter(d => d.id !== from).map(d => ({ icon: 'cards' as const, label: d.name, run: () => move(d.id) }))
  items.push({
    icon: 'plus', label: 'Nova mesa', run: () => {
      const last = desks.desks[desks.desks.length - 1]!.id
      const current = desks.activeDeskId
      const created = desks.create('after', last)
      desks.switchTo(current) // the pane goes there; the user stays where they are
      move(created)
    },
  })
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

/** The menu position for keyboard/menu commands (no pointer): under the active pane's tab. */
function activeTabPoint(): { x: number; y: number } {
  const id = desks.activePanel?.id
  const r = id ? tabs.get(id)?.element.getBoundingClientRect() : undefined
  return r ? { x: r.left, y: r.bottom + 2 } : { x: 120, y: 80 }
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
const BEHIND_DRAWER = ['toolbar', 'desk-strip', 'dock']

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
    desks.active.hidePlus()
  } else {
    drawerState = closeDrawer(drawerState)
  }
  for (const id of BEHIND_DRAWER) $(id).toggleAttribute('inert', open)
  drawer.setOpen(open)
  renderStrip()
  if (open) {
    if (drawer.desk.panels.length === 0) void quickShell()
    requestAnimationFrame(focusDrawer)
  } else {
    requestAnimationFrame(restoreFocusAfterClose)
  }
  markSeenIfWatched()
}

function focusDrawer(): void {
  if (!drawer.isOpen) return
  const active = drawer.desk.activePanel
  if (active) panels.get(active.id)?.focus()
  else $('drawer-new').focus() // an empty drawer: the keyboard sits on its chrome, where Esc closes
}

function restoreFocusAfterClose(): void {
  if (drawer.isOpen) return
  const target = focusAfterClose(drawerState.returnTo, id => desks.getPanel(id) !== undefined, desks.activePanel?.id)
  if (target) {
    desks.getPanel(target)?.api.setActive()
    panels.get(target)?.focus()
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
  let dirty = false
  if (result) {
    const pruned = pruneLayoutV2(result.layout, new Set(slots.keys()))
    layoutFile = pruned.layout
    // The geometry painted at startup had every pane of the file; only when the daemon lost some is the
    // desk rebuilt from the pruned JSON (the same loss-proof path: grid refused → frames side by side,
    // frame refused → panes one by one). Nothing is attached yet, so the rebuild loses nothing.
    if (pruned.kept !== pruned.total) { desks.load(pruned.layout); drawer.load(drawerOf(pruned.layout)) }
    if (result.migrated) await window.tether.backupLayout()
    dirty = result.migrated || pruned.kept !== pruned.total
  } else {
    layoutFile = emptyLayout()
  }
  layoutRestored = true
  if (dirty) scheduleSave()
  // Panes that predate the hint get it now (saved with the next layout change).
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

// ---------- connection ----------

async function onConnection(state: ConnectionState): Promise<void> {
  connection = state
  const conn = $('conn')
  conn.title = state.pipe
  if (!state.connected) {
    conn.replaceChildren(icon('plugs'), document.createTextNode('desconectado'))
    conn.className = 'conn off'
    $('overlay-msg').textContent = `${state.error} (${state.pipe})`
    $('overlay').hidden = false
    return
  }
  conn.replaceChildren(icon('plugs-connected'), document.createTextNode(`tetherd ${state.pid}`))
  conn.className = 'conn on'
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
    // Reconnected (the daemon was restarted): drop panels it no longer knows, re-attach the rest.
    for (const panel of allPanels()) {
      if (!slots.has(panel.id)) removeAnyPanel(panel)
    }
    for (const p of panels.values()) { p.render(); void p.reattach() }
    for (const t of tabs.values()) t.render()
    refreshClosedMenu()
  }
  autoStartPanels()
}

// ---------- closed slots menu ----------

function refreshClosedMenu(): void {
  const list = $('closed-list')
  const closed = [...slots.values()].filter(s => !findPanel(s.slotId))
  $('closed-count').textContent = closed.length ? `(${closed.length})` : ''
  list.replaceChildren()
  if (closed.length === 0) {
    const li = document.createElement('li'); li.className = 'empty'; li.textContent = 'Nenhum slot fechado'
    list.append(li)
    return
  }
  for (const s of closed) {
    const status = STATUS_LABEL[effectiveStatus(s)]
    const li = document.createElement('li')
    const kind = document.createElement('span'); kind.className = 'kind'; kind.append(icon(KIND_ICON[s.kind]))
    const name = document.createElement('span'); name.textContent = s.title ?? s.name ?? folderName(s.cwd)
    const cwd = document.createElement('span'); cwd.className = 'cwd'; cwd.textContent = `${s.cwd} · ${status}`
    const forget = document.createElement('button'); forget.className = 'forget'; forget.title = 'Encerra e remove o slot do tether'
    forget.append(icon('trash'), document.createTextNode('Esquecer'))
    forget.addEventListener('click', async ev => {
      ev.stopPropagation()
      await window.tether.request({ t: 'forget', slotId: s.slotId })
    })
    li.append(kind, name, cwd, forget)
    li.title = `Reabrir o painel (${KIND_LABEL[s.kind]}, ${status})`
    li.addEventListener('click', () => {
      list.hidden = true
      openSlot(s.slotId)
    })
    list.append(li)
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

interface MenuItem { icon: IconName; label: string; run(): void; danger?: boolean }

/** A floating menu at (x, y), closed by a click anywhere else, Esc, or picking an item. */
function showContextMenu(x: number, y: number, items: MenuItem[]): void {
  document.getElementById('ctx-menu')?.remove()
  const menu = document.createElement('ul')
  menu.id = 'ctx-menu'; menu.className = 'menu'; menu.setAttribute('role', 'menu')
  const close = (): void => { menu.remove(); document.removeEventListener('click', onDoc, true); document.removeEventListener('keydown', onKey, true) }
  const onDoc = (ev: Event): void => { if (!menu.contains(ev.target as Node)) close() }
  const onKey = (ev: KeyboardEvent): void => {
    const lis = [...menu.querySelectorAll<HTMLElement>('li[role=menuitem]')]
    const i = lis.indexOf(document.activeElement as HTMLElement)
    if (ev.key === 'Escape') { ev.preventDefault(); close() }
    else if (ev.key === 'ArrowDown') { ev.preventDefault(); lis[(i + 1) % lis.length]?.focus() }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); lis[(i - 1 + lis.length) % lis.length]?.focus() }
    else if ((ev.key === 'Enter' || ev.key === ' ') && i >= 0) { ev.preventDefault(); lis[i]!.click() }
  }
  for (const item of items) {
    const li = document.createElement('li'); li.setAttribute('role', 'menuitem'); li.tabIndex = -1
    if (item.danger) li.classList.add('danger')
    li.append(icon(item.icon), document.createTextNode(item.label))
    li.addEventListener('click', ev => { ev.stopPropagation(); close(); item.run() })
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

/** Right-click on a tab: the two ways to open a panel next to this one, switch the profile, close the panel. */
function showTabMenu(slotId: string, x: number, y: number): void {
  const slot = slots.get(slotId)
  if (!slot) return
  const panel = findPanel(slotId)
  panel?.api.setActive()
  // Where the pane can go: a desk pane to another desk or into the drawer; a drawer pane to the desk behind it.
  const moves: MenuItem[] = inDrawer(slotId)
    ? [
      { icon: 'tray-arrow-up', label: 'Mover para a mesa atual', run: () => movePaneFromDrawer(slotId) },
      { icon: 'tray-arrow-up', label: 'Mover quadro para a mesa atual', run: () => moveFrameFromDrawer(slotId) },
    ]
    : [
      { icon: 'cards', label: 'Mover para a mesa…', run: () => showMoveMenu(x, y, to => movePaneToDesk(slotId, to)) },
      { icon: 'cards', label: 'Mover quadro para a mesa…', run: () => showMoveMenu(x, y, to => moveFrameToDesk(slotId, to)) },
      { icon: 'tray-arrow-down', label: 'Mover para a gaveta', run: () => movePaneToDrawer(slotId) },
      { icon: 'tray-arrow-down', label: 'Mover quadro para a gaveta', run: () => moveFrameToDrawer(slotId) },
    ]
  showContextMenu(x, y, [
    { icon: 'plus', label: NEW_PANEL_LABEL, run: () => { void openNewDialog({ reference: slotId }) } },
    { icon: 'copy', label: `${DUPLICATE_LABEL} ${PLACEMENT_LABEL.right}`, run: () => { void duplicatePanel(slotId, { level: 'pane', placement: 'right' }) } },
    { icon: 'copy', label: `${DUPLICATE_LABEL} ${PLACEMENT_LABEL.below}`, run: () => { void duplicatePanel(slotId, { level: 'pane', placement: 'below' }) } },
    { icon: 'square-half', label: 'Novo painel na borda do quadro…', run: () => { void openNewDialog({ reference: slotId, target: { level: 'frame', placement: 'right' } }) } },
    { icon: 'columns', label: `${NEW_FRAME_LABEL}…`, run: () => { void openNewDialog({ reference: slotId, target: { level: 'desk', placement: 'right' } }) } },
    ...moves,
    { icon: detailsOpen(panel?.params) ? 'caret-up' : 'caret-down', label: detailsLabel(detailsOpen(panel?.params)), run: () => togglePaneDetails(slotId) },
    { icon: 'sliders-horizontal', label: 'Trocar perfil…', run: () => { void switchProfile(slotId) } },
    { icon: 'x', label: 'Fechar painel…', run: () => { void closePanel(slotId) } },
  ])
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
  const dlg = $<HTMLDialogElement>('dlg-new')
  if (dlg.open) renderNewProfiles(selectedProfileId())
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

// ---------- new panel dialog ("Novo painel…": the chooser) ----------

/**
 * `reference`: the panel the placement is relative to (the active one when absent); `placement`: what the
 * "Onde" row starts on (a tab in the reference's group by default). Without any panel there is nothing to
 * be relative to: the row is hidden and the new panel is simply the first.
 */
interface NewPanelOptions { kind?: SlotKind; profileId?: string; cwd?: string; reference?: string; target?: Target }

function selectedProfileId(): string | undefined {
  return $<HTMLFormElement>('form-new').querySelector<HTMLInputElement>('input[name=profile]:checked')?.value
}

function selectedTarget(): Target {
  return targetOf($<HTMLFormElement>('form-new').querySelector<HTMLInputElement>('input[name=placement]:checked')?.value) ?? { level: 'pane', placement: 'within' }
}

/** The "Onde" rows of the chooser: one group per level (pane / frame / desk), relative to `reference`; hidden when there is none. */
function renderPlacements(reference: string | undefined, selected: Target): void {
  const field = $('new-placement')
  const row = $('new-placements')
  field.hidden = !reference
  row.replaceChildren()
  if (!reference) return
  const ref = slots.get(reference)
  $('new-placement-ref').textContent = ref ? panelTitle(ref) : reference
  for (const level of LEVELS) {
    const group = document.createElement('div')
    group.className = 'placement-group'
    group.dataset.level = level
    const head = document.createElement('span')
    head.className = 'placement-level'
    head.textContent = LEVEL_LABEL[level]
    head.title = LEVEL_HINT[level]
    group.append(head)
    for (const t of TARGETS.filter(t => t.level === level)) {
      const label = document.createElement('label')
      label.className = 'placement'
      label.dataset.placement = t.placement
      label.dataset.level = level
      const input = document.createElement('input')
      input.type = 'radio'; input.name = 'placement'; input.value = targetKey(t); input.checked = targetKey(t) === targetKey(selected)
      label.append(input, icon(PLACEMENT_ICON[t.placement]), document.createTextNode(PLACEMENT_LABEL[t.placement]))
      group.append(label)
    }
    row.append(group)
  }
}

const PLACEMENT_ICON: Record<Placement, IconName> = {
  within: 'tabs', left: 'arrow-line-left', right: 'arrow-line-right', above: 'arrow-line-up', below: 'arrow-line-down',
}

/** The profile list of "Novo painel"; a profile's folder is suggested while the folder field still holds the suggestion. */
function renderNewProfiles(selectedId: string | undefined): void {
  const cwdInput = $<HTMLInputElement>('new-cwd')
  renderProfileGroups($('new-profiles'), profiles, {
    mode: 'radio', selectedId,
    onPick: id => {
      const p = profiles.find(x => x.id === id)
      if (p?.cwd && cwdInput.value === cwdInput.dataset.suggested) { cwdInput.value = p.cwd; cwdInput.dataset.suggested = p.cwd }
    },
  })
}

async function openNewDialog(opts: NewPanelOptions = {}): Promise<void> {
  const dlg = $<HTMLDialogElement>('dlg-new')
  const form = $<HTMLFormElement>('form-new')
  const cwdInput = $<HTMLInputElement>('new-cwd')
  const error = $('new-error')
  error.hidden = true
  if (profiles.length === 0) await loadProfiles()
  const wanted = (opts.profileId && profiles.find(p => p.id === opts.profileId)) || defaultOf(profiles, opts.kind ?? 'claude') || profiles[0]
  const recent = await window.tether.recentFolders()
  const suggested = opts.cwd ?? wanted?.cwd ?? recent[0] ?? ''
  cwdInput.value = suggested
  cwdInput.dataset.suggested = suggested
  renderNewProfiles(wanted?.id)
  // The reference is fixed when the dialog opens: the active panel may change underneath (a slot exits) but the
  // user chose "where" looking at this one.
  const reference = opts.reference && findPanel(opts.reference) ? opts.reference : currentDesk().activePanel?.id
  renderPlacements(reference, opts.target ?? { level: 'pane', placement: 'within' })
  const list = $('recent-list')
  list.replaceChildren()
  if (recent.length === 0) {
    const li = document.createElement('li'); li.className = 'empty'; li.textContent = 'Nenhuma pasta recente'
    list.append(li)
  }
  for (const f of recent) {
    const li = document.createElement('li'); li.textContent = f
    li.addEventListener('click', () => { cwdInput.value = f; cwdInput.focus() })
    list.append(li)
  }
  const onSubmit = async (ev: SubmitEvent): Promise<void> => {
    ev.preventDefault()
    const profile = profiles.find(p => p.id === selectedProfileId())
    if (!profile) { error.textContent = 'Escolha um perfil.'; error.hidden = false; return }
    const cwd = cwdInput.value.trim()
    if (!cwd) { error.textContent = 'Informe a pasta.'; error.hidden = false; return }
    const reply = await window.tether.request({ t: 'create', kind: profile.agent, cwd, start: true, profileId: profile.id })
    if (reply.t === 'error' || !reply.slot) {
      error.textContent = reply.t === 'error' ? reply.message : 'o daemon não devolveu o slot'
      error.hidden = false
      return
    }
    await window.tether.rememberFolder(cwd)
    form.removeEventListener('submit', onSubmit)
    const target = selectedTarget()
    dlg.close()
    const stillThere = reference && findPanel(reference) ? reference : undefined
    addPanel(reply.slot, stillThere ? target : undefined, stillThere).api.setActive()
  }
  form.addEventListener('submit', onSubmit)
  dlg.addEventListener('close', () => form.removeEventListener('submit', onSubmit), { once: true })
  dlg.showModal()
  cwdInput.focus()
  cwdInput.select()
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

/** A "+" near a border: the frame's active pane (or the desk's) is the reference; click duplicates, right-click chooses. */
async function onEdge(target: Target, op: 'duplicate' | 'choose', frameId: string | undefined, scope: Desk = currentDesk()): Promise<void> {
  const reference = (frameId ? scope.frames.get(frameId)?.dock.activePanel?.id : undefined) ?? scope.activePanel?.id
  if (op === 'choose' || !reference || !slots.has(reference)) { void openNewDialog({ reference, target }); return }
  await duplicatePanel(reference, target)
}

// ---------- in-app menu ----------
// The native menu bar is hidden (autoHideMenuBar) and Alt does not reach it from a terminal: the same commands
// live behind the toolbar's menu button. Theme and "voltar a perguntar" talk to main; quit-all asks through onAsk.

/** The chord a menu command is shown with (app/renderer/shortcuts.ts is the only place chords live). */
const MENU_SHORTCUT: Record<string, AppShortcut> = {
  'new': { op: 'choose' },
  'duplicate-right': { op: 'duplicate', level: 'pane', direction: 'right' },
  'duplicate-below': { op: 'duplicate', level: 'pane', direction: 'below' },
  'quit-all': { op: 'quit-all' },
  'new-desk': { op: 'desk-new', side: 'after' },
  'toggle-drawer': { op: 'drawer-toggle' },
}

function setupMenu(): void {
  const btn = $('btn-menu')
  const menu = $('app-menu')
  for (const li of menu.querySelectorAll<HTMLElement>('li[data-cmd]')) {
    const cmd = MENU_SHORTCUT[li.dataset.cmd ?? '']
    const kbd = li.querySelector('kbd')
    if (cmd && kbd) kbd.textContent = shortcutHint(cmd)
  }
  const toggle = (open: boolean): void => {
    menu.hidden = !open
    btn.setAttribute('aria-expanded', String(open))
    if (open) menu.querySelector<HTMLElement>('li[role^=menuitem]')?.focus()
  }
  btn.addEventListener('click', ev => {
    ev.stopPropagation()
    // "Duplicar painel" and "Trocar perfil do painel…" act on the active panel: greyed out when there is none.
    for (const item of menu.querySelectorAll<HTMLElement>('li[data-cmd="switch-profile"], li[data-cmd^="duplicate"], li[data-cmd^="move-"]')) item.setAttribute('aria-disabled', String(!desks.activePanel))
    menu.querySelector<HTMLElement>('li[data-cmd="close-desk"]')?.setAttribute('aria-disabled', String(desks.desks.length <= 1))
    toggle(menu.hidden)
  })
  document.addEventListener('click', ev => { if (!menu.hidden && !menu.contains(ev.target as Node)) toggle(false) })
  for (const li of menu.querySelectorAll<HTMLElement>('li[role^=menuitem]')) li.tabIndex = -1
  const run = (li: HTMLElement): void => {
    if (li.getAttribute('aria-disabled') === 'true') return
    toggle(false)
    if (li.dataset.theme) { window.tether.setTheme(normalizeTheme(li.dataset.theme)); return }
    switch (li.dataset.cmd) {
      case 'new': void openNewDialog(); break
      case 'duplicate-right': void duplicateActive({ level: 'pane', placement: 'right' }); break
      case 'duplicate-below': void duplicateActive({ level: 'pane', placement: 'below' }); break
      case 'new-frame-edge': void openNewDialog({ target: { level: 'frame', placement: 'right' } }); break
      case 'new-frame': void openNewDialog({ target: { level: 'desk', placement: 'right' } }); break
      case 'move-pane-desk': { const a = desks.activePanel; if (a) { const p = activeTabPoint(); showMoveMenu(p.x, p.y, to => movePaneToDesk(a.id, to)) } break }
      case 'move-frame-desk': { const a = desks.activePanel; if (a) { const p = activeTabPoint(); showMoveMenu(p.x, p.y, to => moveFrameToDesk(a.id, to)) } break }
      case 'new-desk': desks.create('after'); break
      case 'toggle-drawer': setDrawerOpen(!drawer.isOpen); break
      case 'move-pane-drawer': { const a = desks.activePanel; if (a) movePaneToDrawer(a.id); break }
      case 'move-frame-drawer': { const a = desks.activePanel; if (a) moveFrameToDrawer(a.id); break }
      case 'close-desk': void closeDesk(desks.activeDeskId); break
      case 'profiles': openProfiles(); break
      case 'terminal-theme': themeDialog.show(); break
      case 'switch-profile': { const active = desks.activePanel; if (active) void switchProfile(active.id); break }
      case 'restore-confirmations': window.tether.command('restore-confirmations'); break
      case 'close-window': window.tether.closeWindow(); break
      case 'quit-all': window.tether.command('quit-all'); break
    }
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
    else if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); if (i >= 0) run(items[i]!) }
  })
}

// ---------- wiring ----------

function setupUi(): void {
  // Static icons: <span data-icon="name"> in index.html becomes the inline SVG.
  for (const el of document.querySelectorAll<HTMLElement>('[data-icon]')) el.replaceChildren(icon(el.dataset.icon as IconName))
  $('btn-new').addEventListener('click', () => { void openNewDialog() })
  $('btn-drawer').addEventListener('click', () => setDrawerOpen(!drawer.isOpen))
  $('drawer-new').addEventListener('click', () => { void openNewDialog() })
  $('drawer-duplicate').addEventListener('click', () => { void duplicateActive({ level: 'pane', placement: 'right' }) })
  $('drawer-close').addEventListener('click', () => setDrawerOpen(false))
  $('btn-profiles').addEventListener('click', () => openProfiles())
  $('btn-manage-profiles').addEventListener('click', () => openProfiles(selectedProfileId()))
  setupMenu()
  const dup = $('btn-duplicate')
  const hint = (level: Target['level'], direction: Direction): string => shortcutHint({ op: 'duplicate', level, direction })
  dup.title = `${DUPLICATE_LABEL} ${PLACEMENT_LABEL.right} (${hint('pane', 'right')}): outro painel com o mesmo perfil e a mesma pasta, numa sessão nova. Setas com os mesmos modificadores duplicam para os outros lados; ${hint('frame', 'right')} na borda do quadro; ${hint('desk', 'right')} num quadro novo.`
  dup.addEventListener('click', () => { void duplicateActive({ level: 'pane', placement: 'right' }) })
  $('btn-new').title = `${NEW_PANEL_LABEL} (${shortcutHint({ op: 'choose' })}): escolha o perfil, a pasta e onde abrir`
  $('btn-retry').addEventListener('click', () => window.tether.reconnect())
  $<HTMLSelectElement>('theme-select').addEventListener('change', ev => window.tether.setTheme(normalizeTheme((ev.target as HTMLSelectElement).value)))
  $('btn-cancel').addEventListener('click', () => $<HTMLDialogElement>('dlg-new').close())
  $('btn-browse').addEventListener('click', async () => {
    const input = $<HTMLInputElement>('new-cwd')
    const picked = await window.tether.pickFolder(input.value.trim() || undefined)
    if (picked) input.value = picked
  })
  const closedBtn = $('btn-closed')
  const closedList = $('closed-list')
  closedBtn.addEventListener('click', ev => { ev.stopPropagation(); closedList.hidden = !closedList.hidden })
  document.addEventListener('click', ev => { if (!closedList.contains(ev.target as Node)) closedList.hidden = true })

  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') { drawerEscapeOutside(ev); return }
    const shortcut = shortcutOf(ev)
    if (!shortcut) return
    if ($<HTMLDialogElement>('dlg-new').open || manager.open || themeDialog.open || dialogOpen()) return
    ev.preventDefault()
    if (shortcut.op === 'drawer-toggle' && ev.repeat) return // a held chord is one toggle
    switch (shortcut.op) {
      case 'choose': void openNewDialog(); break
      case 'duplicate': void duplicateActive({ level: shortcut.level, placement: shortcut.direction }); break
      case 'quit-all': window.tether.command('quit-all'); break
      case 'drawer-toggle': setDrawerOpen(!drawer.isOpen); break
      case 'pane-details': { const id = currentDesk().activePanel?.id; if (id) togglePaneDetails(id); break }
      // The desks behind the drawer stay where they are while it is open.
      case 'desk-cycle': if (!drawer.isOpen) desks.switchTo(cycleDesk(desks.desks, desks.activeDeskId, shortcut.step)); break
      case 'desk-go': { const id = deskAt(desks.desks, shortcut.position); if (id && !drawer.isOpen) desks.switchTo(id); break }
      case 'desk-new': if (!drawer.isOpen) desks.create(shortcut.side); break
    }
  })
  // Back to the window: the pane in front of the user is seen.
  window.addEventListener('focus', () => markSeenIfWatched())
  document.addEventListener('visibilitychange', () => markSeenIfWatched())
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
      /** Asks to close a panel exactly as the tab's × does (dialog included). */
      closePanel(slotId: string): void
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
      desks(): { id: string; name: string; color: number; panes: string[]; attention: DeskAttention }[]
      activeDesk(): string
      deskOf(slotId: string): string | undefined
      switchDesk(id: string): void
      createDesk(side: 'before' | 'after', relativeTo?: string): string
      renameDesk(id: string, name: string): void
      recolorDesk(id: string, color: number): void
      moveDesk(id: string, to: number): void
      /** Closes a desk exactly as its menu does (the dialog included when it has panes). */
      closeDesk(id: string): void
      movePaneToDesk(slotId: string, deskId: string): void
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
    closePanel: slotId => { void closePanel(slotId) },
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
    recolorDesk: (id, color) => desks.recolor(id, color),
    moveDesk: (id, to) => desks.move(id, to),
    closeDesk: id => { void closeDesk(id) },
    movePaneToDesk,
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
