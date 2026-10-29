// Renderer entry: dockview grid of terminal panels (panel id === slotId), toolbar, new-panel dialog,
// keyboard shortcuts, layout persistence, the "closed slots" menu, and the start/resume flow of each
// panel (auto-start of exited slots on launch, the unconfirmed choice, error actions).
import { createDockview, themeDark, themeLight, type DockviewApi, type IDockviewPanel, type SerializedDockview } from 'dockview-core'
import type { Event as DaemonEvent, SlotKind, SlotState } from '../../src/daemon/protocol.ts'
import type { ConnectionState } from '../shared/api.ts'
import type { AskRequest, Confirmations } from '../shared/dialog.ts'
import { normalizeTheme, type ColorScheme, type ThemeState } from '../shared/theme.ts'
import { askDialog, dialogOpen } from './dialog.ts'
import { icon, KIND_ICON, type IconName } from './icons.ts'
import { pruneLayout } from './layout.ts'
import { effectiveStatus, KIND_LABEL, SlotTab, STATUS_LABEL, TerminalPanel, panelTitle, type PanelAction, type PanelHost, type SlotError } from './panel.ts'
import { closePanelSituation, folderName, quitAllSituation } from './situations.ts'

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
let api: DockviewApi
let layoutRestored = false
let saveTimer: ReturnType<typeof setTimeout> | undefined
let connection: ConnectionState | undefined
/** What is painted now; main owns the setting and pushes every change (user choice or OS switch). */
let theme: ThemeState = { setting: 'auto', scheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' }
/** Remembered dialog answers ("não perguntar de novo"); main owns the file and pushes every change. */
let confirmations: Confirmations = {}

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
    if (ev.type !== 'keydown' || !ev.ctrlKey || !ev.shiftKey || ev.altKey) return false
    switch (ev.code) {
      case 'KeyC': panel.copy(); return true
      case 'KeyV': void panel.paste(); return true
      // App shortcuts: keep xterm from sending them as input; the event still bubbles to the document listener.
      case 'KeyT': case 'KeyD': case 'KeyE': return true
      default: return false
    }
  },
  getScheme: () => theme.scheme,
}

// ---------- theme ----------

const DOCK_THEME: Record<ColorScheme, typeof themeDark> = { dark: themeDark, light: themeLight }

/** Applies a theme state everywhere: CSS variables (html[data-theme]), dockview, every xterm, the toolbar select. */
function applyTheme(state: ThemeState): void {
  theme = state
  document.documentElement.dataset.theme = state.scheme
  api.updateOptions({ theme: DOCK_THEME[state.scheme] })
  for (const p of panels.values()) p.setScheme(state.scheme)
  $<HTMLSelectElement>('theme-select').value = state.setting
}

function setupDock(): void {
  api = createDockview($('dock'), {
    theme: DOCK_THEME[theme.scheme],
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
      el.innerHTML = '<h1>tether</h1><p>Nenhum painel aberto.</p><p><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> ou "+ Novo painel" para abrir um terminal.</p>'
      return { element: el, init: () => {} }
    },
  })
  api.onDidLayoutChange(() => scheduleSave())
  api.onDidRemovePanel(() => refreshClosedMenu())
  api.onDidAddPanel(() => refreshClosedMenu())
}

function scheduleSave(): void {
  if (!layoutRestored) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { saveTimer = undefined; void window.tether.saveLayout(api.toJSON()) }, SAVE_DEBOUNCE_MS)
}

type Position = { referencePanel: string; direction: 'right' | 'below' | 'within' }

function addPanel(slot: SlotState, position?: Position): IDockviewPanel {
  slots.set(slot.slotId, slot)
  const panel = api.addPanel({
    id: slot.slotId,
    component: COMPONENT,
    tabComponent: TAB,
    title: panelTitle(slot),
    params: { slotId: slot.slotId },
    ...(position ? { position } : {}),
  })
  panel.api.setActive()
  return panel
}

/**
 * Closing a panel puts the situation to the user (app/renderer/situations.ts) unless an answer was
 * remembered for it. `ask: false` is for the overlay's own "Fechar painel" card, whose consequence is
 * already written on it: nothing is running, so the panel just goes (the slot stays in "Slots fechados").
 */
