// The web-bridge extension's renderer side (C1): the command "Instalar Tether Bridge…" and its two screens. First the
// in-app dialog "Em qual navegador?" (the browsers main detected, as an option list); then, once main has prepared the
// folder and opened the browser, the guide: three steps, the folder path (already in the clipboard, "Copiar de novo"),
// and a live line that polls main once a second and, when a browser that was not there before appears, turns into the
// success message and closes the guide two seconds later. The guide is a <dialog class="ask"> like the core's, so the
// app's shortcuts stay quiet while it is open (dialogOpen()) and it shares the dialog's styles; its own pieces live in
// web-bridge.css.
import type { TetherUi } from '../../app/renderer/ext-api.ts'
import type { DialogOption } from '../../app/shared/dialog.ts'
import { icon } from '../../app/renderer/icons.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { toDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { DetectedBrowser } from './browsers.ts'
import type { InstallOutcome, WebBridgeChannels } from './ipc.ts'
import { BRIDGE_NAME } from './manifest.ts'

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

  ui.test.expose('webBridge', {
    guide: (): GuideSnapshot => guide?.snapshot ?? { open: false },
  })

  return [
    ui.commands.registerCommand('web-bridge.install', () => { void run() }),
    toDisposable(() => guide?.close()),
  ]
}
