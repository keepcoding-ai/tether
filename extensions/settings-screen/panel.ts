// The "Configurações" page: a TAB of the active group, like VS Code's settings editor, generated from the registry
// (TetherUi.configuration.all()). The search box on top (debounced; words matched accent-blind in the title, the key,
// the description and the enum labels, rules.ts), the sections' TOC on the left, the settings grouped by node and
// section in the registry's order; a control per type (switch, select with the enum's labels, text, number with its
// validator: an invalid text shows its message and is never written); the left bar and ↺ on a configured setting (↺
// removes the key); "Modificadas" writes `@modified` into the box; a file that does not parse shows the banner and
// the controls wait. Every change on disk (the person's edit in the editor tab included) arrives through onDidChange
// and repaints the rows in place, without stealing a field the person is typing in.
// Origin of the layout and behaviour: https://github.com/microsoft/vscode, commit 7faf984945fefaceb533ca1d851697a2e72e4e68
//   src/vs/workbench/contrib/preferences/browser/settingsEditor2.ts (search box + TOC + tree, debounced search, "@modified"
//     filter, empty result), settingsTree.ts (a renderer per type, the modified indicator, the reset action),
//   media/settingsEditor2.css (the indicator bar at the row's left). MIT.
import type { DockviewPanelApi, GroupPanelPartInitParameters, IContentRenderer, ITabRenderer, TabPartInitParameters } from 'dockview-core'
import { icon, type IconName } from '../../app/renderer/icons.ts'
import { rangeRuns, wordFilter, type Range } from '../../app/renderer/word-filter.ts'
import type { SettingEntry, SettingsList, SettingWriteResult } from '../../app/shared/api.ts'
import type { SettingsError } from '../../app/shared/settings-file.ts'
import type { SettingValue } from '../../app/shared/vscode-configuration-registry.ts'
import { SETTINGS_TITLE } from '../../app/shared/settings-screen.ts'
import { createValidator, filterSections, isConfigured, parseQuery, parseValue, sectionsOf, settingTitle, withModifiedTag, type PageSection, type SettingMatch } from './rules.ts'

export interface SettingsHost {
  all(): Promise<SettingsList>
  set(key: string, value: SettingValue): Promise<SettingWriteResult>
  reset(key: string): Promise<SettingWriteResult>
  /** "Abrir settings.json": in an editor tab of this group. */
  openFile(): void
  /** A section's action runs a command of the app ("Tema do tether…"). */
  runCommand(id: string): void
  onTabMenu(id: string, ev: MouseEvent): void
  onClose(id: string): void
}

/** Things a section does besides its settings: the core's dialogs that edit what the page does not edit as a value. */
interface SectionAction { label: string; icon: IconName; command: string; description?: string }
const SECTION_ACTIONS: Record<string, SectionAction[]> = {
  'core/Tema': [{ label: 'Tema do Tether…', icon: 'palette', command: 'terminal.theme', description: 'Cores do terminal; fonte, tamanho e ligaduras do terminal e dos editores.' }],
  'core/Confirmações': [{ label: 'Voltar a perguntar antes de fechar painéis', icon: 'arrow-clockwise', command: 'confirmations.restore', description: 'Os painéis em que você marcou "não perguntar de novo" voltam a pedir confirmação antes de fechar.' }],
}
/** Sections that hold only actions (no setting declares them), placed after the node's own sections. */
const ACTION_ONLY: { node: string; title: string }[] = [{ node: 'core', title: 'Confirmações' }]

const SEARCH_DEBOUNCE = 150
const WRITE_DEBOUNCE = 500

interface Row {
  entry: SettingEntry
  el: HTMLElement
  title: HTMLElement
  desc: HTMLElement
  err: HTMLElement
  control: HTMLInputElement | HTMLSelectElement | HTMLButtonElement
  /** The text typed and not written yet (an invalid number, or a valid one waiting for its debounce). */
  dirty: boolean
  error: string | null
  timer?: ReturnType<typeof setTimeout>
}

/** What a test reads of the page. */
export interface SettingsSnapshot {
  id: string
  query: string
  count: number
  banner: string | undefined
  sections: string[]
  toc: string[]
  empty: boolean
  rows: { key: string; value: SettingValue; configured: boolean; visible: boolean; modifiedBar: boolean; error: string | null; text: string; disabled: boolean }[]
}