async function closePanel(slotId: string, opts: { ask?: boolean } = {}): Promise<void> {
  const panel = api.getPanel(slotId)
  if (!panel) return
  const slot = slots.get(slotId)
  if (!slot) { api.removePanel(panel); return }
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
  const still = api.getPanel(slotId) // `forget` makes the daemon say `removed`, which may already have taken the panel
  if (still) api.removePanel(still)
}

/** Main asks for a situation to be put to the user (menu items live in main; the dialog lives here). */
async function onAsk(req: AskRequest): Promise<void> {
  switch (req.situation) {
    case 'quit-all': {
      const answer = await askDialog(quitAllSituation([...slots.values()]))
      window.tether.answer(req.askId, answer)
      return
    }
  }
}

function renderSlot(slotId: string): void {
  panels.get(slotId)?.render()
  tabs.get(slotId)?.render()
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
  for (const panel of api.panels) {
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
  const panel = api.getPanel(slotId)
  if (!slot || !panel) return
  const folder = await window.tether.pickFolder()
  if (!folder) return
  const reply = await window.tether.request({ t: 'create', kind: slot.kind, cwd: folder, start: true })
  if (reply.t === 'error' || !reply.slot) {
    startErrors.set(slotId, { code: reply.t === 'error' ? reply.code : 'bad-request', message: reply.t === 'error' ? reply.message : 'o daemon não devolveu o slot' })
    renderSlot(slotId)
    return
  }
  await window.tether.rememberFolder(folder)
  addPanel(reply.slot, { referencePanel: slotId, direction: 'within' })
  api.removePanel(panel)
  await window.tether.request({ t: 'forget', slotId })
}

// ---------- daemon events / state ----------

function applyState(slot: SlotState): void {
  slots.set(slot.slotId, slot)
  if (slot.status === 'running' || slot.status === 'starting' || slot.status === 'queued') startErrors.delete(slot.slotId)
  const panel = api.getPanel(slot.slotId)
  if (panel) {
    const title = panelTitle(slot)
    if (panel.title !== title) panel.api.setTitle(title)
  }
  renderSlot(slot.slotId)
  refreshClosedMenu()
}

function onDaemonEvent(ev: DaemonEvent): void {
  switch (ev.t) {
    case 'data': panels.get(ev.slotId)?.write(ev.data); break
    case 'state': applyState(ev.slot); break
    case 'removed': {
      slots.delete(ev.slotId)
      startErrors.delete(ev.slotId)
      const panel = api.getPanel(ev.slotId)
      if (panel) api.removePanel(panel)
      refreshClosedMenu()
      break
    }
  }
}

async function refreshSlots(): Promise<void> {
  const reply = await window.tether.request({ t: 'list' })
  if (reply.t === 'error') throw new Error(reply.message)
  slots.clear()
  for (const s of reply.slots ?? []) slots.set(s.slotId, s)
}

async function restoreLayout(): Promise<void> {
  const saved = (await window.tether.loadLayout()) as SerializedDockview | null
  if (saved && saved.grid && saved.panels) {
    const pruned = pruneLayout(saved, new Set(slots.keys()))
    if (pruned) {
      try { api.fromJSON(pruned) } catch (err) { console.error('layout inválido, começando vazio', err); api.clear() }
    }
  }
  layoutRestored = true
  if (saved) {
    const kept = Object.keys(saved.panels).filter(id => slots.has(id)).length
    if (kept !== Object.keys(saved.panels).length) scheduleSave()
  }
  refreshClosedMenu()
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
  } else {
    // Reconnected (the daemon was restarted): drop panels it no longer knows, re-attach the rest.
    for (const panel of api.panels) {
      if (!slots.has(panel.id)) api.removePanel(panel)
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
  const closed = [...slots.values()].filter(s => !api.getPanel(s.slotId))
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
  const panel = api.getPanel(slotId) ?? addPanel(s)
  if (effectiveStatus(s) === 'exited') void startSlot(s.slotId)
  panel.api.setActive()
}

// ---------- new panel dialog ----------

interface NewPanelOptions { kind?: SlotKind; cwd?: string; position?: Position }

async function openNewDialog(opts: NewPanelOptions = {}): Promise<void> {
  const dlg = $<HTMLDialogElement>('dlg-new')
  const form = $<HTMLFormElement>('form-new')
  const cwdInput = $<HTMLInputElement>('new-cwd')
  const error = $('new-error')
  error.hidden = true
  const kindInput = form.querySelector<HTMLInputElement>(`input[name=kind][value=${opts.kind ?? 'claude'}]`)
  if (kindInput) kindInput.checked = true
  const recent = await window.tether.recentFolders()
  cwdInput.value = opts.cwd ?? recent[0] ?? ''
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
    const kind = (new FormData(form).get('kind') as SlotKind | null) ?? 'claude'
    const cwd = cwdInput.value.trim()
    if (!cwd) { error.textContent = 'Informe a pasta.'; error.hidden = false; return }
    const reply = await window.tether.request({ t: 'create', kind, cwd, start: true })
    if (reply.t === 'error' || !reply.slot) {
      error.textContent = reply.t === 'error' ? reply.message : 'o daemon não devolveu o slot'
      error.hidden = false
      return
    }
    await window.tether.rememberFolder(cwd)
    form.removeEventListener('submit', onSubmit)
    dlg.close()
    addPanel(reply.slot, opts.position).api.setActive()
  }
  form.addEventListener('submit', onSubmit)
  dlg.addEventListener('close', () => form.removeEventListener('submit', onSubmit), { once: true })
  dlg.showModal()
  cwdInput.focus()
  cwdInput.select()
}

/** New panel of the same kind/folder as the active one, split to the given side. */
async function splitActive(direction: 'right' | 'below'): Promise<void> {
  const active = api.activePanel
  const slot = active ? slots.get(active.id) : undefined
  if (!active || !slot) { void openNewDialog(); return }
  const reply = await window.tether.request({ t: 'create', kind: slot.kind, cwd: slot.cwd, start: true })
  if (reply.t === 'error' || !reply.slot) {
    void openNewDialog({ kind: slot.kind, cwd: slot.cwd, position: { referencePanel: active.id, direction } })
    return
  }
  addPanel(reply.slot, { referencePanel: active.id, direction }).api.setActive()
}

// ---------- wiring ----------

function setupUi(): void {
  // Static icons: <span data-icon="name"> in index.html becomes the inline SVG.
  for (const el of document.querySelectorAll<HTMLElement>('[data-icon]')) el.replaceChildren(icon(el.dataset.icon as IconName))
  $('btn-new').addEventListener('click', () => { void openNewDialog() })
  $('btn-split-right').addEventListener('click', () => { void splitActive('right') })
  $('btn-split-down').addEventListener('click', () => { void splitActive('below') })
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
    if (!ev.ctrlKey || !ev.shiftKey || ev.altKey) return
    if ($<HTMLDialogElement>('dlg-new').open || dialogOpen()) return
    switch (ev.code) {
      case 'KeyT': ev.preventDefault(); void openNewDialog(); break
      case 'KeyD': ev.preventDefault(); void splitActive('right'); break
      case 'KeyE': ev.preventDefault(); void splitActive('below'); break
    }
  })
}

