// The processes extension's renderer side (slices 5 and 6): the pad "Processos" and the `process` pane.
// The pad lists tetherd's background processes by state, in the order of what asks for action ("Pedem atenção", "Rodando",
// "Parados"), with the summary on top, dense rows (state and time, ports as links, memory, who started it and who uses
// it), labelled actions (watch, restart, stop, start) and the "⋯" (copy the command, the history, hold or let go,
// forget); its icon counts only what asks for attention, cleared when the person sees the pad. "Portas" shows who listens
// where. Looking never acts: opening, hovering, switching views, the "⋯" and the output pane change no process; every
// effect comes from a labelled button. A stop or restart that others' uses refuse asks in the core's dialog (waiting is
// the default, going ahead is destructive); forgetting confirms on the row itself.
// The `process` pane shows one process' card, its output live and read only (an xterm with stdin off: no key reaches the
// process), cleared and attached again on each new run, and its timeline. Data lives in the core (TetherUi.procs).
import type { GroupPanelPartInitParameters, IContentRenderer, ITabRenderer } from 'dockview-core'
import { FitAddon } from '@xterm/addon-fit'
import type { Terminal } from '@xterm/xterm'
import type { ContextMenuEntry, Disposable, PadView, ProcAttachment, TetherUi } from '../../app/renderer/ext-api.ts'
import { icon } from '../../app/renderer/icons.ts'
import { createTerminal } from '../../app/renderer/panel.ts'
import { terminalLinkProvider } from '../../app/renderer/terminal-links.ts'
import { applyAppearance, TerminalAddons } from '../../app/renderer/terminal-theme.ts'
import { openLink } from '../../app/renderer/link-open.ts'
import type { Reply } from '../../src/daemon/protocol.ts'
import type { PortRow } from '../../src/daemon/ports.ts'
import type { ProcEvent, ProcState } from '../../src/daemon/procs.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import {
  ACTION_LABELS, chipOf, commandLine, EMPTY_TEXT, FORCE_REASON, FORGET_CONFIRM, FORGOTTEN, HOLD_DURATION, HOLD_PURPOSE, inUseDialog,
  markOf, memoryText, MENU_LABELS, menuActions, NO_OUTPUT, othersUses, portRowView, portViews, procBadge, procGroups, type RowAction,
  rowActions, runSeparator, summaryText, timelineItem, untilText, WAIT_MS, waitingText, whenText, type MenuAction,
} from './proc-rules.ts'
import { manifest, OPEN_COMMAND, PAD_ID, PROCESS_COMPONENT, PROCESS_PANE_PREFIX, PROCESS_TAB } from './manifest.ts'

export { manifest }

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  e.className = className
  if (text !== undefined) e.textContent = text
  return e
}
const button = (className: string, text: string, run: () => void): HTMLButtonElement => {
  const b = el('button', className, text)
  b.type = 'button'
  b.addEventListener('click', ev => { ev.stopPropagation(); run() })
  return b
}
/** The first line of a refusal: tetherd's board continues with the CLI's options, which the app offers as buttons. */
const firstLine = (text: string): string => text.split('\n')[0] ?? text
const paneIdOf = (name: string): string => `${PROCESS_PANE_PREFIX}${name}`
const MINUTE = 60_000

type View = 'procs' | 'ports'

/** What a row shows besides the process' state: an act in flight, a refusal, the wait for uses, the forget confirmation. */
interface RowState { busy?: boolean; error?: string; waitingUntil?: number; confirmForget?: boolean }

