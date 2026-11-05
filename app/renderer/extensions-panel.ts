// The "Extensões" screen (F9 decision 13): a tab listing the extensions (name, id, version, where they run, state).
// Read-only in slice 0b. Registered through the pane registry like the shortcuts screen; one screen at a time.
import type { DockviewPanelApi, GroupPanelPartInitParameters, IContentRenderer, ITabRenderer, TabPartInitParameters } from 'dockview-core'
import { icon } from './icons.ts'
import { STATE_LABEL, type ExtensionRow } from './extensions-list.ts'
import { EXTENSIONS_TITLE } from '../shared/extensions-screen.ts'

export interface ExtensionsHost {
  /** The rows, gathered from every host (main answers over IPC). */
  rows(): Promise<ExtensionRow[]>
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
  private last: ExtensionRow[] = []

  constructor(host: ExtensionsHost) {
    this.host = host
    this.element = document.createElement('div')
    this.element.className = 'ext-pane'
    this.element.dataset.extensions = 'pane'
    this.element.innerHTML = `<header><h2>${EXTENSIONS_TITLE}</h2><p class="dim">O que o tether carrega além do núcleo. Ligar e desligar vem em breve; uma mudança vale depois de "Reiniciar o app".</p></header><div class="ext-list" tabindex="0" role="list" aria-label="${EXTENSIONS_TITLE}"></div>`
    this.list = this.element.querySelector<HTMLElement>('.ext-list')!
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
</div>`).join('')
  }

  /** What the e2e reads. */
  snapshot(): { id: string; rows: ExtensionRow[] } { return { id: this.id, rows: this.last } }

  focus(): void { this.list.focus() }

  dispose(): void { }
}

export class ExtensionsTab implements ITabRenderer {
  readonly element: HTMLElement
  private api: DockviewPanelApi | undefined

  constructor(host: ExtensionsHost) {
    this.element = document.createElement('div')
    this.element.className = 'tether-tab extensions'
    const kind = document.createElement('span'); kind.className = 'kind'; kind.append(icon('puzzle-piece'))
    const text = document.createElement('span'); text.className = 'text'; text.textContent = EXTENSIONS_TITLE
    const close = document.createElement('button')
    close.className = 'close'; close.title = 'Fechar'; close.setAttribute('aria-label', 'Fechar extensões')
    close.append(icon('x'))
    close.addEventListener('pointerdown', ev => ev.stopPropagation())
    close.addEventListener('click', ev => { ev.stopPropagation(); if (this.api) host.onClose(this.api.id) })
    this.element.append(kind, text, close)
    this.element.addEventListener('contextmenu', ev => { ev.preventDefault(); ev.stopPropagation(); if (this.api) host.onTabMenu(this.api.id, ev) })
    this.element.title = EXTENSIONS_TITLE
  }

  init(params: TabPartInitParameters): void {
    this.api = params.api
    this.element.dataset.slot = params.api.id
  }

  dispose(): void { }
}