// Test hooks (Playwright reads these through page.evaluate).
declare global {
  interface Window {
    __tether: {
      layout(): SerializedDockview
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
      /** Remembered dialog answers as the renderer sees them. */
      confirmations(): Confirmations
      /** Asks to close a panel exactly as the tab's × does (dialog included). */
      closePanel(slotId: string): void
    }
  }
}

function setupTestHooks(): void {
  window.__tether = {
    layout: () => api.toJSON(),
    panelIds: () => api.panels.map(p => p.id),
    activeId: () => api.activePanel?.id,
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
    activate: slotId => api.getPanel(slotId)?.api.setActive(),
    openSlot,
    applyState,
    theme: () => theme,
    termTheme: slotId => panels.get(slotId)?.term.options.theme as Record<string, string | undefined> | undefined,
    confirmations: () => confirmations,
    closePanel: slotId => { void closePanel(slotId) },
  }
}

setupDock()
setupUi()
setupTestHooks()
window.tether.onEvent(onDaemonEvent)
window.tether.onConnection(state => { void onConnection(state) })
window.tether.onTheme(applyTheme)
void window.tether.getTheme().then(applyTheme)
window.tether.onConfirmations(c => { confirmations = c })
void window.tether.getConfirmations().then(c => { confirmations = c })
window.tether.onAsk(req => { void onAsk(req) })