export class SettingsPanel implements IContentRenderer {
  readonly element: HTMLElement
  id = ''
  private readonly host: SettingsHost
  private readonly disposers: Array<{ dispose(): void }> = []
  private disposed = false
  private readonly input: HTMLInputElement
  private readonly clear: HTMLButtonElement
  private readonly modBtn: HTMLButtonElement
  private readonly banner: HTMLElement
  private readonly count: HTMLElement
  private readonly toc: HTMLElement
  private readonly list: HTMLElement
  private readonly emptyEl: HTMLElement
  private rows = new Map<string, Row>()
  private sectionEls = new Map<string, HTMLElement>()
  private nodeEls = new Map<string, HTMLElement>()
  private sections: PageSection[] = []
  private errors: SettingsError[] = []
  private query = ''
  private shown: PageSection[] = []
  private shownCount = 0
  private searchTimer: ReturnType<typeof setTimeout> | undefined
  private structure = ''
  private loading: Promise<void> | undefined

  constructor(host: SettingsHost) {
    this.host = host
    this.element = document.createElement('div')
    this.element.className = 'st-pane'
    this.element.dataset.settings = 'pane'
    this.element.innerHTML = `
      <div class="st-head">
        <div class="st-row">
          <div class="st-search">
            <span class="mag"></span>
            <input class="st-q" placeholder="Buscar configurações" autocomplete="off" spellcheck="false" aria-label="Buscar configurações">
            <button type="button" class="ib st-clear" title="Limpar (Esc)" hidden></button>
          </div>
          <button type="button" class="st-chip st-mod" aria-pressed="false" title="Só as configurações que estão no settings.json (@modified)">Modificadas</button>
        </div>
        <div class="st-banner err" role="alert" hidden></div>
        <div class="st-links"><span class="st-count"></span><span class="sp"></span><button type="button" class="lnk" data-act="open-json"></button></div>
      </div>
      <div class="st-body">
        <nav class="st-toc" aria-label="Seções"></nav>
        <div class="st-list" tabindex="-1"><div class="st-empty" hidden></div></div>
      </div>`
    const q = <T extends Element>(sel: string): T => this.element.querySelector<T>(sel)!
    q('.mag').replaceWith(icon('magnifying-glass', 'mag'))
    this.clear = q('.st-clear'); this.clear.append(icon('x'))
    q('[data-act="open-json"]').append(icon('brackets-curly'), document.createTextNode('Abrir settings.json'))
    this.input = q('.st-q'); this.modBtn = q('.st-mod'); this.banner = q('.st-banner'); this.count = q('.st-count')
    this.toc = q('.st-toc'); this.list = q('.st-list'); this.emptyEl = q('.st-empty')
    this.wire()
  }

  init(params: GroupPanelPartInitParameters): void {
    this.id = params.api.id
    this.element.dataset.settingsId = this.id
    void this.refresh()
    this.disposers.push(params.api.onDidActiveChange(({ isActive }) => { if (isActive) requestAnimationFrame(() => this.focus()) }))
  }

  focus(): void {
    if (this.disposed) return
    if (!this.element.contains(document.activeElement)) this.input.focus()
  }

  /** The file or the registry changed: read the list again and repaint in place. */
  refresh(): Promise<void> {
    const run = async (): Promise<void> => {
      const list = await this.host.all()
      if (this.disposed) return
      this.errors = list.errors
      this.sections = withActionSections(sectionsOf(list.entries))
      const structure = list.entries.map(e => e.key).join('\n')
      if (structure !== this.structure) { this.structure = structure; this.build(list.entries) }
      else for (const e of list.entries) this.updateRow(this.rows.get(e.key)!, e)
      this.paintBanner()
      this.applyFilter()
    }
    // One read at a time; a change during one reads again after it.
    this.loading = (this.loading ?? Promise.resolve()).then(run, run)
    return this.loading
  }

  // ---------- wiring ----------

