// The stand-in for a pane whose extension is off (or failed to activate): layout.json still has the pane (its
// component, id and params), so it keeps its place with this inside instead of being dropped or taken for a slot.
// The params are never touched: when the extension is back on, the pane opens as it was. Built from the manifest's
// `contributes.paneTypes` (extensions/types.ts), registered by main.ts for every extension that is not active.
import type { GroupPanelPartInitParameters, IContentRenderer, ITabRenderer, TabPartInitParameters, DockviewPanelApi } from 'dockview-core'
import { icon } from './icons.ts'
import { mountTabEmblem } from './tab-emblems.ts'

export interface DisabledPaneHost {
  /** The extension's name ("Nota") and whether it is off or failed. */
  extension(): { name: string; failed: boolean }
  /** Opens the "Extensões" screen. */
  showExtensions(): void
  onTabMenu(id: string, x: number, y: number): void
  onClose(id: string): void
}

export class DisabledPane implements IContentRenderer {
  readonly element: HTMLElement
  id = ''
  private readonly button: HTMLButtonElement

  constructor(host: DisabledPaneHost) {
    const { name, failed } = host.extension()
    this.element = document.createElement('div')
    this.element.className = 'ext-off-pane'
    this.element.dataset.extensionOff = 'pane'
    const title = document.createElement('p')
    title.className = 'ext-off-title'
    title.textContent = failed ? `A extensão ${name} não conseguiu iniciar.` : `A extensão ${name} está desligada.`
    const text = document.createElement('p')
    text.className = 'ext-off-text'
    text.textContent = 'Este painel continua guardado no lugar. Ligue a extensão em Extensões e use "Reiniciar o app" para abri-lo de novo.'
    this.button = document.createElement('button')
    this.button.type = 'button'
    this.button.className = 'ext-off-open'
    this.button.append(icon('puzzle-piece'), document.createTextNode(' Abrir Extensões'))
    this.button.addEventListener('click', () => host.showExtensions())
    this.element.append(title, text, this.button)
    this.element.tabIndex = 0
  }

  init(params: GroupPanelPartInitParameters): void {
    this.id = params.api.id
    this.element.dataset.extensionOffId = this.id
  }

  focus(): void { this.button.focus() }

  dispose(): void { }
}

export class DisabledTab implements ITabRenderer {
  readonly element: HTMLElement
  private unmountEmblem: (() => void) | undefined
  private api: DockviewPanelApi | undefined
  private readonly text: HTMLElement

  constructor(host: DisabledPaneHost) {
    this.element = document.createElement('div')
    this.element.className = 'tether-tab ext-off'
    const kind = document.createElement('span'); kind.className = 'kind'; kind.append(icon('puzzle-piece'))
    this.text = document.createElement('span'); this.text.className = 'text'
    const close = document.createElement('button')
    close.className = 'close'; close.title = 'Fechar'; close.setAttribute('aria-label', 'Fechar painel')
    close.append(icon('x'))
    close.addEventListener('pointerdown', ev => ev.stopPropagation())
    close.addEventListener('click', ev => { ev.stopPropagation(); if (this.api) host.onClose(this.api.id) })
    this.element.append(kind, this.text, close)
    this.element.addEventListener('contextmenu', ev => { ev.preventDefault(); ev.stopPropagation(); if (this.api) host.onTabMenu(this.api.id, ev.clientX, ev.clientY) })
  }

  init(params: TabPartInitParameters): void {
    this.api = params.api
    this.unmountEmblem?.()
    this.unmountEmblem = mountTabEmblem(this.element.querySelector<HTMLElement>('.kind')!, params.api, params.params)
    this.element.dataset.slot = params.api.id
    this.text.textContent = params.title
    this.element.title = `${params.title} (extensão desligada)`
  }

  dispose(): void {
    this.unmountEmblem?.()
    this.unmountEmblem = undefined
  }
}
