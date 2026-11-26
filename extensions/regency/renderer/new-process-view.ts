// The Regency's "Novo processo": one card (the look of "+ Novo", create-view.ts) with name, command, folder, ports,
// description and environment variables, over the rules of new-process-rules.ts. A modal <dialog> on the page's body:
// desktop, tablet and TV, centred and of contained width; the phone, the whole screen, 44 px targets.
//
// The values of the variables (the secret boundary):
// - they live only in the `value` property of their password inputs while the person types: never in a field of this class,
//   a `data-*`, an attribute, the URL, a log or a snapshot (`snapshot()` says only whether a value is filled);
// - "mostrar" turns ONE value input into text while that field is being edited, and back to a password when the keyboard
//   leaves it (or at "Criar");
// - at "Criar" the request is built from the inputs, every value input is emptied at once, and the request goes to the host:
//   after the send the renderer keeps no value (a refusal asks to type them again);
// - a name that looks like a secret (core/redact-args.ts's rule) asks first, with "Voltar" as the default answer.
// The form's body is built once per opening and never drawn again: what the person typed stays in place under a question.
import type { PickItem, PickSpec } from '../../../app/renderer/ext-api.ts'
import type { ProcCreate } from '../../processes/embed.ts'
import { checkNewProc, ENV_WARNING, maskedCommand, secretQuestion, VALUE_MASK, type NewProcField, type NewProcForm, type NewProcRequest } from '../new-process-rules.ts'
import { el, glyph } from './columns.ts'

export interface NewProcessHost {
  /** The names the list already has (a known name is refused). */
  existing(): readonly string[]
  projects(): readonly { path: string; name: string; pinned: boolean }[]
  recentFolders(): Promise<string[]>
  pickFolder(initial?: string): Promise<string | null>
  pickList<T>(spec: PickSpec<T>): Promise<T | undefined>
  defaultFolder(): string | undefined
  /** The tier the Regency is drawn in ('mobile': the whole screen). */
  tier(): string
  create(request: NewProcRequest): Promise<ProcCreate>
  /** Made: the row of `name` is in the list (`failed`: it did not start, in words). */
  created(name: string, failed?: string): void
}

/** What the E2E reads: the fields that are not secret, and of each variable its name and whether a value is typed. */
export interface NewProcessSnapshot {
  open: boolean
  phase: 'edit' | 'asking' | 'running'
  tier: string
  name: string
  command: string
  cwd: string
  ports: string
  description: string
  env: { name: string; filled: boolean; shown: boolean }[]
  warning: string
  error?: string
  errorField?: string
  question?: string
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled])'

export class NewProcessCard {
  private readonly host: NewProcessHost
  private dialog: HTMLDialogElement | undefined
  private form: HTMLFieldSetElement | undefined
  private phase: 'edit' | 'asking' | 'running' = 'edit'
  private cwd = ''
  private restore: (() => void) | undefined
  private picking = false
  private error: { field: string; text: string } | undefined

  constructor(host: NewProcessHost) {
    this.host = host
  }

  get isOpen(): boolean { return this.dialog !== undefined }

  /** Opens the card (a second open replaces the first, empty). `restore` gives the keyboard back when it closes. */
  open(restore: () => void): void {
    if (this.dialog) this.close(false)
    this.phase = 'edit'
    this.error = undefined
    this.cwd = this.host.defaultFolder() ?? ''
    this.restore = restore
    const d = el('dialog', 'rg-cr rg-np')
    d.setAttribute('aria-modal', 'true')
    d.setAttribute('aria-label', 'Novo processo')
    d.dataset.tier = this.host.tier()
    d.addEventListener('keydown', ev => this.onKey(ev))
    d.addEventListener('cancel', ev => ev.preventDefault())
    d.addEventListener('click', ev => this.onClick(ev))
    d.addEventListener('input', () => this.clearError())
    d.addEventListener('focusout', ev => this.onFocusOut(ev))
    d.append(this.head(), this.body(), this.foot())
    document.body.append(d)
    this.dialog = d
    d.showModal()
    this.dialog.querySelector<HTMLElement>('input[data-f="name"]')?.focus()
  }

  /** Closes the card: every input goes with the dialog (values included); the keyboard goes back (`restore`). */
  close(restore = true): void {
    const d = this.dialog
    if (!d) return
    this.clearValues()
    this.dialog = undefined
    this.form = undefined
    this.error = undefined
    if (d.open) d.close()
    d.remove()
    const back = this.restore
    this.restore = undefined
    if (restore) back?.()
  }

