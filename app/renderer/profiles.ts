// Launch profiles in the UI: the grouped list of the manager (selects the profile being edited; the chooser of
// "Novo painel" / the empty pane has its own list, app/renderer/chooser.ts) and the manager itself
// (app/renderer/index.html #dlg-profiles): list on the left, one form on the right (name, agent, shell executable,
// args with a chips preview, env rows, default folder, default flag). Validation is the daemon's
// (src/core/profile.ts): every error it returns in Portuguese lands next to the field it is about; warnings do not block a save.
import { agentTable, agentUi, agentUiNames } from './agent-ui.ts'
import type { Profile, ProfileInput, SlotState } from '../../src/daemon/protocol.ts'
import type { ProfileAgent } from '../../src/core/profile.ts'
import type { ProfileDeleted, ProfileSaved } from '../shared/api.ts'
import { formatArgs, parseArgs } from './args.ts'
import { askDialog } from './dialog.ts'
import { icon, KIND_ICON } from './icons.ts'
import { UNSAFE_LABEL, UNSAFE_TOOLTIP } from './panel.ts'
import { deleteProfileSituation } from './situations.ts'

/** The agents in the profile manager's order: the extensions' (registration order), then the shell. */
export const agentOrder = (): ProfileAgent[] => [...agentUiNames(), 'shell']
export const AGENT_LABEL: Record<ProfileAgent, string> = agentTable('Shell', ui => ui.label, n => n)
const UNSAFE_ARG = '--dangerously-skip-permissions'

/** What the list shows for a profile's command line: shell profiles show the executable's args too. */
export function displayArgs(p: Profile): string[] {
  return p.agent === 'shell' && p.shell ? [...p.shell.args, ...p.args] : p.args
}

export function profileIsUnsafe(p: Profile): boolean {
  return p.args.includes(UNSAFE_ARG)
}

export function defaultOf(profiles: Profile[], agent: ProfileAgent): Profile | undefined {
  return profiles.find(p => p.agent === agent && p.default) ?? profiles.find(p => p.agent === agent)
}

interface GroupOptions {
  /** `radio`: a form group named `profile`; `select`: buttons, the selected one pressed (manager). */
  mode: 'radio' | 'select'
  selectedId?: string
  onPick(id: string): void
}

/** The profiles grouped by agent, each with its name, args (small, muted), default and unsafe marks. */
export function renderProfileGroups(host: HTMLElement, profiles: Profile[], opts: GroupOptions): void {
  host.replaceChildren()
  // Profiles of an agent with no AgentUi (its extension is off) still show, after the known ones.
  const order = agentOrder()
  const agents = [...order, ...new Set(profiles.map(p => p.agent).filter(a => !order.includes(a)))]
  for (const agent of agents) {
    const items = profiles.filter(p => p.agent === agent)
    if (items.length === 0) continue
    const group = document.createElement('div')
    group.className = 'profile-group'
    group.dataset.agent = agent
    const h = document.createElement('h4')
    h.append(icon(KIND_ICON[agent] ?? 'terminal-window'), document.createTextNode(AGENT_LABEL[agent]!))
    group.append(h)
    for (const p of items) {
      const row = opts.mode === 'radio' ? document.createElement('label') : document.createElement('button')
      row.className = 'profile-option'
      row.dataset.id = p.id
      row.dataset.agent = p.agent
      if (row instanceof HTMLButtonElement) {
        row.type = 'button'
        row.setAttribute('aria-pressed', String(p.id === opts.selectedId))
        if (p.id === opts.selectedId) row.classList.add('selected')
        row.addEventListener('click', () => opts.onPick(p.id))
      } else {
        const input = document.createElement('input')
        input.type = 'radio'; input.name = 'profile'; input.value = p.id
        input.checked = p.id === opts.selectedId
        input.addEventListener('change', () => { if (input.checked) opts.onPick(p.id) })
        row.append(input)
      }
      const ic = document.createElement('span'); ic.className = 'p-icon'; ic.append(icon(KIND_ICON[agent] ?? 'terminal-window'))
      const text = document.createElement('span'); text.className = 'p-text'
      const name = document.createElement('span'); name.className = 'p-name'; name.textContent = p.name
      if (p.default) { const d = document.createElement('span'); d.className = 'p-default'; d.textContent = 'padrão'; d.title = `Pré-selecionado para ${AGENT_LABEL[agent]} em Novo painel`; name.append(d) }
      text.append(name)
      const args = displayArgs(p)
      const a = document.createElement('span'); a.className = 'p-args'
      a.textContent = args.length ? formatArgs(args) : (p.agent === 'shell' && !p.shell ? 'shell padrão' : 'sem argumentos')
      if (args.length === 0) a.classList.add('none')
      if (args.length) a.title = formatArgs(args)
      text.append(a)
      row.append(ic, text)
      if (profileIsUnsafe(p)) {
        const u = document.createElement('span'); u.className = 'p-unsafe'; u.title = UNSAFE_TOOLTIP
        u.append(icon('shield-warning'), document.createTextNode(UNSAFE_LABEL))
        row.append(u)
      }
      group.append(row)
    }
    host.append(group)
  }
}

