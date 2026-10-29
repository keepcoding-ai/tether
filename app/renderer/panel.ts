// One dockview panel = one slot: a header strip (agent, title, folder, status) over an xterm.
// Attaches on first layout, streams `data`, sends `input`/`resize`, detaches on dispose.
import type { DockviewPanelApi, GroupPanelPartInitParameters, IContentRenderer, ITabRenderer, TabPartInitParameters } from 'dockview-core'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import type { SlotKind, SlotState, SlotStatus } from '../../src/daemon/protocol.ts'

export const KIND_ICON: Record<SlotKind, string> = { claude: '✦', soul: '☽', shell: '>_' }
export const KIND_LABEL: Record<SlotKind, string> = { claude: 'Claude', soul: 'soul', shell: 'Shell' }
export const STATUS_LABEL: Record<SlotStatus, string> = {
  running: 'rodando',
  queued: 'na fila',
  starting: 'iniciando',
  exited: 'encerrado',
  unconfirmed: 'não confirmado',
  error: 'erro',
}

export function folderName(cwd: string): string {
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || cwd
}

/** Text shown in the tab: agent icon + session title (or slot name, or folder name). */
export function panelTitle(s: SlotState): string {
  return `${KIND_ICON[s.kind]} ${s.title ?? s.name ?? folderName(s.cwd)}`
}

export function panelTooltip(s: SlotState): string {
  const lines = [`${KIND_LABEL[s.kind]} · ${STATUS_LABEL[s.status]}`, `Pasta: ${s.cwd}`, `Slot: ${s.slotId}`]
  if (s.binding?.sessionId) lines.push(`Sessão: ${s.binding.sessionId}`)
  if (s.error) lines.push(`Erro: ${s.error.message}`)
  return lines.join('\n')
}

export interface PanelHost {
  getSlot(slotId: string): SlotState | undefined
  /** Keys the terminal must not swallow (app shortcuts); return true when handled here. */
  onKey(ev: KeyboardEvent, panel: TerminalPanel): boolean
}

export class TerminalPanel implements IContentRenderer {
  readonly element: HTMLElement
  readonly term: Terminal
  slotId = ''
  private readonly fit = new FitAddon()
  private readonly head: { icon: HTMLElement; title: HTMLElement; cwd: HTMLElement; status: HTMLElement }
  private readonly termHost: HTMLElement
  private observer: ResizeObserver | undefined
  private attached = false
  private attaching: Promise<void> | undefined
  private lastSize = { cols: 0, rows: 0 }
  private fitTimer: ReturnType<typeof setTimeout> | undefined
  private readonly host: PanelHost

  constructor(host: PanelHost) {
    this.host = host
    this.element = document.createElement('div')
    this.element.className = 'panel'
    const head = document.createElement('div')
    head.className = 'panel-head'
    const icon = document.createElement('span'); icon.className = 'icon'
    const title = document.createElement('span'); title.className = 'title'
    const cwd = document.createElement('span'); cwd.className = 'cwd'
    const status = document.createElement('span'); status.className = 'status'
    head.append(icon, title, cwd, status)
    this.head = { icon, title, cwd, status }
    this.termHost = document.createElement('div')
    this.termHost.className = 'panel-term'
    this.element.append(head, this.termHost)

    this.term = new Terminal({
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      theme: {
        background: '#1b1b1f', foreground: '#d8d8dc', cursor: '#d8d8dc',
        selectionBackground: '#3a5a8a', black: '#1b1b1f', brightBlack: '#6b6b75',
      },
    })
    this.term.loadAddon(this.fit)
    this.term.loadAddon(new WebLinksAddon((_ev, uri) => window.tether.openExternal(uri)))
    this.term.onData(data => { if (this.slotId) window.tether.notice({ t: 'input', slotId: this.slotId, data }) })
    this.term.onSelectionChange(() => {
      if (this.term.hasSelection()) window.tether.writeClipboard(this.term.getSelection())
    })
    this.term.attachCustomKeyEventHandler(ev => !this.host.onKey(ev, this))
  }

  init(params: GroupPanelPartInitParameters): void {
    this.slotId = String(params.params.slotId ?? params.api.id)
    this.element.dataset.slotId = this.slotId
    this.term.open(this.termHost)
    this.render()
    // Attach right away, even when the panel is a hidden tab (zero size): the scrollback must land and
    // `data` must flow whether or not the panel is visible. Fits only send `resize` afterwards.
    void this.attach()
    this.observer = new ResizeObserver(() => this.scheduleFit())
    this.observer.observe(this.termHost)
    this.scheduleFit()
    // Keyboard focus follows the active panel. dockview may activate the panel before this init runs,
    // so the current state is applied too (deferred: the element is not laid out yet).
    params.api.onDidActiveChange(({ isActive }) => { if (isActive) requestAnimationFrame(() => this.term.focus()) })
    if (params.api.isActive) requestAnimationFrame(() => this.term.focus())
  }

