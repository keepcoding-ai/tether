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
import { decodeOsc52 } from './clipboard.ts'
import { icon, KIND_ICON, setIcon, type IconName } from './icons.ts'
import { paneShortcutOf } from './shortcuts.ts'
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

/** Text shown in the tab (next to the agent's icon): session title, or slot name, or folder name. */
export function panelTitle(s: SlotState): string {
  return s.title ?? s.name ?? folderName(s.cwd)
}

/** The unsafe marker (tab and header): the launch carries --dangerously-skip-permissions. */
export const UNSAFE_LABEL = 'sem permissões'
export const UNSAFE_TOOLTIP = 'Sem permissões: o Claude roda com --dangerously-skip-permissions e não pede confirmação antes de agir.'

/** The marker element: shield icon + (optionally) the label; hidden unless the slot is unsafe. */
export function unsafeBadge(withLabel: boolean): HTMLElement {
  const el = document.createElement('span')
  el.className = 'unsafe'
  el.title = UNSAFE_TOOLTIP
  el.setAttribute('aria-label', UNSAFE_TOOLTIP)
  el.append(icon('shield-warning'))
  if (withLabel) el.append(document.createTextNode(UNSAFE_LABEL))
  el.hidden = true
  return el
}

export function panelTooltip(s: SlotState): string {
  const lines = [`${KIND_LABEL[s.kind]} · ${STATUS_LABEL[effectiveStatus(s)]}`, `Pasta: ${s.cwd}`, `Slot: ${s.slotId}`]
  if (s.profileName) lines.push(`Perfil: ${s.profileName}`)
  if (s.unsafe) lines.push(UNSAFE_TOOLTIP)
  if (s.restarting) lines.push('Reiniciando com o novo perfil…')
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
  /** Keys the terminal must not swallow (app shortcuts); return true when handled here. */
  onKey(ev: KeyboardEvent, panel: TerminalPanel): boolean
  /** The scheme painted right now (new terminals start with it; setScheme follows later switches). */
  getScheme(): ColorScheme
  /** "Trocar perfil…" from the header pill. */
  onSwitchProfile(slotId: string): void
  /** Right-click on a tab: the host shows the panel's context menu at the pointer. */
  onTabMenu(slotId: string, ev: MouseEvent): void
}

/** The header pill's text: the profile's name, or what its absence means. */
export const NO_PROFILE_LABEL = 'sem perfil'
export const SWITCH_PROFILE_TOOLTIP = 'Trocar perfil…'

export class TerminalPanel implements IContentRenderer {
  readonly element: HTMLElement
  readonly term: Terminal
  slotId = ''
  private readonly fit = new FitAddon()
  private readonly head: { icon: HTMLElement; title: HTMLElement; profile: HTMLButtonElement; unsafe: HTMLElement; cwd: HTMLElement; status: HTMLElement }
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
    const profile = document.createElement('button'); profile.type = 'button'; profile.className = 'profile'; profile.hidden = true
    profile.addEventListener('click', ev => { ev.stopPropagation(); if (this.slotId) this.host.onSwitchProfile(this.slotId) })
    const unsafe = unsafeBadge(true)
    const cwd = document.createElement('span'); cwd.className = 'cwd'
    const status = document.createElement('span'); status.className = 'status'
    head.append(icon, title, profile, unsafe, cwd, status)
    this.head = { icon, title, profile, unsafe, cwd, status }
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
    // xterm calls this for keydown, keypress and keyup of the same chord: a command is decided on keydown only.
    // What is handled here is also prevented, so Chromium's own copy/paste on the textarea never runs on top
    // of it (a native paste would reach xterm's `paste` listener and paste twice; a native copy would overwrite
    // the clipboard with the selection xterm has just cleared).
    this.term.attachCustomKeyEventHandler(ev => {
      if (ev.type !== 'keydown') return true
      const command = paneShortcutOf(ev, this.term.hasSelection())
      if (command) {
        ev.preventDefault()
        if (command === 'copy') this.copy()
        else void this.paste(command === 'paste-or-raw')
        return false
      }
      const handled = this.host.onKey(ev, this)
      if (handled) ev.preventDefault()
      return !handled
    })
    // OSC 52 from the program (Claude, tmux, neovim's clipboard provider): straight to the Windows clipboard.
    this.term.parser.registerOscHandler(52, data => {
      const text = decodeOsc52(data)
      if (text !== undefined) window.tether.writeClipboard(text)
      return true
    })
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
    this.head.title.textContent = s.title ?? s.name ?? KIND_LABEL[s.kind]
    // The pill is the way to "Trocar perfil…": shown on every agent panel, and on a shell only when it has a profile.
    const profileLabel = s.profileName ?? (s.profileId ? `${s.profileId} (apagado)` : NO_PROFILE_LABEL)
    this.head.profile.textContent = profileLabel
    this.head.profile.classList.toggle('none', !s.profileName)
    this.head.profile.title = `${s.profileName ? `Perfil de lançamento: ${s.profileName}` : s.profileId ? `O perfil ${s.profileId} foi apagado; o painel usa a cópia guardada dos argumentos` : 'Sem perfil de lançamento: só os argumentos do painel'}\n${SWITCH_PROFILE_TOOLTIP}`
    this.head.profile.setAttribute('aria-label', `Perfil: ${profileLabel}. ${SWITCH_PROFILE_TOOLTIP}`)
    this.head.profile.hidden = s.kind === 'shell' && !s.profileId
    this.head.unsafe.hidden = !s.unsafe
    this.head.cwd.textContent = s.cwd
    this.head.cwd.title = s.cwd
    if (s.restarting) this.setStatus('starting', 'reiniciando…')
    else this.setStatus(status, STATUS_LABEL[status])
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

  /**
   * Pastes the clipboard text through xterm (bracketed paste when the program asked for it). With no text and
   * `rawWhenEmpty`, the raw ^V goes to the process instead: Claude Code pastes an image from the clipboard
   * when it receives that key, and a screenshot in the clipboard has no text form.
   */
  async paste(rawWhenEmpty = false): Promise<void> {
    const text = await window.tether.readClipboard()
    if (text) this.term.paste(text)
    else if (rawWhenEmpty && this.slotId) window.tether.notice({ t: 'input', slotId: this.slotId, data: '\x16' })
  }

  /** Copies the selection to the clipboard and clears it; nothing without a selection. */
  copy(): void {
    if (!this.term.hasSelection()) return
    window.tether.writeClipboard(this.term.getSelection())
    this.term.clearSelection()
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
  private readonly unsafe: HTMLElement
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
    this.unsafe = unsafeBadge(false)
    const close = document.createElement('button')
    close.className = 'close'; close.title = 'Fechar painel'; close.setAttribute('aria-label', 'Fechar painel')
    close.append(icon('x'))
    close.addEventListener('pointerdown', ev => ev.stopPropagation())
    close.addEventListener('click', ev => { ev.stopPropagation(); if (this.api) this.onClose(this.api.id) })
    this.element.append(this.kind, this.text, this.unsafe, this.dot, close)
    this.element.addEventListener('contextmenu', ev => { ev.preventDefault(); ev.stopPropagation(); if (this.api) this.host.onTabMenu(this.api.id, ev) })
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
    this.unsafe.hidden = !s?.unsafe
    this.element.title = s ? panelTooltip(s) : `Slot ${this.api.id} (desconhecido)`
  }

  dispose(): void {
    for (const d of this.disposers) d()
    this.disposers = []
  }
}
