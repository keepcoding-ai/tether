// "Sistema" in the Regency's right column: the back button, the five sections as tabs (Processos, Ronda, Perfis, Projetos,
// Ajustes) and the rows of the open one, drawn from the pure model (system-rules.ts). A repaint never destroys: each row is
// kept by its key and only its head is drawn again; a row's open panel (a form, the in-use refusal, a question) is the same
// element before and after, so its fields keep their text, caret and focus; the body's scroll is untouched; the button with
// the keyboard is found again by its key. Values of environment variables never reach this file: profiles show names only.
import type { IdentityInput } from '../../../app/renderer/agent-identity.ts'
import { identityView } from '../../../app/renderer/agent-identity.ts'
import type { ContextMenuEntry, RondaAnswer, RondaChange } from '../../../app/renderer/ext-api.ts'
import type { GuardedOptions, ProcAct } from '../../processes/embed.ts'
import {
  SYSTEM_SECTIONS, forceReasonError, intervalWords, refusalText, type InUseRefusal, type ProcRow, type ProfileRow, type ProjectRow,
  type RondaRow, type SettingsItem, type SystemModel, type SystemSection,
} from '../system-rules.ts'
import { el, glyph } from './columns.ts'

/** What the view asks of the Regency (renderer.ts gives it). */
export interface SystemViewHost {
  model(): SystemModel
  /** The processes extension is on (its feed publishes). */
  procsActive(): boolean
  identity(paneId: string): IdentityInput | undefined
  proc(act: 'start' | 'stop' | 'restart' | 'hold' | 'release', name: string, opts?: GuardedOptions): Promise<ProcAct>
  /** The record in the quick view (no tab). */
  peekLog(name: string): ProcAct
  /** The record as a tab on a desk, chosen among the awake ones; the person stays where she is. */
  logOnDesk(name: string): Promise<ProcAct | undefined>
  /** Someone looked at the marked processes: their attention goes (the red dot with it). */
  seen(name: string): void
  setRonda(agentId: string, change: RondaChange): Promise<RondaAnswer>
  offRonda(agentId: string, force: boolean): Promise<RondaAnswer>
  /** The core's profile editor. */
  editProfile(id: string | 'new', duplicate?: boolean): void
  /** The "+ Novo" card with the folder filled; `restore` gives the keyboard back when it closes with nothing made. */
  createHere(what: 'agent' | 'terminal', cwd: string, restore: () => void): void
  togglePin(path: string): void
  openScreen(screenType: string): void
  /** Opens a status icon's popover; false when the icon is not drawn. */
  showStatus(id: 'bridge' | 'sync'): boolean
  menu(x: number, y: number, entries: ContextMenuEntry[]): void
  /** The view ticks while shown (the "há 4 min" age): one clock, only then. */
  tick(): void
}

/** What the pane gives: going back to the tree and choosing a section (both kept in the layout). */
export interface SystemNav {
  back(): void
  select(section: SystemSection): void
}

/** The ronda's intervals the form offers (the daemon takes `10m`, `1h`...). */
const INTERVALS: readonly string[] = ['5m', '10m', '15m', '20m', '30m', '1h', '2h']
const DEFAULT_INTERVAL = '20m'
const CLOCK_MS = 30_000

const SECTION_ICON: Record<SystemSection, string> = {
  processes: 'pulse', ronda: 'timer', profiles: 'sliders-horizontal', projects: 'folder', settings: 'gear-six',
}

const SETTINGS_ICON: Record<SettingsItem['id'], string> = {
  settings: 'gear-six', extensions: 'puzzle-piece', keybindings: 'keyboard', bridge: 'brand', sync: 'arrows-clockwise',
}

/** A row's colour by intent: running is ok, a fall or a failure is bad, stopping is a warning, the rest is quiet. */
function procIntent(r: ProcRow): 'ok' | 'warn' | 'bad' | 'off' {
  if (r.status === 'running') return 'ok'
  if (r.status === 'stopping') return 'warn'
  if (r.attention || r.status === 'failed' || r.status === 'host-lost') return 'bad'
  if (r.status === 'exited' && !/código 0/.test(r.stateText)) return 'bad'
  return 'off'
}

interface Act { id: string; icon: string; tip: string; label?: string; danger?: boolean }

function button(act: Act, key: string): HTMLButtonElement {
  const b = el('button', act.label ? 'rg-sys-btn' : 'rg-sys-ib')
  b.type = 'button'
  b.dataset.sys = act.id
  b.dataset.key = key
  b.title = act.tip
  b.setAttribute('aria-label', act.tip)
  if (act.danger) b.classList.add('danger')
  const g = glyph(act.icon, act.tip)
  g.removeAttribute('title')
  g.removeAttribute('role')
  g.removeAttribute('aria-label')
  g.setAttribute('aria-hidden', 'true')
  b.append(g)
  if (act.label) b.append(el('span', '', act.label))
  return b
}

function chip(text: string, cls = '', tip?: string): HTMLElement {
  const c = el('span', `rg-sr-c${cls ? ` ${cls}` : ''}`, text)
  c.title = tip ?? text
  return c
}