// ---------- the manager ----------

export interface ManagerHost {
  profiles(): Profile[]
  /** The file had to be repaired or had entries skipped: shown over the list. */
  problem(): string | undefined
  slots(): SlotState[]
  pickFolder(initial?: string): Promise<string | null>
  save(input: ProfileInput): Promise<ProfileSaved>
  delete(id: string): Promise<ProfileDeleted>
  /** After a save/delete without a daemon there is no `profiles` event: the host re-reads the list. */
  reload(): Promise<void>
}

type Field = 'name' | 'agent' | 'shell' | 'args' | 'env' | 'cwd' | 'general'

/** Which field a validator line (src/core/profile.ts, Portuguese) is about. */
export function fieldOfError(line: string): Field {
  if (/variável/i.test(line)) return 'env'
  if (/argumento|args /i.test(line)) return 'args'
  if (/precisa de um nome|já existe um perfil chamado/i.test(line)) return 'name'
  if (/agente/i.test(line)) return 'agent'
  if (/shell/i.test(line)) return 'shell'
  if (/cwd/i.test(line)) return 'cwd'
  return 'general'
}

/** The renderer's copy of the validator's one warning, so it shows while typing, not only after a save. */
export function envWarning(key: string): string | undefined {
  if (/^claude/i.test(key) && key !== 'CLAUDE_CONFIG_DIR') return `a variável ${key} pode impedir o Claude de gravar o transcript (o tether remove as CLAUDE* herdadas por isso)`
  return undefined
}

export class ProfileManager {
  private readonly dlg: HTMLDialogElement
  private readonly form: HTMLFormElement
  private readonly list: HTMLElement
  private readonly host: ManagerHost
  /** The profile being edited (id), or undefined for a new one. */
  private editing: string | undefined
  private savedTimer: ReturnType<typeof setTimeout> | undefined

  constructor(host: ManagerHost) {
    this.host = host
    this.dlg = document.getElementById('dlg-profiles') as HTMLDialogElement
    this.form = document.getElementById('form-profile') as HTMLFormElement
    this.list = document.getElementById('profiles-list') as HTMLElement
    this.wire()
  }

  get open(): boolean { return this.dlg.open }

  /** Opens on `id` (or the first profile; `'new'` starts a blank one). */
  show(id?: string): void {
    const profiles = this.host.profiles()
    if (id === 'new') this.startNew()
    else this.edit(profiles.find(p => p.id === id)?.id ?? this.editing ?? profiles[0]?.id)
    if (!this.dlg.open) this.dlg.showModal()
    this.field<HTMLInputElement>('name').focus()
  }

  close(): void { if (this.dlg.open) this.dlg.close() }

