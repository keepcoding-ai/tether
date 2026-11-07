// The Faults screen's renderer entry: the pane type (the screen as a tab of the active group, one at a time), the command
// faults.show, the top bar's status icon ("3 falhas novas no tether · Ver", present only while something is new), the
// "Mandar para o agente" flow (types `/tether-fault-investigate <id>` into an idle agent pane, or opens a new pane and
// types once its agent is up) and the test hooks. The data is the registry in Electron main, over the bus ext:faults:*.
import type { PaneType, ContextMenuEntry, StatusHandle, TetherUi } from '../../app/renderer/ext-api.ts'
import { agentUi } from '../../app/renderer/agent-ui.ts'
import { escapeHtml } from '../../app/renderer/chord-pill.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { toDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { FaultsChannels } from './ipc.ts'
import { FAULTS_COMPONENT, FAULTS_SCREEN_LAYOUT, FAULTS_TAB, FAULTS_TITLE, newFaultsPanelId } from './layouts.ts'
import { FAULTS_FEATURE, FAULTS_STATUS_ID, manifest } from './manifest.ts'
import { FaultsPanel, FaultsTab, type FaultsHost, type SendOutcome } from './panel.ts'
import { buildChooser, investigateCommand, newCount, statusSentence, type Choice } from './rules.ts'
import { FaultsStore } from './store.ts'

export { manifest }

/** How long a new pane gets to bring its agent up before the command is given up on. */
export const READY_TIMEOUT_MS = 30_000
/** The text first, the Enter after it: an agent TUI takes a burst ending in Enter for a paste, not for a submit. */
export const SUBMIT_DELAY_MS = 250

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

