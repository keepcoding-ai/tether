// "Novo processo" from afar (RR5 5.5, fio-spec 18), on screen: the form of the app's card (the look of "+ Novo": a modal
// <dialog>, the whole screen on the phone, a dialog of contained width elsewhere, walked by arrows on the TV) with name,
// command, folder (from the list the tether knows), ports, description and environment variables, over the rules of
// new-proc-afar-rules.ts. At "Criar" it says what is going to run and that the biometrics are asked, then asks them for
// this very act (a command on the machine is proved by the act, fio-spec 18), and the request goes.
//
// The values of the variables (the secret boundary):
// - they live only in the `value` of their password inputs while the person types: never in a field of this class, a
//   `data-*`, an attribute, the URL, the browser's storage, a draft, the persisted outbox, a log or a snapshot;
// - at "Criar" the body is built from the inputs for the one call that sends it, every value input is emptied at once, and
//   the act's queue (manage.ts, in memory) holds the bytes only until the answer; a refusal asks to type them again;
// - a name or a value that looks like a secret is barred before anything goes, with the advice and no "create anyway".
import { el, glyph } from '../../../extensions/regency/renderer/columns.ts'
import type { Tier } from '../../../extensions/regency/renderer/layout-rules.ts'
import { createOptionsView, type CreateOptions } from '../../../src/remote/create.ts'
import { walkBoxByArrows } from './box-keys.ts'
import { foldersOf, defaultFolderOf } from './create-afar-rules.ts'
import type { Manager } from './manage.ts'
import { PROOF_LINE, PROVING, refusalWords } from './manage-rules.ts'
import { afarProcRefusal, checkAfarProc, ENV_WARNING, runLine, type AfarProcField } from './new-proc-afar-rules.ts'
import { pickList } from './sheet.ts'

export interface NewProcAfarDeps {
  manager: Manager
  tier(): Tier
  /** The Regency's brief notice. */
  say(text: string): void
}

/** What the E2E reads: the fields that are not secret, and of each variable its name and whether a value is typed. */
export interface NewProcAfarSnapshot {
  open: boolean
  phase: 'edit' | 'running'
  warning: string
  error?: string
  errorField?: string
  env: { name: string; filled: boolean }[]
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled])'

export class NewProcAfar {
  private readonly d: NewProcAfarDeps
  private dialog: HTMLDialogElement | undefined
  private folder = ''
  private options: CreateOptions | undefined
  private restore: (() => void) | undefined
  private phase: 'edit' | 'running' = 'edit'
  private picking = false
  private error: { field: string; text: string } | undefined

  constructor(d: NewProcAfarDeps) { this.d = d }

  get isOpen(): boolean { return this.dialog !== undefined }

  /** Opens the form: the folders the tether knows are read first (never a path). */
  async open(restore: () => void): Promise<void> {
    if (this.dialog || !this.d.manager.caps.procs) { restore(); return }
    const r = await this.d.manager.read('create.options', {})
    if (!r.ok) { this.d.say(refusalWords(r.code)); restore(); return }
    this.options = createOptionsView(r.body)
    this.folder = defaultFolderOf(this.options) ?? ''
    this.restore = restore
    this.phase = 'edit'
    this.error = undefined
    const d = el('dialog', 'rg-cr rg-np')
    d.setAttribute('aria-modal', 'true')
    d.setAttribute('aria-label', 'Novo processo')
    d.dataset.tier = this.d.tier()
    d.addEventListener('keydown', ev => this.onKey(ev))
    d.addEventListener('cancel', ev => ev.preventDefault())
    d.addEventListener('click', ev => this.onClick(ev))
    d.addEventListener('input', () => this.clearError())
    d.append(this.head(), this.body(), this.foot())
    document.body.append(d)
    this.dialog = d
    walkBoxByArrows(d, () => this.d.tier() === 'wide')
    d.showModal()
    d.querySelector<HTMLElement>('input[data-f="name"]')?.focus()
  }

  /** Closes the form: every input goes with the dialog (values included); the keyboard goes back. */
  close(restore = true): void {
    const d = this.dialog
    if (!d) return
    this.clearValues()
    this.dialog = undefined
    this.error = undefined
    if (d.open) d.close()
    d.remove()
    const back = this.restore
    this.restore = undefined
    if (restore) back?.()
  }

