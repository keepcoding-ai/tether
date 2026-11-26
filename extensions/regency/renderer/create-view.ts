// The Regency's "+ Novo": the card of steps (O quê › Onde › Detalhes) over the rules of create-rules.ts. It lives outside the
// pane (a modal <dialog> on the page's body), so a repaint of the tree never touches the form; the core's pickers are modal
// dialogs too and stack over it. Desktop, tablet and TV: a centred dialog of contained width. The phone: a sheet from the
// bottom, one step per screen, 44 px targets. The keyboard stays in the card while it is open (Tab wraps) and goes back
// where it came from when it closes. Enter goes on, Esc goes back a step (on the first, it closes). Nothing here creates:
// the host runs the plan (renderer.ts, by create-run.ts) and the card says how it ended.
import type { CreateItem, DeskTree, PickItem, PickManySpec, PickSpec } from '../../../app/renderer/ext-api.ts'
import { identityMark, identityOf } from '../../../app/renderer/agent-identity.ts'
import { HUE_LABELS } from '../../../app/renderer/emblem-rules.ts'
import { HUE_NAMES } from '../../../app/shared/palette.ts'
import type { ChannelSummary } from '../../channels/daemon/requests.ts'
import {
  advance, back, CREATE_TILES, channelNameOf, defaultNameOf, deskChannelOf, deskChoices, NEW_DESK, patchDraft, startCreate, stepsOf, STEP_LABELS,
  type CreateContext, type CreateDraft, type CreateFixed, type CreateState, type CreateStep, type CreateWhat,
} from '../create-rules.ts'
import type { RegencyInput } from '../model.ts'
import { el, glyph } from './columns.ts'
import { errorField } from './create-run.ts'

/** A live agent, for "para um agente" and "com quem". */
export interface CreateAgent { id: string; kind: string; name: string }

/** How a run ended: `text` is said in the card (a failure, or what did not go); `after` lights what was made. */
export interface CreateRunEnd { ok: boolean; text?: string; after(): void }

export interface CreateViewHost {
  items(): readonly CreateItem[]
  desks(): DeskTree
  owners(): RegencyInput['owners']
  /** Every channel the app knows (open and closed). */
  channels(): readonly ChannelSummary[]
  agents(): readonly CreateAgent[]
  /** The window's projects. */
  projects(): readonly { path: string; name: string; pinned: boolean }[]
  recentFolders(): Promise<string[]>
  pickFolder(initial?: string): Promise<string | null>
  /** The folder a new pane starts in when nothing else says. */
  defaultFolder(): string | undefined
  pickList<T>(spec: PickSpec<T>): Promise<T | undefined>
  pickMany<T>(spec: PickManySpec<T>): Promise<T[] | undefined>
  /** The tier the Regency is drawn in ('mobile' makes the card a sheet). */
  tier(): string
  run(state: CreateState): Promise<CreateRunEnd>
}

/** What the E2E reads of the card. */
export interface CreateViewSnapshot {
  open: boolean
  phase: 'edit' | 'running' | 'told'
  step: CreateStep
  steps: CreateStep[]
  draft: CreateDraft
  error?: string
  told?: string
  tier: string
}

const TILE_ICON: Readonly<Record<string, { icon: string; hint: string }>> = {
  agent: { icon: 'robot', hint: 'uma IA para trabalhar' },
  terminal: { icon: 'terminal-window', hint: 'um terminal numa pasta' },
  note: { icon: 'note-pencil', hint: 'uma anotação' },
  browser: { icon: 'globe-simple', hint: 'uma página da web' },
  desk: { icon: 'cards', hint: 'uma mesa para organizar' },
  channel: { icon: 'chats-circle', hint: 'uma conversa com agentes' },
}

const NOUN: Readonly<Record<CreateWhat, string>> = {
  agent: 'Novo agente', terminal: 'Novo terminal', note: 'Nova nota', browser: 'Nova guia do navegador', channel: 'Novo canal', desk: 'Mesa nova', 'desk-for': 'Mesa nova',
}

/** Where the note is written (the note-new item's destinations); the draft's `name` carries the id. */
const NOTE_PLACES: readonly { id: string; label: string; tip: string }[] = [
  { id: 'project', label: 'Notas do projeto', tip: 'Na pasta do projeto, em .tether\\notes' },
  { id: 'home', label: 'Minhas notas', tip: 'Na pasta das suas notas (Configurações)' },
  { id: 'other', label: 'Exatamente na pasta', tip: 'Na pasta escolhida, sem subpasta' },
]

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex="0"]'
const isAgentItem = (i: CreateItem): boolean => i.kind === 'profile' && i.engine !== undefined && i.engine !== 'shell'
const isShellItem = (i: CreateItem): boolean => i.kind === 'profile' && i.engine === 'shell'

export class CreateCard {
  private readonly host: CreateViewHost
  private dialog: HTMLDialogElement | undefined
  private state: CreateState = startCreate()
  private phase: 'edit' | 'running' | 'told' = 'edit'
  private told: CreateRunEnd | undefined
  private restore: (() => void) | undefined
  /** A picker of the card is up: the card's keys wait (the picker is its own dialog). */
  private picking = false

  constructor(host: CreateViewHost) {
    this.host = host
  }