  /** The list changed (a `profiles` event or a reload): redraw it; the form keeps what is being typed. */
  refresh(): void {
    const profiles = this.host.profiles()
    renderProfileGroups(this.list, profiles, { mode: 'select', selectedId: this.editing, onPick: id => this.edit(id) })
    const problem = this.host.problem()
    let note = this.list.querySelector<HTMLElement>('.profiles-problem')
    if (problem) {
      if (!note) { note = document.createElement('p'); note.className = 'profiles-problem' }
      note.replaceChildren(icon('warning'), document.createTextNode(problem))
      this.list.prepend(note)
    }
    if (this.editing && !profiles.some(p => p.id === this.editing)) this.startNew()
  }

  // ---- form ----

  private field<T extends HTMLElement>(name: string): T {
    const el = this.form.elements.namedItem(name)
    if (!el) throw new Error(`campo ${name} não existe`)
    return el as unknown as T
  }

  private agent(): ProfileAgent {
    return ((new FormData(this.form).get('agent') as ProfileAgent | null) ?? agentOrder()[0]!)
  }

  private edit(id: string | undefined): void {
    const p = id ? this.host.profiles().find(x => x.id === id) : undefined
    if (!p) { this.startNew(); return }
    this.editing = p.id
    this.fill({
      id: p.id, name: p.name, agent: p.agent, args: displayArgs(p), env: p.env ?? {}, cwd: p.cwd ?? '',
      shell: p.agent === 'shell' && p.shell ? p.shell.command : '', default: !!p.default,
    })
    this.refresh()
  }

  private startNew(agent: ProfileAgent = agentOrder()[0]!): void {
    this.editing = undefined
    this.fill({ id: '', name: '', agent, args: [], env: {}, cwd: '', shell: '', default: false })
    this.refresh()
    this.field<HTMLInputElement>('name').focus()
  }

  private fill(v: { id: string; name: string; agent: ProfileAgent; args: string[]; env: Record<string, string>; cwd: string; shell: string; default: boolean }): void {
    this.clearErrors()
    this.field<HTMLInputElement>('id').value = v.id
    this.field<HTMLInputElement>('name').value = v.name
    this.renderAgentRadios(v.agent)
    for (const r of this.form.querySelectorAll<HTMLInputElement>('input[name=agent]')) r.checked = r.value === v.agent
    this.field<HTMLInputElement>('shell').value = v.shell
    this.field<HTMLInputElement>('args').value = formatArgs(v.args)
    this.field<HTMLInputElement>('cwd').value = v.cwd
    this.field<HTMLInputElement>('default').checked = v.default
    const env = document.getElementById('profile-env')!
    env.replaceChildren()
    for (const [k, val] of Object.entries(v.env)) this.addEnvRow(k, val)
    this.onAgentChange()
    this.previewArgs()
    this.previewEnv()
    const del = document.getElementById('btn-profile-delete') as HTMLButtonElement
    const dup = document.getElementById('btn-profile-duplicate') as HTMLButtonElement
    del.hidden = !v.id
    dup.hidden = !v.id
  }

  /** The agent options, from the AgentUi registry (plus the edited profile's agent when its extension is off). */
  private renderAgentRadios(current: ProfileAgent): void {
    const row = this.form.querySelector<HTMLElement>('.row.agents')!
    const names = agentOrder()
    if (!names.includes(current)) names.splice(names.length - 1, 0, current)
    if (row.dataset.agents === names.join(',')) return
    row.dataset.agents = names.join(',')
    row.replaceChildren(...names.map(name => {
      const label = document.createElement('label')
      const input = document.createElement('input')
      input.type = 'radio'
      input.name = 'agent'
      input.value = name
      label.append(input, ' ', icon(KIND_ICON[name] ?? 'terminal-window'), ` ${AGENT_LABEL[name]}`)
      return label
    }))
  }

  private onAgentChange(): void {
    const agent = this.agent()
    for (const el of this.form.querySelectorAll<HTMLElement>('[data-only]')) el.hidden = el.dataset.only !== agent
    document.getElementById('profile-default-label')!.textContent = `Perfil padrão de ${AGENT_LABEL[agent]} (pré-selecionado em Novo painel)`
    this.field<HTMLInputElement>('args').placeholder = agent === 'shell' ? '--login -i' : agentUi(agent)?.argsPlaceholder ?? ''
  }

