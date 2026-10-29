// One dockview panel = one slot: a header strip (agent, title, folder, status) over an xterm, plus an
// overlay for the states that need the user (unconfirmed binding, error, exited, queued).
// Attaches on first layout, streams `data`, sends `input`/`resize`, detaches on dispose.
import type { DockviewPanelApi, GroupPanelPartInitParameters, IContentRenderer, ITabRenderer, TabPartInitParameters } from 'dockview-core'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import type { ITheme } from '@xterm/xterm'
import type { ErrorCode, SlotKind, SlotState, SlotStatus } from '../../src/daemon/protocol.ts'
import { WINDOW_BACKGROUND, type ColorScheme } from '../shared/theme.ts'

/**
 * xterm palettes per scheme. Every key is set: `term.options.theme` replaces the whole object and any key
 * left out falls back to xterm's (dark) defaults. The light one follows VS Code's Light+ terminal colors,
 * whose ANSI set stays legible on white (yellow/cyan/white are darkened on purpose); bright colors keep
 * enough contrast for Claude Code's and soul's dim/bright text.
 */
export const TERMINAL_THEME: Record<ColorScheme, ITheme> = {
  dark: {
    background: WINDOW_BACKGROUND.dark, foreground: '#d8d8dc', cursor: '#d8d8dc', cursorAccent: WINDOW_BACKGROUND.dark,
    selectionBackground: '#3a5a8a', selectionForeground: undefined,
    black: '#1b1b1f', red: '#f14c4c', green: '#23d18b', yellow: '#f5f543', blue: '#3b8eea', magenta: '#d670d6', cyan: '#29b8db', white: '#e5e5e5',
    brightBlack: '#6b6b75', brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#ffffff',
  },
  light: {
    background: WINDOW_BACKGROUND.light, foreground: '#24292f', cursor: '#24292f', cursorAccent: WINDOW_BACKGROUND.light,
    selectionBackground: '#b4d5fe', selectionForeground: undefined,
    black: '#000000', red: '#cd3131', green: '#107c10', yellow: '#8a6d00', blue: '#0451a5', magenta: '#bc05bc', cyan: '#0a7f99', white: '#555555',
    brightBlack: '#5f6368', brightRed: '#cd3131', brightGreen: '#0f8a0f', brightYellow: '#946f00', brightBlue: '#0451a5', brightMagenta: '#bc05bc', brightCyan: '#0a7f99', brightWhite: '#777777',
  },
}

export const KIND_ICON: Record<SlotKind, string> = { claude: '✦', soul: '☽', shell: '>_' }
export const KIND_LABEL: Record<SlotKind, string> = { claude: 'Claude', soul: 'soul', shell: 'Shell' }
export const STATUS_LABEL: Record<SlotStatus, string> = {
  running: 'rodando',
  queued: 'na fila',
  starting: 'iniciando…',
  exited: 'encerrado',
  unconfirmed: 'não confirmado',
  error: 'erro',
}

export type SlotError = { code: ErrorCode; message: string }

/** What the user can do from a panel overlay. */
export type PanelAction = 'start' | 'resume' | 'new' | 'pick-folder' | 'close'

/**
 * The status the panel shows. The daemon reports a slot whose binding was inferred (not confirmed by the
 * agent) as `exited`; starting it is refused until the user chooses, so the panel treats it as `unconfirmed`.
 */
export function effectiveStatus(s: SlotState): SlotStatus {
  if (s.status === 'exited' && s.binding && !s.binding.confirmed) return 'unconfirmed'
  return s.status
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
  const lines = [`${KIND_LABEL[s.kind]} · ${STATUS_LABEL[effectiveStatus(s)]}`, `Pasta: ${s.cwd}`, `Slot: ${s.slotId}`]
  if (s.binding?.sessionId) lines.push(`Sessão: ${s.binding.sessionId}`)
  if (s.error) lines.push(`Erro: ${s.error.message}`)
  return lines.join('\n')
}

interface OverlaySpec {
  title: string
  text: string
  tone: 'info' | 'warn' | 'error'
  buttons: Array<{ label: string; action: PanelAction; primary?: boolean }>
}

/** What the overlay says for a daemon error code (from the slot's state or from a refused `start`). */
export function errorOverlay(s: SlotState, err: SlotError): OverlaySpec {
  const close = { label: 'Fechar painel', action: 'close' as const }
  switch (err.code) {
    case 'unconfirmed':
      return unconfirmedOverlay(s)
    case 'session-missing':
      return {
        title: 'Sessão não encontrada', tone: 'error',
        text: `${KIND_LABEL[s.kind]} não tem mais a sessão deste painel${s.binding?.sessionId ? ` (${s.binding.sessionId})` : ''}.`,
        buttons: [{ label: 'Começar nova sessão', action: 'new', primary: true }, close],
      }
    case 'cwd-missing':
      return {
        title: 'Pasta não existe', tone: 'error',
        text: `A pasta deste painel não existe mais: ${s.cwd}`,
        buttons: [{ label: 'Escolher outra pasta…', action: 'pick-folder', primary: true }, close],
      }
    case 'already-open':
      return {
        title: 'Sessão já aberta', tone: 'warn',
        text: 'Esta sessão já está rodando em outro painel.',
        buttons: [{ label: 'Começar nova sessão', action: 'new', primary: true }, close],
      }
    case 'spawn-failed':
      return {
        title: 'Não foi possível iniciar', tone: 'error',
        text: `O processo não subiu: ${err.message}`,
        buttons: [{ label: 'Tentar de novo', action: 'start', primary: true }, close],
      }
    default:
      return {
        title: 'Erro', tone: 'error',
        text: err.message,
        buttons: [{ label: 'Tentar de novo', action: 'start', primary: true }, close],
      }
  }
}