/** One row kept across repaints: its element, the head drawn each time, and the panel below it while one is open. */
interface KeptRow { el: HTMLElement; head: HTMLElement; panel?: HTMLElement }

export class SystemView {
  readonly element: HTMLElement
  private readonly host: SystemViewHost
  private readonly nav: SystemNav
  private readonly tabs = el('div', 'rg-sys-tabs')
  private readonly body = el('div', 'rg-sys-body')
  private readonly foot = el('div', 'rg-sys-foot')
  private section: SystemSection = 'processes'
  private signature = ''
  private model: SystemModel | undefined
  private rows = new Map<string, KeptRow>()
  /** Rows waiting for an answer (their buttons are off meanwhile). */
  private busy = new Set<string>()
  /** The marked processes already told as seen (asked once until the mark goes). */
  private told = new Set<string>()
  private shown = false
  private clock: ReturnType<typeof setInterval> | undefined
  /** Repaints so far (the E2E proves a repaint happened without losing a field). */
  paints = 0

  constructor(host: SystemViewHost, nav: SystemNav) {
    this.host = host
    this.nav = nav
    this.element = el('div', 'rg-sys')
    this.element.setAttribute('aria-label', 'Sistema')
    const head = el('div', 'rg-sys-hd')
    const back = el('button', 'rg-sys-back')
    back.type = 'button'
    back.dataset.sys = 'back'
    back.title = 'Voltar ao tether: a árvore das mesas e guias'
    back.setAttribute('aria-label', 'Voltar ao tether')
    const arrow = glyph('arrow-left', 'Voltar')
    arrow.setAttribute('aria-hidden', 'true')
    back.append(arrow, el('span', '', 'voltar ao tether'))
    head.append(back, el('span', 'rg-sp'), el('b', 'rg-sys-t', 'Sistema'))
    this.tabs.setAttribute('role', 'tablist')
    this.tabs.setAttribute('aria-label', 'Seções do Sistema')
    for (const s of SYSTEM_SECTIONS) {
      const b = el('button', 'rg-sys-tab')
      b.type = 'button'
      b.dataset.sys = 'tab'
      b.dataset.section = s.id
      b.dataset.key = `tab:${s.id}`
      b.setAttribute('role', 'tab')
      b.title = s.label
      const g = glyph(SECTION_ICON[s.id], s.label)
      g.setAttribute('aria-hidden', 'true')
      const dot = el('span', 'rg-sys-dot')
      dot.hidden = true
      b.append(g, el('span', 'rg-sys-tab-t', s.label), dot)
      this.tabs.append(b)
    }
    this.body.setAttribute('role', 'tabpanel')
    this.element.append(head, this.tabs, this.body, this.foot)
    this.element.addEventListener('click', ev => this.onClick(ev))
    this.element.addEventListener('keydown', ev => this.onKey(ev))
  }

  get sectionShown(): SystemSection { return this.section }

  /** On screen or not (the column shows "Sistema" and the Regency is the visible desk): the one clock runs only while shown. */
  setShown(on: boolean): void {
    if (this.shown === on) return
    this.shown = on
    if (on && !this.clock) this.clock = setInterval(() => this.host.tick(), CLOCK_MS)
    if (!on && this.clock) { clearInterval(this.clock); this.clock = undefined }
  }

  dispose(): void { this.setShown(false) }

  /** The keyboard on the open section's tab (the column was just swapped). */
  focusTab(): void {
    this.tabs.querySelector<HTMLElement>(`[data-section="${this.section}"]`)?.focus({ preventScroll: true })
  }

  /** Draws `section` from the model; nothing changes on screen when the model of the section did not. */
  paint(section: SystemSection, model: SystemModel): void {
    if (section !== this.section) {
      this.section = section
      this.rows.clear()
      this.busy.clear()
      this.body.replaceChildren()
      this.body.scrollTop = 0
      this.signature = ''
    }
    this.model = model
    this.paintTabs(model)
    if (this.shown && section === 'processes') this.markSeen(model)
    const active = this.host.procsActive()
    const sig = `${section}|${active}|${[...this.busy].join(',')}|${JSON.stringify(this.sectionData(section, model))}`
    if (sig === this.signature) return
    this.signature = sig
    this.paints++
    this.keepFocus(() => this.paintBody(section, model, active))
  }

  /** Forces the next paint (a row's panel changed). */
  private dirty(): void {
    this.signature = ''
    if (this.model) this.paint(this.section, this.host.model())
  }

  private sectionData(section: SystemSection, m: SystemModel): unknown {
    switch (section) {
      case 'processes': return [m.processes, m.procFoot]
      case 'ronda': return m.ronda
      case 'profiles': return m.profiles
      case 'projects': return m.projects
      case 'settings': return m.settings
    }
  }

  private markSeen(model: SystemModel): void {
    const marked = new Set(model.processes.filter(p => p.attention).map(p => p.name))
    for (const n of [...this.told]) if (!marked.has(n)) this.told.delete(n)
    for (const n of marked) if (!this.told.has(n)) { this.told.add(n); this.host.seen(n) }
  }

