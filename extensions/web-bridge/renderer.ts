// The web-bridge extension's renderer side (C1): the command "Instalar Tether Bridge…" and its two screens. First the
// in-app dialog "Em qual navegador?" (the browsers main detected, as an option list); then, once main has prepared the
// folder and opened the browser, the guide: three steps, the folder path (already in the clipboard, "Copiar de novo"),
// and a live line that polls main once a second and, when a browser that was not there before appears, turns into the
// success message and closes the guide two seconds later. The guide is a <dialog class="ask"> like the core's, so the
// app's shortcuts stay quiet while it is open (dialogOpen()) and it shares the dialog's styles; its own pieces live in
// web-bridge.css.
// C4: the status icon of the top bar (design §5). Main polls the daemon and pushes a sanitized snapshot (`status` event);
// this side computes state/badge/tooltip from it (status.ts), and fills the popover: browsers (tabs under control, last
// activity), agents per `tether:<slot>` (click brings the pane to the front), Pausar/Retomar, Retomar todas as abas,
// Instalar em outro navegador…, Opções da extensão, and the version footer with the "recarregue" hint (C5 marker).
import type { TetherUi } from '../../app/renderer/ext-api.ts'
import type { DialogOption } from '../../app/shared/dialog.ts'
import { icon, type IconName } from '../../app/renderer/icons.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { toDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { DetectedBrowser } from './browsers.ts'
import type { ActionOutcome, InstallOutcome, StatusSnapshot, WebBridgeChannels } from './ipc.ts'
import { BRIDGE_NAME, STATUS_ID } from './manifest.ts'
import { activeAgents, ago, badgeOf, EMPTY_SNAPSHOT, stateOf, tabsLabel, titleOf, versionLine } from './status.ts'

export { manifest } from './manifest.ts'

export const GUIDE_SITUATION = 'web-bridge-guide'
export const PICK_SITUATION = 'web-bridge-install'
export const NO_BROWSER_SITUATION = 'web-bridge-no-browser'
export const FAILED_SITUATION = 'web-bridge-failed'

const POLL_MS = 1000
const CLOSE_AFTER_MS = 2000

type GuideState = 'waiting' | 'daemon-down' | 'connected'

/** What the e2e reads. */
export interface GuideSnapshot { open: boolean; state?: GuideState; path?: string; browser?: string; connected?: string[] }

/** How a step's instruction reads for a given browser (the page is the browser's own; the labels are Chrome's, the same in Edge and Brave). */
export function guideSteps(browser: DetectedBrowser): { text: string; strong: string; after?: string; kbd?: string }[] {
  return [
    { text: 'Ligue o ', strong: 'Modo do desenvolvedor', after: ' (canto superior direito da página que abriu). Se já estiver ligado, pule.' },
    { text: 'Clique em ', strong: 'Carregar sem compactação', after: '.' },
    { text: 'Na janela de pasta, cole o caminho (', strong: '', kbd: 'Ctrl+V', after: `) e dê Enter. ${browser.name} carrega a extensão "${BRIDGE_NAME}".` },
  ]
}