  snapshot(): NewProcAfarSnapshot {
    return {
      open: this.isOpen, phase: this.phase, warning: this.dialog?.querySelector('.rg-np-warn')?.textContent ?? '',
      ...(this.error ? { error: this.error.text, errorField: this.error.field } : {}),
      env: this.envRows().map(r => ({ name: r.querySelector<HTMLInputElement>('input[data-f="env-name"]')!.value, filled: r.querySelector<HTMLInputElement>('input[data-f="env-value"]')!.value !== '' })),
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
    form.append(
      this.field('name', 'Nome', this.textInput('name', 'Nome do processo', 'ex.: atrium-web')),
      this.field('command', 'Comando', this.textInput('command', 'Comando', 'ex.: npm run dev')),
      this.field('cwd', 'Pasta', this.folderButton()),
      this.field('ports', 'Portas (opcional)', this.textInput('ports', 'Portas', 'ex.: 3000, 5173')),
      this.field('description', 'Descrição (opcional)', this.textInput('description', 'Descrição', 'para que serve')),
      this.envField(),
    )
    const run = el('div', 'rg-np-run')
    run.setAttribute('role', 'status')
    run.hidden = true
    body.append(form, run)
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
    // No autofill and no saved-password offer: this is not a login, and the browser keeps nothing of it.
    value.setAttribute('autocomplete', 'new-password')
    value.setAttribute('aria-label', 'Valor da variável (não volta à tela depois de criar)')
    wrap.append(value)
    row.append(name, wrap, this.iconButton('env-del', 'trash', 'Apagar esta variável', 'rg-np-del'))
    return row
  }

  private field(name: string, label: string, ...content: HTMLElement[]): HTMLElement {
    const box = el('div', 'rg-cr-fl')
    box.dataset.field = name
    const lb = el('div', 'rg-cr-lb', label)
    lb.id = `rg-npa-${name}-label`
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

  private folderLabel(): string | undefined { return this.options?.folders.find(f => f.id === this.folder)?.label }

  private folderButton(): HTMLButtonElement {
    const b = el('button', 'rg-cr-val')
    b.type = 'button'
    b.dataset.do = 'folder'
    b.title = 'Escolher a pasta: projetos e recentes'
    this.paintFolder(b)
    return b
  }

  private paintFolder(b = this.dialog?.querySelector<HTMLButtonElement>('[data-do="folder"]') ?? undefined): void {
    if (!b) return
    const g = glyph('folder', 'Pasta')
    g.setAttribute('aria-hidden', 'true')
    const label = this.folderLabel()
    b.replaceChildren(g, el('span', 'rg-cr-vt', label ?? 'Escolher pasta…'), glyph('caret-down', 'Escolher'))
    b.setAttribute('aria-label', label ? `Pasta: ${label}` : 'Escolher pasta')
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

  private envRows(): HTMLElement[] { return [...(this.dialog?.querySelectorAll<HTMLElement>('.rg-np-env') ?? [])] }

  private v(f: string): string { return this.dialog?.querySelector<HTMLInputElement>(`input[data-f="${f}"]`)?.value ?? '' }

  /** Every value input emptied. */
  private clearValues(): void {
    for (const i of this.dialog?.querySelectorAll<HTMLInputElement>('input[data-f="env-value"]') ?? []) i.value = ''
  }

  // ---------------------------------------------------------------- the moves

  /** "Criar": checked field by field (a secret barred); then the sentence of what runs, the biometrics, the request. */
  private async submit(): Promise<void> {
    if (!this.dialog || this.phase !== 'edit' || this.picking) return
    const existing = (this.d.manager.procs() ?? []).map(p => p.name)
    // The form as typed at this moment, values included, for this call only.
    const checked = checkAfarProc({
      name: this.v('name'), command: this.v('command'), folder: this.folder, ports: this.v('ports'), description: this.v('description'),
      env: this.envRows().map(r => ({ name: r.querySelector<HTMLInputElement>('input[data-f="env-name"]')!.value, value: r.querySelector<HTMLInputElement>('input[data-f="env-value"]')!.value })),
    }, existing)
    if (!checked.ok) { this.showError(checked.field, checked.error, checked.envIndex); return }
    const typed = (checked.body.env ?? []).length > 0
    // The values leave the screen before the request goes.
    this.clearValues()
    this.setPhase('running')
    const run = this.dialog.querySelector<HTMLElement>('.rg-np-run')
    if (run) {
      run.replaceChildren(el('span', '', runLine(checked.body, this.folderLabel())), el('b', '', PROOF_LINE))
      run.hidden = false
    }
    const r = await this.d.manager.act('procs.new', checked.body as unknown as Record<string, unknown>, {
      proof: 'act',
      proving: () => { if (run) run.lastElementChild!.textContent = PROVING },
    })
    if (!this.dialog) return
    if (r.ok) {
      const name = checked.body.name
      const status = r.body.proc && typeof r.body.proc === 'object' ? (r.body.proc as { status?: unknown }).status : undefined
      this.close()
      this.d.say(status === 'failed' ? `O processo ${name} foi criado, mas não subiu.` : `Processo ${name} criado.`)
      void this.d.manager.readProcs()
      return
    }
    if (run) run.hidden = true
    this.setPhase('edit')
    const refusal = afarProcRefusal(r.code, r.body, refusalWords)
    this.showError(refusal.field ?? 'general', refusal.text + (typed ? ' Os valores das variáveis foram apagados: digite-os de novo.' : ''))
  }

  private setPhase(phase: 'edit' | 'running'): void {
    this.phase = phase
    const d = this.dialog
    if (!d) return
    d.dataset.phase = phase
    const form = d.querySelector<HTMLFieldSetElement>('.rg-np-form')
    if (form) form.disabled = phase !== 'edit'
    for (const b of d.querySelectorAll<HTMLButtonElement>('.rg-cr-foot button')) b.disabled = phase !== 'edit'
    const create = d.querySelector<HTMLElement>('.rg-cr-foot [data-do="create"]')
    if (create) create.textContent = phase === 'running' ? 'Criando…' : 'Criar'
    d.querySelector('.rg-cr-body')?.setAttribute('aria-busy', String(phase === 'running'))
  }

  private async chooseFolder(): Promise<void> {
    const rows = foldersOf(this.options ?? { engines: [], profiles: [], desks: [], folders: [] })
      .map(f => ({ value: f.value, label: f.label, icon: f.recent ? 'clock-counter-clockwise' : 'folder', group: f.recent ? 'Recentes' : 'Projetos' }))
    this.picking = true
    let got: string | undefined
    try {
      got = await pickList<string>(this.d.tier(), { title: 'Pasta do processo', placeholder: 'Nome do projeto', emptyText: 'O tether não conhece nenhuma pasta ainda', items: rows })
    } finally { this.picking = false }
    if (!this.dialog) return
    if (got) { this.folder = got; this.paintFolder(); this.clearError() }
    this.dialog.querySelector<HTMLElement>('[data-do="folder"]')?.focus()
  }

  // ---------------------------------------------------------------- errors

  private showError(field: AfarProcField | 'general', text: string, envIndex?: number): void {
    const d = this.dialog
    if (!d) return
    this.clearError()
    this.error = { field, text }
    const box = field === 'general' ? undefined : d.querySelector<HTMLElement>(`.rg-cr-fl[data-field="${field}"]`)
    const p = el('p', 'rg-cr-err', text)
    p.id = 'rg-npa-err'
    p.setAttribute('role', 'alert')
    if (box) box.append(p)
    else d.querySelector('.rg-np-form')?.after(p)
    const target = field === 'env'
      ? this.envRows()[envIndex ?? 0]?.querySelector<HTMLInputElement>('input[data-f="env-name"]')
      : box?.querySelector<HTMLInputElement | HTMLButtonElement>('input, button')
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
      case 'create': void this.submit(); return
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
      }
    }
  }

  private onKey(ev: KeyboardEvent): void {
    if (this.picking) return
    if (ev.key === 'Escape' || ev.key === 'GoBack' || ev.key === 'BrowserBack') {
      ev.preventDefault()
      ev.stopPropagation()
      if (this.phase === 'edit') this.close()
      return
    }
    if (ev.key === 'Tab') { this.wrapTab(ev); return }
    if (ev.key !== 'Enter' || ev.shiftKey || ev.ctrlKey || ev.altKey || ev.metaKey) return
    const t = ev.target instanceof HTMLElement ? ev.target : null
    // A button answers Enter itself (its click); in a field, Enter is "Criar".
    if (!t || t.tagName === 'BUTTON') return
    ev.preventDefault()
    ev.stopPropagation()
    void this.submit()
  }

  /** The keyboard stays in the form. */
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
