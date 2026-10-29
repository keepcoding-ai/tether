// Renderer entry: dockview grid of terminal panels (panel id === slotId), toolbar, new-panel dialog,
// keyboard shortcuts, layout persistence and the "closed slots" menu.
import { createDockview, themeDark, type DockviewApi, type IDockviewPanel, type SerializedDockview } from 'dockview-core'
import type { Event as DaemonEvent, SlotKind, SlotState } from '../../src/daemon/protocol.ts'
import type { ConnectionState } from '../shared/api.ts'
import { pruneLayout } from './layout.ts'
import { KIND_ICON, KIND_LABEL, SlotTab, STATUS_LABEL, TerminalPanel, folderName, panelTitle, type PanelHost } from './panel.ts'

const COMPONENT = 'terminal'
const TAB = 'slot-tab'
const SAVE_DEBOUNCE_MS = 300

const slots = new Map<string, SlotState>()
const panels = new Map<string, TerminalPanel>()
const tabs = new Map<string, SlotTab>()
let api: DockviewApi
let layoutRestored = false
let saveTimer: ReturnType<typeof setTimeout> | undefined

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`elemento #${id} não existe`)
  return el as T
}

// ---------- dockview ----------

const host: PanelHost = {
  getSlot: id => slots.get(id),
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
}

function setupDock(): void {
  api = createDockview($('dock'), {
    theme: themeDark,
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

function addPanel(slot: SlotState, position?: { referencePanel: string; direction: 'right' | 'below' }): IDockviewPanel {
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

async function closePanel(slotId: string): Promise<void> {
  const panel = api.getPanel(slotId)
  if (!panel) return
  const slot = slots.get(slotId)
  const running = slot && (slot.status === 'running' || slot.status === 'starting' || slot.status === 'queued')
  let choice: 'stop' | 'detach' | 'cancel' = 'detach'
  if (running) choice = await window.tether.confirmClose(panel.title ?? slotId)
  if (choice === 'cancel') return
  if (choice === 'stop') await window.tether.request({ t: 'stop', slotId })
  api.removePanel(panel)
}

// ---------- daemon events / state ----------

function applyState(slot: SlotState): void {
  slots.set(slot.slotId, slot)
  panels.get(slot.slotId)?.render()
  const panel = api.getPanel(slot.slotId)
  if (panel) {
    const title = panelTitle(slot)
    if (panel.title !== title) panel.api.setTitle(title)
  }
  tabs.get(slot.slotId)?.render()
  refreshClosedMenu()
}

function onDaemonEvent(ev: DaemonEvent): void {
  switch (ev.t) {
    case 'data': panels.get(ev.slotId)?.write(ev.data); break
    case 'state': applyState(ev.slot); break
    case 'removed': {
      slots.delete(ev.slotId)
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
  const conn = $('conn')
  conn.title = state.pipe
  if (!state.connected) {
    conn.textContent = '● desconectado'
    conn.className = 'conn off'
    $('overlay-msg').textContent = `${state.error} (${state.pipe})`
    $('overlay').hidden = false
    return
  }
  conn.textContent = '● tetherd'
  conn.className = 'conn on'
  $('overlay').hidden = true
  await refreshSlots()
  if (!layoutRestored) {
    await restoreLayout()
  } else {
    for (const panel of api.panels) {
      if (!slots.has(panel.id)) api.removePanel(panel)
    }
    for (const p of panels.values()) { p.render(); void p.reattach() }
    for (const t of tabs.values()) t.render()
    refreshClosedMenu()
  }
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
    const li = document.createElement('li')
    const icon = document.createElement('span'); icon.textContent = KIND_ICON[s.kind]
    const name = document.createElement('span'); name.textContent = s.title ?? s.name ?? folderName(s.cwd)
    const cwd = document.createElement('span'); cwd.className = 'cwd'; cwd.textContent = `${s.cwd} · ${STATUS_LABEL[s.status]}`
    const forget = document.createElement('button'); forget.className = 'forget'; forget.textContent = 'Esquecer'; forget.title = 'Encerra e remove o slot do tether'
    forget.addEventListener('click', async ev => {
      ev.stopPropagation()
      await window.tether.request({ t: 'forget', slotId: s.slotId })
    })
    li.append(icon, name, cwd, forget)
    li.title = `Reabrir o painel (${KIND_LABEL[s.kind]}, ${STATUS_LABEL[s.status]})`
    li.addEventListener('click', () => {
      list.hidden = true
      const panel = addPanel(s)
      if (s.status === 'exited') void window.tether.request({ t: 'start', slotId: s.slotId })
      panel.api.setActive()
    })
    list.append(li)
  }
}

// ---------- new panel dialog ----------

interface NewPanelOptions { kind?: SlotKind; cwd?: string; position?: { referencePanel: string; direction: 'right' | 'below' } }

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
  $('btn-new').addEventListener('click', () => { void openNewDialog() })
  $('btn-split-right').addEventListener('click', () => { void splitActive('right') })
  $('btn-split-down').addEventListener('click', () => { void splitActive('below') })
  $('btn-retry').addEventListener('click', () => window.tether.reconnect())
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
    if ($<HTMLDialogElement>('dlg-new').open) return
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
  }
}

setupDock()
setupUi()
setupTestHooks()
window.tether.onEvent(onDaemonEvent)
window.tether.onConnection(state => { void onConnection(state) })