  get isOpen(): boolean { return this.dialog !== undefined }

  /** Opens the card (one at a time: a second open replaces the first). `restore` gives the keyboard back when it closes. */
  open(fixed: CreateFixed, restore: () => void, what?: CreateWhat): void {
    if (this.dialog) this.close(false)
    this.state = startCreate(fixed, what)
    if (this.state.draft.what === 'desk-for') this.state = patchDraft(this.state, { newDesk: { name: fixed.forName ? `Mesa de ${fixed.forName}` : '', color: 'purple' } })
    this.phase = 'edit'
    this.told = undefined
    this.restore = restore
    const d = el('dialog', 'rg-cr')
    d.setAttribute('aria-modal', 'true')
    d.addEventListener('keydown', ev => this.onKey(ev))
    // Esc is the card's own (a step back): the dialog never closes by itself.
    d.addEventListener('cancel', ev => ev.preventDefault())
    d.addEventListener('click', ev => this.onClick(ev))
    d.addEventListener('input', ev => this.onInput(ev))
    d.addEventListener('change', ev => this.onChange(ev))
    document.body.append(d)
    this.dialog = d
    this.render()
    d.showModal()
    this.focusFirst()
    // A project's "Agente aqui…" / "Terminal aqui…": the tile is taken at once (the profile picker for an agent), the folder stays.
    if (fixed.cwd !== undefined && (what === 'agent' || what === 'terminal')) void this.pickTile(what)
  }

  /** Closes the card; the keyboard goes back to where it came from (`restore`). */
  close(restore = true): void {
    const d = this.dialog
    if (!d) return
    this.dialog = undefined
    if (d.open) d.close()
    d.remove()
    const back = this.restore
    this.restore = undefined
    if (restore) back?.()
  }

  snapshot(): CreateViewSnapshot {
    const s = this.state
    return {
      open: this.isOpen, phase: this.phase, step: s.step, steps: stepsOf(s.draft, s.fixed), draft: { ...s.draft },
      ...(s.error !== undefined ? { error: s.error } : {}), ...(this.told?.text !== undefined ? { told: this.told.text } : {}),
      tier: this.dialog?.dataset.tier ?? this.host.tier(),
    }
  }

  // ---------------------------------------------------------------- the moves

  private ctx(): CreateContext { return { desks: this.host.desks(), channels: this.host.channels() } }

  /** Draws the state and puts the keyboard on the error's field, or on the step's first thing. */
  private set(next: CreateState): void {
    this.state = next
    if (next.error === undefined) this.fillDefaults()
    this.render()
    if (this.state.error !== undefined) this.focusError()
    else this.focusFirst()
  }

  private patch(p: Partial<CreateDraft>): void { this.state = patchDraft(this.state, p) }

  /** A field of the draft taken away (`patchDraft` only adds). */
  private drop(key: 'joinChannel' | 'browserFor'): void {
    const draft = { ...this.state.draft }
    delete draft[key]
    this.state = { ...this.state, draft }
  }

  /** Enter or "Continuar": the step is checked; the last one runs the plan. */
  async forward(): Promise<void> {
    if (this.phase !== 'edit' || !this.dialog) return
    this.fillDefaults()
    const next = advance(this.state, this.ctx())
    if (next.outcome === 'ready') { this.state = next; await this.runIt(); return }
    this.set(next)
  }

  /** Esc or "Voltar": a step back; from the first, the card closes. */
  backward(): void {
    if (!this.dialog) return
    if (this.phase === 'running') return
    if (this.phase === 'told') { this.ackTold(); return }
    const prev = back(this.state)
    if (prev.outcome === 'closed') { this.close(); return }
    this.set(prev)
  }

  /** What the next step shows without asking: the folder, the new desk's colour. */
  private fillDefaults(): void {
    const d = this.state.draft
    if ((d.what === 'agent' || d.what === 'terminal' || d.what === 'note') && (d.cwd ?? '') === '') {
      const f = this.host.defaultFolder()
      if (f) this.patch({ cwd: f })
    }
    if ((d.what === 'desk' || d.deskId === NEW_DESK) && d.newDesk === undefined) this.patch({ newDesk: { name: '', color: 'blue' } })
  }

  private async runIt(): Promise<void> {
    this.phase = 'running'
    this.render()
    let end: CreateRunEnd
    try { end = await this.host.run(this.state) } catch (e) { end = { ok: false, text: `Não consegui criar: ${e instanceof Error ? e.message : String(e)}.`, after: () => {} } }
    if (!this.dialog) { end.after(); return }
    if (end.ok && end.text === undefined) { this.close(); end.after(); return }
    this.phase = 'told'
    this.told = end
    this.render()
    this.dialog.querySelector<HTMLElement>('[data-do="ack"]')?.focus()
  }

  private ackTold(): void {
    const end = this.told
    this.close()
    end?.after()
  }

  // ---------------------------------------------------------------- the pickers of a field

  private async picked<T>(p: Promise<T | undefined>): Promise<T | undefined> {
    this.picking = true
    try { return await p } finally { this.picking = false }
  }

  private profileRow(i: CreateItem): PickItem<string> {
    return {
      value: i.id, label: i.name, ...(i.hint ? { detail: i.hint } : {}), ...(i.engine ? { engine: i.engine } : {}),
      group: i.recent ? 'Recentes' : (identityOf({ kind: i.engine ?? '', name: i.name, seed: i.id }).engine.label || i.group),
    }
  }

