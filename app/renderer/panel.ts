// One dockview panel = one slot: a header strip (agent, title, folder, status) over an xterm, plus an
// overlay for the states that need the user (unconfirmed binding, error, exited, queued).
// Attaches on first layout, streams `data`, sends `input`/`resize`, detaches on dispose.
import type { DockviewPanelApi, GroupPanelPartInitParameters, IContentRenderer, ITabRenderer, TabPartInitParameters } from 'dockview-core'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import type { ITheme } from '@xterm/xterm'
import type { ErrorCode, SlotKind, SlotState, SlotStatus } from '../../src/daemon/protocol.ts'
import type { DialogChoice } from '../shared/dialog.ts'
import { WINDOW_BACKGROUND, type ColorScheme } from '../shared/theme.ts'
import { renderChoices, roveWithArrows } from './dialog.ts'
import { icon, KIND_ICON, setIcon, type IconName } from './icons.ts'
import { folderName } from './situations.ts'

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

/**
 * Text shown in the tab (next to the agent's icon): the slot name (chosen by the user: tab rename, CLI --name),
 * else the session title (set by the agent), else the folder name.
 */
export function panelTitle(s: SlotState): string {
  return s.name ?? s.title ?? folderName(s.cwd)
}

export function panelTooltip(s: SlotState): string {
  const lines = [`${KIND_LABEL[s.kind]} · ${STATUS_LABEL[effectiveStatus(s)]}`, `Pasta: ${s.cwd}`, `Slot: ${s.slotId}`]
  if (s.name && s.title) lines.push(`Título: ${s.title}`)
  if (s.binding?.sessionId) lines.push(`Sessão: ${s.binding.sessionId}`)
  if (s.error) lines.push(`Erro: ${s.error.message}`)
  return lines.join('\n')
}

/** A choice on a panel overlay: the same card as the dialog's, whose id is the panel action it fires. */
type OverlayChoice = DialogChoice & { id: PanelAction }

/** An in-panel situation: same structure as the dialog (icon, title, text, choices with consequences), inside the panel. */
interface OverlaySpec {
  icon: IconName
  title: string
  text: string
  tone: 'info' | 'warn' | 'error'
  choices: OverlayChoice[]
}

const CLOSE: OverlayChoice = { id: 'close', icon: 'x', label: 'Fechar painel', consequence: 'O slot fica em Slots fechados.', tone: 'neutral' }
const NEW_SESSION = (consequence: string): OverlayChoice => ({ id: 'new', icon: 'plus', label: 'Começar nova sessão', consequence, tone: 'safe' })

/** What the overlay says for a daemon error code (from the slot's state or from a refused `start`). */
export function errorOverlay(s: SlotState, err: SlotError): OverlaySpec {
  switch (err.code) {
    case 'unconfirmed':
      return unconfirmedOverlay(s)
    case 'session-missing':
      return {
        icon: 'x-circle', title: 'Sessão não encontrada', tone: 'error',
        text: `${KIND_LABEL[s.kind]} não tem mais a sessão deste painel${s.binding?.sessionId ? ` (${s.binding.sessionId.slice(0, 8)})` : ''}.`,
        choices: [NEW_SESSION('Abre uma conversa nova nesta pasta.'), CLOSE],
      }
    case 'cwd-missing':
      return {
        icon: 'folder-open', title: 'A pasta não existe mais', tone: 'error',
        text: s.cwd,
        choices: [{ id: 'pick-folder', icon: 'folder-open', label: 'Escolher outra pasta…', consequence: 'Abre um slot novo do mesmo tipo na pasta escolhida, neste mesmo lugar.', tone: 'safe' }, CLOSE],
      }
    case 'already-open':
      return {
        icon: 'warning', title: 'Esta sessão já está aberta em outro painel', tone: 'warn',
        text: 'Duas cópias da mesma conversa não podem rodar ao mesmo tempo.',
        choices: [NEW_SESSION('Uma conversa nova nesta pasta; a outra continua no painel dela.'), CLOSE],
      }
    case 'spawn-failed':
      return {
        icon: 'x-circle', title: 'O processo não subiu', tone: 'error',
        text: err.message,
        choices: [{ id: 'start', icon: 'arrow-clockwise', label: 'Tentar de novo', consequence: 'Tenta iniciar o processo outra vez.', tone: 'safe' }, CLOSE],
      }
    default:
      return {
        icon: 'x-circle', title: 'Erro', tone: 'error',
        text: err.message,
        choices: [{ id: 'start', icon: 'arrow-clockwise', label: 'Tentar de novo', consequence: 'Tenta iniciar o processo outra vez.', tone: 'safe' }, CLOSE],
      }
  }
}