  private paintTabs(model: SystemModel): void {
    for (const b of this.tabs.querySelectorAll<HTMLElement>('.rg-sys-tab')) {
      const id = b.dataset.section as SystemSection
      const on = id === this.section
      if (b.getAttribute('aria-selected') !== String(on)) b.setAttribute('aria-selected', String(on))
      b.tabIndex = on ? 0 : -1
      const row = model.sections.find(s => s.id === id)
      const dot = b.querySelector<HTMLElement>('.rg-sys-dot')!
      dot.hidden = !row?.dot
      dot.title = row?.dot ? model.dot.tooltip : ''
      b.title = row?.dot ? `${row.label}: ${model.dot.tooltip}` : row?.label ?? b.title
    }
  }

  private paintBody(section: SystemSection, m: SystemModel, active: boolean): void {
    const want: { key: string; draw: (head: HTMLElement, key: string) => void; cls: string }[] = []
    let empty: string | undefined
    const foot: (HTMLElement | string)[] = []
    if (section === 'processes') {
      if (!active) empty = 'A extensão Processos está desligada: ligue-a em Ajustes › Extensões para ver os processos.'
      else {
        if (m.processes.length === 0) empty = 'Nenhum processo'
        for (const r of m.processes) want.push({ key: `proc:${r.name}`, cls: 'proc', draw: (h, k) => this.procHead(h, k, r) })
        if (m.processes.length > 0) foot.push(m.procFoot)
        foot.push(el('span', 'rg-sys-note', 'Processos novos nascem pela linha de comando: tether proc start <nome> -- <comando>.'))
      }
    } else if (section === 'ronda') {
      if (m.ronda.length === 0) empty = 'Nenhum agente vivo para ter ronda'
      for (const r of m.ronda) want.push({ key: `ronda:${r.agentId}`, cls: 'ronda', draw: (h, k) => this.rondaHead(h, k, r) })
      foot.push(el('span', 'rg-sys-note', 'A ronda cutuca o agente quando ele está parado; o critério diz quando ele mesmo deve desligá-la.'))
    } else if (section === 'profiles') {
      if (m.profiles.length === 0) empty = 'Nenhum perfil'
      for (const r of m.profiles) want.push({ key: `profile:${r.id}`, cls: 'profile', draw: (h, k) => this.profileHead(h, k, r) })
      foot.push(button({ id: 'profile-new', icon: 'plus', tip: 'Novo perfil: abre o gerenciador de perfis', label: 'Novo perfil' }, 'foot:profile-new'))
    } else if (section === 'projects') {
      if (m.projects.length === 0) empty = 'Nenhum projeto aberto'
      for (const r of m.projects) want.push({ key: `project:${r.path}`, cls: 'project', draw: (h, k) => this.projectHead(h, k, r) })
      foot.push(el('span', 'rg-sys-note', 'Cada "aqui…" abre o "+ Novo" com a pasta e pergunta em qual mesa.'))
    } else {
      for (const r of m.settings) want.push({ key: `settings:${r.id}`, cls: 'settings', draw: (h, k) => this.settingsHead(h, k, r) })
    }
    // Rows by key: kept ones get a new head (their panel stays the same element), new ones are made, gone ones go.
    const keys = new Set(want.map(w => w.key))
    for (const [k, r] of [...this.rows]) if (!keys.has(k)) { r.el.remove(); this.rows.delete(k) }
    let at = 0
    for (const w of want) {
      let kept = this.rows.get(w.key)
      if (!kept) {
        const row = el('div', `rg-sr ${w.cls}`)
        row.dataset.key = w.key
        const head = el('div', 'rg-sr-h')
        row.append(head)
        kept = { el: row, head }
        this.rows.set(w.key, kept)
      }
      kept.head.replaceChildren()
      w.draw(kept.head, w.key)
      kept.el.classList.toggle('busy', this.busy.has(w.key))
      for (const b of kept.head.querySelectorAll<HTMLButtonElement>('button')) b.disabled = this.busy.has(w.key)
      // Moved only when out of place (moving the element that has the keyboard would take it away).
      const here = this.body.children[at]
      if (here !== kept.el) this.body.insertBefore(kept.el, here ?? null)
      at++
    }
    const emptyEl = this.body.querySelector('.rg-sys-empty')
    while (this.body.children.length > at) {
      const last = this.body.lastElementChild!
      if (last === emptyEl) break
      last.remove()
    }
    if (empty !== undefined) {
      if (!emptyEl) this.body.append(el('p', 'rg-empty rg-sys-empty', empty))
      else if (emptyEl.textContent !== empty) emptyEl.textContent = empty
    } else emptyEl?.remove()
    this.foot.replaceChildren(...foot)
    this.foot.hidden = foot.length === 0
  }

  // ---------------------------------------------------------------- the heads of the rows