  private wire(): void {
    this.input.addEventListener('input', () => {
      this.clear.hidden = !this.input.value
      if (this.searchTimer) clearTimeout(this.searchTimer)
      this.searchTimer = setTimeout(() => { this.searchTimer = undefined; this.query = this.input.value; this.applyFilter() }, SEARCH_DEBOUNCE)
    })
    this.input.addEventListener('keydown', ev => {
      if (ev.key === 'Escape' && this.input.value) { ev.preventDefault(); ev.stopPropagation(); this.setQuery('') }
      if (ev.key === 'ArrowDown') { ev.preventDefault(); this.list.querySelector<HTMLElement>('.st-item:not([hidden]) .st-ctl')?.focus() }
    })
    this.clear.addEventListener('click', () => { this.setQuery(''); this.input.focus() })
    this.modBtn.addEventListener('click', () => this.setQuery(withModifiedTag(this.input.value, !parseQuery(this.input.value).modified)))
    this.element.querySelector<HTMLElement>('[data-act="open-json"]')!.addEventListener('click', () => this.host.openFile())
    this.toc.addEventListener('click', ev => {
      const a = (ev.target as HTMLElement).closest<HTMLElement>('[data-sec]')
      if (!a) return
      const target = this.sectionEls.get(a.dataset.sec!) ?? this.nodeEls.get(a.dataset.sec!)
      if (target) { this.list.scrollTop = target.offsetTop - 4; this.paintTocActive() }
    })
    this.list.addEventListener('scroll', () => this.paintTocActive(), { passive: true })
  }

  /** One setting on screen: the search cleared, the row scrolled to, its control focused and briefly marked. */
  async reveal(key: string): Promise<void> {
    await (this.loading ?? this.refresh())
    if (this.disposed) return
    this.setQuery('')
    const row = this.rows.get(key)
    if (!row) { this.focus(); return }
    row.el.scrollIntoView({ block: 'center' })
    row.el.querySelector<HTMLElement>('.st-ctl')?.focus()
    row.el.classList.remove('st-flash'); void row.el.offsetWidth; row.el.classList.add('st-flash')
  }

  private setQuery(text: string): void {
    if (this.searchTimer) { clearTimeout(this.searchTimer); this.searchTimer = undefined }
    this.input.value = text
    this.clear.hidden = !text
    this.query = text
    this.applyFilter()
  }

  // ---------- building ----------

  private build(entries: SettingEntry[]): void {
    for (const r of this.rows.values()) if (r.timer) clearTimeout(r.timer)
    this.rows.clear(); this.sectionEls.clear(); this.nodeEls.clear()
    this.list.querySelectorAll('.st-node, .st-sec').forEach(el => el.remove())
    void entries
    let node = ''
    for (const s of this.sections) {
      if (s.node !== node) {
        node = s.node
        const h = document.createElement('h2'); h.className = 'st-node'; h.textContent = s.nodeTitle; h.dataset.node = s.node
        this.nodeEls.set(s.node, h)
        this.list.insertBefore(h, this.emptyEl)
      }
      const sec = document.createElement('section'); sec.className = 'st-sec'; sec.dataset.sec = s.id
      const h3 = document.createElement('h3'); h3.textContent = s.title
      if (s.title !== s.nodeTitle) sec.append(h3) // a node with one unnamed section: its heading is the node's
      for (const a of SECTION_ACTIONS[s.id] ?? []) sec.append(this.actionEl(a))
      for (const e of s.entries) { const r = this.rowOf(e); this.rows.set(e.key, r); sec.append(r.el) }
      this.sectionEls.set(s.id, sec)
      this.list.insertBefore(sec, this.emptyEl)
    }
  }

  private actionEl(a: SectionAction): HTMLElement {
    const el = document.createElement('div'); el.className = 'st-item st-action'; el.dataset.action = a.command
    const b = document.createElement('button'); b.type = 'button'; b.className = 'st-btn'; b.append(icon(a.icon), document.createTextNode(a.label))
    b.addEventListener('click', () => this.host.runCommand(a.command))
    el.append(b)
    if (a.description) { const d = document.createElement('div'); d.className = 'st-d'; d.textContent = a.description; el.append(d) }
    return el
  }

