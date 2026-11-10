// One dockview panel = one empty pane (app/shared/empty.ts): a place reserved in the layout, with the chooser
// (app/renderer/chooser.ts) inside it instead of a black screen. The pane IS the place, so the chooser has no
// "Onde" row; its ⤢ opens the same chooser in focus mode with the same state. When the person picks, the host
// replaces this pane, in the same group and at the same index, by what they chose. Cancelling depends on where
// the pane came from (`origin`): a "+" pane closes, a laid-out pane only gives the keyboard back. Nothing here
// talks to tetherd.
//
// A pane can start blank (`empty.blank` in its params): it then shows the blank view (blank-view.ts: a calm line and
// "Abrir algo aqui") instead of the chooser, and that action swaps the view for the chooser in the same pane. The
// pane is the same one before and after (same id, tab, place), only its content changes.
import type { DockviewPanelApi, GroupPanelPartInitParameters, IContentRenderer, ITabRenderer, TabPartInitParameters } from 'dockview-core'
import type { Choice } from './chooser-rules.ts'
import { Chooser, type ChooserHost, type ChooserSnapshot, type ChooserState } from './chooser.ts'
import { createBlankView } from './blank-view.ts'
import { icon } from './icons.ts'
import type { ChooserDestination } from './ext-api.ts'
import { EMPTY_TITLE, emptyOrigin, emptyParams, type EmptyOrigin } from '../shared/empty.ts'

export interface EmptyHost extends ChooserHost {
  /** The person picked: the host opens it in this pane's place. Resolves with an error message to show, or nothing. */
  fill(panel: EmptyPanel, choice: Choice, cwd: string, destination?: ChooserDestination): Promise<string | undefined>
  /** Esc / Cancelar with nothing left to undo: close the pane (`add`) or give the keyboard back (`layout`). */
  cancel(panel: EmptyPanel, origin: EmptyOrigin): void
  /** The ⤢: the same chooser as a popup, with this state; the popup hands the pick (or the state) back to the pane. */
  expand(panel: EmptyPanel, state: ChooserState): void
  /** The folder to suggest when the chooser takes the place of the blank view (a panel pad: its target panel's folder), asked at that moment. */
  suggestFolder?(panel: EmptyPanel): string | undefined
  /** The pane left the blank state (its action was used): persist it with the layout. */
  onUnblank(panel: EmptyPanel): void
  /** The pane's suggested folder changed (the person typed one): persist it with the layout. */
  onCwdChange(panel: EmptyPanel): void
  /** Right-click on the tab / the strip's "⋯". */
  onTabMenu(id: string, ev: MouseEvent): void
  /** The tab's ×. */
  onClose(id: string): void
}

/** What a test reads of an empty pane. */
export interface EmptySnapshot extends ChooserSnapshot { id: string; cwd: string; origin: EmptyOrigin; blank: boolean }

export class EmptyPanel implements IContentRenderer {
  readonly element: HTMLElement
  id = ''
  origin: EmptyOrigin = 'layout'
  /** Showing the blank view, not the chooser. */
  blank = false
  private blankView: HTMLElement | undefined
  private folder = ''
  private api: DockviewPanelApi | undefined
  private readonly host: EmptyHost
  private chooser: Chooser | undefined
  private disposed = false
  private readonly disposers: Array<{ dispose(): void }> = []

  constructor(host: EmptyHost) {
    this.host = host
    this.element = document.createElement('div')
    this.element.className = 'empty-panel'
    this.element.dataset.empty = 'pane'
  }

  init(params: GroupPanelPartInitParameters): void {
    this.api = params.api
    this.id = params.api.id
    this.element.dataset.emptyId = this.id
    this.origin = emptyOrigin(params.params)
    this.element.dataset.origin = this.origin
    this.folder = emptyParams(params.params)?.cwd ?? ''
    this.blank = emptyParams(params.params)?.blank === true
    this.element.dataset.blank = String(this.blank)
    if (this.blank) this.mountBlank()
    else this.mount({ folder: this.folder })
    this.disposers.push(params.api.onDidActiveChange(({ isActive }) => { if (isActive) requestAnimationFrame(() => this.focus()) }))
  }