  private procHead(h: HTMLElement, key: string, r: ProcRow): void {
    const intent = procIntent(r)
    h.parentElement!.dataset.state = intent
    h.parentElement!.dataset.proc = r.name
    const icon = glyph('pulse', 'Processo')
    const main = el('div', 'rg-sr-m')
    const name = el('span', 'rg-sr-n', r.name)
    name.title = r.cwd ? `${r.name} · ${r.cwd}` : r.name
    const line = el('div', 'rg-sr-l')
    const st = chip(r.stateText, `st ${intent}`)
    st.prepend(el('i', 'rg-sr-dot'))
    st.dataset.role = 'state'
    line.append(st)
    if (r.portsText) line.append(chip(r.portsText, 'ports', `Portas: ${r.portsText}`))
    if (r.startedByText) line.append(chip(r.startedByText, 'who'))
    for (const u of r.uses) line.append(chip(u.mine ? `Você segura ${u.untilText}` : `${u.byName} usa ${u.untilText}`, u.mine ? 'use mine' : 'use', u.text))
    main.append(name, line)
    const list: Act[] = []
    if (r.can.start) list.push({ id: 'start', icon: 'play', tip: `Iniciar ${r.name}` })
    if (r.can.stop) list.push({ id: 'stop', icon: 'stop', tip: `Parar ${r.name}` })
    if (r.can.restart) list.push({ id: 'restart', icon: 'arrow-clockwise', tip: `Reiniciar ${r.name}` })
    if (r.can.release) list.push({ id: 'release', icon: 'hand-grabbing', tip: `Soltar ${r.name}: deixar de segurar` })
    else if (r.can.hold) list.push({ id: 'hold', icon: 'hand', tip: `Segurar ${r.name} por 15 min: quem quiser parar ou reiniciar vê que você usa` })
    if (r.can.log) list.push({ id: 'log', icon: 'eye', tip: `Ver o registro de ${r.name} (visão rápida)` })
    list.push({ id: 'more', icon: 'dots-three', tip: `Mais ações de ${r.name}` })
    const acts = el('span', 'rg-sr-a')
    for (const a of list) acts.append(button(a, `${key}:${a.id}`))
    h.append(icon, main, acts)
  }

  private rondaHead(h: HTMLElement, key: string, r: RondaRow): void {
    h.parentElement!.dataset.agent = r.agentId
    h.parentElement!.dataset.on = String(r.on)
    const who = this.host.identity(r.agentId) ?? { kind: '', name: r.name, seed: r.agentId }
    const main = el('div', 'rg-sr-m')
    const id = identityView(who)
    id.classList.add('rg-sr-id')
    const line = el('div', 'rg-sr-l')
    if (!r.on) line.append(chip('sem ronda', 'off'))
    else {
      line.append(chip(r.intervalText ?? '', 'st ok', `Ronda ${r.intervalText ?? ''}`))
      if (r.nextText) line.append(chip(`próxima ${r.nextText}`, 'next'))
      if (r.noChannel) line.append(chip('sem canal', 'warn', 'O agente não está ouvindo o canal da ronda agora: o cutucão espera até ele ouvir'))
      if (r.criterion) line.append(chip(`até "${r.criterion}"`, 'crit', `Critério de parada: ${r.criterion}`))
    }
    main.append(id, line)
    const list: Act[] = r.on
      ? [{ id: 'ronda-remount', icon: 'arrow-clockwise', tip: `Remontar a ronda de ${r.name}: intervalo, cutucão extra, critério` },
        { id: 'ronda-off', icon: 'power', tip: `Desligar a ronda de ${r.name}`, danger: true }]
      : [{ id: 'ronda-on', icon: 'play', tip: `Ligar a ronda de ${r.name}: escolher o intervalo` }]
    const acts = el('span', 'rg-sr-a')
    for (const a of list) acts.append(button(a, `${key}:${a.id}`))
    h.append(main, acts)
  }

  private profileHead(h: HTMLElement, key: string, r: ProfileRow): void {
    h.parentElement!.dataset.profile = r.id
    const main = el('div', 'rg-sr-m')
    const name = el('span', 'rg-sr-n', r.name)
    name.title = r.name
    if (r.isDefault) name.append(chip('padrão', 'def', `Perfil padrão do ${r.engine}`))
    const line = el('div', 'rg-sr-l')
    line.append(chip(r.engine, 'eng'), chip(r.usersText, 'who'))
    if (r.envNames.length > 0) line.append(chip(`variáveis: ${r.envNames.join(', ')}`, 'env', `Variáveis de ambiente que o perfil define (só os nomes): ${r.envNames.join(', ')}`))
    main.append(name, line)
    const acts = el('span', 'rg-sr-a')
    acts.append(
      button({ id: 'profile-edit', icon: 'pencil-simple', tip: `Editar o perfil ${r.name}` }, `${key}:edit`),
      button({ id: 'profile-dup', icon: 'copy', tip: `Duplicar o perfil ${r.name}` }, `${key}:dup`),
    )
    h.append(glyph('sliders-horizontal', 'Perfil'), main, acts)
  }

