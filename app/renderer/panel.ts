// One dockview panel = one slot: a header strip (agent, title, folder, status) over an xterm, plus an
// overlay for the states that need the user (unconfirmed binding, error, exited, queued).
// Attaches on first layout, streams `data`, sends `input`/`resize`, detaches on dispose.
import type { DockviewPanelApi, GroupPanelPartInitParameters, IContentRenderer, ITabRenderer, TabPartInitParameters } from 'dockview-core'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import type { ErrorCode, SlotKind, SlotState, SlotStatus } from '../../src/daemon/protocol.ts'
import type { DialogChoice } from '../shared/dialog.ts'
import { terminalFontOptions, terminalTheme, type TerminalAppearance } from '../shared/terminal-theme.ts'
import type { ColorScheme } from '../shared/theme.ts'
import { renderChoices, roveWithArrows } from './dialog.ts'
import { decodeOsc52 } from './clipboard.ts'
import { icon, KIND_ICON, setIcon, type IconName } from './icons.ts'
import { paneShortcutOf } from './shortcuts.ts'
import { folderName } from './situations.ts'
import { loadingStage, type PaneHint } from './loading.ts'
import { applyAppearance, loadTerminalFonts, terminalFontsLoaded } from './terminal-theme.ts'

// The palette and the font come from the terminal appearance (app/shared/terminal-theme.ts: preset per
// scheme over the window background, bundled font, weight, size, line height, contrast 4.5). The host owns
// the current value; every panel is repainted through setAppearance when it or the scheme changes.

/** Which xterm renderer a panel ended up with: WebGL draws box/block glyphs itself (no gaps at line height 1.2); DOM is the fallback. */
export type TerminalRenderer = 'webgl' | 'dom'

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
export const UNSAFE_LABEL = 'sem restrições'
export const UNSAFE_TOOLTIP = 'Sem restrições: o Claude age sem pedir confirmação (--dangerously-skip-permissions).'

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
  /** The scheme painted right now (new terminals start with it; setAppearance follows later switches). */
  getScheme(): ColorScheme
  /** The terminal appearance in force (preset, font, weight, size, line height). */
  getAppearance(): TerminalAppearance
  /** "Trocar perfil…" from the header pill. */
  onSwitchProfile(slotId: string): void
  /** Right-click on a tab: the host shows the panel's context menu at the pointer. */
  onTabMenu(slotId: string, ev: MouseEvent): void
  /** What the layout file remembers of the pane (kind, folder, profile), painted before the daemon answers. */
  getHint(slotId: string): PaneHint | undefined
  /** The daemon answered and its slot list is loaded. */
  isDaemonReady(): boolean
  /** Resolves once the daemon is ready (the pane attaches then). */
  daemonReady(): Promise<void>
  /** Resolves once the terminal font is loaded: only the xterm waits for it, the chrome paints right away. */
  fontsReady(): Promise<void>
  /** 1-based place in the start queue, when known. */
  queuePosition(slotId: string): number | undefined
}