function unconfirmedOverlay(s: SlotState): OverlaySpec {
  const what = s.title ? `"${s.title}"` : s.binding?.sessionId ? `(${s.binding.sessionId})` : ''
  return {
    title: 'Sessão não confirmada', tone: 'warn',
    text: `O tether não tem certeza de qual sessão de ${KIND_LABEL[s.kind]} este painel estava rodando ${what}`.trim() + '. O que fazer?',
    buttons: [{ label: 'Retomar a última sessão', action: 'resume', primary: true }, { label: 'Começar nova sessão', action: 'new' }],
  }
}

export interface PanelHost {
  getSlot(slotId: string): SlotState | undefined
  /** The error of the last refused `start` (cleared when the slot comes up). */
  getStartError(slotId: string): SlotError | undefined
  /** A `start` was sent and not answered yet: show "iniciando…" instead of "encerrado". */
  isStartPending(slotId: string): boolean
  onAction(slotId: string, action: PanelAction): void
  /** Keys the terminal must not swallow (app shortcuts); return true when handled here. */
  onKey(ev: KeyboardEvent, panel: TerminalPanel): boolean
  /** The scheme painted right now (new terminals start with it; setScheme follows later switches). */
  getScheme(): ColorScheme
}

export class TerminalPanel implements IContentRenderer {
  readonly element: HTMLElement
  readonly term: Terminal
  slotId = ''
  private readonly fit = new FitAddon()
  private readonly head: { icon: HTMLElement; title: HTMLElement; cwd: HTMLElement; status: HTMLElement }
  private readonly termHost: HTMLElement
  private readonly overlay: HTMLElement
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
    this.overlay = document.createElement('div')
    this.overlay.className = 'panel-overlay'
    this.overlay.hidden = true
    const body = document.createElement('div')
    body.className = 'panel-body'
    body.append(this.termHost, this.overlay)
    this.element.append(head, body)

    this.term = new Terminal({
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      theme: TERMINAL_THEME[host.getScheme()],
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

  /** Current slot state applied to the header and the overlay (on init and on every `state` event). */
  render(): void {
    const s = this.host.getSlot(this.slotId)
    if (!s) {
      this.head.icon.textContent = '?'
      this.head.title.textContent = this.slotId
      this.head.status.textContent = 'desconhecido'
      this.head.status.className = 'status error'
      this.showOverlay({ title: 'Slot desconhecido', tone: 'error', text: 'O tetherd não conhece mais este painel.', buttons: [{ label: 'Fechar painel', action: 'close', primary: true }] })
      return
    }
    const startError = this.host.getStartError(this.slotId)
    const pending = this.host.isStartPending(this.slotId)
    let status = effectiveStatus(s)
    if (startError?.code === 'unconfirmed') status = 'unconfirmed'
    else if (startError && status === 'exited') status = 'error'
    else if (pending && status === 'exited') status = 'starting'
    this.head.icon.textContent = KIND_ICON[s.kind]
    this.head.title.textContent = s.title ?? s.name ?? KIND_LABEL[s.kind]
    this.head.cwd.textContent = s.cwd
    this.head.cwd.title = s.cwd
    this.head.status.textContent = STATUS_LABEL[status]
    this.head.status.className = `status ${status}`
    this.element.dataset.status = status

    const err = s.status === 'error' && s.error ? s.error : startError
    if (status === 'unconfirmed') this.showOverlay(unconfirmedOverlay(s))
    else if (status === 'error' && err) this.showOverlay(errorOverlay(s, err))
    else if (status === 'queued') this.showOverlay({ title: 'Na fila', tone: 'info', text: 'Aguardando a vez para iniciar (no máximo 3 agentes sobem ao mesmo tempo).', buttons: [] })
    else if (status === 'exited') this.showOverlay({ title: 'Encerrado', tone: 'info', text: `O processo deste painel terminou.`, buttons: [{ label: 'Iniciar de novo', action: 'start', primary: true }, { label: 'Fechar painel', action: 'close' }] })
    else this.overlay.hidden = true
  }

  private showOverlay(spec: OverlaySpec): void {
    this.overlay.replaceChildren()
    this.overlay.className = `panel-overlay ${spec.tone}`
    const card = document.createElement('div'); card.className = 'card'
    const h = document.createElement('h3'); h.textContent = spec.title
    const p = document.createElement('p'); p.textContent = spec.text
    const actions = document.createElement('div'); actions.className = 'actions'
    for (const b of spec.buttons) {
      const btn = document.createElement('button')
      btn.textContent = b.label
      btn.dataset.action = b.action
      if (b.primary) btn.className = 'primary'
      btn.addEventListener('click', ev => { ev.stopPropagation(); this.host.onAction(this.slotId, b.action) })
      actions.append(btn)
    }
    card.append(h, p)
    if (spec.buttons.length) card.append(actions)
    this.overlay.append(card)
    this.overlay.hidden = false
  }

  write(data: string): void {
    if (this.attached) this.term.write(data)
  }

  focus(): void { this.term.focus() }

  /** Repaints the terminal with the scheme's palette (live switch, scrollback kept). */
  setScheme(scheme: ColorScheme): void {
    this.term.options.theme = TERMINAL_THEME[scheme]
  }

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
    this.dot.className = `dot ${s ? effectiveStatus(s) : 'error'}`
    this.element.title = s ? panelTooltip(s) : `Slot ${this.api.id} (desconhecido)`
  }

  dispose(): void {
    for (const d of this.disposers) d()
    this.disposers = []
  }
}