  private rowOf(entry: SettingEntry): Row {
    const el = document.createElement('div'); el.className = 'st-item'; el.dataset.key = entry.key; el.dataset.type = entry.schema.type
    const head = document.createElement('div'); head.className = 'st-t'
    const title = document.createElement('span'); title.className = 'st-title'
    const mod = document.createElement('span'); mod.className = 'st-modlbl'; mod.textContent = 'Modificado'
    const reset = document.createElement('button'); reset.type = 'button'; reset.className = 'ib st-reset'; reset.title = 'Redefinir: tira do settings.json e volta ao padrão'
    reset.setAttribute('aria-label', 'Redefinir'); reset.append(icon('arrow-counter-clockwise'))
    head.append(title, mod, reset)
    const desc = document.createElement('div'); desc.className = 'st-d'
    const err = document.createElement('div'); err.className = 'st-err'; err.setAttribute('role', 'alert'); err.hidden = true
    const key = document.createElement('code'); key.className = 'st-k'; key.textContent = entry.key
    const schema = entry.schema
    let control: Row['control']
    const ctl = document.createElement('div'); ctl.className = 'st-c'
    if (schema.type === 'boolean') {
      const sw = document.createElement('button'); sw.type = 'button'; sw.className = 'st-ctl st-switch'; sw.setAttribute('role', 'switch')
      sw.setAttribute('aria-label', settingTitle(entry))
      sw.append(document.createElement('i'))
      control = sw
      ctl.append(sw, desc)
      el.append(head, ctl, err, key)
    } else {
      if (schema.type === 'string' && schema.enum) {
        const sel = document.createElement('select'); sel.className = 'st-ctl st-select'
        schema.enum.forEach((v, i) => { const o = document.createElement('option'); o.value = v; o.textContent = schema.enumLabels?.[i] ?? v; sel.append(o) })
        control = sel
        const wrap = document.createElement('label'); wrap.className = 'st-selwrap'; wrap.append(sel, icon('caret-down', 'caret'))
        ctl.append(wrap)
      } else {
        const inp = document.createElement('input'); inp.className = 'st-ctl st-input'; inp.spellcheck = false; inp.autocomplete = 'off'
        if (schema.type !== 'string') { inp.inputMode = schema.type === 'integer' ? 'numeric' : 'decimal'; inp.classList.add('num') }
        control = inp
        ctl.append(inp)
      }
      control.setAttribute('aria-label', settingTitle(entry))
      el.append(head, desc, ctl, err, key)
    }
    const row: Row = { entry, el, title, desc, err, control, dirty: false, error: null }
    reset.addEventListener('click', () => this.resetRow(row))
    this.wireControl(row)
    this.updateRow(row, entry)
    return row
  }

  private wireControl(row: Row): void {
    const c = row.control
    if (c instanceof HTMLButtonElement) {
      c.addEventListener('click', () => {
        if (this.errors.length) return
        const next = !(row.entry.value as boolean)
        this.paintValue(row, next)
        this.write(row, next)
      })
    } else if (c instanceof HTMLSelectElement) {
      c.addEventListener('change', () => { if (!this.errors.length) this.write(row, c.value) })
    } else {
      const validate = createValidator(row.entry.schema)
      const flush = (): void => {
        if (row.timer) { clearTimeout(row.timer); row.timer = undefined }
        if (row.error || !row.dirty) return
        const value = parseValue(row.entry.schema, c.value)
        row.dirty = false
        if (value !== row.entry.value) this.write(row, value)
      }
      c.addEventListener('input', () => {
        row.dirty = true
        row.error = validate(c.value)
        this.paintError(row)
        if (row.timer) { clearTimeout(row.timer); row.timer = undefined }
        if (!row.error && !this.errors.length) row.timer = setTimeout(flush, WRITE_DEBOUNCE)
      })
      c.addEventListener('keydown', ev => { if (ev.key === 'Enter') flush() })
      c.addEventListener('change', flush)
    }
  }

  private write(row: Row, value: SettingValue): void {
    void this.host.set(row.entry.key, value).then(r => {
      if (!r.ok) { row.error = r.message; this.paintError(row) }
      else if (row.error && !row.dirty) { row.error = null; this.paintError(row) }
    })
  }

  private resetRow(row: Row): void {
    if (row.timer) { clearTimeout(row.timer); row.timer = undefined }
    row.dirty = false; row.error = null; this.paintError(row)
    void this.host.reset(row.entry.key).then(r => { if (!r.ok) { row.error = r.message; this.paintError(row) } })
  }

  // ---------- painting ----------

  private updateRow(row: Row, entry: SettingEntry): void {
    row.entry = entry
    const configured = isConfigured(entry)
    row.el.classList.toggle('modified', configured)
    // A field being typed in keeps its text; everything else shows the value in force.
    if (!(row.dirty && document.activeElement === row.control)) { row.dirty = false; if (row.error && row.control instanceof HTMLInputElement) { row.error = null; this.paintError(row) } this.paintValue(row, entry.value) }
  }