  snapshot(): NewProcessSnapshot {
    const v = (f: string): string => this.dialog?.querySelector<HTMLInputElement>(`input[data-f="${f}"]`)?.value ?? ''
    const ask = this.dialog?.querySelector<HTMLElement>('.rg-np-ask:not([hidden]) .rg-np-q')
    return {
      open: this.isOpen, phase: this.phase, tier: this.dialog?.dataset.tier ?? this.host.tier(),
      name: v('name'), command: v('command'), cwd: this.cwd, ports: v('ports'), description: v('description'),
      env: this.envRows().map(r => {
        const value = r.querySelector<HTMLInputElement>('input[data-f="env-value"]')!
        return { name: r.querySelector<HTMLInputElement>('input[data-f="env-name"]')!.value, filled: value.value !== '', shown: value.type === 'text' }
      }),
      warning: this.dialog?.querySelector('.rg-np-warn')?.textContent ?? '',
      ...(this.error ? { error: this.error.text, errorField: this.error.field } : {}),
      ...(ask ? { question: ask.textContent ?? '' } : {}),
    }
  }

  // ---------------------------------------------------------------- drawing (once per opening)

  private head(): HTMLElement {
    const head = el('div', 'rg-cr-head')
    const t = el('h2', 'rg-cr-title')
    t.append(glyph('pulse', 'Novo processo'), el('span', '', 'Novo processo'))
    head.append(t, this.iconButton('close', 'x', 'Fechar sem criar (Esc)', 'rg-cr-x'))
    return head
  }

  private body(): HTMLElement {
    const body = el('div', 'rg-cr-body')
    const form = el('fieldset', 'rg-np-form')
    this.form = form
    form.append(
      this.field('name', 'Nome', this.textInput('name', 'Nome do processo', 'ex.: atrium-web')),
      this.field('command', 'Comando', this.textInput('command', 'Comando', 'ex.: npm run dev')),
      this.field('cwd', 'Pasta', this.folderButton()),
      this.field('ports', 'Portas (opcional)', this.textInput('ports', 'Portas', 'ex.: 3000, 5173')),
      this.field('description', 'Descrição (opcional)', this.textInput('description', 'Descrição', 'para que serve')),
      this.envField(),
    )
    const ask = el('div', 'rg-np-ask')
    ask.hidden = true
    ask.setAttribute('role', 'alertdialog')
    body.append(form, ask)
    return body
  }

  private foot(): HTMLElement {
    const foot = el('div', 'rg-cr-foot')
    foot.append(
      el('span', 'rg-cr-stay', 'Você continua na Regência'), el('span', 'rg-sp'),
      this.textButton('close', 'Cancelar', 'Fechar sem criar (Esc)'),
      this.textButton('create', 'Criar', 'Criar e iniciar o processo (Enter)', true),
    )
    return foot
  }

  private envField(): HTMLElement {
    const box = this.field('env', 'Variáveis de ambiente (opcional)')
    const warn = el('p', 'rg-np-warn')
    warn.setAttribute('role', 'note')
    const g = glyph('shield-warning', 'Aviso')
    g.setAttribute('aria-hidden', 'true')
    warn.append(g, el('span', '', ENV_WARNING))
    const rows = el('div', 'rg-np-envs')
    const add = el('button', 'rg-np-add')
    add.type = 'button'
    add.dataset.do = 'env-add'
    add.title = 'Mais uma variável'
    const pg = glyph('plus', 'Adicionar')
    pg.setAttribute('aria-hidden', 'true')
    add.append(pg, el('span', '', 'Variável'))
    box.append(warn, rows, add)
    return box
  }

  private envRow(): HTMLElement {
    const row = el('div', 'rg-np-env')
    const name = el('input', 'rg-np-en')
    name.type = 'text'
    name.dataset.f = 'env-name'
    name.placeholder = 'NOME'
    name.spellcheck = false
    name.autocomplete = 'off'
    name.setAttribute('aria-label', 'Nome da variável')
    const wrap = el('label', 'rg-cr-in rg-np-ev')
    const value = el('input')
    value.type = 'password'
    value.dataset.f = 'env-value'
    value.placeholder = 'valor'
    value.spellcheck = false
    // No autofill and no saved-password offer: this is not a login.
    value.setAttribute('autocomplete', 'new-password')
    value.setAttribute('aria-label', 'Valor da variável (não volta à tela depois de criar)')
    const show = this.iconButton('env-show', 'eye', 'Mostrar o valor enquanto edita', 'rg-np-show')
    show.setAttribute('aria-pressed', 'false')
    wrap.append(value, show)
    row.append(name, wrap, this.iconButton('env-del', 'trash', 'Apagar esta variável', 'rg-np-del'))
    return row
  }