export function activate(ui: TetherUi): IDisposable[] {
  const rows = new Map<string, RowState>()
  const rowOf = (name: string): RowState => { let r = rows.get(name); if (!r) rows.set(name, r = {}); return r }
  const pads = new Set<Pad>()
  const outputs = new Map<string, OutputPanel>()
  let ports: PortRow[] | undefined
  let portsError: string | undefined
  let lastBadge: ReturnType<typeof procBadge>

  // ---------- acts ----------

  const redrawAll = (): void => {
    lastBadge = procBadge(ui.procs.list())
    ui.pads.setBadge(PAD_ID, lastBadge)
    for (const p of pads) p.draw()
    for (const o of outputs.values()) o.paint()
  }
  let redrawQueued = false
  /** Many events arrive together (a restart: stopping, stopped, running): one redraw. */
  const redraw = (): void => {
    if (redrawQueued) return
    redrawQueued = true
    setTimeout(() => { redrawQueued = false; redrawAll() }, 0)
  }

  const showError = (name: string, r: Reply): boolean => {
    const row = rowOf(name)
    if (r.t === 'error') { row.error = r.code === 'proc-in-use' ? firstLine(r.message) : r.message; redraw(); return true }
    row.error = undefined
    return false
  }

  /** Stop or restart: straight when nobody else uses it; with others' uses, the dialog (wait is the default, now is destructive). */
  async function guarded(name: string, action: 'stop' | 'restart'): Promise<void> {
    const row = rowOf(name)
    if (row.busy) return
    const act = (opts: { waitMs?: number; force?: string }): Promise<Reply> => action === 'stop' ? ui.procs.stop(name, opts) : ui.procs.restart(name, opts)
    row.busy = true
    row.error = undefined
    redraw()
    try {
      let r = await act({})
      if (r.t === 'error' && r.code === 'proc-in-use') {
        const p = ui.procs.get(name)
        const answer = await ui.dialogs.ask(inUseDialog(name, action, othersUses(p ?? { uses: [] })))
        if (answer.choice === 'wait') {
          row.waitingUntil = Date.now() + WAIT_MS
          redraw()
          r = await act({ waitMs: WAIT_MS })
          row.waitingUntil = undefined
        } else if (answer.choice === 'force') r = await act({ force: FORCE_REASON })
        else return
      }
      showError(name, r)
    } finally {
      row.busy = false
      redraw()
    }
  }

  async function runAction(name: string, a: RowAction): Promise<void> {
    if (a === 'output') { openOutput(name, false); return }
    if (a === 'stop' || a === 'restart') { await guarded(name, a); return }
    const row = rowOf(name)
    row.busy = true
    row.error = undefined
    redraw()
    try { showError(name, await ui.procs.start(name)) } finally { row.busy = false; redraw() }
  }

  async function runMenu(name: string, a: MenuAction): Promise<void> {
    const p = ui.procs.get(name)
    if (!p) return
    switch (a) {
      case 'copy-command': ui.shell.writeClipboard(commandLine(p.card)); return
      case 'history': openOutput(name, true); return
      case 'hold': showError(name, await ui.procs.use(name, HOLD_DURATION, HOLD_PURPOSE)); redraw(); return
      case 'release': showError(name, await ui.procs.release(name)); redraw(); return
      case 'forget': rowOf(name).confirmForget = true; redraw(); return
    }
  }

  async function forget(name: string): Promise<void> {
    const row = rowOf(name)
    row.confirmForget = false
    row.busy = true
    redraw()
    try {
      const r = await ui.procs.forget(name)
      if (!showError(name, r)) rows.delete(name)
    } finally { row.busy = false; redraw() }
  }

  const menuEntries = (p: ProcState, opts: { inPane?: boolean } = {}): ContextMenuEntry[] => menuActions(p)
    .filter(a => !(opts.inPane && a === 'history'))
    .map(a => ({
      icon: a === 'copy-command' ? 'copy' : a === 'history' ? 'clock-counter-clockwise' : a === 'hold' ? 'push-pin' : a === 'release' ? 'push-pin-fill' : 'trash',
      label: MENU_LABELS[a],
      ...(a === 'forget' ? { danger: true } : {}),
      run: () => { void runMenu(p.name, a) },
    }))

  /** The row's (and the card's) labelled buttons, then the "⋯". */
  function actionBar(p: ProcState, opts: { inPane?: boolean } = {}): HTMLElement {
    const bar = el('div', 'pr-actions')
    const row = rowOf(p.name)
    if (row.confirmForget) {
      bar.dataset.role = 'confirm'
      bar.append(el('span', 'pr-confirm', FORGET_CONFIRM),
        button('pr-btn danger', 'Esquecer', () => { void forget(p.name) }),
        button('pr-btn', 'Cancelar', () => { row.confirmForget = false; redraw() }))
      return bar
    }
    for (const a of rowActions(p)) {
      if (opts.inPane && a === 'output') continue
      const b = button(`pr-btn${a === 'stop' ? ' quiet-danger' : ''}`, ACTION_LABELS[a], () => { void runAction(p.name, a) })
      b.dataset.action = a
      b.disabled = !!row.busy
      bar.append(b)
    }
    const more = button('pr-more', '', () => {
      const r = more.getBoundingClientRect()
      ui.menus.context(r.left, r.bottom + 2, menuEntries(p, opts))
    })
    more.append(icon('dots-three'))
    more.title = 'Mais ações'
    more.dataset.action = 'more'
    more.setAttribute('aria-label', `Mais ações de ${p.name}`)
    bar.append(more)
    return bar
  }

  /** An author's chip: the panel's current name; a click brings the agent's pane forward. */
  function chip(by: ProcState['startedBy']): HTMLElement {
    const c = chipOf(by, by?.slotId ? ui.agents.get(by.slotId) : undefined)
    const e = c.focusable ? button('pr-chip link', '', () => { if (c.slotId) ui.agents.focus(c.slotId) }) : el('span', 'pr-chip')
    e.append(icon(c.icon === 'agent' ? 'sparkle' : c.icon === 'shell' ? 'terminal-window' : c.icon === 'person' ? 'eye' : 'globe-simple'), document.createTextNode(c.text))
    if (c.focusable) e.title = `Ir para o painel ${c.text}`
    return e
  }

  /** Ports (links while they listen), memory, who started it and who uses it, separated by "·". */
  function facts(p: ProcState, into: HTMLElement): void {
    const parts: HTMLElement[] = []
    for (const v of portViews(p)) {
      if (v.url) {
        const a = button('pr-port live', v.text, () => openLink({ kind: 'external', url: v.url! }))
        a.title = `Abrir ${v.url}`
        parts.push(a)
      } else parts.push(el('span', 'pr-port', v.text))
    }
    if (p.memoryMB !== undefined && (p.status === 'running' || p.status === 'stopping')) parts.push(el('span', 'pr-mem', memoryText(p.memoryMB)))
    parts.forEach((part, i) => { if (i) into.append(el('span', 'pr-sep', '·')); into.append(part) })
  }
  function people(p: ProcState, into: HTMLElement): void {
    if (p.startedBy) into.append(el('span', 'pr-dim', 'iniciado por '), chip(p.startedBy))
    for (const u of p.uses ?? []) {
      if (into.childNodes.length) into.append(el('span', 'pr-sep', '·'))
      into.append(el('span', 'pr-dim', 'em uso por '), chip(u.by), el('span', 'pr-dim', ` ${untilText(u)}`))
      into.lastElementChild!.setAttribute('title', u.purpose)
    }
  }

  // ---------- the pad ----------

  let clock: ReturnType<typeof setInterval> | undefined
  /** Relative times tick once a minute, only while a pad is shown. */
  const syncClock = (): void => {
    const shown = [...pads].some(p => p.visible)
    if (shown && !clock) clock = setInterval(() => { for (const p of pads) if (p.visible) p.draw() }, MINUTE)
    if (!shown && clock) { clearInterval(clock); clock = undefined }
  }
  /** Seeing the pad is the only look that does something: it clears the attention of what it shows. */
  const markSeen = (): void => {
    if (![...pads].some(p => p.visible)) return
    for (const p of ui.procs.list()) if (p.attention) void ui.procs.seen(p.name)
  }

  async function loadPorts(): Promise<void> {
    const r = await ui.procs.ports()
    if (r.t === 'error') { portsError = r.message; ports = undefined } else { portsError = undefined; ports = r.ports ?? [] }
    redraw()
  }

  class Pad implements PadView {
    readonly element = el('div', 'pr-pad')
    visible = false
    view: View
    private flashName: string | undefined
    constructor(state: unknown) {
      this.element.dataset.pad = PAD_ID
      this.view = (state as { view?: View } | undefined)?.view === 'ports' ? 'ports' : 'procs'
      pads.add(this)
      this.draw()
      if (this.view === 'ports') void loadPorts()
    }
    serialize(): unknown { return { view: this.view } }
    focus(): void { this.element.querySelector<HTMLElement>('button')?.focus() }
    setVisible(visible: boolean): void {
      this.visible = visible
      syncClock()
      if (visible) { this.draw(); markSeen() }
    }
    setView(v: View, host?: { persist(): void }): void {
      if (this.view === v) return
      this.view = v
      host?.persist()
      if (v === 'ports') void loadPorts()
      this.draw()
    }
    /** From the ports view to a process' row. */
    reveal(name: string): void {
      this.flashName = name
      this.setView('procs', this.host)
      this.draw()
      this.element.querySelector<HTMLElement>(`.pr-row[data-proc="${CSS.escape(name)}"]`)?.scrollIntoView({ block: 'nearest' })
      setTimeout(() => { this.flashName = undefined; this.draw() }, 1200)
    }
    host: { persist(): void } | undefined
    draw(): void {
      const list = ui.procs.list()
      const now = Date.now()
      const root = el('div', 'pr-pad-in')
      root.dataset.view = this.view
      const head = el('div', 'pr-head')
      const summary = el('div', 'pr-summary', summaryText(list))
      summary.dataset.role = 'summary'
      const toggle = el('div', 'pr-toggle')
      toggle.setAttribute('role', 'group')
      for (const [v, label] of [['procs', 'Processos'], ['ports', 'Portas']] as const) {
        const b = button('pr-chipbtn', label, () => this.setView(v, this.host))
        b.dataset.view = v
        b.setAttribute('aria-pressed', String(this.view === v))
        toggle.append(b)
      }
      head.append(summary, toggle)
      root.append(head)
      const body = el('div', 'pr-body')
      root.append(body)
      if (this.view === 'ports') this.drawPorts(body)
      else if (!list.length) body.append(el('p', 'pr-empty', EMPTY_TEXT))
      else for (const g of procGroups(list)) {
        const section = el('section', 'pr-group')
        section.dataset.group = g.id
        const h = el('h3', 'pr-group-head', g.title)
        h.append(el('span', 'pr-count', String(g.procs.length)))
        section.append(h)
        for (const p of g.procs) section.append(this.row(p, now))
        body.append(section)
      }
      this.element.replaceChildren(root)
    }
    private row(p: ProcState, now: number): HTMLElement {
      const r = rowOf(p.name)
      const row = el('div', 'pr-row')
      row.dataset.proc = p.name
      row.dataset.status = p.status
      if (this.flashName === p.name) row.classList.add('flash')
      if (p.card.description) row.title = p.card.description
      const l1 = el('div', 'pr-l1')
      const mark = el('span', 'pr-mark')
      mark.dataset.mark = markOf(p)
      if (markOf(p) === 'warn') mark.append(icon('warning'))
      l1.append(mark, el('span', 'pr-name', p.name))
      const when = el('span', 'pr-when', whenText(p, now))
      when.dataset.role = 'when'
      l1.append(when)
      row.append(l1)
      const l2 = el('div', 'pr-l2')
      l2.dataset.role = 'facts'
      facts(p, l2)
      if (l2.childNodes.length) row.append(l2)
      const l3 = el('div', 'pr-l3')
      l3.dataset.role = 'people'
      people(p, l3)
      if (l3.childNodes.length) row.append(l3)
      if (p.status === 'failed' && p.error) row.append(el('div', 'pr-err', p.error))
      if (r.waitingUntil) { const w = el('div', 'pr-wait', waitingText(r.waitingUntil)); w.dataset.role = 'waiting'; row.append(w) }
      if (r.error) { const e = el('div', 'pr-err', r.error); e.dataset.role = 'error'; row.append(e) }
      row.append(actionBar(p))
      return row
    }
    private drawPorts(body: HTMLElement): void {
      const bar = el('div', 'pr-ports-bar')
      bar.append(button('pr-btn', 'Atualizar', () => { void loadPorts() }))
      body.append(bar)
      if (portsError) { body.append(el('div', 'pr-err', portsError)); return }
      if (!ports) { body.append(el('p', 'pr-empty', 'Lendo as portas…')); return }
      if (!ports.length) { body.append(el('p', 'pr-empty', 'Nenhuma porta ouvindo nem declarada.')); return }
      const table = el('div', 'pr-ports')
      for (const row of ports.map(portRowView)) {
        const line = el('div', 'pr-port-row')
        line.dataset.port = String(row.port)
        line.dataset.listening = String(row.listening)
        const port = el('span', 'pr-port-num', String(row.port))
        const who = row.proc ? button('pr-chip link', row.who, () => this.reveal(row.proc!)) : el('span', row.listening ? 'pr-who' : 'pr-who free', row.who)
        who.dataset.role = 'who'
        line.append(port, who)
        if (row.declared) line.append(el('span', 'pr-declared', row.declared))
        table.append(line)
      }
      body.append(table)
    }
    dispose(): void { pads.delete(this); syncClock() }
  }

  // ---------- the output pane ----------

  function openOutput(name: string, timeline: boolean): void {
    const id = paneIdOf(name)
    const live = outputs.get(id)
    if (ui.panes.find(id)) {
      ui.panes.reveal(id)
      if (timeline) live?.setTimeline(true)
      return
    }
    ui.panes.open({ id, component: PROCESS_COMPONENT, tabComponent: PROCESS_TAB, title: name, params: { name, timeline } })
  }

  class OutputPanel implements IContentRenderer {
    readonly element = el('div', 'pr-out')
    private readonly card = el('div', 'pr-card')
    private readonly termHost = el('div', 'pr-term')
    /** "── execução 3 ──" above the screen: a process' output starts by clearing its screen (ConPTY), so it lives outside it. */
    private readonly runLine = el('div', 'pr-run')
    private readonly timeline = el('aside', 'pr-timeline')
    private readonly fit = new FitAddon()
    private term: Terminal | undefined
    /** WebGL and ligatures, the same as the slot panes (follow the appearance live). */
    private addons: TerminalAddons | undefined
    private name = ''
    private paneId = ''
    private api: GroupPanelPartInitParameters['api'] | undefined
    private run: number | undefined
    private gen = 0
    private attachment: ProcAttachment | undefined
    private events: ProcEvent[] = []
    private timelineOpen = true
    private forgotten = false
    private disposed = false
    private readonly subs: Disposable[] = []
    private ro: ResizeObserver | undefined
    private fitTimer: ReturnType<typeof setTimeout> | undefined

    init(p: GroupPanelPartInitParameters): void {
      const params = p.params as { name?: string; timeline?: boolean }
      this.name = String(params.name ?? p.api.id.slice(PROCESS_PANE_PREFIX.length))
      this.paneId = p.api.id
      this.api = p.api
      this.timelineOpen = params.timeline !== false
      this.element.dataset.proc = this.name
      outputs.set(this.paneId, this)
      const body = el('div', 'pr-out-body')
      const screen = el('div', 'pr-screen')
      screen.append(this.runLine, this.termHost)
      body.append(screen, this.timeline)
      this.element.append(this.card, body)
      const term = createTerminal(ui.theme.appearance(), ui.theme.scheme(), { cursorBlink: false, disableStdin: true })
      this.term = term
      term.loadAddon(this.fit)
      term.registerLinkProvider(terminalLinkProvider(term, {
        openingCwd: () => ui.procs.get(this.name)?.card.cwd,
        open: target => openLink(target, { baseDir: ui.procs.get(this.name)?.card.cwd }),
      }))
      term.open(this.termHost)
      this.addons = new TerminalAddons(term)
      this.addons.start(ui.theme.appearance())
      this.ro = new ResizeObserver(() => this.scheduleFit())
      this.ro.observe(this.termHost)
      this.subs.push(
        ui.theme.onChange(scheme => this.repaintTerm(scheme)),
        ui.theme.onAppearance(() => this.repaintTerm(ui.theme.scheme())),
        ui.procs.onDidChange(e => this.onChange(e.names, !!e.reconnected)),
      )
      this.paint()
      void this.attach()
      void this.loadTimeline()
    }

    private repaintTerm(scheme: ReturnType<TetherUi['theme']['scheme']>): void {
      if (!this.term) return
      applyAppearance(this.term, ui.theme.appearance(), scheme)
      this.addons?.update(ui.theme.appearance())
      this.term.refresh(0, this.term.rows - 1)
      this.scheduleFit()
    }

    private scheduleFit(): void {
      clearTimeout(this.fitTimer)
      this.fitTimer = setTimeout(() => { if (this.termHost.isConnected && this.termHost.clientHeight > 0) this.fit.fit() }, 40)
    }

    private onChange(names: string[] | undefined, reconnected: boolean): void {
      if (names && !names.includes(this.name) && !reconnected) return
      const p = ui.procs.get(this.name)
      if (!p) { if (names?.includes(this.name) || !names) this.setForgotten(); return }
      this.forgotten = false
      if (reconnected || p.run !== this.run) void this.attach()
      this.paint()
      if (this.timelineOpen) void this.loadTimeline()
    }

    private setForgotten(): void {
      if (this.forgotten) return
      this.forgotten = true
      this.attachment?.dispose()
      this.attachment = undefined
      this.paint()
    }

    /** Attaches to the current run: the screen is cleared and gets the scrollback, then the live output. */
    private async attach(): Promise<void> {
      const term = this.term
      if (!term) return
      const gen = ++this.gen
      const p = ui.procs.get(this.name)
      this.run = p?.run
      const old = this.attachment
      const a = await ui.procs.attach(this.name, data => { if (gen === this.gen) term.write(data) })
      old?.dispose()
      if (gen !== this.gen || this.disposed) { a.dispose(); return }
      this.attachment = a
      term.reset()
      this.runLine.textContent = p?.run ? runSeparator(p.run) : ''
      this.runLine.hidden = !p?.run
      if (a.error) term.writeln(`\x1b[31m${a.error}\x1b[0m`)
      else if (a.scrollback === undefined) term.writeln(`\x1b[2m${NO_OUTPUT(this.name)}\x1b[0m`)
      else term.write(a.scrollback)
    }

    private async loadTimeline(): Promise<void> {
      if (!this.timelineOpen) { this.drawTimeline(); return }
      const r = await ui.procs.info(this.name)
      if (this.disposed) return
      if (r.t === 'ok') this.events = r.events ?? []
      this.drawTimeline()
    }

    setTimeline(open: boolean): void {
      this.timelineOpen = open
      if (this.api) { this.api.updateParameters({ name: this.name, timeline: open }); ui.layout.scheduleSave() }
      this.paint()
      void this.loadTimeline()
      this.scheduleFit()
    }

    private drawTimeline(): void {
      this.timeline.hidden = !this.timelineOpen
      if (!this.timelineOpen) return
      const head = el('div', 'pr-tl-head', 'Linha do tempo')
      const list = el('ol', 'pr-tl')
      for (const e of this.events.map(timelineItem)) {
        const li = el('li', 'pr-tl-item')
        li.append(el('span', 'pr-tl-time', e.time), el('span', 'pr-tl-who', e.who), el('span', 'pr-tl-what', e.what))
        if (e.reason) li.append(el('span', 'pr-tl-why', `motivo: ${e.reason}`))
        list.append(li)
      }
      this.timeline.replaceChildren(head, list)
      list.scrollTop = list.scrollHeight
    }

    /** The card: name, state, ports, who started it, uses, memory and the row's actions. */
    paint(): void {
      const p = this.forgotten ? undefined : ui.procs.get(this.name)
      this.element.dataset.forgotten = String(!p)
      const top = el('div', 'pr-card-l1')
      const mark = el('span', 'pr-mark')
      mark.dataset.mark = p ? markOf(p) : 'idle'
      top.append(mark, el('span', 'pr-name', this.name))
      const state = el('span', 'pr-when', p ? whenText(p) : FORGOTTEN)
      state.dataset.role = 'when'
      top.append(state)
      const tl = button('pr-btn ghost', 'Linha do tempo', () => this.setTimeline(!this.timelineOpen))
      tl.setAttribute('aria-pressed', String(this.timelineOpen))
      tl.dataset.action = 'timeline'
      top.append(el('span', 'pr-grow'), tl)
      const lines: HTMLElement[] = [top]
      if (p) {
        const l2 = el('div', 'pr-l2')
        facts(p, l2)
        const l3 = el('div', 'pr-l3')
        people(p, l3)
        if (l2.childNodes.length) lines.push(l2)
        if (l3.childNodes.length) lines.push(l3)
        const r = rowOf(p.name)
        if (r.waitingUntil) lines.push(el('div', 'pr-wait', waitingText(r.waitingUntil)))
        if (r.error) lines.push(el('div', 'pr-err', r.error))
        lines.push(actionBar(p, { inPane: true }))
        if (p.card.description) this.card.title = p.card.description
      }
      this.card.replaceChildren(...lines)
      tabs.get(this.paneId)?.paint()
    }

    /** What the e2e reads: the screen's text, the card, the timeline. */
    snapshot(): { text: string; run: string; card: string; timeline: string[]; forgotten: boolean; stdinDisabled: boolean } {
      const buf = this.term?.buffer.active
      const lines: string[] = []
      if (buf) for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '')
      return {
        text: lines.join('\n').replace(/\n+$/, ''),
        run: this.runLine.hidden ? '' : this.runLine.textContent ?? '',
        card: this.card.textContent ?? '',
        timeline: [...this.timeline.querySelectorAll('.pr-tl-item')].map(li => li.textContent ?? ''),
        forgotten: this.element.dataset.forgotten === 'true',
        stdinDisabled: this.term?.options.disableStdin === true,
      }
    }

    dispose(): void {
      this.disposed = true
      this.gen++
      this.attachment?.dispose()
      this.ro?.disconnect()
      clearTimeout(this.fitTimer)
      for (const s of this.subs) s.dispose()
      this.term?.dispose()
      if (outputs.get(this.paneId) === this) outputs.delete(this.paneId)
    }
  }

  /** The tab: the icon, the process' name and its state's mark. */
  const tabs = new Map<string, OutputTab>()
  class OutputTab implements ITabRenderer {
    readonly element = el('div', 'pr-tab')
    private readonly mark = el('span', 'pr-mark')
    private paneId = ''
    private name = ''
    init(p: GroupPanelPartInitParameters): void {
      this.paneId = p.api.id
      this.name = String((p.params as { name?: string }).name ?? this.paneId.slice(PROCESS_PANE_PREFIX.length))
      const close = el('button', 'close')
      close.title = 'Fechar painel'; close.setAttribute('aria-label', 'Fechar painel')
      close.append(icon('x'))
      close.addEventListener('pointerdown', ev => ev.stopPropagation())
      close.addEventListener('click', ev => { ev.stopPropagation(); ui.panes.close(this.paneId) })
      this.element.append(icon('pulse'), el('span', 'pr-tab-title', this.name), this.mark, close)
      this.element.addEventListener('contextmenu', ev => { ev.preventDefault(); ev.stopPropagation(); ui.panes.showTabMenu(this.paneId, ev.clientX, ev.clientY) })
      tabs.set(this.paneId, this)
      this.paint()
    }
    paint(): void {
      const p = ui.procs.get(this.name)
      this.mark.dataset.mark = p ? markOf(p) : 'idle'
      this.element.title = p ? `${this.name}: ${whenText(p)}` : `${this.name}: ${FORGOTTEN}`
    }
    dispose(): void { if (tabs.get(this.paneId) === this) tabs.delete(this.paneId) }
  }

  // ---------- test hooks ----------

  const shownPad = (): Pad | undefined => [...pads].find(p => p.element.isConnected) ?? [...pads][0]
  const text = (e: Element | null | undefined): string => (e?.textContent ?? '').replace(/\s+/g, ' ').trim()
  ui.test.expose('processesPad', () => {
    const pad = shownPad()
    if (!pad) return null
    const root = pad.element
    return {
      visible: pad.visible,
      view: pad.view,
      summary: text(root.querySelector('[data-role="summary"]')),
      empty: text(root.querySelector('.pr-empty')),
      badge: lastBadge ?? null,
      groups: [...root.querySelectorAll<HTMLElement>('.pr-group')].map(g => ({
        id: g.dataset.group ?? '',
        title: text(g.querySelector('.pr-group-head')),
        rows: [...g.querySelectorAll<HTMLElement>('.pr-row')].map(r => ({
          name: r.dataset.proc ?? '', status: r.dataset.status ?? '', title: r.title,
          when: text(r.querySelector('[data-role="when"]')), facts: text(r.querySelector('[data-role="facts"]')), people: text(r.querySelector('[data-role="people"]')),
          error: text(r.querySelector('[data-role="error"]')), waiting: text(r.querySelector('[data-role="waiting"]')),
          actions: [...r.querySelectorAll<HTMLButtonElement>('.pr-actions button')].map(b => b.textContent || b.dataset.action || ''),
          confirm: text(r.querySelector('[data-role="confirm"] .pr-confirm')),
        })),
      })),
      ports: [...root.querySelectorAll<HTMLElement>('.pr-port-row')].map(r => ({ port: Number(r.dataset.port), listening: r.dataset.listening === 'true', who: text(r.querySelector('[data-role="who"]')), declared: text(r.querySelector('.pr-declared')) })),
    }
  })
  ui.test.expose('processesOpenPad', () => { ui.pads.open(PAD_ID) })
  ui.test.expose('processesMenuRun', (name: string, action: MenuAction) => { void runMenu(name, action) })
  ui.test.expose('processesOutput', (name: string) => outputs.get(paneIdOf(name))?.snapshot() ?? null)

  return [
    ui.pads.register({
      id: PAD_ID,
      create: host => { const p = new Pad(host.state); p.host = host; return p },
    }),
    ui.panes.register({
      id: 'process', idPrefix: PROCESS_PANE_PREFIX, component: PROCESS_COMPONENT, tabComponent: PROCESS_TAB, hasSlot: false, icon: 'pulse',
      optionsOf: p => ({ id: p.id, component: PROCESS_COMPONENT, tabComponent: PROCESS_TAB, title: p.title ?? p.id.slice(PROCESS_PANE_PREFIX.length), params: p.params ?? {} }),
      create: () => new OutputPanel(), createTab: () => new OutputTab() as unknown as ITabRenderer, has: id => outputs.has(id),
      // The process' own actions, then the minimum every tab has (hiding the tabs' × never leaves a tab without a close).
      tabMenu: (id, x, y) => {
        const name = id.slice(PROCESS_PANE_PREFIX.length)
        const p = ui.procs.get(name)
        ui.menus.context(x, y, [
          ...(p ? [...menuEntries(p, { inPane: true }), 'sep' as const] : []),
          { icon: 'link', label: 'Copiar link do painel', run: () => ui.panes.copyLink(id) },
          { icon: 'arrow-square-out', label: 'Mover…', run: () => ui.panes.move(id) },
          'sep',
          { icon: 'x', label: 'Fechar painel', run: () => ui.panes.close(id) },
        ])
      },
    }),
    ui.commands.registerCommand(OPEN_COMMAND, () => ui.pads.open(PAD_ID)),
    ui.procs.onDidChange(e => {
      if (e.names) for (const n of e.names) if (!ui.procs.get(n)) rows.delete(n)
      // A process that asks for attention while the pad is shown is seen at once.
      if (ui.procs.list().some(p => p.attention)) markSeen()
      redraw()
    }),
    ui.agents.onDidChange(() => redraw()),
    { dispose: () => { if (clock) clearInterval(clock) } },
  ]
}