export function activate(ui: TetherUi): IDisposable[] {
  const ipc = ui.ipc<WebBridgeChannels>()
  let guide: { el: HTMLDialogElement; snapshot: GuideSnapshot; close(): void } | undefined

  const askNoBrowser = (): Promise<unknown> => ui.dialogs.ask({
    situation: NO_BROWSER_SITUATION, tone: 'warn', icon: 'globe-simple', title: 'Nenhum navegador compatível encontrado',
    message: `O ${BRIDGE_NAME} funciona no Google Chrome, no Microsoft Edge e no Brave. Instale um deles e rode "Instalar ${BRIDGE_NAME}…" de novo.`,
    choices: [{ id: 'ok', icon: 'check', label: 'Entendi', consequence: 'Nada é instalado agora.', tone: 'neutral' }],
  })

  const askFailed = (message: string): Promise<unknown> => ui.dialogs.ask({
    situation: FAILED_SITUATION, tone: 'danger', icon: 'globe-simple', title: `Não deu para preparar o ${BRIDGE_NAME}`,
    message,
    choices: [{ id: 'ok', icon: 'check', label: 'Fechar', consequence: 'Nada foi alterado no navegador.', tone: 'neutral' }],
  })

  const pickBrowser = async (browsers: DetectedBrowser[]): Promise<DetectedBrowser | undefined> => {
    const items: DialogOption[] = browsers.map(b => ({ id: b.id, icon: 'globe-simple', label: b.name, detail: b.exe }))
    const a = await ui.dialogs.ask({
      situation: PICK_SITUATION, tone: 'info', icon: 'globe-simple', title: 'Em qual navegador?',
      message: `O ${BRIDGE_NAME} é carregado como extensão sem compactação. O tether prepara a pasta, copia o caminho dela e abre o navegador na página de extensões; você faz três cliques.`,
      options: { label: 'Navegadores encontrados', items, selected: browsers[0]!.id },
      choices: [{ id: 'install', icon: 'arrow-square-out', label: 'Preparar e abrir o navegador', consequence: 'Copia a extensão, põe o caminho da pasta na área de transferência e abre {option} na página de extensões.', tone: 'safe' }],
      cancelLabel: 'Agora não',
    })
    if (a.choice !== 'install') return undefined
    return browsers.find(b => b.id === a.option) ?? browsers[0]
  }

  const showGuide = (r: Extract<InstallOutcome, { ok: true }>): void => {
    guide?.close()
    const snapshot: GuideSnapshot = { open: true, state: r.daemon === 'failed' ? 'daemon-down' : 'waiting', path: r.dir, browser: r.browser.name, connected: [] }
    const dlg = document.createElement('dialog')
    dlg.className = 'ask info web-bridge-guide'
    dlg.dataset.dialog = GUIDE_SITUATION
    dlg.setAttribute('aria-labelledby', 'wb-guide-title')

    const head = document.createElement('header')
    const badge = document.createElement('span'); badge.className = 'badge'; badge.append(icon('globe-simple'))
    const title = document.createElement('h2'); title.id = 'wb-guide-title'; title.textContent = `Carregue o ${BRIDGE_NAME} no ${r.browser.name}`
    head.append(badge, title)

    const desc = document.createElement('div'); desc.className = 'desc'
    const msg = document.createElement('p'); msg.className = 'message'
    msg.textContent = r.openError
      ? `O caminho da pasta já está na área de transferência. Abra ${r.browser.extensionsUrl} no ${r.browser.name} (ele não abriu sozinho) e siga os passos.`
      : `${r.browser.name} abriu em ${r.browser.extensionsUrl}; o caminho da pasta já está na área de transferência.`
    desc.append(msg)

    const steps = document.createElement('ol'); steps.className = 'wb-steps'
    for (const s of guideSteps(r.browser)) {
      const li = document.createElement('li')
      li.append(document.createTextNode(s.text))
      if (s.strong) { const b = document.createElement('strong'); b.textContent = s.strong; li.append(b) }
      if (s.kbd) { const k = document.createElement('kbd'); k.textContent = s.kbd; li.append(k) }
      if (s.after) li.append(document.createTextNode(s.after))
      steps.append(li)
    }
    desc.append(steps)

    const pathRow = document.createElement('div'); pathRow.className = 'wb-path'
    const pathText = document.createElement('code'); pathText.className = 'wb-path-text'; pathText.textContent = r.dir; pathText.title = r.dir
    const copyBtn = document.createElement('button'); copyBtn.type = 'button'; copyBtn.className = 'wb-copy'; copyBtn.dataset.action = 'copy'
    copyBtn.append(icon('copy'), document.createTextNode('Copiar de novo'))
    copyBtn.addEventListener('click', () => { ui.shell.writeClipboard(r.dir); copyBtn.classList.add('done'); setTimeout(() => copyBtn.classList.remove('done'), 1200) })
    pathRow.append(pathText, copyBtn)
    desc.append(pathRow)

    const wait = document.createElement('div'); wait.className = 'wb-wait'; wait.setAttribute('role', 'status')
    const dot = document.createElement('span'); dot.className = 'wb-dot'
    const waitText = document.createElement('span'); waitText.className = 'wb-wait-text'
    wait.append(dot, waitText)
    desc.append(wait)

    const note = document.createElement('p'); note.className = 'wb-note'
    note.textContent = `Enquanto a extensão vier por esta pasta, o ${r.browser.name} pode avisar ao abrir que há extensões no modo do desenvolvedor: é o preço de não vir da loja, e some quando o ${BRIDGE_NAME} for publicado nela.`
    desc.append(note)

    const foot = document.createElement('footer')
    const spacer = document.createElement('span'); spacer.className = 'spacer'
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'cancel'; cancel.dataset.choice = 'cancel'
    const kbd = document.createElement('kbd'); kbd.textContent = 'Esc'; kbd.setAttribute('aria-hidden', 'true')
    cancel.append(document.createTextNode('Fechar '), kbd)
    foot.append(spacer, cancel)

    dlg.append(head, desc, foot)

    let timer: ReturnType<typeof setTimeout> | undefined
    let closeTimer: ReturnType<typeof setTimeout> | undefined
    let polling = false
    const paint = (): void => {
      dlg.dataset.state = snapshot.state
      waitText.textContent = snapshot.state === 'connected'
        ? `${r.browser.name} conectado. Seus agentes já podem usar o ${r.browser.name}.`
        : snapshot.state === 'daemon-down'
          ? `O serviço do ${BRIDGE_NAME} ainda não respondeu; continuo tentando…`
          : `Aguardando o ${r.browser.name} se conectar…`
    }
    const close = (): void => {
      if (timer) clearTimeout(timer)
      if (closeTimer) clearTimeout(closeTimer)
      snapshot.open = false
      if (dlg.open) dlg.close()
      dlg.remove()
      if (guide?.el === dlg) guide = undefined
    }
    const poll = async (): Promise<void> => {
      if (polling || !snapshot.open) return
      polling = true
      try {
        const c = await ipc.invoke('connected')
        if (!snapshot.open || snapshot.state === 'connected') return
        if (c.ok) {
          snapshot.connected = c.browsers.map(b => b.id)
          const fresh = c.browsers.filter(b => !r.before.includes(b.id))
          if (fresh.length) { snapshot.state = 'connected'; paint(); closeTimer = setTimeout(close, CLOSE_AFTER_MS); return }
          snapshot.state = 'waiting'
        } else {
          snapshot.state = c.reason === 'daemon-down' || c.reason === 'no-key' ? 'daemon-down' : 'waiting'
        }
        paint()
      } finally {
        polling = false
        if (snapshot.open && snapshot.state !== 'connected') timer = setTimeout(() => { void poll() }, POLL_MS)
      }
    }

    cancel.addEventListener('click', close)
    dlg.addEventListener('cancel', ev => { ev.preventDefault(); close() })
    document.body.append(dlg)
    dlg.showModal()
    copyBtn.focus()
    paint()
    guide = { el: dlg, snapshot, close }
    void poll()
  }

  const run = async (): Promise<void> => {
    const browsers = await ipc.invoke('browsers')
    if (!browsers.length) { await askNoBrowser(); return }
    const browser = await pickBrowser(browsers)
    if (!browser) return
    const r = await ipc.invoke('install', browser.id)
    if (!r.ok) { await askFailed(r.message); return }
    ui.shell.writeClipboard(r.dir)
    showGuide(r)
  }

  // ---- C4: the status icon -----------------------------------------------------------------------------------------
  let snapshot: StatusSnapshot = EMPTY_SNAPSHOT
  let popoverOpen = false
  let notice: { text: string; tone: 'warn' | 'ok' } | undefined
  let noticeTimer: ReturnType<typeof setTimeout> | undefined
  let busyTimer: ReturnType<typeof setTimeout> | undefined
  let acting = false

  const el = (tag: string, className?: string, text?: string): HTMLElement => {
    const e = document.createElement(tag)
    if (className) e.className = className
    if (text !== undefined) e.textContent = text
    return e
  }
  const button = (action: string, iconName: IconName, label: string, run: () => void, opts: { danger?: boolean; disabled?: boolean } = {}): HTMLButtonElement => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = `wb-action${opts.danger ? ' danger' : ''}`
    b.dataset.action = action
    b.disabled = !!opts.disabled || acting
    b.append(icon(iconName), document.createTextNode(label))
    b.addEventListener('click', ev => { ev.stopPropagation(); run() })
    return b
  }

  const say = (text: string, tone: 'warn' | 'ok'): void => {
    notice = { text, tone }
    if (noticeTimer) clearTimeout(noticeTimer)
    noticeTimer = setTimeout(() => { notice = undefined; handle.update() }, 6000)
    handle.update()
  }

  const act = async (what: () => Promise<ActionOutcome>, done: string): Promise<void> => {
    if (acting) return
    acting = true
    handle.update()
    try {
      const r = await what()
      if (r.ok) say(done, 'ok'); else say(r.message, 'warn')
    } finally { acting = false; handle.update() }
  }

  /** The busy state ends 10 s after the last call even without a new snapshot: a redraw is scheduled for that moment. */
  const scheduleBusyEnd = (): void => {
    if (busyTimer) clearTimeout(busyTimer)
    const active = activeAgents(snapshot, Date.now())
    if (!active.length) return
    const latest = Math.max(...active.map(a => a.lastSeenAt ?? 0))
    busyTimer = setTimeout(() => { busyTimer = undefined; handle.update() }, Math.max(50, latest + 10_000 - Date.now() + 20))
  }

  const render = (pop: HTMLElement): void => {
    const now = Date.now()
    pop.classList.add('wb-pop')
    const state = stateOf(snapshot, now)
    pop.dataset.state = state

    const head = el('div', 'wb-pop-head')
    head.append(icon('brand'), el('span', 'wb-pop-title', BRIDGE_NAME), el('span', 'wb-pop-state', titleOf(snapshot, now, BRIDGE_NAME)))
    pop.append(head)

    if (snapshot.daemon === 'up') {
      // Browsers.
      const bSec = el('section', 'wb-sec'); bSec.dataset.section = 'browsers'
      bSec.append(el('h3', undefined, 'Navegadores'))
      if (!snapshot.browsers.length) bSec.append(el('p', 'wb-empty', 'Nenhum navegador conectado.'))
      else {
        const ul = el('ul', 'wb-list')
        for (const b of snapshot.browsers) {
          const li = el('li', 'wb-row'); li.dataset.browser = b.id
          li.append(icon('globe-simple'), el('span', 'wb-name', b.name), el('span', 'wb-meta', `${tabsLabel(b.tabs)} sob controle${b.lastActivityAt ? ` · ${ago(b.lastActivityAt, now)}` : ''}`))
          ul.append(li)
        }
        bSec.append(ul)
      }
      pop.append(bSec)

      // Agents.
      const aSec = el('section', 'wb-sec'); aSec.dataset.section = 'agents'
      aSec.append(el('h3', undefined, 'Agentes'))
      if (!snapshot.agents.length) aSec.append(el('p', 'wb-empty', 'Nenhum agente usou o navegador ainda.'))
      else {
        const ul = el('ul', 'wb-list')
        const active = new Set(activeAgents(snapshot, now).map(a => a.clientId))
        for (const a of snapshot.agents) {
          const pane = a.slotId ? ui.panes.describe(a.slotId) : undefined
          const li = el('li', `wb-row wb-agent${active.has(a.clientId) ? ' active' : ''}${pane ? ' clickable' : ''}`)
          li.dataset.client = a.clientId
          if (a.slotId) li.dataset.slot = a.slotId
          const agentIcon: IconName = pane?.agent ? 'sparkle' : 'terminal-window'
          li.append(icon(agentIcon), el('span', 'wb-name', a.name))
          const bits = [tabsLabel(a.tabs), a.lastTool ? `${a.lastTool} ${ago(a.lastSeenAt, now)}`.trim() : ago(a.lastSeenAt, now)].filter(Boolean)
          li.append(el('span', 'wb-meta', bits.join(' · ')))
          if (pane) {
            li.tabIndex = 0
            li.setAttribute('role', 'button')
            li.title = `Ir para o painel${pane.place ? ` (${pane.place})` : ''}`
            const go = (): void => { ui.panes.reveal(a.slotId!) }
            li.addEventListener('click', ev => { ev.stopPropagation(); go() })
            li.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go() } })
          }
          ul.append(li)
        }
        aSec.append(ul)
      }
      pop.append(aSec)
    } else {
      pop.append(el('p', 'wb-empty wb-down', snapshot.daemon === 'no-key'
        ? 'A instalação do bridge ainda não tem chave: o tetherd a cria ao subir.'
        : snapshot.daemon === 'refused' ? 'O daemon recusou a chave do tether; veja tether doctor.'
          : snapshot.everUp ? 'O daemon do bridge parou de responder. A próxima chamada de um agente o reinicia; "Instalar…" também.' : 'O serviço do bridge ainda não respondeu.'))
    }

    // Actions.
    const actions = el('div', 'wb-actions')
    const up = snapshot.daemon === 'up'
    if (snapshot.paused) actions.append(button('resume', 'play', 'Retomar', () => { void act(() => ipc.invoke('pause', false), `${BRIDGE_NAME} retomado.`) }, { disabled: !up }))
    else actions.append(button('pause', 'stop-circle', 'Pausar', () => { void act(() => ipc.invoke('pause', true), `${BRIDGE_NAME} pausado: os agentes esperam.`) }, { disabled: !up || !snapshot.pauseSupported }))
    actions.append(button('release-all', 'arrow-counter-clockwise', 'Retomar todas as abas', () => { void act(() => ipc.invoke('releaseAll'), 'Abas soltas: os agentes abrem outras quando precisarem.') }, { disabled: !up || !snapshot.agents.length }))
    actions.append(button('install', 'arrow-square-out', 'Instalar em outro navegador…', () => { void ui.commands.run('web-bridge.install') }))
    if (snapshot.options) actions.append(button('options', 'puzzle-piece', `Opções da extensão (${snapshot.options.browserName})`, () => { void act(() => ipc.invoke('openOptions'), `Página da extensão aberta no ${snapshot.options?.browserName ?? 'navegador'}.`) }))
    pop.append(actions)
    if (!snapshot.pauseSupported && !snapshot.paused) pop.append(el('p', 'wb-hint', 'Pausar está indisponível nesta versão do bridge.'))

    if (notice) { const n = el('p', `wb-notice ${notice.tone}`, notice.text); n.setAttribute('role', 'status'); pop.append(n) }

    // Footer: versions.
    const v = versionLine(snapshot.version)
    const foot = el('footer', 'wb-foot')
    foot.append(el('span', 'wb-version', v.text))
    if (v.reload) foot.append(el('span', 'wb-reload', 'Recarregue a extensão no navegador (chrome://extensions) para usar a versão nova.'))
    pop.append(foot)
  }

  const handle = ui.status.register({
    id: STATUS_ID,
    title: () => titleOf(snapshot, Date.now(), BRIDGE_NAME),
    state: () => stateOf(snapshot, Date.now()),
    badge: () => badgeOf(snapshot, Date.now()),
    render: pop => {
      render(pop)
      // The core calls render on open and on every update while open: the first call after a close is the "opened" signal.
      if (!popoverOpen) { popoverOpen = true; ipc.send('watch', true); watchClose(pop) }
    },
  })

  /** The popover closes without a callback: when its wrap loses `pinned`, the fast poll stops. */
  const watchClose = (pop: HTMLElement): void => {
    const wrap = pop.parentElement
    if (!wrap) { popoverOpen = false; ipc.send('watch', false); return }
    const obs = new MutationObserver(() => {
      if (wrap.classList.contains('pinned')) return
      obs.disconnect()
      popoverOpen = false
      ipc.send('watch', false)
    })
    obs.observe(wrap, { attributes: true, attributeFilter: ['class'] })
  }

  const apply = (s: StatusSnapshot): void => { snapshot = s; handle.update(); scheduleBusyEnd() }
  const onStatus = ipc.on('status', apply)
  void ipc.invoke('status').then(apply).catch(() => undefined)

  ui.test.expose('webBridge', {
    guide: (): GuideSnapshot => guide?.snapshot ?? { open: false },
    status: (): { snapshot: StatusSnapshot; state: string; badge: number | 'dot' | undefined; title: string; watching: boolean } => ({ snapshot, state: stateOf(snapshot, Date.now()), badge: badgeOf(snapshot, Date.now()), title: titleOf(snapshot, Date.now(), BRIDGE_NAME), watching: popoverOpen }),
  })

  return [
    ui.commands.registerCommand('web-bridge.install', () => { void run() }),
    toDisposable(() => guide?.close()),
    handle,
    onStatus,
    toDisposable(() => { if (busyTimer) clearTimeout(busyTimer); if (noticeTimer) clearTimeout(noticeTimer) }),
  ]
}