  /** The Agent tile: the profile by engine (the same rows as "Novo painel…"), then on. */
  private async chooseAgent(): Promise<void> {
    const items = this.host.items().filter(isAgentItem)
    const id = await this.picked(this.host.pickList<string>({
      title: 'Novo agente: qual agente', placeholder: 'Nome do perfil ou do motor', emptyText: 'Nenhum perfil de agente', items: items.map(i => this.profileRow(i)),
    }))
    if (id === undefined || !this.dialog) { this.focusFirst(); return }
    const item = items.find(i => i.id === id)
    if (!item) return
    // A folder the entry fixed (a project's "Agente aqui…") wins over the profile's own.
    const folder = this.state.fixed.cwd === undefined ? item.folder : undefined
    this.patch({ what: 'agent', kind: item.engine as string, profileId: item.id, profileName: item.name, ...(folder ? { cwd: folder } : {}) })
    await this.forward()
  }

  private async chooseShell(): Promise<void> {
    const items = this.host.items().filter(isShellItem)
    const id = await this.picked(this.host.pickList<string>({ title: 'Terminal: o shell', placeholder: 'Nome do perfil', emptyText: 'Nenhum perfil de terminal', items: items.map(i => this.profileRow(i)) }))
    if (id === undefined || !this.dialog) return
    this.patch({ kind: 'shell', profileId: id })
    this.render()
    this.focusField('shell')
  }

  /** The working folder: the window's projects, the recent folders, then the system's picker. A typed path is taken as is. */
  private async chooseFolder(): Promise<void> {
    const PICK = '\u0000pick'
    const projects = this.host.projects()
    const recent = await this.host.recentFolders().catch(() => [] as string[])
    const seen = new Set(projects.map(p => p.path.toLowerCase()))
    const rows: PickItem<string>[] = [
      ...projects.map(p => ({ value: p.path, label: p.name, detail: p.path, icon: p.pinned ? 'push-pin' : 'folder', group: 'Projetos' })),
      ...recent.filter(r => !seen.has(r.toLowerCase())).map(r => ({ value: r, label: r.split(/[\\/]/).filter(Boolean).pop() ?? r, detail: r, icon: 'clock-counter-clockwise', group: 'Recentes' })),
      { value: PICK, label: 'Escolher pasta…', icon: 'folder-open', detail: 'Abre o seletor de pastas do sistema', group: 'Outra' },
    ]
    const got = await this.picked(this.host.pickList<string>({
      title: 'Pasta de trabalho', placeholder: 'Nome do projeto ou caminho', emptyText: 'Nenhum projeto', items: rows,
      create: q => (/[\\/]/.test(q.trim()) ? { value: q.trim(), label: `Usar ${q.trim()}`, icon: 'folder' } : undefined),
    }))
    if (got === undefined || !this.dialog) { this.focusField('cwd'); return }
    const path = got === PICK ? await this.host.pickFolder(this.state.draft.cwd) : got
    if (!this.dialog) return
    if (path) this.patch({ cwd: path })
    this.render()
    this.focusField('cwd')
  }

  private async chooseMembers(): Promise<void> {
    const chosen = new Set(this.state.draft.channel?.members ?? [])
    const agents = this.host.agents()
    const ids = await this.picked(this.host.pickMany<string>({
      title: 'Com quem', placeholder: 'Nome do agente', emptyText: 'Nenhum agente vivo', confirmLabel: 'Escolher', confirmHint: 'escolhe',
      items: agents.map(a => ({ value: a.id, label: a.name, engine: a.kind, ...(chosen.has(a.id) ? { group: 'Já escolhidos' } : {}) })),
    }))
    if (!this.dialog) return
    if (ids !== undefined) this.patch({ channel: { name: this.state.draft.channel?.name ?? '', members: ids } })
    this.render()
    this.focusField('members')
  }

  // ---------------------------------------------------------------- events

  private onKey(ev: KeyboardEvent): void {
    if (this.picking) return
    const t = ev.target instanceof HTMLElement ? ev.target : null
    if (ev.key === 'Escape') {
      ev.preventDefault()
      ev.stopPropagation()
      this.backward()
      return
    }
    if (ev.key === 'Tab') { this.wrapTab(ev); return }
    if (ev.key !== 'Enter' || ev.shiftKey || ev.ctrlKey || ev.altKey || ev.metaKey) return
    // A button answers Enter itself (its click); a field or a choice goes on.
    if (t && (t.tagName === 'BUTTON' || t.tagName === 'TEXTAREA')) return
    ev.preventDefault()
    ev.stopPropagation()
    if (this.phase === 'told') { this.ackTold(); return }
    void this.forward()
  }

  /** The keyboard stays in the card: Tab past the last goes to the first, Shift+Tab before the first to the last. */
  private wrapTab(ev: KeyboardEvent): void {
    const all = this.focusables()
    if (all.length === 0) return
    const first = all[0]!
    const last = all[all.length - 1]!
    const at = document.activeElement
    if (ev.shiftKey && (at === first || !this.dialog?.contains(at))) { ev.preventDefault(); last.focus() }
    else if (!ev.shiftKey && (at === last || !this.dialog?.contains(at))) { ev.preventDefault(); first.focus() }
  }