  private projectHead(h: HTMLElement, key: string, r: ProjectRow): void {
    h.parentElement!.dataset.path = r.path
    const main = el('div', 'rg-sr-m')
    const name = el('span', 'rg-sr-n', r.name)
    name.title = r.path
    const line = el('div', 'rg-sr-l')
    const path = chip(r.path, 'path')
    line.append(path, chip(r.text, r.missing ? 'warn' : 'who'))
    main.append(name, line)
    const list: Act[] = []
    if (r.can.agentHere) list.push({ id: 'agent-here', icon: 'robot', tip: `Agente aqui…: um agente novo em ${r.name}` })
    if (r.can.terminalHere) list.push({ id: 'terminal-here', icon: 'terminal-window', tip: `Terminal aqui…: um terminal novo em ${r.name}` })
    list.push(r.pinned
      ? { id: 'unpin', icon: 'push-pin-fill', tip: `Soltar ${r.name} dos projetos fixados` }
      : { id: 'pin', icon: 'push-pin', tip: `Fixar ${r.name} nos projetos` })
    const acts = el('span', 'rg-sr-a')
    for (const a of list) acts.append(button(a, `${key}:${a.id}`))
    h.append(glyph(r.pinned ? 'push-pin-fill' : 'folder', r.pinned ? 'Projeto fixado' : 'Projeto'), main, acts)
  }

  private settingsHead(h: HTMLElement, key: string, r: SettingsItem): void {
    h.parentElement!.dataset.item = r.id
    const main = el('div', 'rg-sr-m')
    main.append(el('span', 'rg-sr-n', r.label))
    const line = el('div', 'rg-sr-l')
    if (r.kind === 'screen') line.append(chip('abre na visão rápida', 'who'))
    else line.append(chip(r.sentence, 'who'))
    main.append(line)
    const acts = el('span', 'rg-sr-a')
    acts.append(r.kind === 'screen'
      ? button({ id: 'screen', icon: 'eye', tip: `Abrir ${r.label} na visão rápida` }, `${key}:open`)
      : button({ id: 'status', icon: 'arrow-square-out', tip: `Abrir o ${r.label} (o popover do ícone na barra)` }, `${key}:open`))
    h.append(glyph(SETTINGS_ICON[r.id], r.label), main, acts)
  }

  // ---------------------------------------------------------------- panels (a form, a refusal, a question under a row)

  private panelOf(key: string, cls: string): HTMLElement | undefined {
    const kept = this.rows.get(key)
    if (!kept) return undefined
    kept.panel?.remove()
    const p = el('div', `rg-sr-x ${cls}`)
    kept.panel = p
    kept.el.append(p)
    return p
  }

  private closePanel(key: string, focusAct?: string): void {
    const kept = this.rows.get(key)
    if (!kept?.panel) return
    const had = kept.panel.contains(document.activeElement)
    kept.panel.remove()
    delete kept.panel
    if (had || focusAct) {
      const b = kept.head.querySelector<HTMLElement>(`[data-sys="${focusAct ?? 'more'}"]`) ?? kept.head.querySelector<HTMLElement>('button')
      b?.focus({ preventScroll: true })
    }
  }

  private say(key: string, text: string): void {
    const p = this.panelOf(key, 'msg')
    if (!p) return
    p.setAttribute('role', 'status')
    const ok = button({ id: 'panel-close', icon: 'check', tip: 'Fechar o aviso', label: 'Entendi' }, `${key}:close`)
    p.append(el('p', 'rg-sr-msg', text), ok)
    ok.focus({ preventScroll: true })
  }

  private async withBusy<T>(key: string, run: () => Promise<T>): Promise<T> {
    this.busy.add(key)
    this.dirty()
    try { return await run() } finally { this.busy.delete(key); this.dirty() }
  }

  private procRow(name: string): ProcRow | undefined { return this.model?.processes.find(p => p.name === name) }
  private rondaRow(id: string): RondaRow | undefined { return this.model?.ronda.find(r => r.agentId === id) }

  private async procAct(key: string, name: string, act: 'start' | 'stop' | 'restart' | 'hold' | 'release', opts?: GuardedOptions): Promise<void> {
    const r = await this.withBusy(key, () => this.host.proc(act, name, opts))
    if ('ok' in r) { this.closePanel(key, act === 'hold' ? 'release' : act === 'release' ? 'hold' : undefined); return }
    if (r.inUse && (act === 'stop' || act === 'restart')) this.inUse(key, name, act, r.inUse)
    else this.say(key, r.refusal)
  }