  private field(name: string, label: string, ...content: HTMLElement[]): HTMLElement {
    const box = el('div', 'rg-cr-fl')
    box.dataset.field = name
    const lb = el('div', 'rg-cr-lb', label)
    lb.id = `rg-np-${name}-label`
    box.setAttribute('role', 'group')
    box.setAttribute('aria-labelledby', lb.id)
    box.append(lb, ...content)
    return box
  }

  private textInput(f: string, label: string, placeholder: string): HTMLElement {
    const wrap = el('label', 'rg-cr-in')
    const i = el('input')
    i.type = 'text'
    i.dataset.f = f
    i.placeholder = placeholder
    i.spellcheck = false
    i.autocomplete = 'off'
    i.setAttribute('aria-label', label)
    wrap.append(i)
    return wrap
  }

  private folderButton(): HTMLButtonElement {
    const b = el('button', 'rg-cr-val')
    b.type = 'button'
    b.dataset.do = 'folder'
    b.title = 'Escolher a pasta: projetos, recentes ou outra'
    this.paintFolder(b)
    return b
  }

  private paintFolder(b = this.dialog?.querySelector<HTMLButtonElement>('[data-do="folder"]') ?? undefined): void {
    if (!b) return
    const g = glyph('folder', 'Pasta')
    g.setAttribute('aria-hidden', 'true')
    const name = this.cwd ? this.cwd.split(/[\\/]/).filter(Boolean).pop() ?? this.cwd : 'Escolher pasta…'
    b.replaceChildren(g, el('span', 'rg-cr-vt', name))
    if (this.cwd) b.append(el('span', 'rg-cr-vd', this.cwd))
    b.append(glyph('caret-down', 'Escolher'))
    b.setAttribute('aria-label', this.cwd ? `Pasta: ${this.cwd}` : 'Escolher pasta')
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

  private textButton(action: string, label: string, tip: string, primary = false, danger = false): HTMLButtonElement {
    const b = el('button', `rg-cr-btn${primary ? ' pri' : ''}${danger ? ' danger' : ''}`, label)
    b.type = 'button'
    b.dataset.do = action
    b.title = tip
    return b
  }

  private envRows(): HTMLElement[] {
    return [...(this.dialog?.querySelectorAll<HTMLElement>('.rg-np-env') ?? [])]
  }

  // ---------------------------------------------------------------- the moves

  /** The form as typed, read from the inputs at this moment (the values included: the caller does not keep it). */
  private read(): NewProcForm {
    const v = (f: string): string => this.dialog?.querySelector<HTMLInputElement>(`input[data-f="${f}"]`)?.value ?? ''
    return {
      name: v('name'), command: v('command'), cwd: this.cwd, ports: v('ports'), description: v('description'),
      env: this.envRows().map(r => ({
        name: r.querySelector<HTMLInputElement>('input[data-f="env-name"]')!.value,
        value: r.querySelector<HTMLInputElement>('input[data-f="env-value"]')!.value,
      })),
    }
  }

  /** Every value input emptied and hidden again. */
  private clearValues(): void {
    for (const i of this.dialog?.querySelectorAll<HTMLInputElement>('input[data-f="env-value"]') ?? []) {
      i.value = ''
      this.hideValue(i)
    }
  }

  private hideValue(i: HTMLInputElement): void {
    i.type = 'password'
    const b = i.parentElement?.querySelector<HTMLElement>('[data-do="env-show"]')
    if (b) {
      b.setAttribute('aria-pressed', 'false')
      b.title = 'Mostrar o valor enquanto edita'
      b.setAttribute('aria-label', b.title)
      b.replaceChildren(glyph('eye', b.title))
    }
  }

  /** "Criar": checked field by field; a secret-looking name asks first; then the request goes. */
  private submit(confirmed: boolean): void {
    if (!this.dialog || this.phase === 'running' || this.picking) return
    const checked = checkNewProc(this.read(), this.host.existing())
    if (!checked.ok) { this.showError(checked.field, checked.error, checked.envIndex); return }
    if ((checked.secretNames.length > 0 || checked.commandSecret) && !confirmed) { this.ask(checked.secretNames, checked.commandSecret); return }
    void this.send(checked.request, checked.commandSecret)
  }

  private async send(request: NewProcRequest, commandSecret: boolean): Promise<void> {
    const typed = Object.values(request.recipe.env).some(v => v !== '')
    // The values leave the screen before the request goes; from here on only `request` (this call's) holds them. A secret
    // in the command line goes the same way: the field keeps the line with that part masked (sent again as it is, it is refused).
    this.clearValues()
    const cmd = this.dialog?.querySelector<HTMLInputElement>('input[data-f="command"]')
    if (commandSecret && cmd) cmd.value = maskedCommand(cmd.value)
    this.setPhase('running')
    let r: ProcCreate
    try {
      r = await this.host.create(request)
    } catch {
      r = { refusal: 'Não deu certo: o pedido não chegou ao tether.', code: 'unknown' }
    }
    if (!this.dialog) return
    if ('ok' in r) {
      const name = request.name
      this.close()
      this.host.created(name, r.failed)
      return
    }
    this.setPhase('edit')
    const again = (typed ? ' Os valores das variáveis foram apagados: digite-os de novo.' : '')
      + (commandSecret ? ` O trecho secreto do comando foi apagado (${VALUE_MASK}): digite-o de novo.` : '')
    this.showError((r.field ?? 'general') as NewProcField | 'general', r.refusal + again)
  }

  private ask(names: readonly string[], command: boolean): void {
    const box = this.dialog?.querySelector<HTMLElement>('.rg-np-ask')
    if (!box) return
    const text = secretQuestion(names, command)
    box.replaceChildren()
    const g = glyph('shield-warning', 'Atenção')
    g.setAttribute('aria-hidden', 'true')
    const q = el('p', 'rg-np-q', text)
    q.id = 'rg-np-q'
    box.setAttribute('aria-labelledby', q.id)
    const btns = el('div', 'rg-np-ask-b')
    btns.append(
      this.textButton('ask-go', 'Criar mesmo assim', names.length > 0 ? 'Criar com essas variáveis' : 'Criar com esse comando', false, true),
      this.textButton('ask-back', 'Voltar', 'Voltar ao formulário (Enter, Esc)', true),
    )
    box.append(g, q, btns)
    box.hidden = false
    this.setPhase('asking')
    btns.querySelector<HTMLElement>('[data-do="ask-back"]')?.focus()
  }

  private unask(): void {
    const box = this.dialog?.querySelector<HTMLElement>('.rg-np-ask')
    if (box) { box.hidden = true; box.replaceChildren() }
    this.setPhase('edit')
  }

  private setPhase(phase: 'edit' | 'asking' | 'running'): void {
    this.phase = phase
    const d = this.dialog
    if (!d) return
    d.dataset.phase = phase
    if (this.form) this.form.disabled = phase !== 'edit'
    for (const b of d.querySelectorAll<HTMLButtonElement>('.rg-cr-foot button')) b.disabled = phase !== 'edit'
    const create = d.querySelector<HTMLElement>('.rg-cr-foot [data-do="create"]')
    if (create) create.textContent = phase === 'running' ? 'Criando…' : 'Criar'
    d.querySelector('.rg-cr-body')?.setAttribute('aria-busy', String(phase === 'running'))
  }

  /** The working folder: the window's projects, the recent folders, then the system's picker (as "+ Novo"). */
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
    this.picking = true
    let got: string | undefined
    try {
      got = await this.host.pickList<string>({
        title: 'Pasta do processo', placeholder: 'Nome do projeto ou caminho', emptyText: 'Nenhum projeto', items: rows,
        create: q => (/[\\/]/.test(q.trim()) ? { value: q.trim(), label: `Usar ${q.trim()}`, icon: 'folder' } : undefined),
      })
      if (got === PICK) got = (await this.host.pickFolder(this.cwd || undefined)) ?? undefined
    } finally {
      this.picking = false
    }
    if (!this.dialog) return
    if (got) { this.cwd = got; this.paintFolder(); this.clearError() }
    this.dialog.querySelector<HTMLElement>('[data-do="folder"]')?.focus()
  }