  /** Current slot state applied to the header (called on init and on every `state` event). */
  render(): void {
    const s = this.host.getSlot(this.slotId)
    if (!s) {
      this.head.icon.textContent = '?'
      this.head.title.textContent = this.slotId
      this.head.status.textContent = 'desconhecido'
      this.head.status.className = 'status error'
      return
    }
    this.head.icon.textContent = KIND_ICON[s.kind]
    this.head.title.textContent = s.title ?? s.name ?? KIND_LABEL[s.kind]
    this.head.cwd.textContent = s.cwd
    this.head.cwd.title = s.cwd
    this.head.status.textContent = s.error ? `${STATUS_LABEL[s.status]}: ${s.error.message}` : STATUS_LABEL[s.status]
    this.head.status.className = `status ${s.status}`
  }

  write(data: string): void {
    if (this.attached) this.term.write(data)
  }

  focus(): void { this.term.focus() }

  async paste(): Promise<void> {
    const text = await window.tether.readClipboard()
    if (text) this.term.paste(text)
  }

  copy(): void {
    if (this.term.hasSelection()) window.tether.writeClipboard(this.term.getSelection())
  }

  /** Re-attach after a daemon reconnect: replaces the screen by the daemon's scrollback. */
  async reattach(): Promise<void> {
    this.attached = false
    this.term.reset()
    await this.attach()
  }

  private scheduleFit(): void {
    if (this.fitTimer) clearTimeout(this.fitTimer)
    this.fitTimer = setTimeout(() => { this.fitTimer = undefined; this.applyFit() }, 40)
  }

  private applyFit(): void {
    if (!this.termHost.isConnected || this.termHost.clientHeight === 0) return
    this.fit.fit()
    if (!this.attached) return // attach() in flight: it schedules a fit when done
    const { cols, rows } = this.term
    if (cols === this.lastSize.cols && rows === this.lastSize.rows) return
    this.lastSize = { cols, rows }
    void window.tether.request({ t: 'resize', slotId: this.slotId, cols, rows })
  }

  private attach(): Promise<void> {
    if (this.attaching) return this.attaching
    const { cols, rows } = this.term
    this.lastSize = { cols, rows }
    this.attaching = window.tether.request({ t: 'attach', slotId: this.slotId, cols, rows }).then(reply => {
      this.attaching = undefined
      if (reply.t === 'error') {
        this.term.writeln(`\x1b[31mNão foi possível anexar ao slot: ${reply.message}\x1b[0m`)
        return
      }
      this.attached = true
      if (reply.scrollback) this.term.write(reply.scrollback)
      this.scheduleFit()
    })
    return this.attaching
  }

  dispose(): void {
    this.observer?.disconnect()
    if (this.fitTimer) clearTimeout(this.fitTimer)
    if (this.attached && this.slotId) void window.tether.request({ t: 'detach', slotId: this.slotId })
    this.attached = false
    this.term.dispose()
  }
}

/** Tab: icon + title + status dot + close button; tooltip with folder, session id and status. */
export class SlotTab implements ITabRenderer {
  readonly element: HTMLElement
  private api: DockviewPanelApi | undefined
  private readonly text: HTMLElement
  private readonly dot: HTMLElement
  private disposers: Array<() => void> = []
  private readonly host: PanelHost
  private readonly onClose: (slotId: string) => void

  constructor(host: PanelHost, onClose: (slotId: string) => void) {
    this.host = host
    this.onClose = onClose
    this.element = document.createElement('div')
    this.element.className = 'tether-tab'
    this.dot = document.createElement('span'); this.dot.className = 'dot'; this.dot.textContent = '●'
    this.text = document.createElement('span'); this.text.className = 'text'
    const close = document.createElement('button')
    close.className = 'close'; close.textContent = '×'; close.title = 'Fechar painel'
    close.addEventListener('pointerdown', ev => ev.stopPropagation())
    close.addEventListener('click', ev => { ev.stopPropagation(); if (this.api) this.onClose(this.api.id) })
    this.element.append(this.dot, this.text, close)
  }

  init(params: TabPartInitParameters): void {
    this.api = params.api
    this.disposers.push(params.api.onDidTitleChange(() => this.render()).dispose)
    this.render()
  }

  render(): void {
    if (!this.api) return
    const s = this.host.getSlot(this.api.id)
    this.text.textContent = this.api.title ?? this.api.id
    this.dot.className = `dot ${s?.status ?? 'error'}`
    this.element.title = s ? panelTooltip(s) : `Slot ${this.api.id} (desconhecido)`
  }

  dispose(): void {
    for (const d of this.disposers) d()
    this.disposers = []
  }
}
