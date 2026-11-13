// The "Extensões" screen (F9 decision 13): a tab listing the extensions (name, id, version, where they run, state),
// with a switch per optional extension. A change is written at once and takes effect at "Reiniciar o app" (decision 3):
// the row says so and the screen offers the restart. Registered through the pane registry like the shortcuts screen;
// one screen at a time.
import type { DockviewPanelApi, GroupPanelPartInitParameters, IContentRenderer, ITabRenderer, TabPartInitParameters } from 'dockview-core'
import { createTabHeader } from './tab-header.ts'
import { STATE_LABEL, type ExtensionRow } from './extensions-list.ts'
import { EXTENSIONS_TITLE } from '../shared/extensions-screen.ts'
import { mountTabEmblem } from './tab-emblems.ts'

export interface ExtensionsHost {
  /** The rows, gathered from every host (main answers over IPC). */
  rows(): Promise<ExtensionRow[]>
  /** The switch: on or off at the next start. */
  setEnabled(id: string, on: boolean): Promise<void>
  /** "Reiniciar o app" (the agents keep running). */
  relaunch(): void
  onTabMenu(id: string, ev: MouseEvent): void
  onClose(id: string): void
}

const HOST_LABEL: Record<string, string> = { renderer: 'janela', main: 'app', daemon: 'tetherd' }
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export class ExtensionsPanel implements IContentRenderer {
  readonly element: HTMLElement
  id = ''
  private readonly host: ExtensionsHost
  private readonly list: HTMLElement
  private readonly restart: HTMLElement
  private last: ExtensionRow[] = []

  constructor(host: ExtensionsHost) {
    this.host = host
    this.element = document.createElement('div')
    this.element.className = 'ext-pane'
    this.element.dataset.extensions = 'pane'
    this.element.innerHTML = `<header><h2>${EXTENSIONS_TITLE}</h2><p class="dim">O que o tether carrega além do núcleo. Ligar ou desligar uma extensão vale depois de "Reiniciar o app"; os agentes continuam rodando.</p></header><div class="ext-restart" role="status" hidden><span>Há mudanças que valem depois de reiniciar o app.</span><button type="button" class="ext-relaunch">Reiniciar o app</button></div><div class="ext-list" tabindex="0" role="list" aria-label="${EXTENSIONS_TITLE}"></div>`
    this.list = this.element.querySelector<HTMLElement>('.ext-list')!
    this.restart = this.element.querySelector<HTMLElement>('.ext-restart')!
    this.restart.querySelector('button')!.addEventListener('click', () => host.relaunch())
    this.list.addEventListener('click', ev => {
      const sw = (ev.target as HTMLElement).closest<HTMLButtonElement>('button.ext-toggle')
      if (!sw?.dataset.ext) return
      void host.setEnabled(sw.dataset.ext, sw.getAttribute('aria-checked') !== 'true').then(() => this.refresh())
    })
  }

  init(params: GroupPanelPartInitParameters): void {
    this.id = params.api.id
    this.element.dataset.extensionsId = this.id
    void this.refresh()
  }

  async refresh(): Promise<void> {
    this.last = await this.host.rows()
    this.list.innerHTML = this.last.length === 0
      ? '<p class="ext-empty dim">Nenhuma extensão instalada ainda. Os recursos que virarem extensão aparecem aqui.</p>'
      : this.last.map(r => `<div class="ext-row" role="listitem" data-ext="${esc(r.id)}" data-state="${r.state}">
  <div class="ext-main"><span class="ext-name">${esc(r.displayName)}</span> <code class="ext-id">${esc(r.id)}</code> <span class="ext-version dim">v${esc(r.version)}</span></div>
  ${r.description ? `<div class="ext-desc dim">${esc(r.description)}</div>` : ''}
  <div class="ext-meta dim">Roda em: ${r.hosts.map(h => HOST_LABEL[h] ?? h).join(', ')}</div>
  <span class="ext-state" title="${esc(r.error ?? '')}">${STATE_LABEL[r.state]}</span>
  ${r.optional ? `<button type="button" class="ext-toggle" role="switch" data-ext="${esc(r.id)}" aria-checked="${r.wanted}" aria-label="${r.wanted ? 'Desligar' : 'Ligar'} ${esc(r.displayName)}">${r.wanted ? 'Ligada' : 'Desligada'}</button>` : ''}
  ${r.pending ? `<div class="ext-pending">${r.wanted ? 'Liga' : 'Desliga'} depois de "Reiniciar o app".</div>` : ''}
</div>`).join('')
    this.restart.hidden = !this.last.some(r => r.pending)
  }

  /** What the e2e reads. */
  snapshot(): { id: string; rows: ExtensionRow[] } { return { id: this.id, rows: this.last } }

  focus(): void { this.list.focus() }

  dispose(): void { }
}

export class ExtensionsTab implements ITabRenderer {
  readonly element: HTMLElement
  private unmountEmblem: (() => void) | undefined
  private api: DockviewPanelApi | undefined

  constructor(host: ExtensionsHost) {
    const h = createTabHeader({
      className: 'extensions', glyph: 'puzzle-piece',
      close: { label: 'Fechar', aria: 'Fechar extensões', onClose: () => { if (this.api) host.onClose(this.api.id) } },
      onMenu: ev => { if (this.api) host.onTabMenu(this.api.id, ev) },
    })
    this.element = h.element
    h.text.textContent = EXTENSIONS_TITLE
    this.element.title = EXTENSIONS_TITLE
  }

  init(params: TabPartInitParameters): void {
    this.api = params.api
    this.unmountEmblem?.()
    this.unmountEmblem = mountTabEmblem(this.element.querySelector<HTMLElement>('.kind')!, params.api, params.params)
    this.element.dataset.slot = params.api.id
  }

  dispose(): void {
    this.unmountEmblem?.()
    this.unmountEmblem = undefined
  }
}
