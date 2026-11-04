// One dockview panel = one empty pane (app/shared/empty.ts): a place reserved in the layout, with the chooser
// inside it instead of a black screen. The chooser is the "Novo painel…" dialog's own pieces (the grouped list of
// profiles with the note choices on top, the folder with "Procurar…" and the recent folders, "Abrir" / Enter),
// without the "Onde" row: the pane IS the place. When the person picks, the host replaces this pane, in the same
// group and at the same index, by what they chose. Nothing here talks to tetherd.
import type { DockviewPanelApi, GroupPanelPartInitParameters, IContentRenderer, ITabRenderer, TabPartInitParameters } from 'dockview-core'
import type { Profile } from '../../src/daemon/protocol.ts'
import { type Choice, choiceNeedsFolder, choiceOf, leadingChoices } from './chooser-rules.ts'
import { icon } from './icons.ts'
import { defaultOf, renderProfileGroups } from './profiles.ts'
import { EMPTY_TITLE, emptyParams } from '../shared/empty.ts'

export interface EmptyHost {
  profiles(): Profile[]
  recentFolders(): Promise<string[]>
  pickFolder(initial?: string): Promise<string | null>
  /** The person picked: the host opens it in this pane's place. Resolves with an error message to show, or nothing. */
  fill(panel: EmptyPanel, choice: Choice, cwd: string): Promise<string | undefined>
  /** The pane's suggested folder changed (the person typed one): persist it with the layout. */
  onCwdChange(panel: EmptyPanel): void
  /** Right-click on the tab / the strip's "⋯". */
  onTabMenu(id: string, ev: MouseEvent): void
  /** The tab's ×. */
  onClose(id: string): void
}

/** What a test reads of an empty pane. */
export interface EmptySnapshot { id: string; cwd: string; selected: string | undefined; focused: boolean; error: string | undefined }

export class EmptyPanel implements IContentRenderer {
  readonly element: HTMLElement
  id = ''
  private api: DockviewPanelApi | undefined
  private readonly host: EmptyHost
  private readonly form: HTMLFormElement
  private readonly groups: HTMLElement
  private readonly cwdInput: HTMLInputElement
  private readonly recent: HTMLUListElement
  private readonly error: HTMLElement
  private readonly submit: HTMLButtonElement
  private busy = false
  private disposed = false
  private readonly disposers: Array<{ dispose(): void }> = []

  constructor(host: EmptyHost) {
    this.host = host
    this.element = document.createElement('div')
    this.element.className = 'empty-panel'
    this.element.dataset.empty = 'pane'
    // A form of its own: the radios are named `profile` like the dialog's, and a radio group is scoped to its form.
    this.form = document.createElement('form')
    this.form.className = 'chooser'
    this.form.setAttribute('aria-label', 'O que abrir neste painel')
    const head = document.createElement('h3')
    head.append(icon('plus'), document.createTextNode('O que abrir aqui?'))
    this.groups = document.createElement('div')
    this.groups.className = 'profile-groups'
    const folder = document.createElement('label'); folder.className = 'field'
    const folderLabel = document.createElement('span'); folderLabel.textContent = 'Pasta'
    const row = document.createElement('span'); row.className = 'row'
    this.cwdInput = document.createElement('input')
    this.cwdInput.type = 'text'; this.cwdInput.name = 'cwd'; this.cwdInput.placeholder = 'D:\\projetos\\meu-app'; this.cwdInput.spellcheck = false
    const browse = document.createElement('button'); browse.type = 'button'
    browse.append(icon('folder-open'), document.createTextNode('Procurar…'))
    browse.addEventListener('click', () => { void this.browse() })
    row.append(this.cwdInput, browse)
    folder.append(folderLabel, row)
    const recentField = document.createElement('div'); recentField.className = 'field'
    const recentLabel = document.createElement('span'); recentLabel.textContent = 'Pastas recentes'
    this.recent = document.createElement('ul'); this.recent.className = 'recent'
    recentField.append(recentLabel, this.recent)
    this.error = document.createElement('p'); this.error.className = 'error'; this.error.hidden = true
    const actions = document.createElement('footer'); actions.className = 'actions'
    this.submit = document.createElement('button'); this.submit.type = 'submit'; this.submit.className = 'primary'
    const kbd = document.createElement('kbd'); kbd.textContent = 'Enter'
    this.submit.append(document.createTextNode('Abrir '), kbd)
    actions.append(this.submit)
    this.form.append(head, this.groups, folder, recentField, this.error, actions)
    this.form.addEventListener('submit', ev => { ev.preventDefault(); void this.open() })
    this.cwdInput.addEventListener('change', () => this.host.onCwdChange(this))
    // Keys typed in the chooser are its own (the terminal's Esc handling, the app's chords on letters stay away);
    // the app's chords (Ctrl+Shift+…) still bubble to the document.
    this.element.append(this.form)
  }