function unconfirmedOverlay(s: SlotState): OverlaySpec {
  const what = s.title ? ` "${s.title}"` : s.binding?.sessionId ? ` (${s.binding.sessionId.slice(0, 8)})` : ''
  return {
    icon: 'question', title: 'Qual sessão este painel estava rodando?', tone: 'warn',
    text: `O tether não tem certeza de qual sessão de ${KIND_LABEL[s.kind]} era a deste painel${what}.`,
    choices: [
      { id: 'resume', icon: 'clock-counter-clockwise', label: 'Retomar a última sessão', consequence: 'Continua a conversa mais recente desta pasta.', tone: 'safe' },
      NEW_SESSION(`A conversa anterior continua no histórico de ${KIND_LABEL[s.kind]}.`),
    ],
  }
}

function exitedOverlay(s: SlotState): OverlaySpec {
  const shell = s.kind === 'shell'
  return {
    icon: 'stop-circle', title: shell ? 'O shell terminou' : `${KIND_LABEL[s.kind]} terminou`, tone: 'info',
    text: shell ? 'Nenhum processo neste painel.' : 'Nenhum processo neste painel; a conversa está salva.',
    choices: [
      { id: 'start', icon: 'play', label: 'Iniciar de novo', consequence: shell ? 'Abre um shell novo na mesma pasta.' : 'Retoma a conversa deste slot.', tone: 'safe' },
      CLOSE,
    ],
  }
}

const QUEUED: OverlaySpec = { icon: 'hourglass', title: 'Na fila', tone: 'info', text: 'Aguardando a vez para iniciar (no máximo 3 agentes sobem ao mesmo tempo).', choices: [] }
const UNKNOWN: OverlaySpec = {
  icon: 'x-circle', title: 'Slot desconhecido', tone: 'error', text: 'O tetherd não conhece mais este painel.',
  choices: [{ id: 'close', icon: 'x', label: 'Fechar painel', consequence: 'Só remove o painel: não há slot por trás dele.', tone: 'safe' }],
}