/** How long a running pane with an empty scrollback waits for its first output before showing the terminal anyway. */
const FIRST_OUTPUT_GRACE_MS = 1500
/** The loading skeleton's fade-out (matches the CSS transition). */
const LOADING_FADE_MS = 160

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
  private readonly loading: { root: HTMLElement; icon: HTMLElement; text: HTMLElement }
  /** The xterm is open in the DOM (after the font loaded). */
  private opened = false
  private disposed = false
  /** Attached and showed its first output (or the grace period passed): the loading skeleton goes. */
  private ready = false
  private graceTimer: ReturnType<typeof setTimeout> | undefined
  private fadeTimer: ReturnType<typeof setTimeout> | undefined
  private loadingKey = ''
  private observer: ResizeObserver | undefined
  private attached = false
  private attaching: Promise<void> | undefined
  private lastSize = { cols: 0, rows: 0 }
  private fitTimer: ReturnType<typeof setTimeout> | undefined
  private readonly host: PanelHost
  renderer: TerminalRenderer = 'dom'

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
    const loading = document.createElement('div'); loading.className = 'panel-loading'
    loading.setAttribute('role', 'status')
    const loadingIcon = document.createElement('span'); loadingIcon.className = 'badge'
    const loadingText = document.createElement('span'); loadingText.className = 'text'
    const stageLine = document.createElement('div'); stageLine.className = 'stage'; stageLine.append(loadingIcon, loadingText)
    const lines = document.createElement('div'); lines.className = 'lines'
    for (let i = 0; i < 4; i++) lines.append(document.createElement('span'))
    loading.append(stageLine, lines)
    this.loading = { root: loading, icon: loadingIcon, text: loadingText }
    const body = document.createElement('div')
    body.className = 'panel-body'
    body.append(this.termHost, loading, this.overlay)
    this.element.append(head, body)

    this.term = new Terminal({
      ...terminalFontOptions(host.getAppearance()),
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      theme: terminalTheme(host.getAppearance(), host.getScheme()),
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
    this.layoutTitle = params.title
    // The chrome (header, loading skeleton) paints now, from the layout's hint if the daemon has not answered.
    this.render()
    // Keyboard focus follows the active panel. dockview may activate the panel before this init runs,
    // so the current state is applied too (deferred: the element is not laid out yet).
    params.api.onDidActiveChange(({ isActive }) => { if (isActive) requestAnimationFrame(() => this.term.focus()) })
    void this.boot(() => params.api.isActive)
  }

  /** The tab title the layout file carried (the header's title before the daemon answers). */
  private layoutTitle: string | undefined

  /**
   * The xterm opens once the font is loaded (so it measures the real glyphs), then attaches once the daemon
   * is ready — even when the panel is a hidden tab (zero size): the scrollback must land and `data` must flow
   * whether or not the panel is visible. Fits only send `resize` afterwards.
   */
  private async boot(isActive: () => boolean): Promise<void> {
    await this.host.fontsReady()
    if (this.disposed) return
    this.term.open(this.termHost)
    this.opened = true
    this.loadRenderer()
    this.ensureFont()
    this.observer = new ResizeObserver(() => this.scheduleFit())
    this.observer.observe(this.termHost)
    this.scheduleFit()
    if (isActive()) requestAnimationFrame(() => this.term.focus())
    await this.host.daemonReady()
    if (this.disposed) return
    void this.attach()
  }

  /** Current slot state applied to the header and the overlay (on init and on every `state` event). */
  render(): void {
    const s = this.host.getSlot(this.slotId)
    if (!s) {
      if (!this.host.isDaemonReady()) this.renderHint()
      else {
        setIcon(this.head.icon, 'question')
        this.head.title.textContent = this.slotId
        this.setStatus('error', 'desconhecido')
        this.showOverlay(UNKNOWN)
      }
      this.renderLoading()
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
    else if (status === 'exited') this.showOverlay(exitedOverlay(s))
    else this.overlay.hidden = true
    this.renderLoading()
  }

  /** The header from the layout's hint, before the daemon answers: kind, title, folder, profile pill. */
  private renderHint(): void {
    const hint = this.host.getHint(this.slotId)
    setIcon(this.head.icon, hint ? KIND_ICON[hint.kind] : 'question')
    this.head.title.textContent = this.layoutTitle ?? (hint ? KIND_LABEL[hint.kind] : this.slotId)
    this.head.profile.textContent = hint?.profileName ?? NO_PROFILE_LABEL
    this.head.profile.classList.toggle('none', !hint?.profileName)
    this.head.profile.hidden = !hint || (hint.kind === 'shell' && !hint.profileName)
    this.head.unsafe.hidden = !hint?.unsafe
    this.head.cwd.textContent = hint?.cwd ?? ''
    this.head.cwd.title = hint?.cwd ?? ''
    this.setStatus('starting', 'conectando…')
    this.element.dataset.status = 'starting'
    this.overlay.hidden = true
  }

  /** The loading skeleton for the current stage; a quick fade when the terminal (or an overlay) takes over. */
  private renderLoading(): void {
    const stage = loadingStage({
      daemonReady: this.host.isDaemonReady(),
      slot: this.host.getSlot(this.slotId),
      startPending: this.host.isStartPending(this.slotId),
      startError: this.host.getStartError(this.slotId) !== undefined,
      queuePosition: this.host.queuePosition(this.slotId),
      ready: this.ready,
    })
    const root = this.loading.root
    if (stage) {
      if (this.fadeTimer) { clearTimeout(this.fadeTimer); this.fadeTimer = undefined }
      root.classList.remove('leaving')
      root.hidden = false
      root.dataset.stage = stage.id
      const key = `${stage.icon}|${stage.text}`
      if (key !== this.loadingKey) {
        this.loadingKey = key
        setIcon(this.loading.icon, stage.icon)
        this.loading.text.textContent = stage.text
      }
      return
    }
    if (root.hidden || root.classList.contains('leaving')) return
    this.loadingKey = ''
    root.classList.add('leaving')
    this.fadeTimer = setTimeout(() => { this.fadeTimer = undefined; root.hidden = true; root.classList.remove('leaving') }, LOADING_FADE_MS)
  }

  /** The terminal has something to show: the loading skeleton fades out. */
  private markReady(): void {
    if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = undefined }
    if (this.ready) return
    this.ready = true
    this.renderLoading()
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
    if (!this.attached) return
    this.term.write(data)
    if (!this.ready && data.length > 0) this.markReady()
  }

  focus(): void { this.term.focus() }

  /**
   * WebGL after `open()`: xterm then draws box drawing and block glyphs itself (`customGlyphs`), so they
   * join at any line height; the texture atlas also keeps a tall scrollback cheap. When the GPU is not
   * there (software rendering, a lost context later) the DOM renderer carries on with the font's glyphs.
   */
  private loadRenderer(): void {
    try {
      // preserveDrawingBuffer: the canvas keeps its last frame, so a window capture (E2E screenshots) sees it.
      const webgl = new WebglAddon(true)
      webgl.onContextLoss(() => { webgl.dispose(); this.renderer = 'dom' })
      this.term.loadAddon(webgl)
      this.renderer = 'webgl'
    } catch {
      this.renderer = 'dom'
    }
  }

  /**
   * The renderer loads the appearance's font before any panel exists, so xterm measures the real glyphs.
   * Should a panel still open with the font not ready (a face evicted, a slow disk), it is loaded now and
   * the options are reapplied so the cells are measured again.
   */
  private ensureFont(): void {
    const appearance = this.host.getAppearance()
    if (terminalFontsLoaded(appearance)) return
    void loadTerminalFonts(appearance).then(() => {
      if (this.term.element === undefined) return
      this.setAppearance(this.host.getAppearance(), this.host.getScheme(), { remeasure: true })
    })
  }

  /** Repaints the terminal with the appearance's palette for the scheme and its font; refits (scrollback kept). */
  setAppearance(appearance: TerminalAppearance, scheme: ColorScheme, opts: { remeasure?: boolean } = {}): void {
    // xterm only measures again when a font option changes: a font that loaded after `open()` needs the nudge.
    if (opts.remeasure) this.term.options.fontFamily = 'monospace'
    applyAppearance(this.term, appearance, scheme)
    this.term.refresh(0, this.term.rows - 1)
    this.scheduleFit()
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
    if (!this.opened) return // boot() attaches once the font is in
    this.attached = false
    this.ready = false
    this.term.reset()
    this.render()
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
        this.markReady()
        return
      }
      this.attached = true
      if (reply.scrollback) { this.term.write(reply.scrollback); this.markReady() }
      else {
        // An empty scrollback: wait for the first output; a running process that stays silent shows its terminal anyway.
        this.graceTimer = setTimeout(() => {
          this.graceTimer = undefined
          if (this.host.getSlot(this.slotId)?.status === 'running') this.markReady()
        }, FIRST_OUTPUT_GRACE_MS)
      }
      this.scheduleFit()
    })
    return this.attaching
  }

  dispose(): void {
    this.disposed = true
    this.observer?.disconnect()
    if (this.fitTimer) clearTimeout(this.fitTimer)
    if (this.graceTimer) clearTimeout(this.graceTimer)
    if (this.fadeTimer) clearTimeout(this.fadeTimer)
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
    if (!s && !this.host.isDaemonReady()) {
      // Before the daemon answers: the layout's hint and a "starting" dot.
      const hint = this.host.getHint(this.api.id)
      setIcon(this.kind, hint ? KIND_ICON[hint.kind] : 'question')
      this.text.textContent = this.api.title ?? this.api.id
      this.dot.className = 'dot starting'
      this.unsafe.hidden = !hint?.unsafe
      this.element.title = `${this.api.title ?? this.api.id}\nConectando ao serviço…`
      return
    }
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