  /** In use by others: who, until when and what for, and the three ways out (wait, force with a reason, cancel). */
  private inUse(key: string, name: string, act: 'stop' | 'restart', refusal: InUseRefusal): void {
    const p = this.panelOf(key, 'inuse')
    if (!p) return
    p.setAttribute('role', 'alertdialog')
    p.setAttribute('aria-label', refusal.sentence)
    p.append(el('p', 'rg-sr-msg strong', refusal.sentence))
    const ul = el('ul', 'rg-sr-uses')
    for (const l of refusal.lines) ul.append(el('li', '', l))
    p.append(ul)
    const row = el('div', 'rg-sr-btns')
    for (const x of refusal.exits) {
      const b = button({ id: `inuse-${x.id}`, icon: x.id === 'wait' ? 'hourglass' : x.id === 'force' ? 'warning' : 'x', tip: x.hint, label: x.id === 'force' ? 'Forçar…' : x.label, danger: x.id === 'force' }, `${key}:inuse-${x.id}`)
      if (x.waitMs !== undefined) b.dataset.wait = String(x.waitMs)
      row.append(b)
    }
    p.append(row)
    p.dataset.act = act
    p.dataset.name = name
    row.querySelector<HTMLElement>('[data-sys="inuse-wait"]')?.focus({ preventScroll: true })
  }

  /** "Forçar…": the reason, required; the button goes only with a good one. */
  private forceForm(key: string, panel: HTMLElement): void {
    if (panel.querySelector('.rg-sr-reason')) { panel.querySelector<HTMLElement>('.rg-sr-reason input')?.focus(); return }
    const box = el('div', 'rg-sr-reason')
    const label = el('label', '', 'Motivo (fica registrado):')
    const input = el('input', '')
    input.type = 'text'
    input.maxLength = 240
    input.placeholder = 'Por que forçar agora?'
    input.setAttribute('aria-label', 'Motivo para forçar')
    input.dataset.field = 'reason'
    label.append(input)
    const err = el('p', 'rg-sr-err')
    err.hidden = true
    const go = button({ id: 'inuse-force-go', icon: 'warning', tip: 'Passa por cima de quem usa, com o seu motivo', label: 'Forçar agora', danger: true }, `${key}:inuse-force-go`)
    box.append(label, err, go)
    panel.querySelector('.rg-sr-btns')?.after(box)
    input.focus()
  }

  /** Ligar or Remontar: interval, extra nudge and criterion, in a form under the row. */
  private rondaForm(key: string, agentId: string, remount: boolean): void {
    const r = this.rondaRow(agentId)
    if (!r) return
    const p = this.panelOf(key, 'form')
    if (!p) return
    p.dataset.agent = agentId
    p.dataset.mode = remount ? 'remount' : 'on'
    const sel = el('select', '')
    sel.dataset.field = 'interval'
    sel.setAttribute('aria-label', 'Intervalo da ronda')
    const current = remount && r.intervalText ? r.intervalText.replace(/^a cada /, '') : ''
    for (const v of INTERVALS) {
      const o = el('option', '', `a cada ${intervalWords(v.endsWith('h') ? Number(v.slice(0, -1)) * 3_600_000 : Number(v.slice(0, -1)) * 60_000)}`)
      o.value = v
      if ((current && o.textContent === `a cada ${current}`) || (!current && v === DEFAULT_INTERVAL)) o.selected = true
      sel.append(o)
    }
    if (current && ![...sel.options].some(o => o.selected)) {
      const o = el('option', '', `a cada ${current} (atual)`)
      o.value = ''
      o.selected = true
      sel.prepend(o)
    }
    const field = (name: string, label: string, value: string, hint: string): HTMLLabelElement => {
      const l = el('label', '', label)
      const i = el('input', '')
      i.type = 'text'
      i.value = value
      i.placeholder = hint
      i.maxLength = 200
      i.dataset.field = name
      i.setAttribute('aria-label', label)
      l.append(i)
      return l
    }
    const lab = el('label', '', 'Intervalo')
    lab.append(sel)
    p.append(
      lab,
      field('nudge', 'Cutucão extra', '', 'texto somado ao cutucão padrão (opcional)'),
      field('criterion', 'Critério de parada', remount ? r.criterion ?? '' : '', 'ex.: até a bateria ficar verde (opcional)'),
    )
    const err = el('p', 'rg-sr-err')
    err.hidden = true
    const btns = el('div', 'rg-sr-btns')
    btns.append(
      button({ id: 'ronda-go', icon: 'check', tip: remount ? 'Remontar a ronda com estes valores' : 'Ligar a ronda', label: remount ? 'Remontar' : 'Ligar' }, `${key}:ronda-go`),
      button({ id: 'panel-close', icon: 'x', tip: 'Cancelar: nada muda', label: 'Cancelar' }, `${key}:close`),
    )
    p.append(err, btns)
    sel.focus()
  }