export function activate(ui: TetherUi): IDisposable[] {
  const ipc = ui.ipc<FaultsChannels>()
  const store = new FaultsStore({ list: () => ipc.invoke('list') })
  const panels = new Map<string, FaultsPanel>()
  /** fault sig → the pane label it was sent to ("enviada para Claude · tether-faults"), until the fault is no longer open. */
  const sent = new Map<string, string>()
  let seenLocal: string | null = null
  let generalOn = false

  const seenAt = (): string | null => seenLocal ?? store.info?.seenAt ?? null

  // ---- the general switch of the feature (settings.json agents.features.faults) ----
  const loadGeneral = (): void => {
    void ui.configuration.all().then(list => {
      const e = list.entries.find(x => x.key === `agents.features.${FAULTS_FEATURE}`)
      generalOn = e ? e.value === true : false
    }).catch(() => undefined)
  }
  loadGeneral()

  // ---- the agent chooser ----
  const chooser = () => buildChooser({
    slots: ui.slots.list(),
    openPanes: new Set(ui.panes.all().filter(p => p.agent !== undefined).map(p => p.id)),
    labelOf: id => ui.slots.label(id),
    profiles: ui.slots.profiles(),
    general: generalOn,
    cwd: store.info?.cwd ?? '',
    agentLabel: kind => agentUi(kind)?.label ?? kind,
  })

  /** Types the command and then Enter, once the slot is still idle. */
  async function type(slotId: string, faultId: string): Promise<SendOutcome | undefined> {
    const now = ui.slots.list().find(s => s.slotId === slotId)
    if (!now || now.status !== 'running' || now.turn !== 'idle') return { ok: false, message: 'O painel não está mais livre; escolha outro.' }
    ui.slots.input(slotId, investigateCommand(faultId))
    await sleep(SUBMIT_DELAY_MS)
    ui.slots.input(slotId, '\r')
    return undefined
  }

  /** Resolves when the slot's agent is up and idle, or false after the timeout. */
  function untilReady(slotId: string): Promise<boolean> {
    const ready = (): boolean => { const s = ui.slots.list().find(x => x.slotId === slotId); return !!s && s.status === 'running' && s.turn === 'idle' }
    if (ready()) return Promise.resolve(true)
    return new Promise(resolve => {
      const done = (ok: boolean): void => { sub.dispose(); clearTimeout(timer); resolve(ok) }
      const sub = ui.slots.onDidChange(() => { if (ready()) done(true) })
      const timer = setTimeout(() => done(false), READY_TIMEOUT_MS)
    })
  }

  async function send(choice: Choice, fault: { id: string; sig: string }): Promise<SendOutcome> {
    let slotId = choice.slotId
    if (choice.kind === 'new') {
      const cwd = store.info?.cwd
      if (!choice.profileId || !cwd) return { ok: false, message: 'Não sei em que pasta abrir o painel.' }
      const created = await ui.slots.create({ profileId: choice.profileId, cwd })
      if (!created.ok) return { ok: false, message: `Não abri o painel: ${created.message}` }
      slotId = created.slotId
      if (!(await untilReady(slotId))) return { ok: false, message: 'O agente não ficou pronto; o comando não foi enviado. O painel ficou aberto · Tentar de novo.' }
    }
    if (!slotId) return { ok: false, message: 'Painel desconhecido.' }
    const failed = await type(slotId, fault.id)
    if (failed) return failed
    const label = ui.slots.label(slotId)
    sent.set(fault.sig, label)
    ui.panes.reveal(slotId)
    return { ok: true, label }
  }

  const host: FaultsHost = {
    store,
    show: (id, all) => ipc.invoke('show', id, all),
    update: (id, action) => ipc.invoke('update', id, action),
    markSeen: () => { seenLocal = new Date().toISOString(); void ipc.invoke('markSeen'); syncStatus() },
    copy: text => ui.shell.writeClipboard(text),
    openFolder: path => { void ui.shell.openPath(path) },
    chooser,
    onSlotsChange: listener => ui.slots.onDidChange(listener),
    send,
    openProfile: id => ui.slots.openProfiles(id),
    sentTo: sig => sent.get(sig),
    onTabMenu: (id, ev) => ui.panes.showTabMenu(id, ev.clientX, ev.clientY),
    onClose: id => ui.panes.close(id),
  }

  // ---- the top bar: only while something is new ----
  let handle: StatusHandle | undefined
  const count = (): number => newCount(store.rows, seenAt())
  function syncStatus(): void {
    const n = count()
    if (n > 0 && !handle) {
      handle = ui.status.register({
        id: FAULTS_STATUS_ID,
        title: () => statusSentence(count()),
        state: () => 'warn',
        badge: () => count(),
        render: pop => {
          pop.innerHTML = `<div class="fl-pop"><span>${escapeHtml(statusSentence(count()))}</span> · <button type="button" class="lnk" data-act="see">Ver</button></div>`
          pop.querySelector('[data-act="see"]')!.addEventListener('click', () => { void ui.commands.run('faults.show') })
        },
      })
    } else if (n === 0 && handle) {
      handle.dispose()
      handle = undefined
    } else handle?.update()
  }
  const sub = store.onDidChange(() => {
    // A fault that is no longer open is no longer "sent".
    for (const [sig] of sent) { const r = store.rows.find(x => x.sig === sig); if (!r || r.status !== 'open') sent.delete(sig) }
    syncStatus()
  })
  const changed = ipc.on('changed', () => { void store.refresh() })
  void store.refresh()

  // ---- the screen ----
  function show(): void {
    const existing = panels.keys().next().value as string | undefined
    const found = existing ? ui.panes.find(existing) : undefined
    if (existing && found) {
      found.api.setActive()
      requestAnimationFrame(() => ui.panes.focus(existing))
      return
    }
    const reference = ui.panes.activeId()
    const within = reference && ui.panes.find(reference)
    const panel = ui.panes.open(
      { id: newFaultsPanelId(), component: FAULTS_COMPONENT, tabComponent: FAULTS_TAB, title: FAULTS_TITLE, params: {} },
      within ? { target: { level: 'pane', placement: 'within' }, reference } : {},
    )
    ui.layout.scheduleSave()
    requestAnimationFrame(() => ui.panes.focus(panel.id))
  }

  function tabMenu(id: string, x: number, y: number): void {
    const entries: ContextMenuEntry[] = [
      { icon: 'arrow-square-out', label: 'Mover…', run: () => ui.panes.move(id) },
      'sep',
      { icon: 'x', label: 'Fechar', run: () => ui.panes.close(id) },
    ]
    ui.menus.context(x, y, entries)
  }

  /** Keeps `panels` in step with a pane's life: set on init (dockview gives the id there), removed on dispose. */
  function tracked(pane: FaultsPanel): FaultsPanel {
    const init = pane.init.bind(pane)
    pane.init = params => { init(params); panels.set(pane.id, pane) }
    const dispose = pane.dispose.bind(pane)
    pane.dispose = () => { const k = pane.id; dispose(); if (panels.get(k) === pane) panels.delete(k) }
    return pane
  }

  const type_: PaneType = {
    ...FAULTS_SCREEN_LAYOUT, hasSlot: false, icon: 'bug',
    create: () => tracked(new FaultsPanel(host)),
    createTab: () => new FaultsTab(host),
    has: id => panels.has(id),
    contextFlags: () => ['faults.screen'],
    tabMenu,
    focus: id => panels.get(id)?.focus(),
  }

  ui.test.expose('faults', () => [...panels.values()].map(p => p.snapshot()))
  ui.test.expose('openFaults', () => show())
  ui.test.expose('faultsStatus', () => ({ visible: !!handle, badge: count(), title: statusSentence(count()) }))
  ui.test.expose('faultsSent', () => Object.fromEntries(sent))

  return [
    ui.panes.register(type_),
    ui.commands.registerCommand('faults.show', () => show()),
    ui.configuration.onDidChange(e => { if (e.keys.some(k => k.startsWith('agents.features'))) loadGeneral() }),
    sub,
    changed,
    toDisposable(() => { handle?.dispose(); handle = undefined }),
  ]
}