  private onClick(ev: MouseEvent): void {
    const t = ev.target instanceof Element ? ev.target.closest<HTMLElement>('[data-do]') : null
    if (!t || this.picking) return
    const what = t.dataset.do!
    const arg = t.dataset.arg ?? ''
    switch (what) {
      case 'tile': void this.pickTile(arg as CreateWhat); break
      case 'next': void this.forward(); break
      case 'back': this.backward(); break
      case 'close': if (this.phase !== 'running') this.close(); break
      case 'ack': this.ackTold(); break
      case 'folder': void this.chooseFolder(); break
      case 'shell': void this.chooseShell(); break
      case 'profile': void this.chooseAgent(); break
      case 'members': void this.chooseMembers(); break
      case 'unmember': {
        const members = (this.state.draft.channel?.members ?? []).filter(m => m !== arg)
        this.patch({ channel: { name: this.state.draft.channel?.name ?? '', members } })
        this.render()
        this.focusField('members')
        break
      }
      case 'color': this.setColor(arg); break
    }
  }

  private setColor(color: string): void {
    const d = this.state.draft
    this.patch({ newDesk: { ...(d.newDesk ?? { name: '' }), color } })
    this.render()
    this.dialog?.querySelector<HTMLElement>(`[data-do="color"][data-arg="${color}"]`)?.focus()
  }

  private async pickTile(what: CreateWhat): Promise<void> {
    if (what === 'agent') { await this.chooseAgent(); return }
    if (what !== this.state.draft.what) this.patch({ what, ...(what === 'terminal' ? { kind: 'shell' } : {}) })
    await this.forward()
  }

  /** A typed field: the draft follows without a repaint (the caret stays). */
  private onInput(ev: Event): void {
    const t = ev.target
    if (!(t instanceof HTMLInputElement) || t.type === 'radio' || t.type === 'checkbox') return
    const d = this.state.draft
    const v = t.value
    switch (t.dataset.f) {
      case 'name': this.patch({ name: v }); break
      case 'url': this.patch({ url: v }); break
      case 'desk-name': this.patch({ newDesk: { ...(d.newDesk ?? { name: '' }), name: v } }); break
      case 'channel-name': this.patch({ channel: { name: v, ...(d.channel?.members ? { members: d.channel.members } : {}) } }); break
    }
    this.clearError()
  }

  /** A choice: the draft follows and the step is drawn again (a choice may show or hide fields). */
  private onChange(ev: Event): void {
    const t = ev.target
    if (!(t instanceof HTMLInputElement) || (t.type !== 'radio' && t.type !== 'checkbox')) return
    const on = t.checked
    switch (t.dataset.f) {
      case 'desk': this.patch({ deskId: t.value }); if (t.value === NEW_DESK) this.fillDefaults(); break
      case 'join': if (t.value === '') this.drop('joinChannel'); else this.patch({ joinChannel: t.value }); break
      case 'front': this.patch({ front: on }); break
      case 'go': this.patch({ goAfter: on }); break
      case 'for': if (t.value === '') this.drop('browserFor'); else this.patch({ browserFor: t.value }); break
      case 'place': this.patch({ name: t.value }); break
      case 'shell-row': this.patch({ kind: 'shell', profileId: t.value }); break
      case 'give': this.patch({ giveDesk: on }); break
      case 'move': this.patch({ movePane: on }); break
      default: return
    }
    const focus = t.dataset.f + ':' + t.value
    this.render()
    const again = [...(this.dialog?.querySelectorAll<HTMLInputElement>('input[data-f]') ?? [])].find(i => `${i.dataset.f}:${i.value}` === focus)
    again?.focus()
  }

  private clearError(): void {
    if (this.state.error === undefined) return
    const { error: _e, ...rest } = this.state
    this.state = rest
    for (const e of this.dialog?.querySelectorAll('.rg-cr-err') ?? []) e.remove()
    for (const i of this.dialog?.querySelectorAll('[aria-invalid]') ?? []) i.removeAttribute('aria-invalid')
  }

  // ---------------------------------------------------------------- focus