  // ---------------------------------------------------------------- errors

  private showError(field: NewProcField | 'general', text: string, envIndex?: number): void {
    const d = this.dialog
    if (!d) return
    this.clearError()
    this.error = { field, text }
    const box = field === 'general' ? undefined : d.querySelector<HTMLElement>(`.rg-cr-fl[data-field="${field}"]`)
    const p = el('p', 'rg-cr-err', text)
    p.id = 'rg-np-err'
    p.setAttribute('role', 'alert')
    if (box) box.append(p)
    else d.querySelector('.rg-np-form')?.after(p)
    let target: HTMLInputElement | HTMLButtonElement | null | undefined
    if (field === 'env') {
      const row = this.envRows()[envIndex ?? 0]
      target = row?.querySelector<HTMLInputElement>('input[data-f="env-name"]')
    } else target = box?.querySelector<HTMLInputElement | HTMLButtonElement>('input, button')
    if (target) {
      target.setAttribute('aria-invalid', 'true')
      target.setAttribute('aria-describedby', p.id)
      target.focus()
    } else d.querySelector<HTMLElement>('[data-do="create"]')?.focus()
  }

  private clearError(): void {
    if (!this.error) return
    this.error = undefined
    for (const e of this.dialog?.querySelectorAll('.rg-cr-err') ?? []) e.remove()
    for (const i of this.dialog?.querySelectorAll('[aria-invalid]') ?? []) { i.removeAttribute('aria-invalid'); i.removeAttribute('aria-describedby') }
  }