  private async rondaGo(key: string, panel: HTMLElement): Promise<void> {
    const agentId = panel.dataset.agent ?? ''
    const remount = panel.dataset.mode === 'remount'
    const val = (f: string): string => (panel.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-field="${f}"]`)?.value ?? '').trim()
    const change: RondaChange = {}
    const interval = val('interval')
    if (interval !== '') change.interval = interval
    const nudge = val('nudge')
    const criterion = val('criterion')
    if (nudge !== '') change.nudge = nudge
    if (remount || criterion !== '') change.criterion = criterion
    const a = await this.withBusy(key, () => this.host.setRonda(agentId, change))
    if (a.ok) { this.closePanel(key, remount ? 'ronda-remount' : 'ronda-off'); return }
    const err = panel.querySelector<HTMLElement>('.rg-sr-err')
    if (err && panel.isConnected) { err.textContent = refusalText(a.code, a.message); err.hidden = false }
    else this.say(key, refusalText(a.code, a.message))
  }

  /** Desligar: tried plainly; a ronda with a criterion asks first (the criterion shown), and only then goes with force. */
  private async rondaOff(key: string, agentId: string, force: boolean): Promise<void> {
    const a = await this.withBusy(key, () => this.host.offRonda(agentId, force))
    if (a.ok) { this.closePanel(key, 'ronda-on'); return }
    if (a.code !== 'ronda-criterion') { this.say(key, refusalText(a.code, a.message)); return }
    const r = this.rondaRow(agentId)
    const p = this.panelOf(key, 'ask')
    if (!p) return
    p.setAttribute('role', 'alertdialog')
    const text = `A ronda de ${r?.name ?? 'este agente'} tem um critério de parada: "${r?.criterion ?? ''}". Desligar assim mesmo?`
    p.setAttribute('aria-label', text)
    p.dataset.agent = agentId
    p.append(el('p', 'rg-sr-msg', text))
    const btns = el('div', 'rg-sr-btns')
    btns.append(
      button({ id: 'ronda-force', icon: 'power', tip: 'Desliga a ronda mesmo com o critério', label: 'Desligar assim mesmo', danger: true }, `${key}:ronda-force`),
      button({ id: 'panel-close', icon: 'x', tip: 'Cancelar: a ronda continua', label: 'Cancelar' }, `${key}:close`),
    )
    p.append(btns)
    btns.querySelector<HTMLElement>('[data-sys="panel-close"]')?.focus({ preventScroll: true })
  }

  // ---------------------------------------------------------------- input

  private onClick(ev: MouseEvent): void {
    const t = ev.target instanceof Element ? ev.target : null
    const b = t?.closest<HTMLButtonElement>('button[data-sys]')
    if (!b || !this.element.contains(b) || b.disabled) {
      // A click on a process' head (not on a button) is the quick view of its record.
      const head = t?.closest<HTMLElement>('.rg-sr.proc > .rg-sr-h')
      const name = head?.parentElement?.dataset.proc
      if (head && name && !t?.closest('button') && this.procRow(name)?.can.log) {
        const r = this.host.peekLog(name)
        if ('refusal' in r) this.say(`proc:${name}`, r.refusal)
      }
      return
    }
    const sys = b.dataset.sys!
    if (sys === 'back') { this.nav.back(); return }
    if (sys === 'tab') { this.nav.select(b.dataset.section as SystemSection); return }
    if (sys === 'profile-new') { this.host.editProfile('new'); return }
    const row = b.closest<HTMLElement>('.rg-sr')
    const key = row?.dataset.key ?? ''
    const panel = b.closest<HTMLElement>('.rg-sr-x')
    switch (sys) {
      case 'panel-close': this.closePanel(key); return
      case 'start': case 'stop': case 'restart': case 'hold': case 'release':
        void this.procAct(key, row!.dataset.proc!, sys)
        return
      case 'log': {
        const r = this.host.peekLog(row!.dataset.proc!)
        if ('refusal' in r) this.say(key, r.refusal)
        return
      }
      case 'more': this.procMenu(key, row!.dataset.proc!, b); return
      case 'inuse-wait': {
        const name = panel!.dataset.name!
        const act = panel!.dataset.act as 'stop' | 'restart'
        panel!.querySelector('.rg-sr-btns')?.replaceChildren(el('span', 'rg-sr-msg', 'Esperando acabar o uso…'))
        void this.procAct(key, name, act, { waitMs: Number(b.dataset.wait ?? 0) })
        return
      }
      case 'inuse-force': this.forceForm(key, panel!); return
      case 'inuse-cancel': this.closePanel(key, panel!.dataset.act); return
      case 'inuse-force-go': {
        const reason = panel!.querySelector<HTMLInputElement>('[data-field="reason"]')?.value ?? ''
        const bad = forceReasonError(reason)
        const err = panel!.querySelector<HTMLElement>('.rg-sr-reason .rg-sr-err')
        if (bad) { if (err) { err.textContent = bad; err.hidden = false } panel!.querySelector<HTMLElement>('[data-field="reason"]')?.focus(); return }
        void this.procAct(key, panel!.dataset.name!, panel!.dataset.act as 'stop' | 'restart', { force: reason.trim() })
        return
      }
      case 'ronda-on': this.rondaForm(key, row!.dataset.agent!, false); return
      case 'ronda-remount': this.rondaForm(key, row!.dataset.agent!, true); return
      case 'ronda-go': void this.rondaGo(key, panel!); return
      case 'ronda-off': void this.rondaOff(key, row!.dataset.agent!, false); return
      case 'ronda-force': void this.rondaOff(key, panel!.dataset.agent!, true); return
      case 'profile-edit': this.host.editProfile(row!.dataset.profile!); return
      case 'profile-dup': this.host.editProfile(row!.dataset.profile!, true); return
      case 'agent-here': case 'terminal-here': {
        const path = row!.dataset.path!
        this.host.createHere(sys === 'agent-here' ? 'agent' : 'terminal', path, () => {
          const again = this.rows.get(key)?.head.querySelector<HTMLElement>(`[data-sys="${sys}"]`)
          again?.focus({ preventScroll: true })
        })
        return
      }
      case 'pin': case 'unpin': this.host.togglePin(row!.dataset.path!); return
      case 'screen': {
        const item = this.model?.settings.find(s => s.id === row!.dataset.item)
        if (item?.kind === 'screen') this.host.openScreen(item.screenType)
        return
      }
      case 'status': {
        const id = row!.dataset.item as 'bridge' | 'sync'
        if (!this.host.showStatus(id)) this.say(key, `O ícone do ${id === 'bridge' ? 'Bridge' : 'Sync'} não está na barra agora (a extensão pode estar desligada).`)
        return
      }
    }
  }

  private procMenu(key: string, name: string, anchor: HTMLElement): void {
    const r = this.procRow(name)
    if (!r) return
    const box = anchor.getBoundingClientRect()
    const entries: ContextMenuEntry[] = []
    if (r.can.log) {
      entries.push(
        { icon: 'eye', label: 'Ver o registro', hint: 'clique na linha', run: () => { const a = this.host.peekLog(name); if ('refusal' in a) this.say(key, a.refusal) } },
        { icon: 'cards', label: 'Abrir o registro numa mesa…', run: () => { void this.host.logOnDesk(name).then(a => { if (a && 'refusal' in a) this.say(key, a.refusal) }) } },
      )
    } else entries.push({ icon: 'eye', label: 'Processo de fora do tether: sem registro', disabled: true, run: () => {} })
    this.host.menu(Math.round(box.left), Math.round(box.bottom + 2), entries)
  }

  /** Enter in a form's field submits it; Esc closes a row's panel (the keyboard goes back to the row's buttons). */
  private onKey(ev: KeyboardEvent): void {
    const t = ev.target instanceof HTMLElement ? ev.target : null
    const panel = t?.closest<HTMLElement>('.rg-sr-x')
    if (t && t.closest('.rg-sys-tabs') && (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft')) {
      const i = SYSTEM_SECTIONS.findIndex(s => s.id === this.section)
      const next = SYSTEM_SECTIONS[(i + (ev.key === 'ArrowRight' ? 1 : SYSTEM_SECTIONS.length - 1)) % SYSTEM_SECTIONS.length]!
      ev.preventDefault()
      this.nav.select(next.id)
      this.tabs.querySelector<HTMLElement>(`[data-section="${next.id}"]`)?.focus()
      return
    }
    if (!panel) return
    const key = panel.closest<HTMLElement>('.rg-sr')?.dataset.key ?? ''
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); this.closePanel(key, panel.dataset.act ?? undefined); return }
    if (ev.key === 'Enter' && t instanceof HTMLInputElement) {
      ev.preventDefault()
      panel.querySelector<HTMLElement>('[data-sys="ronda-go"], [data-sys="inuse-force-go"]')?.click()
    }
  }

  /** The button with the keyboard, found again by its key after the heads were drawn again. */
  private keepFocus(paint: () => void): void {
    const active = document.activeElement
    const key = active instanceof HTMLElement && this.element.contains(active) && active.closest('.rg-sr-h') ? active.dataset.key : undefined
    const scroll = this.body.scrollTop
    paint()
    if (this.body.scrollTop !== scroll) this.body.scrollTop = scroll
    if (!key || (document.activeElement && document.activeElement !== document.body)) return
    const again = [...this.body.querySelectorAll<HTMLElement>('.rg-sr-h [data-key]')].find(e => e.dataset.key === key)
    again?.focus({ preventScroll: true })
  }

  /** What the E2E reads: the section, the rows as drawn (state, chips, buttons, panel) and the foot. */
  snapshot(): { section: SystemSection; paints: number; rows: { key: string; text: string; state?: string; acts: string[]; panel?: string }[]; empty?: string; foot: string } {
    return {
      section: this.section,
      paints: this.paints,
      rows: [...this.body.querySelectorAll<HTMLElement>('.rg-sr')].map(r => {
        const panel = r.querySelector<HTMLElement>('.rg-sr-x')
        return {
          key: r.dataset.key ?? '',
          text: r.querySelector('.rg-sr-h')?.textContent ?? '',
          ...(r.dataset.state ? { state: r.dataset.state } : {}),
          acts: [...r.querySelectorAll<HTMLElement>('.rg-sr-h button[data-sys]')].map(b => b.dataset.sys!),
          ...(panel ? { panel: panel.textContent ?? '' } : {}),
        }
      }),
      ...(this.body.querySelector('.rg-sys-empty') ? { empty: this.body.querySelector('.rg-sys-empty')!.textContent ?? '' } : {}),
      foot: this.foot.textContent ?? '',
    }
  }
}