  private mountBlank(): void {
    this.blankView = createBlankView({ onAction: () => this.unblank() })
    // Esc means here what it means in the chooser: withdraw a request in progress (`add`), or give the keyboard back (`layout`).
    this.blankView.addEventListener('keydown', ev => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); this.host.cancel(this, this.origin) } })
    this.element.append(this.blankView)
  }

  /** The blank view's action: it leaves and the chooser enters in its place, with the keyboard. */
  private unblank(): void {
    if (!this.blank || this.disposed) return
    this.blank = false
    this.element.dataset.blank = 'false'
    this.blankView?.remove()
    this.blankView = undefined
    this.folder = this.host.suggestFolder?.(this) ?? this.folder
    this.mount({ folder: this.folder })
    this.host.onUnblank(this)
    requestAnimationFrame(() => this.focus())
  }

  private mount(state: Partial<ChooserState>): void {
    this.chooser?.dispose()
    this.chooser = new Chooser(this.host, {
      mode: 'pane',
      origin: this.origin,
      state,
      onOpen: (choice, cwd, _where, destination) => this.host.fill(this, choice, cwd, destination),
      onCancel: () => this.host.cancel(this, this.origin),
      onExpand: s => this.host.expand(this, s),
    })
    this.element.append(this.chooser.element)
    // The folder typed here is the pane's state: it goes to the layout file.
    this.chooser.element.querySelector<HTMLInputElement>('.ch-path-input')?.addEventListener('change', () => this.host.onCwdChange(this))
  }

  /** The folder the chooser holds now (what the layout keeps). */
  get cwd(): string { return this.chooser ? this.chooser.snapshot().folder.trim() : this.folder }

  /** The profiles changed: the list is redrawn with the same state. */
  renderProfiles(): void { this.chooser?.render() }

  /** The popup gave its state back (cancelled): the pane's chooser continues from it. */
  setState(state: Partial<ChooserState>): void { this.chooser?.setState(state) }

  setBusy(busy: boolean): void { this.chooser?.setBusy(busy) }

  /** The keyboard to the chooser's search field. */
  focus(): void {
    if (this.disposed) return
    if (this.blank) { this.blankView?.querySelector<HTMLElement>('.blank-action')?.focus(); return }
    this.chooser?.focus()
  }

  // ---------- tests ----------

  snapshot(): EmptySnapshot {
    const s = this.chooser?.snapshot()
    return { ...(s ?? { query: '', highlight: undefined, folder: '', touched: false, where: { level: 'pane', placement: 'within' }, busy: false, error: undefined, recentsOpen: false, shown: [], effectiveFolder: '', fromProfile: false, focused: false }), id: this.id, cwd: this.cwd, origin: this.origin, blank: this.blank }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.chooser?.dispose()
    for (const d of this.disposers.splice(0)) d.dispose()
  }
}

/** The empty pane's tab: a plus, "Vazio", the ×; right-click opens the menu. */
export class EmptyTab implements ITabRenderer {
  readonly element: HTMLElement
  private api: DockviewPanelApi | undefined
  private readonly text: HTMLElement
  private readonly host: EmptyHost

  constructor(host: EmptyHost) {
    this.host = host
    this.element = document.createElement('div')
    this.element.className = 'tether-tab empty'
    const kind = document.createElement('span'); kind.className = 'kind'; kind.append(icon('plus'))
    this.text = document.createElement('span'); this.text.className = 'text'
    const close = document.createElement('button')
    close.className = 'close'; close.title = 'Fechar'; close.setAttribute('aria-label', 'Fechar painel vazio')
    close.append(icon('x'))
    close.addEventListener('pointerdown', ev => ev.stopPropagation())
    close.addEventListener('click', ev => { ev.stopPropagation(); if (this.api) this.host.onClose(this.api.id) })
    this.element.append(kind, this.text, close)
    this.element.addEventListener('contextmenu', ev => { ev.preventDefault(); ev.stopPropagation(); if (this.api) this.host.onTabMenu(this.api.id, ev) })
  }

  init(params: TabPartInitParameters): void {
    this.api = params.api
    this.element.dataset.slot = params.api.id
    this.render()
  }

  render(): void {
    if (!this.api) return
    this.text.textContent = this.api.title ?? EMPTY_TITLE
    this.element.title = `${EMPTY_TITLE}\nUm lugar reservado: escolha dentro dele o que abrir`
  }

  dispose(): void {}
}