  private focusables(): HTMLElement[] {
    return [...(this.dialog?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter(e => !e.closest('[hidden]') && e.tabIndex >= 0 && !(e instanceof HTMLInputElement && e.type === 'radio' && !e.checked && this.radioHasChecked(e)))
  }

  private radioHasChecked(r: HTMLInputElement): boolean {
    return [...(this.dialog?.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${r.name}"]`) ?? [])].some(x => x.checked)
  }

  /** The first thing of the step's body (the chosen tile, the chosen desk, the first field). */
  private focusFirst(): void {
    const body = this.dialog?.querySelector<HTMLElement>('.rg-cr-body')
    if (!body) return
    const chosen = body.querySelector<HTMLElement>('[aria-pressed="true"], input[type="radio"]:checked')
    const first = chosen ?? [...body.querySelectorAll<HTMLElement>(FOCUSABLE)].find(e => !(e instanceof HTMLInputElement && e.type === 'radio' && this.radioHasChecked(e) && !e.checked))
    ;(first ?? this.dialog?.querySelector<HTMLElement>('[data-do="next"]'))?.focus()
  }

  private focusField(field: string): void {
    const box = this.dialog?.querySelector<HTMLElement>(`[data-field="${field}"]`)
    const target = box?.querySelector<HTMLElement>('input[type="radio"]:checked') ?? box?.querySelector<HTMLElement>(FOCUSABLE)
    if (target) target.focus()
    else this.focusFirst()
  }

  private focusError(): void {
    const box = this.dialog?.querySelector<HTMLElement>('.rg-cr-err')?.closest<HTMLElement>('[data-field]')
    const target = box?.querySelector<HTMLElement>('input[type="radio"]:checked') ?? box?.querySelector<HTMLElement>(FOCUSABLE)
    ;(target ?? this.dialog?.querySelector<HTMLElement>('[data-do="next"]'))?.focus()
  }

  // ---------------------------------------------------------------- drawing

  private render(): void {
    const d = this.dialog
    if (!d) return
    const s = this.state
    const steps = stepsOf(s.draft, s.fixed)
    const at = Math.max(0, steps.indexOf(s.step))
    d.dataset.tier = this.host.tier()
    d.dataset.step = s.step
    d.dataset.phase = this.phase
    const title = this.titleOf()
    d.setAttribute('aria-label', title)

    const head = el('div', 'rg-cr-head')
    if (at > 0 && this.phase === 'edit') head.append(this.iconButton('back', 'arrow-left', 'Voltar um passo (Esc)', 'rg-cr-up'))
    const t = el('h2', 'rg-cr-title')
    t.append(glyph(this.titleIcon(), title), el('span', '', title))
    head.append(t)
    if (steps.length > 1) {
      const crumbs = el('ol', 'rg-cr-crumbs')
      crumbs.setAttribute('aria-label', `Passo ${at + 1} de ${steps.length}`)
      steps.forEach((step, i) => {
        const li = el('li', i === at ? 'on' : i < at ? 'done' : '', STEP_LABELS[step])
        if (i === at) li.setAttribute('aria-current', 'step')
        crumbs.append(li)
      })
      head.append(crumbs)
    }
    head.append(this.iconButton('close', 'x', 'Fechar sem criar', 'rg-cr-x'))

    const body = el('div', 'rg-cr-body')
    const foot = el('div', 'rg-cr-foot')
    if (this.phase === 'running') {
      body.setAttribute('aria-busy', 'true')
      body.append(el('p', 'rg-cr-busy', 'Criando… você continua na Regência.'))
    } else if (this.phase === 'told') {
      const box = el('div', 'rg-cr-told')
      box.setAttribute('role', 'alert')
      box.append(glyph(this.told?.ok ? 'warning' : 'shield-warning', this.told?.ok ? 'Aviso' : 'Não deu certo'), el('p', '', this.told?.text ?? ''))
      body.append(box)
      foot.append(el('span', 'rg-sp'), this.textButton('ack', 'Entendi', 'Fechar este aviso', true))
    } else {
      this.paintStep(body)
      const last = at === steps.length - 1
      foot.append(el('span', 'rg-cr-stay', 'Você continua na Regência'), el('span', 'rg-sp'))
      foot.append(at === 0 ? this.textButton('back', 'Cancelar', 'Fechar sem criar (Esc)') : this.textButton('back', 'Voltar', 'Voltar um passo (Esc)'))
      foot.append(this.textButton('next', last ? 'Criar' : 'Continuar', last ? 'Criar agora (Enter)' : 'Próximo passo (Enter)', true))
    }
    d.replaceChildren(head, body, foot)
    if (this.phase === 'edit' && s.error !== undefined) this.showError(body, s.error)
  }

  private titleOf(): string {
    const s = this.state
    if (s.draft.what === 'desk-for') return `Mesa nova para ${s.fixed.forName ?? 'o agente'}`
    const desk = s.fixed.deskId ? this.host.desks().desks.find(x => x.id === s.fixed.deskId)?.name : undefined
    if (s.step === 'what') return desk ? `Nova guia em ${desk}` : 'Novo'
    const noun = s.draft.what ? NOUN[s.draft.what] : 'Novo'
    return desk ? `${noun} em ${desk}` : noun
  }

  private titleIcon(): string {
    const w = this.state.draft.what
    if (this.state.step === 'what' || !w) return 'plus'
    return TILE_ICON[w === 'desk-for' ? 'desk' : w]?.icon ?? 'plus'
  }

  private iconButton(action: string, iconName: string, tip: string, cls: string): HTMLButtonElement {
    const b = el('button', `rg-cr-ib ${cls}`)
    b.type = 'button'
    b.dataset.do = action
    b.title = tip
    b.setAttribute('aria-label', tip)
    const g = glyph(iconName, tip)
    g.setAttribute('aria-hidden', 'true')
    b.append(g)
    return b
  }

  private textButton(action: string, label: string, tip: string, primary = false): HTMLButtonElement {
    const b = el('button', `rg-cr-btn${primary ? ' pri' : ''}`, label)
    b.type = 'button'
    b.dataset.do = action
    b.title = tip
    return b
  }

  private field(name: string, label: string, ...content: HTMLElement[]): HTMLElement {
    const box = el('div', 'rg-cr-fl')
    box.dataset.field = name
    const id = `rg-cr-${name}`
    const lb = el('div', 'rg-cr-lb', label)
    lb.id = `${id}-label`
    box.setAttribute('role', 'group')
    box.setAttribute('aria-labelledby', lb.id)
    box.append(lb, ...content)
    return box
  }

  private textInput(f: string, value: string, label: string, placeholder: string, prefix?: string): HTMLElement {
    const wrap = el('label', 'rg-cr-in')
    if (prefix) wrap.append(el('span', 'rg-cr-pre', prefix))
    const i = el('input')
    i.type = 'text'
    i.dataset.f = f
    i.value = value
    i.placeholder = placeholder
    i.spellcheck = false
    i.autocomplete = 'off'
    i.setAttribute('aria-label', label)
    wrap.append(i)
    return wrap
  }

  /** A button that shows a value and opens its picker (the folder, the shell, the members). */
  private valueButton(action: string, iconName: string, text: string, detail: string | undefined, tip: string): HTMLButtonElement {
    const b = el('button', 'rg-cr-val')
    b.type = 'button'
    b.dataset.do = action
    b.title = tip
    const g = glyph(iconName, tip)
    g.setAttribute('aria-hidden', 'true')
    b.append(g, el('span', 'rg-cr-vt', text))
    if (detail) b.append(el('span', 'rg-cr-vd', detail))
    b.append(glyph('caret-down', 'Escolher'))
    return b
  }

  private radio(group: string, f: string, value: string, checked: boolean, content: HTMLElement[], opts: { disabled?: boolean; tip?: string } = {}): HTMLElement {
    const row = el('label', 'rg-cr-opt')
    if (checked) row.classList.add('on')
    if (opts.tip) row.title = opts.tip
    const r = el('input')
    r.type = 'radio'
    r.name = group
    r.value = value
    r.checked = checked
    r.dataset.f = f
    if (opts.disabled) r.disabled = true
    row.append(r, ...content)
    return row
  }

  private check(f: string, checked: boolean, label: string, opts: { disabled?: boolean; tip?: string } = {}): HTMLElement {
    const row = el('label', 'rg-cr-ck')
    if (opts.tip) row.title = opts.tip
    const c = el('input')
    c.type = 'checkbox'
    c.dataset.f = f
    c.checked = checked
    if (opts.disabled) c.disabled = true
    row.append(c, el('span', '', label))
    return row
  }

  private paintStep(body: HTMLElement): void {
    const s = this.state
    if (s.step === 'what') this.paintWhat(body)
    else if (s.step === 'where') this.paintWhere(body)
    else this.paintDetails(body)
  }

  private paintWhat(body: HTMLElement): void {
    const s = this.state
    const inDesk = s.fixed.deskId !== undefined
    const groups: { key: 'desk' | 'tether'; label: string }[] = inDesk ? [{ key: 'desk', label: 'Nesta mesa' }] : [{ key: 'desk', label: 'Numa mesa' }, { key: 'tether', label: 'No tether' }]
    const box = el('div', 'rg-cr-tiles')
    box.dataset.field = 'what'
    box.setAttribute('role', 'group')
    box.setAttribute('aria-label', 'O que criar')
    const engines = this.engineMarks()
    for (const g of groups) {
      box.append(el('div', 'rg-cr-tgrp', g.label))
      for (const tile of CREATE_TILES.filter(x => x.group === g.key)) {
        const meta = TILE_ICON[tile.what]!
        const b = el('button', 'rg-cr-tile')
        b.type = 'button'
        b.dataset.do = 'tile'
        b.dataset.arg = tile.what
        const on = s.draft.what === tile.what
        b.setAttribute('aria-pressed', String(on))
        const hint = tile.what === 'agent' && on && s.draft.profileId
          ? this.host.items().find(i => i.id === s.draft.profileId)?.name ?? meta.hint
          : meta.hint
        b.title = `${tile.label}: ${hint}`
        b.append(glyph(meta.icon, tile.label), el('b', '', tile.label), el('small', '', hint))
        if (tile.what === 'agent' && engines.length > 0) {
          const strip = el('span', 'rg-cr-engines')
          strip.append(...engines)
          b.append(strip)
        }
        box.append(b)
      }
    }
    body.append(box)
  }

  /** The engines the agent profiles run on, each as its identity's icon with the engine's name (the Agent tile). */
  private engineMarks(): HTMLElement[] {
    const seen = new Set<string>()
    const out: HTMLElement[] = []
    for (const i of this.host.items()) {
      if (!isAgentItem(i) || seen.has(i.engine!)) continue
      seen.add(i.engine!)
      const id = identityOf({ kind: i.engine!, name: i.engine!, seed: i.engine! })
      const mark = identityMark(id)
      mark.querySelector('.aid-mark')?.remove()
      mark.title = id.engine.label
      out.push(mark)
    }
    return out
  }

  private paintWhere(body: HTMLElement): void {
    const s = this.state
    const choices = deskChoices(this.host.desks(), this.host.owners(), s.fixed.deskId)
    const list = el('div', 'rg-cr-list')
    for (const c of choices) {
      const dot = el('span', 'rg-dot')
      dot.style.setProperty('--rg-desk', `var(--x-${c.color}, var(--accent))`)
      dot.title = c.isNew ? 'Mesa nova' : `Cor da mesa: ${HUE_LABELS[c.color as keyof typeof HUE_LABELS] ?? c.color}`
      const content: HTMLElement[] = c.isNew ? [glyph('plus', 'Mesa nova'), el('span', 'rg-cr-on', 'Mesa nova…')] : [dot, el('span', 'rg-cr-on', c.name)]
      if (c.owner) {
        const own = el('span', 'rg-own')
        own.title = `Dono da mesa: ${c.owner}`
        own.append(glyph('crown-simple', 'Dono da mesa'), el('span', '', c.owner))
        content.push(own)
      }
      if (!c.isNew) {
        const n = this.host.desks().desks.find(x => x.id === c.id)?.panes.length ?? 0
        content.push(el('small', '', `${n} guia${n === 1 ? '' : 's'}`))
      }
      list.append(this.radio('rg-cr-desk', 'desk', c.id, s.draft.deskId === c.id, content))
    }
    body.append(this.field('desk', 'Em qual mesa?', list))
    if (s.draft.deskId === NEW_DESK) this.paintNewDesk(body)
  }

  private paintNewDesk(body: HTMLElement): void {
    const nd = this.state.draft.newDesk ?? { name: '' }
    body.append(this.field('desk-name', 'Nome da mesa nova', this.textInput('desk-name', nd.name, 'Nome da mesa nova', 'obra, estudo, revisão…')))
    const sw = el('div', 'rg-cr-sw')
    sw.setAttribute('role', 'radiogroup')
    sw.setAttribute('aria-label', 'Cor da mesa')
    for (const hue of HUE_NAMES) {
      const b = el('button', 'rg-cr-hue')
      b.type = 'button'
      b.dataset.do = 'color'
      b.dataset.arg = hue
      b.setAttribute('role', 'radio')
      b.setAttribute('aria-checked', String(nd.color === hue))
      b.title = HUE_LABELS[hue]
      b.setAttribute('aria-label', HUE_LABELS[hue])
      b.style.setProperty('--rg-hue', `var(--x-${hue})`)
      sw.append(b)
    }
    body.append(this.field('desk-color', 'Cor', sw))
  }

  private deskName(): string | undefined {
    const id = this.state.draft.deskId
    if (id === NEW_DESK) return this.state.draft.newDesk?.name || 'mesa nova'
    return id ? this.host.desks().desks.find(d => d.id === id)?.name : undefined
  }

  private paintDetails(body: HTMLElement): void {
    const s = this.state
    const d = s.draft
    switch (d.what) {
      case 'agent': {
        const item = this.host.items().find(i => i.id === d.profileId)
        const who = el('div', 'rg-cr-who')
        if (item) {
          const mark = identityMark(identityOf({ kind: item.engine ?? '', name: item.name, seed: item.id }))
          mark.querySelector('.aid-mark')?.remove()
          who.append(mark, el('span', 'rg-cr-vt', item.name))
          if (item.hint) who.append(el('span', 'rg-cr-vd', item.hint))
        }
        const change = this.textButton('profile', 'Trocar', 'Escolher outro agente')
        who.append(el('span', 'rg-sp'), change)
        body.append(this.field('what', 'Qual agente', who))
        this.paintFolder(body)
        body.append(this.field('name', 'Nome (opcional)', this.textInput('name', d.name ?? '', 'Nome da guia', this.defaultName() || 'o nome do perfil')))
        this.paintJoin(body)
        this.paintGo(body)
        return
      }
      case 'terminal': {
        const shells = this.host.items().filter(isShellItem)
        if (shells.length > 1) {
          const current = shells.find(i => i.id === d.profileId) ?? shells.find(i => i.default) ?? shells[0]!
          body.append(this.field('shell', 'Shell', this.valueButton('shell', 'terminal-window', current.name, current.hint, 'Escolher o shell')))
        }
        this.paintFolder(body)
        body.append(this.field('name', 'Nome (opcional)', this.textInput('name', d.name ?? '', 'Nome da guia', this.defaultName() || 'Terminal')))
        this.paintGo(body)
        return
      }
      case 'note': {
        this.paintFolder(body)
        const list = el('div', 'rg-cr-list')
        const place = d.name ?? 'project'
        for (const p of NOTE_PLACES) list.append(this.radio('rg-cr-place', 'place', p.id, place === p.id, [el('span', 'rg-cr-on', p.label), el('small', '', p.tip)], { tip: p.tip }))
        body.append(this.field('place', 'Onde guardar', list))
        this.paintGo(body)
        return
      }
      case 'browser': {
        const list = el('div', 'rg-cr-list')
        list.append(this.radio('rg-cr-for', 'for', '', d.browserFor === undefined, [glyph('globe-simple', 'Você'), el('span', 'rg-cr-on', 'Para você')]))
        for (const a of this.host.agents()) {
          const mark = identityMark(identityOf({ kind: a.kind, name: a.name, seed: a.id }), { compact: true })
          list.append(this.radio('rg-cr-for', 'for', a.id, d.browserFor === a.id, [mark, el('span', 'rg-cr-on', `Para ${a.name}`), el('small', '', 'a aba nasce dele, com o escudo')], { tip: `A aba nasce de ${a.name}: o escudo de pé antes de qualquer página` }))
        }
        body.append(this.field('for', 'Para quem', list))
        body.append(this.field('url', 'Endereço (opcional)', this.textInput('url', d.url ?? '', 'Endereço da página', 'https://…')))
        return
      }
      case 'channel': {
        body.append(this.field('channel-name', 'Nome do canal', this.textInput('channel-name', d.channel?.name ?? '', 'Nome do canal', 'obra, revisão…', '#')))
        const members = d.channel?.members ?? []
        const agents = this.host.agents()
        const chips = el('div', 'rg-cr-chips')
        for (const id of members) {
          const a = agents.find(x => x.id === id)
          const chip = el('span', 'rg-cr-chip')
          if (a) chip.append(identityMark(identityOf({ kind: a.kind, name: a.name, seed: a.id }), { compact: true }))
          chip.append(el('span', '', a?.name ?? id))
          const x = this.iconButton('unmember', 'x', `Tirar ${a?.name ?? id}`, 'rg-cr-chip-x')
          x.dataset.arg = id
          chip.append(x)
          chips.append(chip)
        }
        const add = this.valueButton('members', 'user-plus', members.length > 0 ? 'Mudar quem entra…' : 'Escolher agentes…', undefined, 'Escolher os agentes que entram no canal')
        body.append(this.field('members', 'Com quem (opcional)', chips, add))
        if (d.channel?.name) {
          const n = channelNameOf(d.channel.name)
          if (n) body.append(el('p', 'rg-cr-note', `Abre no centro da Regência como #${n}.`))
        }
        return
      }
      case 'desk':
      case 'desk-for': {
        this.paintNewDeskFields(body)
        if (d.what === 'desk-for') {
          const who = s.fixed.forName ?? 'o agente'
          body.append(this.check('give', d.giveDesk !== false, `Dar a mesa a ${who}`, { tip: `${who} passa a ser dono da mesa nova` }))
          body.append(this.check('move', d.movePane === true, `Levar a guia de ${who} para lá`, { tip: 'Muda a guia de mesa; sem isso ela fica onde está' }))
        }
        return
      }
    }
  }

  /** The new desk's name and colour (the "Mesa" tile and "Dar uma mesa nova"). */
  private paintNewDeskFields(body: HTMLElement): void {
    if (this.state.draft.newDesk === undefined) this.patch({ newDesk: { name: '', color: 'blue' } })
    this.paintNewDesk(body)
  }

  private paintFolder(body: HTMLElement): void {
    const cwd = this.state.draft.cwd ?? ''
    const name = cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd : 'Escolher pasta…'
    body.append(this.field('cwd', 'Pasta de trabalho', this.valueButton('folder', 'folder', name, cwd || undefined, 'Escolher a pasta: projetos, recentes ou outra')))
  }

  /** "Entrar num canal": none or one open channel; the desk's own channel is ticked and locked (the agent enters by the desk). */
  private paintJoin(body: HTMLElement): void {
    const d = this.state.draft
    const open = this.host.channels().filter(c => c.closed === undefined)
    const own = d.deskId && d.deskId !== NEW_DESK ? deskChannelOf(d.deskId, open) : undefined
    const list = el('div', 'rg-cr-list')
    if (own) list.append(this.check('desk-channel', true, `#${own.name}, o canal da mesa: entra sozinho`, { disabled: true, tip: 'Quem está na mesa entra no canal dela' }))
    const others = open.filter(c => c.id !== own?.id && !c.desk)
    if (others.length === 0 && !own) list.append(el('p', 'rg-cr-note', 'Nenhum canal aberto.'))
    if (others.length > 0) {
      list.append(this.radio('rg-cr-join', 'join', '', d.joinChannel === undefined, [el('span', 'rg-cr-on', 'Nenhum')]))
      for (const c of others) list.append(this.radio('rg-cr-join', 'join', c.id, d.joinChannel === c.id, [el('span', 'rg-cr-hash', '#'), el('span', 'rg-cr-on', c.name), ...(c.title && c.title !== c.name ? [el('small', '', c.title)] : [])]))
    }
    body.append(this.field('join', 'Entrar num canal', list))
  }

  /** "Ir até a guia depois de criar", unticked: by default the person stays on the Regency and the new row glows. */
  private paintGo(body: HTMLElement): void {
    const desk = this.deskName()
    body.append(this.check('go', this.state.draft.goAfter === true, 'Ir até a guia depois de criar', { tip: desk ? `Leva você até a guia nova, em ${desk}` : 'Leva você até a guia nova' }))
  }

  /** The name the pane gets if the person types none ("Terminal 1", the profile's name). */
  private defaultName(): string {
    return defaultNameOf({ ...this.state.draft, name: '' }, this.ctx())
  }

  private showError(body: HTMLElement, error: string): void {
    const field = errorField(error)
    const box = body.querySelector<HTMLElement>(`[data-field="${field}"]`) ?? body
    const p = el('p', 'rg-cr-err', error)
    p.id = 'rg-cr-err'
    p.setAttribute('role', 'alert')
    box.append(p)
    for (const i of box.querySelectorAll<HTMLElement>('input, button.rg-cr-val')) {
      i.setAttribute('aria-invalid', 'true')
      i.setAttribute('aria-describedby', p.id)
    }
  }
}