  private paintValue(row: Row, value: SettingValue): void {
    const c = row.control
    if (c instanceof HTMLButtonElement) c.setAttribute('aria-checked', String(value === true))
    else c.value = String(value)
  }

  private paintError(row: Row): void {
    row.err.hidden = !row.error
    row.err.textContent = row.error ?? ''
    row.el.classList.toggle('invalid', !!row.error)
    row.control.setAttribute('aria-invalid', String(!!row.error))
  }

  private paintBanner(): void {
    const bad = this.errors.length > 0
    this.element.classList.toggle('file-bad', bad)
    this.banner.hidden = !bad
    for (const r of this.rows.values()) r.control.disabled = bad
    if (!bad) { this.banner.replaceChildren(); return }
    const text = document.createElement('span')
    text.innerHTML = '<b>settings.json tem erros; corrija para voltar a salvar.</b> '
    text.append(document.createTextNode(`${this.errors[0]!.message}${this.errors.length > 1 ? ` (e mais ${this.errors.length - 1})` : ''}. Enquanto isso valem os últimos valores lidos.`))
    const open = document.createElement('button'); open.type = 'button'; open.className = 'lnk'; open.textContent = 'Abrir settings.json'
    open.addEventListener('click', () => this.host.openFile())
    this.banner.replaceChildren(icon('warning'), text, open)
  }

  private applyFilter(): void {
    const parsed = parseQuery(this.query)
    this.modBtn.setAttribute('aria-pressed', String(parsed.modified))
    const { sections, matches, count } = filterSections(this.sections.filter(s => s.entries.length), this.query)
    // Action sections: shown with no query; with words, when an action's label matches.
    const actionHits = new Set<string>()
    for (const s of this.sections) {
      const acts = SECTION_ACTIONS[s.id]
      if (!acts || parsed.modified || (parsed.extensions.length && !parsed.extensions.includes(s.node))) continue
      if (!parsed.query || acts.some(a => parsed.query.split(' ').every(w => wordFilter(w, `${a.label} ${a.description ?? ''} ${s.title}`)))) actionHits.add(s.id)
    }
    const visible = new Set(sections.map(s => s.id))
    for (const id of actionHits) visible.add(id)
    this.shown = this.sections.filter(s => visible.has(s.id))
    this.shownCount = count
    for (const r of this.rows.values()) {
      const m = matches.get(r.entry.key)
      r.el.hidden = !m
      paintRuns(r.title, settingTitle(r.entry), m?.title ?? [])
      paintRuns(r.desc, r.entry.schema.description ?? '', m?.description ?? [])
    }
    for (const [id, el] of this.sectionEls) {
      el.hidden = !visible.has(id)
      el.querySelectorAll<HTMLElement>('.st-action').forEach(a => { a.hidden = !actionHits.has(id) })
    }
    for (const [node, el] of this.nodeEls) el.hidden = !this.shown.some(s => s.node === node)
    const searching = !!(parsed.query || parsed.modified || parsed.extensions.length)
    this.count.innerHTML = searching ? `<b>${count}</b> ${count === 1 ? 'configuração encontrada' : 'configurações encontradas'}` : `<b>${this.rows.size}</b> configurações`
    this.emptyEl.hidden = this.shown.length > 0
    if (!this.shown.length) {
      this.emptyEl.replaceChildren()
      const p = document.createElement('p')
      p.textContent = parsed.modified && !parsed.query ? 'Nenhuma configuração modificada: tudo está no padrão.' : `Nenhuma configuração encontrada${parsed.query ? ` para «${parsed.query}»` : ''}.`
      const b = document.createElement('button'); b.type = 'button'; b.className = 'lnk'; b.textContent = 'Limpar a busca'
      b.addEventListener('click', () => { this.setQuery(''); this.input.focus() })
      this.emptyEl.append(p, b)
    }
    this.paintToc()
  }