  private previewArgs(): void {
    const chips = document.getElementById('profile-args-preview')!
    const args = parseArgs(this.field<HTMLInputElement>('args').value)
    chips.replaceChildren()
    for (const a of args) {
      const c = document.createElement('span'); c.className = 'chip'; c.textContent = a
      if (a === UNSAFE_ARG) { c.classList.add('unsafe'); c.title = UNSAFE_TOOLTIP; c.prepend(icon('shield-warning')) }
      chips.append(c)
    }
    chips.hidden = args.length === 0
  }

  private addEnvRow(key = '', value = ''): HTMLElement {
    const rows = document.getElementById('profile-env')!
    const row = document.createElement('div'); row.className = 'env-row'
    const k = document.createElement('input'); k.type = 'text'; k.className = 'env-key'; k.placeholder = 'NOME'; k.value = key; k.spellcheck = false; k.setAttribute('aria-label', 'Nome da variável')
    const eq = document.createElement('span'); eq.className = 'eq'; eq.textContent = '='
    const v = document.createElement('input'); v.type = 'text'; v.className = 'env-value'; v.placeholder = 'valor'; v.value = value; v.spellcheck = false; v.setAttribute('aria-label', 'Valor da variável')
    const rm = document.createElement('button'); rm.type = 'button'; rm.className = 'env-remove'; rm.title = 'Remover variável'; rm.setAttribute('aria-label', 'Remover variável'); rm.append(icon('minus'))
    rm.addEventListener('click', () => { row.remove(); this.previewEnv() })
    k.addEventListener('input', () => this.previewEnv())
    row.append(k, eq, v, rm)
    rows.append(row)
    return row
  }

  private envEntries(): Array<[string, string]> {
    const out: Array<[string, string]> = []
    for (const row of this.form.querySelectorAll<HTMLElement>('.env-row')) {
      const k = row.querySelector<HTMLInputElement>('.env-key')!.value.trim()
      const v = row.querySelector<HTMLInputElement>('.env-value')!.value
      if (k || v) out.push([k, v])
    }
    return out
  }

  /** The CLAUDE_* warning, live (the daemon repeats it on save). */
  private previewEnv(): void {
    const warn = this.form.querySelector<HTMLElement>('.field-warning[data-for=env]')!
    const lines = this.envEntries().map(([k]) => envWarning(k)).filter((w): w is string => !!w)
    warn.textContent = lines.join('\n')
    warn.hidden = lines.length === 0
  }

  private readForm(): ProfileInput {
    const agent = this.agent()
    const args = parseArgs(this.field<HTMLInputElement>('args').value)
    const env: Record<string, string> = {}
    for (const [k, v] of this.envEntries()) env[k] = v
    const input: ProfileInput = { name: this.field<HTMLInputElement>('name').value, agent, args }
    const id = this.field<HTMLInputElement>('id').value
    if (id) input.id = id
    if (Object.keys(env).length) input.env = env
    const cwd = this.field<HTMLInputElement>('cwd').value.trim()
    if (cwd) input.cwd = cwd
    if (agent === 'shell') {
      const command = this.field<HTMLInputElement>('shell').value.trim()
      // The executable's args and the profile's are one list for the user; they all go with the executable.
      if (command) { input.shell = { command, args }; input.args = [] }
    }
    if (this.field<HTMLInputElement>('default').checked) input.default = true
    return input
  }

  private clearErrors(): void {
    for (const el of this.form.querySelectorAll<HTMLElement>('.field-error')) { el.textContent = ''; el.hidden = true }
    for (const el of this.form.querySelectorAll<HTMLElement>('.field.invalid')) el.classList.remove('invalid')
    document.getElementById('profile-saved')!.hidden = true
  }