  // ---------------------------------------------------------------- events

  private onClick(ev: MouseEvent): void {
    const t = ev.target instanceof Element ? ev.target.closest<HTMLElement>('[data-do]') : null
    if (!t || this.picking || (t instanceof HTMLButtonElement && t.disabled)) return
    switch (t.dataset.do) {
      case 'close': if (this.phase !== 'running') this.close(); return
      case 'create': this.submit(false); return
      case 'ask-back': this.unask(); this.dialog?.querySelector<HTMLElement>('[data-do="create"]')?.focus(); return
      case 'ask-go': this.unask(); this.submit(true); return
      case 'folder': void this.chooseFolder(); return
      case 'env-add': {
        const row = this.envRow()
        this.dialog?.querySelector('.rg-np-envs')?.append(row)
        row.querySelector<HTMLElement>('input')?.focus()
        return
      }
      case 'env-del': {
        const row = t.closest<HTMLElement>('.rg-np-env')
        if (!row) return
        const rows = this.envRows()
        const next = rows[rows.indexOf(row) + 1] ?? rows[rows.indexOf(row) - 1]
        const value = row.querySelector<HTMLInputElement>('input[data-f="env-value"]')
        if (value) value.value = ''
        row.remove()
        this.clearError()
        ;(next?.querySelector<HTMLElement>('input') ?? this.dialog?.querySelector<HTMLElement>('[data-do="env-add"]'))?.focus()
        return
      }
      case 'env-show': {
        const input = t.parentElement?.querySelector<HTMLInputElement>('input[data-f="env-value"]')
        if (!input) return
        if (input.type === 'text') { this.hideValue(input); input.focus(); return }
        input.type = 'text'
        t.setAttribute('aria-pressed', 'true')
        t.title = 'Esconder o valor'
        t.setAttribute('aria-label', t.title)
        t.replaceChildren(glyph('eye-closed', t.title))
        input.focus()
        return
      }
    }
  }

  /** "Mostrar" lasts while that value is being edited: the keyboard leaving the input and its eye hides it again. */
  private onFocusOut(ev: FocusEvent): void {
    const from = ev.target instanceof HTMLElement ? ev.target : null
    const wrap = from?.closest<HTMLElement>('.rg-np-ev')
    if (!wrap) return
    const to = ev.relatedTarget instanceof Node ? ev.relatedTarget : null
    if (to && wrap.contains(to)) return
    const input = wrap.querySelector<HTMLInputElement>('input[data-f="env-value"]')
    if (input?.type === 'text') this.hideValue(input)
  }

  private onKey(ev: KeyboardEvent): void {
    if (this.picking) return
    if (ev.key === 'Escape') {
      ev.preventDefault()
      ev.stopPropagation()
      if (this.phase === 'asking') { this.unask(); this.dialog?.querySelector<HTMLElement>('[data-do="create"]')?.focus() }
      else if (this.phase === 'edit') this.close()
      return
    }
    if (ev.key === 'Tab') { this.wrapTab(ev); return }
    if (ev.key !== 'Enter' || ev.shiftKey || ev.ctrlKey || ev.altKey || ev.metaKey) return
    const t = ev.target instanceof HTMLElement ? ev.target : null
    // A button answers Enter itself (its click); in a field, Enter is "Criar".
    if (!t || t.tagName === 'BUTTON') return
    ev.preventDefault()
    ev.stopPropagation()
    if (this.phase === 'edit') this.submit(false)
  }

  /** The keyboard stays in the card. */
  private wrapTab(ev: KeyboardEvent): void {
    const all = [...(this.dialog?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter(e => !e.closest('[hidden]') && !e.closest('fieldset:disabled'))
    if (all.length === 0) return
    const first = all[0]!
    const last = all[all.length - 1]!
    const at = document.activeElement
    if (ev.shiftKey && (at === first || !this.dialog?.contains(at))) { ev.preventDefault(); last.focus() }
    else if (!ev.shiftKey && (at === last || !this.dialog?.contains(at))) { ev.preventDefault(); first.focus() }
  }
}