  private paintToc(): void {
    this.toc.replaceChildren()
    let node = ''
    for (const s of this.shown) {
      if (s.node !== node) {
        node = s.node
        const n = document.createElement('button'); n.type = 'button'; n.className = 'st-toc-node'; n.dataset.sec = s.node; n.textContent = s.nodeTitle
        this.toc.append(n)
      }
      // A section named as its node (an extension's settings without sections) is the node's own entry.
      const own = s.title === s.nodeTitle
      const b = own ? this.toc.lastElementChild as HTMLButtonElement : document.createElement('button')
      if (own) { b.classList.add('st-toc-sec'); b.dataset.sec = s.id; b.textContent = '' } else { b.type = 'button'; b.className = 'st-toc-sec'; b.dataset.sec = s.id }
      const n = s.entries.filter(e => !this.rows.get(e.key)?.el.hidden).length
      b.append(document.createTextNode(s.title))
      if (this.query.trim() && n) { const c = document.createElement('span'); c.className = 'n'; c.textContent = String(n); b.append(c) }
      if (!own) this.toc.append(b)
    }
    this.paintTocActive()
  }

  private paintTocActive(): void {
    const top = this.list.scrollTop + 12
    let active = this.shown[0]?.id
    for (const s of this.shown) { const el = this.sectionEls.get(s.id); if (el && el.offsetTop <= top) active = s.id }
    this.toc.querySelectorAll<HTMLElement>('.st-toc-sec').forEach(b => b.classList.toggle('active', b.dataset.sec === active))
  }

  // ---------- tests ----------

  snapshot(): SettingsSnapshot {
    return {
      id: this.id, query: this.query, count: this.shownCount,
      banner: this.banner.hidden ? undefined : this.banner.textContent ?? '',
      sections: this.shown.map(s => s.id),
      toc: [...this.toc.querySelectorAll('.st-toc-sec')].map(b => (b as HTMLElement).dataset.sec!),
      empty: !this.emptyEl.hidden,
      rows: [...this.rows.values()].map(r => ({
        key: r.entry.key, value: r.entry.value, configured: r.entry.configured, visible: !r.el.hidden,
        modifiedBar: getComputedStyle(r.el, '::before').opacity !== '0' && r.el.classList.contains('modified'),
        error: r.error, disabled: r.control.disabled, text: r.control instanceof HTMLButtonElement ? String(r.control.getAttribute('aria-checked')) : r.control.value,
      })),
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.searchTimer) clearTimeout(this.searchTimer)
    for (const r of this.rows.values()) if (r.timer) clearTimeout(r.timer)
    for (const d of this.disposers.splice(0)) d.dispose()
  }
}

/** The page's sections plus the action-only ones, each after its node's own sections. */
function withActionSections(sections: PageSection[]): PageSection[] {
  const out = [...sections]
  for (const a of ACTION_ONLY) {
    const id = `${a.node}/${a.title}`
    if (out.some(s => s.id === id)) continue
    const last = out.map(s => s.node).lastIndexOf(a.node)
    const nodeTitle = out[last]?.nodeTitle ?? a.node
    out.splice(last + 1, 0, { id, node: a.node, nodeTitle, title: a.title, entries: [] })
  }
  return out
}

function paintRuns(el: HTMLElement, text: string, ranges: Range[]): void {
  el.replaceChildren(...rangeRuns(text, ranges).map(r => {
    if (!r.hit) return document.createTextNode(r.text)
    const m = document.createElement('mark'); m.textContent = r.text; return m
  }))
}

/** The page's tab: a gear, the title, the ×; right-click opens the menu. */
export class SettingsTab implements ITabRenderer {
  readonly element: HTMLElement
  private api: DockviewPanelApi | undefined
  private readonly host: SettingsHost

  constructor(host: SettingsHost) {
    this.host = host
    this.element = document.createElement('div')
    this.element.className = 'tether-tab settings'
    const kind = document.createElement('span'); kind.className = 'kind'; kind.append(icon('gear-six'))
    const text = document.createElement('span'); text.className = 'text'; text.textContent = SETTINGS_TITLE
    const close = document.createElement('button')
    close.className = 'close'; close.title = 'Fechar'; close.setAttribute('aria-label', 'Fechar configurações')
    close.append(icon('x'))
    close.addEventListener('pointerdown', ev => ev.stopPropagation())
    close.addEventListener('click', ev => { ev.stopPropagation(); if (this.api) this.host.onClose(this.api.id) })
    this.element.append(kind, text, close)
    this.element.addEventListener('contextmenu', ev => { ev.preventDefault(); ev.stopPropagation(); if (this.api) this.host.onTabMenu(this.api.id, ev) })
    this.element.title = `${SETTINGS_TITLE}\nTodas as configurações do Tether e das extensões`
  }

  init(params: TabPartInitParameters): void {
    this.api = params.api
    this.element.dataset.slot = params.api.id
  }

  dispose(): void {}
}