  private showErrors(message: string): void {
    this.clearErrors()
    const byField = new Map<Field, string[]>()
    for (const line of message.split('\n').map(l => l.trim()).filter(Boolean)) {
      const f = fieldOfError(line)
      byField.set(f, [...(byField.get(f) ?? []), line])
    }
    let first: HTMLElement | undefined
    for (const [f, lines] of byField) {
      const el = this.form.querySelector<HTMLElement>(`.field-error[data-for=${f}]`)!
      el.textContent = lines.join('\n')
      el.hidden = false
      const field = el.closest<HTMLElement>('.field')
      field?.classList.add('invalid')
      const input = field?.querySelector<HTMLElement>('input:not([type=hidden])')
      if (!first && input) first = input
    }
    first?.focus()
  }

  private async save(): Promise<void> {
    const input = this.readForm()
    const r = await this.host.save(input)
    if (!r.ok) { this.showErrors(r.message); return }
    this.clearErrors()
    this.editing = r.profile.id
    await this.host.reload()
    this.edit(r.profile.id)
    const warn = this.form.querySelector<HTMLElement>('.field-warning[data-for=env]')!
    if (r.warnings.length) { warn.textContent = r.warnings.join('\n'); warn.hidden = false }
    const saved = document.getElementById('profile-saved')!
    saved.hidden = false
    if (this.savedTimer) clearTimeout(this.savedTimer)
    this.savedTimer = setTimeout(() => { saved.hidden = true }, 2500)
  }

  private duplicate(): void {
    const src = this.readForm()
    this.editing = undefined
    this.fill({
      id: '', name: `${src.name.trim()} (cópia)`, agent: src.agent, args: src.shell ? src.shell.args : src.args, env: src.env ?? {},
      cwd: src.cwd ?? '', shell: src.shell?.command ?? '', default: false,
    })
    this.refresh()
    this.field<HTMLInputElement>('name').focus()
  }

  private async remove(): Promise<void> {
    const id = this.editing
    const p = id ? this.host.profiles().find(x => x.id === id) : undefined
    if (!p) return
    const users = this.host.slots().filter(s => s.profileId === p.id)
    const answer = await askDialog(deleteProfileSituation(p, users))
    if (answer.choice !== 'delete') return
    const r = await this.host.delete(p.id)
    if (!r.ok) { this.showErrors(r.message); return }
    await this.host.reload()
    this.editing = undefined
    this.refresh()
    const next = this.host.profiles().find(x => x.agent === p.agent) ?? this.host.profiles()[0]
    this.edit(next?.id)
  }

  private wire(): void {
    document.getElementById('btn-profiles-close')!.addEventListener('click', () => this.close())
    document.getElementById('btn-profile-new')!.addEventListener('click', () => this.startNew(this.agent()))
    document.getElementById('btn-profile-duplicate')!.addEventListener('click', () => this.duplicate())
    document.getElementById('btn-profile-delete')!.addEventListener('click', () => { void this.remove() })
    document.getElementById('btn-profile-env-add')!.addEventListener('click', () => { this.addEnvRow().querySelector<HTMLInputElement>('.env-key')!.focus() })
    document.getElementById('btn-profile-cwd-browse')!.addEventListener('click', async () => {
      const input = this.field<HTMLInputElement>('cwd')
      const picked = await this.host.pickFolder(input.value.trim() || undefined)
      if (picked) input.value = picked
    })
    // The radios are rebuilt from the AgentUi registry (renderAgentRadios): listen on their row.
    this.form.querySelector<HTMLElement>('.row.agents')!.addEventListener('change', ev => { if ((ev.target as HTMLInputElement).name === 'agent') this.onAgentChange() })
    this.field<HTMLInputElement>('args').addEventListener('input', () => this.previewArgs())
    this.form.addEventListener('submit', ev => { ev.preventDefault(); void this.save() })
    this.form.addEventListener('keydown', ev => { if (ev.key === 'Enter' && ev.ctrlKey) { ev.preventDefault(); void this.save() } })
    // Esc: the browser raises `cancel`; the dialog closes but stays in the DOM for the next time.
    this.dlg.addEventListener('cancel', ev => { ev.preventDefault(); this.close() })
  }
}