export interface PanelHost {
  getSlot(slotId: string): SlotState | undefined
  /** The error of the last refused `start` (cleared when the slot comes up). */
  getStartError(slotId: string): SlotError | undefined
  /** A `start` was sent and not answered yet: show "iniciando…" instead of "encerrado". */
  isStartPending(slotId: string): boolean
  onAction(slotId: string, action: PanelAction): void
  /** The user renamed the tab; an empty name removes the custom name (the session title shows again). */
  onRename(slotId: string, name: string): void
  /** Keys the terminal must not swallow (app shortcuts); return true when handled here. */
  onKey(ev: KeyboardEvent, panel: TerminalPanel): boolean
  /** The scheme painted right now (new terminals start with it; setScheme follows later switches). */
  getScheme(): ColorScheme
  /** The terminal font size in use (new terminals start with it; setFontSize follows later changes). */
  getFontSize(): number
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
      fontSize: host.getFontSize(),
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
      setIcon(this.head.icon, 'question')
      this.head.title.textContent = this.slotId
      this.setStatus('error', 'desconhecido')
      this.showOverlay(UNKNOWN)
      return
    }
    const startError = this.host.getStartError(this.slotId)
    const pending = this.host.isStartPending(this.slotId)
    let status = effectiveStatus(s)
    if (startError?.code === 'unconfirmed') status = 'unconfirmed'
    else if (startError && status === 'exited') status = 'error'
    else if (pending && status === 'exited') status = 'starting'
    setIcon(this.head.icon, KIND_ICON[s.kind])
    this.head.title.textContent = s.name ?? s.title ?? KIND_LABEL[s.kind]
    this.head.cwd.textContent = s.cwd
    this.head.cwd.title = s.cwd
    this.setStatus(status, STATUS_LABEL[status])
    this.element.dataset.status = status

    const err = s.status === 'error' && s.error ? s.error : startError
    if (status === 'unconfirmed') this.showOverlay(unconfirmedOverlay(s))
    else if (status === 'error' && err) this.showOverlay(errorOverlay(s, err))
    else if (status === 'queued') this.showOverlay(QUEUED)
    else if (status === 'exited') this.showOverlay(exitedOverlay(s))
    else this.overlay.hidden = true
  }

  private setStatus(status: string, label: string): void {
    this.head.status.className = `status ${status}`
    this.head.status.replaceChildren(icon('circle-fill', 'status-dot'), document.createTextNode(label))
  }

  /** The overlay re-renders on every state event; the same situation is left alone (focus and arrows stay put). */
  private overlayKey = ''

  private showOverlay(spec: OverlaySpec): void {
    const key = JSON.stringify(spec)
    if (!this.overlay.hidden && key === this.overlayKey) return
    this.overlayKey = key
    this.overlay.replaceChildren()
    this.overlay.className = `panel-overlay ${spec.tone}`
    const card = document.createElement('div'); card.className = 'card'
    card.setAttribute('role', 'group')
    card.setAttribute('aria-label', spec.title)
    const head = document.createElement('header')
    const badge = document.createElement('span'); badge.className = 'badge'; badge.append(icon(spec.icon))
    const h = document.createElement('h3'); h.textContent = spec.title
    head.append(badge, h)
    const p = document.createElement('p'); p.textContent = spec.text
    card.append(head, p)
    if (spec.choices.length) {
      const def = spec.choices.find(c => c.tone === 'safe')?.id
      const choices = renderChoices(spec.choices, id => this.host.onAction(this.slotId, id as PanelAction), { defaultId: def })
      for (const b of choices.querySelectorAll<HTMLButtonElement>('button.choice')) b.dataset.action = b.dataset.choice
      choices.addEventListener('keydown', ev => { roveWithArrows(choices, ev) })
      card.append(choices)
    }
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

  /** Changes the font size and refits: the new cols/rows reach the daemon through the usual `resize`. */
  setFontSize(size: number): void {
    if (this.term.options.fontSize === size) return
    this.term.options.fontSize = size
    this.scheduleFit()
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

/** Tab: agent icon + title + status dot + close button; tooltip with folder, session id and status. */
export class SlotTab implements ITabRenderer {
  readonly element: HTMLElement
  private api: DockviewPanelApi | undefined
  private readonly kind: HTMLElement
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
    this.kind = document.createElement('span'); this.kind.className = 'kind'
    this.dot = document.createElement('span'); this.dot.className = 'dot'; this.dot.append(icon('circle-fill'))
    this.text = document.createElement('span'); this.text.className = 'text'
    const close = document.createElement('button')
    close.className = 'close'; close.title = 'Fechar painel'; close.setAttribute('aria-label', 'Fechar painel')
    close.append(icon('x'))
    close.addEventListener('pointerdown', ev => ev.stopPropagation())
    close.addEventListener('click', ev => { ev.stopPropagation(); if (this.api) this.onClose(this.api.id) })
    this.element.append(this.kind, this.text, this.dot, close)
    this.element.addEventListener('dblclick', ev => { ev.preventDefault(); ev.stopPropagation(); this.startRename() })
  }

  init(params: TabPartInitParameters): void {
    this.api = params.api
    this.disposers.push(params.api.onDidTitleChange(() => this.render()).dispose)
    this.render()
  }

  render(): void {
    if (!this.api) return
    const s = this.host.getSlot(this.api.id)
    setIcon(this.kind, s ? KIND_ICON[s.kind] : 'question')
    this.text.textContent = this.api.title ?? this.api.id
    this.dot.className = `dot ${s ? effectiveStatus(s) : 'error'}`
    this.element.title = s ? panelTooltip(s) : `Slot ${this.api.id} (desconhecido)`
  }

  /**
   * Inline rename: an input takes the text's place with the current custom name (empty when the tab shows
   * the session title or folder). Enter saves, Esc cancels, leaving the field saves; an empty name removes
   * the custom one. The input swallows pointer and key events so dockview does not drag the tab and the
   * app shortcuts stay quiet while typing.
   */
  startRename(): void {
    if (!this.api || this.element.querySelector('input.rename')) return
    const slot = this.host.getSlot(this.api.id)
    if (!slot) return
    const slotId = this.api.id
    const input = document.createElement('input')
    input.className = 'rename'
    input.type = 'text'
    input.value = slot.name ?? ''
    input.placeholder = slot.title ?? folderName(slot.cwd)
    input.title = 'Enter salva, Esc cancela; vazio volta ao título da sessão'
    input.setAttribute('aria-label', 'Nome do painel')
    let done = false
    const finish = (save: boolean): void => {
      if (done) return
      done = true
      const name = input.value.trim()
      input.replaceWith(this.text)
      if (save && name !== (slot.name ?? '')) this.host.onRename(slotId, name)
    }
    for (const type of ['pointerdown', 'mousedown', 'click', 'dblclick'] as const) input.addEventListener(type, ev => ev.stopPropagation())
    input.addEventListener('keydown', ev => {
      ev.stopPropagation()
      if (ev.key === 'Enter') { ev.preventDefault(); finish(true) }
      else if (ev.key === 'Escape') { ev.preventDefault(); finish(false) }
    })
    input.addEventListener('blur', () => finish(true))
    this.text.replaceWith(input)
    input.focus()
    input.select()
  }

  dispose(): void {
    for (const d of this.disposers) d()
    this.disposers = []
  }
}