  init(params: GroupPanelPartInitParameters): void {
    this.api = params.api
    this.id = params.api.id
    this.element.dataset.emptyId = this.id
    const suggested = emptyParams(params.params)?.cwd ?? ''
    this.cwdInput.value = suggested
    this.cwdInput.dataset.suggested = suggested
    this.renderProfiles()
    void this.loadRecent()
    this.disposers.push(params.api.onDidActiveChange(({ isActive }) => { if (isActive) requestAnimationFrame(() => this.focus()) }))
  }

  /** The folder the chooser shows now (what the layout keeps). */
  get cwd(): string { return this.cwdInput.value.trim() }

  /** The grouped list: the note choices first, then the profiles (re-rendered when the profiles change). */
  renderProfiles(): void {
    const profiles = this.host.profiles()
    const selected = this.selectedValue() ?? defaultOf(profiles, 'claude')?.id ?? profiles[0]?.id
    renderProfileGroups(this.groups, profiles, {
      mode: 'radio', selectedId: selected, leading: leadingChoices('empty'),
      onPick: id => {
        const p = profiles.find(x => x.id === id)
        if (p?.cwd && this.cwdInput.value === this.cwdInput.dataset.suggested) { this.cwdInput.value = p.cwd; this.cwdInput.dataset.suggested = p.cwd }
      },
    })
  }

  private async loadRecent(): Promise<void> {
    const recent = await this.host.recentFolders()
    if (this.disposed) return
    this.recent.replaceChildren()
    if (recent.length === 0) {
      const li = document.createElement('li'); li.className = 'empty'; li.textContent = 'Nenhuma pasta recente'
      this.recent.append(li)
    }
    for (const f of recent) {
      const li = document.createElement('li'); li.textContent = f
      li.addEventListener('click', () => { this.cwdInput.value = f; this.host.onCwdChange(this); this.cwdInput.focus() })
      this.recent.append(li)
    }
    // No folder to suggest yet: the most recent one.
    if (!this.cwdInput.value && recent[0]) { this.cwdInput.value = recent[0]; this.cwdInput.dataset.suggested = recent[0] }
  }

  private selectedValue(): string | undefined {
    return this.form.querySelector<HTMLInputElement>('input[name=profile]:checked')?.value
  }

  private async browse(): Promise<void> {
    const picked = await this.host.pickFolder(this.cwd || undefined)
    if (picked && !this.disposed) { this.cwdInput.value = picked; this.host.onCwdChange(this); this.cwdInput.focus() }
  }

  private showError(message: string | undefined): void {
    this.error.textContent = message ?? ''
    this.error.hidden = !message
  }

  /** "Abrir" / Enter: the choice goes to the host, which replaces this pane. */
  private async open(): Promise<void> {
    if (this.busy || this.disposed) return
    const choice = choiceOf(this.selectedValue(), this.host.profiles())
    if (!choice) { this.showError('Escolha um perfil.'); return }
    const cwd = this.cwd
    if (choiceNeedsFolder(choice) && !cwd) { this.showError('Informe a pasta.'); this.cwdInput.focus(); return }
    this.busy = true
    this.submit.disabled = true
    this.showError(undefined)
    try {
      const error = await this.host.fill(this, choice, cwd)
      if (!this.disposed && error) this.showError(error)
    } finally {
      this.busy = false
      if (!this.disposed) this.submit.disabled = false
    }
  }

  /** The keyboard to the chooser: the folder field, selected (as the dialog does). */
  focus(): void {
    if (this.disposed) return
    this.cwdInput.focus()
    this.cwdInput.select()
  }

  // ---------- tests ----------

  snapshot(): EmptySnapshot {
    return { id: this.id, cwd: this.cwd, selected: this.selectedValue(), focused: this.element.contains(document.activeElement), error: this.error.hidden ? undefined : this.error.textContent ?? undefined }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
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
