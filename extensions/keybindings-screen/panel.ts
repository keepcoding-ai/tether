// The "Atalhos de teclado" screen (docs/keybindings-preview.html, section B): a TAB of the active group, like VS
// Code's, so it stays open while the keys are tried in another pane. Every command of the registry, bound or not;
// search by name, id or key; "Gravar teclas" searches by the key pressed; double-click (Enter, Ctrl+K Ctrl+K)
// records a new key, chord of two allowed, with the conflict shown and RESOLVED on the act (the other command loses
// the key; ↺ gives it back) and the terminal's use of the key told; the chips Janela · Terminal · Nota are where the
// binding is the app's (Terminal off = the key passes to the program); ↺ per row and "Restaurar todos os padrões…".
// Fixed rows are shown, not edited: the editor's (Monaco), the native menu's, the pane's own clipboard keys.
// Everything the person changes becomes the smallest keybindings.json (keybindings-rules.ts) through the host.
import type { DockviewPanelApi, GroupPanelPartInitParameters, IContentRenderer, ITabRenderer, TabPartInitParameters } from 'dockview-core'
import { chordHtml, escapeHtml } from '../../app/renderer/chord-pill.ts'
import { prefixIssue, type FixedBinding, type KbCommandInfo, type KeybindingsFileInfo } from '../../app/renderer/keybindings-rules.ts'
import { icon } from '../../app/renderer/icons.ts'
import { chordLabel, chordOfEvent, defaultWhere, isModifierOnly, keysLabel, PREFIX_COMMAND, resolvedDefaults, sameKeys, WHERE_ALL, WHERE_LABEL, type Chord, type Keybinding, type KeyTable, type Where } from '../../app/renderer/shortcuts.ts'
import { KEYBINDINGS_TITLE } from '../../app/shared/keybindings.ts'


export interface KeybindingsHost {
  commands(): KbCommandInfo[]
  table(): KeyTable
  /** The screen changed the table: the host writes the file and applies it (the screen re-renders on `refresh`). */
  apply(bindings: Keybinding[]): void
  resetAll(): void
  /** The file as main last read it: where it is, whether it failed to parse, the entries skipped. */
  fileState(): KeybindingsFileInfo
  /** "Abrir keybindings.json": in a note tab beside this one. */
  openFile(): void
  fixedBindings(): FixedBinding[]
  onTabMenu(id: string, ev: MouseEvent): void
  onClose(id: string): void
}

type Filter = 'all' | 'bound' | 'unbound' | 'user' | 'conflict' | 'pass'

interface Row { c: KbCommandInfo; b: Keybinding | null; fixed?: FixedBinding; index: number }

const GROUP_ORDER = ['Painel', 'Quadro', 'Mesa', 'Gaveta', 'Nota', 'Editor', 'Aparência', 'App', 'Terminal']

/** What the terminal does with a key (bash / PSReadLine / Claude Code): told when the Terminal chip is on. */
const TERMINAL_USE: Record<string, string> = {
  'ctrl+a': 'início da linha (bash, Claude Code)', 'ctrl+b': 'volta um caractere (bash); tarefa de fundo (Claude Code)', 'ctrl+c': 'interrompe (^C)',
  'ctrl+d': 'fim de entrada / sai do shell', 'ctrl+e': 'fim da linha', 'ctrl+f': 'avança um caractere', 'ctrl+g': 'abre o prompt no editor externo (Claude Code)',
  'ctrl+h': 'apaga um caractere', 'ctrl+i': 'Tab', 'ctrl+j': 'nova linha (Claude Code) / Enter', 'ctrl+k': 'apaga até o fim da linha (bash, Claude Code)',
  'ctrl+l': 'limpa a tela', 'ctrl+m': 'Enter', 'ctrl+n': 'próximo comando do histórico (bash; a seta ↓ faz o mesmo)', 'ctrl+o': 'modo detalhado do Claude Code',
  'ctrl+p': 'comando anterior do histórico (bash; a seta ↑ faz o mesmo)', 'ctrl+q': 'retoma a saída (XON)', 'ctrl+r': 'busca no histórico (bash, PowerShell, Claude Code)',
  'ctrl+s': 'congela a saída (XOFF)', 'ctrl+t': 'lista de tarefas (Claude Code); troca caracteres (bash)', 'ctrl+u': 'apaga até o início da linha',
  'ctrl+v': 'colar / imagem da área de transferência (Claude Code)', 'ctrl+w': 'apaga a palavra anterior (bash, PowerShell, Claude Code)', 'ctrl+x': 'prefixo do bash',
  'ctrl+y': 'cola o último trecho apagado', 'ctrl+z': 'suspende o processo', 'ctrl+-': 'desfazer (bash)', 'ctrl+\\': 'SIGQUIT: mata o programa em primeiro plano (capturar protege)',
  'f2': 'alterna a visão de previsão do PSReadLine', 'f1': 'ajuda do comando no PSReadLine', 'ctrl+shift+←': 'seleciona a palavra anterior (PSReadLine)', 'ctrl+shift+→': 'seleciona a palavra seguinte (PSReadLine)',
  'alt+←': 'palavra anterior (bash)', 'alt+→': 'palavra seguinte (bash)',
}
function terminalUse(first: Chord): string | undefined {
  return TERMINAL_USE[chordLabel(first, false).toLowerCase()]
}

const norm = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
const sameWhere = (a: readonly Where[], b: readonly Where[]): boolean => a.length === b.length && a.every(w => b.includes(w))

/** What a test reads of the screen. */
export interface KeybindingsSnapshot {
  id: string
  query: string
  recordSearch: boolean
  filter: Filter
  banner: string | undefined
  rows: { command: string; keys: string | null; where: Where[]; user: boolean; conflict: boolean; fixed?: string }[]
  selected: string | undefined
  dialog: { command: string; keys: string; where: Where[]; conflict: string; terminal: string } | undefined
  overrides: number
}

export class KeybindingsPanel implements IContentRenderer {
  readonly element: HTMLElement
  id = ''
  private api: DockviewPanelApi | undefined
  private readonly host: KeybindingsHost
  private readonly disposers: Array<{ dispose(): void }> = []
  private disposed = false
  // state
  private query = ''
  private filter: Filter = 'all'
  private recordSearch = false
  private recordKeys: Chord[] = []
  private recordAt = 0
  private selected = 0
  private visible: Row[] = []
  private defaults = resolvedDefaults()
  private veil: HTMLElement
  private list: HTMLElement
  private input: HTMLInputElement
  private live: HTMLElement
  private banner: HTMLElement
  private count: HTMLElement
  private foot: HTMLElement
  private toastEl: HTMLElement
  private toastTimer: ReturnType<typeof setTimeout> | undefined
  private dialogState: KeybindingsSnapshot['dialog']

  constructor(host: KeybindingsHost) {
    this.host = host
    this.element = document.createElement('div')
    this.element.className = 'kb-pane'
    this.element.dataset.keybindings = 'pane'
    this.element.innerHTML = `
      <div class="kb" tabindex="-1">
        <div class="kb-head">
          <div class="kb-row">
            <div class="kb-search">
              <span class="mag"></span>
              <input class="kb-q" placeholder="Buscar por nome, id ou tecla (ex.: mesa, ctrl+k, fechar)" autocomplete="off" spellcheck="false" aria-label="Buscar atalho">
              <div class="kb-live" tabindex="0" hidden></div>
              <button type="button" class="ib kb-clear" title="Limpar (Esc)" hidden></button>
              <button type="button" class="ib kb-rec" aria-pressed="false" title="Gravar teclas: tecle o atalho para buscar por ele (Alt+K)"></button>
            </div>
            <label class="kb-sel"><select class="kb-filter" aria-label="Filtro">
              <option value="all">Todos</option><option value="bound">Com atalho</option><option value="unbound">Sem atalho</option>
              <option value="user">Alterados por você</option><option value="conflict">Em conflito</option><option value="pass">Que passam ao terminal</option>
            </select><span class="caret"></span></label>
          </div>
          <div class="kb-banner err" hidden></div>
          <div class="kb-links"><span class="kb-count"></span><span class="sp"></span>
            <button type="button" class="lnk" data-act="open-json"></button>
            <button type="button" class="lnk" data-act="reset-all"></button>
          </div>
        </div>
        <div class="kb-list" tabindex="0" role="grid" aria-label="Atalhos"></div>
        <div class="kb-foot"><span><kbd>↑</kbd><kbd>↓</kbd> navega</span><span><kbd>Enter</kbd> grava</span><span class="hide-n"><kbd>Delete</kbd> tira o atalho</span><span class="hide-n"><kbd>Ctrl+K</kbd><kbd>Ctrl+K</kbd> grava</span><span class="sp"></span><span class="kb-foot-src"></span></div>
        <div class="kb-veil" hidden></div>
        <div class="kb-toast" hidden></div>
      </div>`
    const q = <T extends Element>(sel: string): T => this.element.querySelector<T>(sel)!
    q('.mag').replaceWith(icon('magnifying-glass', 'mag'))
    q('.kb-clear').append(icon('x'))
    q('.kb-rec').append(icon('keyboard'))
    q('.caret').replaceWith(icon('caret-down', 'caret'))
    q('[data-act="open-json"]').append(icon('note-pencil'), document.createTextNode('Abrir keybindings.json'))
    q('[data-act="reset-all"]').append(icon('arrow-counter-clockwise'), document.createTextNode('Restaurar todos os padrões…'))
    this.veil = q('.kb-veil'); this.list = q('.kb-list'); this.input = q('.kb-q'); this.live = q('.kb-live')
    this.banner = q('.kb-banner'); this.count = q('.kb-count'); this.foot = q('.kb-foot-src'); this.toastEl = q('.kb-toast')
    this.wire()
  }

  init(params: GroupPanelPartInitParameters): void {
    this.api = params.api
    this.id = params.api.id
    this.element.dataset.keybindingsId = this.id
    this.render()
    this.disposers.push(params.api.onDidActiveChange(({ isActive }) => { if (isActive) requestAnimationFrame(() => this.focus()) }))
  }

  focus(): void {
    if (this.disposed) return
    if (!this.veil.hidden) { this.veil.querySelector<HTMLElement>('.cap')?.focus(); return }
    this.list.focus()
  }

  /** The table changed (the file, another screen, a reset): redraw. */
  refresh(): void {
    this.defaults = resolvedDefaults()
    this.render()
  }

  // ---------- data ----------

  private get table(): KeyTable { return this.host.table() }

  private isUser(id: string): boolean {
    const def = this.defaults.filter(b => b.command === id)
    const now = this.table.bindingsOf(id)
    return def.length !== now.length || !def.every(d => now.some(n => sameKeys(n.keys, d.keys) && sameWhere(n.where, d.where)))
  }

  private overridesCount(): number {
    const ids = new Set([...this.defaults.map(b => b.command), ...this.table.bindings.map(b => b.command), ...this.host.commands().map(c => c.id)])
    let n = 0
    for (const id of ids) if (this.isUser(id)) n++
    return n
  }

  private conflictOf(b: Keybinding | null, command: string): Keybinding[] {
    return b ? this.table.usersOf(b.keys, b.where, command) : []
  }

  private rows(): Row[] {
    const out: Row[] = []
    const commands = this.host.commands()
    const prefixInfo: KbCommandInfo = { id: PREFIX_COMMAND, title: 'Ctrl+K (prefixo dos atalhos de duas teclas)', group: 'App' }
    for (const c of [...commands, prefixInfo]) {
      const bs = this.table.bindingsOf(c.id)
      if (!bs.length) out.push({ c, b: null, index: -1 })
      bs.forEach((b, i) => out.push({ c, b, index: i }))
    }
    for (const f of this.host.fixedBindings()) {
      out.push({ c: { id: f.command, title: f.title, group: f.group }, b: f.keys ? { keys: f.keys, command: f.command, where: f.where, source: 'default' } : null, fixed: f, index: -1 })
    }
    const order = (g?: string): number => { const i = GROUP_ORDER.indexOf(g ?? ''); return i === -1 ? GROUP_ORDER.length : i }
    return out.map((r, i) => ({ r, i })).sort((a, b) => order(a.r.c.group) - order(b.r.c.group) || a.i - b.i).map(x => x.r)
  }

  private matches(r: Row): boolean {
    const conf = this.conflictOf(r.b, r.c.id)
    if (this.filter === 'bound' && !r.b) return false
    if (this.filter === 'unbound' && r.b) return false
    if (this.filter === 'user' && (r.fixed || !this.isUser(r.c.id))) return false
    if (this.filter === 'conflict' && !conf.length) return false
    if (this.filter === 'pass' && !(r.b && !r.b.where.includes('terminal') && !r.fixed)) return false
    if (this.recordSearch) {
      if (!this.recordKeys.length) return true
      if (!r.b) return false
      return this.recordKeys.length === 1 ? sameKeys([r.b.keys[0]!], this.recordKeys) : sameKeys(r.b.keys, this.recordKeys)
    }
    const nq = norm(this.query).trim()
    if (!nq) return true
    const hay = norm(`${r.c.title} ${r.c.id} ${r.b ? keysLabel(r.b.keys, false) : ''} ${r.fixed?.label ?? ''}`)
    return nq.split(/\s+/).every(w => hay.includes(w))
  }

  // ---------- rendering ----------

  private render(): void {
    if (this.disposed) return
    const all = this.rows()
    this.visible = all.filter(r => this.matches(r))
    const overrides = this.overridesCount()
    const file = this.host.fileState()
    this.count.innerHTML = `<b>${this.visible.length}</b> de ${all.length} atalhos · <b>${overrides}</b> alterado${overrides === 1 ? '' : 's'}`
    this.foot.textContent = overrides ? `keybindings.json · ${overrides}` : 'padrões'
    this.foot.title = file.path
    const problems = file.error ? [`<b>keybindings.json</b> tem um erro${file.error.line ? ` na linha ${file.error.line}` : ''}: ${escapeHtml(file.error.message)}. Os padrões valem até você corrigir.`] : file.warnings.map(w => `<b>keybindings.json</b>: ${escapeHtml(w)}`)
    this.banner.hidden = !problems.length
    this.banner.className = `kb-banner ${file.error ? 'err' : 'warn'}`
    if (problems.length) {
      this.banner.replaceChildren(icon('warning'))
      const s = document.createElement('span'); s.innerHTML = problems.join('<br>')
      const sp = document.createElement('span'); sp.className = 'sp'
      const b = document.createElement('button'); b.type = 'button'; b.className = 'lnk'; b.dataset.act = 'open-json'; b.textContent = 'Abrir o arquivo'
      b.addEventListener('click', () => this.host.openFile())
      this.banner.append(s, sp, b)
    }
    const words = this.recordSearch ? [] : norm(this.query).trim().split(/\s+/).filter(Boolean)
    if (!this.visible.length) {
      const what = this.recordSearch ? keysLabel(this.recordKeys) : this.query || 'esse filtro'
      this.list.innerHTML = `<div class="kb-empty">Nenhum atalho com <b>${escapeHtml(what)}</b>.<br>${this.recordSearch ? 'Tecle outra combinação ou desligue "Gravar teclas".' : 'Para achar pela tecla, ligue <b>Gravar teclas</b> e tecle o atalho.'}</div>`
      return
    }
    this.selected = Math.min(this.selected, this.visible.length - 1)
    let html = '<table class="kbt"><thead><tr><th>Comando</th><th>Atalho</th><th class="c-where">Onde vale</th><th class="c-src">Origem</th><th class="c-grp">Grupo</th><th></th></tr></thead><tbody>'
    let lastG: string | undefined
    this.visible.forEach((r, i) => {
      const g = r.c.group ?? 'Outros'
      if (g !== lastG && !this.query && !this.recordSearch) { html += `<tr class="sec"><td colspan="6">${escapeHtml(g)}</td></tr>`; lastG = g }
      const conf = this.conflictOf(r.b, r.c.id)
      const pre = r.b && !r.fixed ? prefixIssue(this.table.bindings, r.b.keys, r.b.where, r.c.id) : undefined
      const user = !r.fixed && this.isUser(r.c.id)
      const selos = (r.fixed ? ` <span class="selo editor">${r.fixed.source}</span>` : '') + (user ? ' <span class="selo user">você</span>' : '')
      const keyCell = r.b
        ? chordHtml(r.b.keys)
          + (conf.length ? `<span class="warn" title="Também em: ${escapeHtml(conf.map(x => this.titleOf(x.command)).join(', '))}">${icon('warning').outerHTML}</span>` : '')
          + (pre ? `<span class="warn" title="${pre.kind === 'is-prefix' ? 'É prefixo de atalhos de duas teclas: um atalho simples aqui fica à sombra deles' : 'A primeira tecla já é um atalho simples: ele passa a ficar à sombra deste chord'}">${icon('warning').outerHTML}</span>` : '')
        : r.fixed?.label ? `<span class="fixed-label">${escapeHtml(r.fixed.label)}</span>` : '<span class="none">sem atalho</span>'
      const where = r.b
        ? `<span class="sc">${WHERE_ALL.map(w => `<button type="button" data-w="${w}" aria-pressed="${r.b!.where.includes(w)}" class="${w === 'terminal' ? 'pass' : ''}" ${r.fixed ? 'disabled' : ''} title="${w === 'terminal' && !r.b!.where.includes(w) ? 'Desligado: a tecla passa ao programa do terminal' : WHERE_LABEL[w]}">${WHERE_LABEL[w]}</button>`).join('')}</span>`
        : '<span class="dim">—</span>'
      const src = r.fixed ? (r.fixed.source === 'editor' ? 'Monaco' : r.fixed.source === 'nativo' ? 'Menu nativo' : 'Painel') : user ? 'Você' : 'Padrão'
      const acts = r.fixed
        ? `<button type="button" class="ib" disabled title="Tecla fixa por ora (${escapeHtml(src)})">${icon('pencil-simple').outerHTML}</button>`
        : `<button type="button" class="ib" data-a="edit" title="Gravar atalho (Enter)">${icon('pencil-simple').outerHTML}</button><button type="button" class="ib" data-a="add" title="Adicionar outro atalho">${icon('plus').outerHTML}</button>${r.b ? `<button type="button" class="ib" data-a="remove" title="Tirar este atalho (Delete)">${icon('minus-circle').outerHTML}</button>` : ''}${user ? `<button type="button" class="ib always" data-a="reset" title="Voltar ao padrão">${icon('arrow-counter-clockwise').outerHTML}</button>` : ''}`
      html += `<tr class="r${i === this.selected ? ' sel' : ''}${conf.length ? ' conflict' : ''}" data-i="${i}" data-command="${escapeHtml(r.c.id)}" role="row"><td class="cmd"><div class="t"><span class="nm${r.c.danger ? ' danger' : ''}">${hl(r.c.title, words)}</span>${selos}</div><span class="id">${hl(r.c.id, words)}</span></td><td class="key">${keyCell}</td><td class="where">${where}</td><td class="src">${src}</td><td class="grp dim">${escapeHtml(g)}</td><td class="act">${acts}</td></tr>`
    })
    html += '</tbody></table>'
    this.list.innerHTML = html
    const selRow = this.list.querySelector('tr.sel')
    if (selRow && document.activeElement === this.list) selRow.scrollIntoView({ block: 'nearest' })
  }

  private titleOf(id: string): string {
    return this.host.commands().find(c => c.id === id)?.title ?? (id === PREFIX_COMMAND ? 'Ctrl+K (prefixo)' : id)
  }

  private select(i: number): void {
    this.selected = i
    this.list.querySelectorAll<HTMLElement>('tr.r').forEach(tr => tr.classList.toggle('sel', Number(tr.dataset.i) === i))
    this.list.querySelector('tr.sel')?.scrollIntoView({ block: 'nearest' })
  }

  private toast(html: string): void {
    this.toastEl.innerHTML = html
    this.toastEl.hidden = false
    if (this.toastTimer) clearTimeout(this.toastTimer)
    this.toastTimer = setTimeout(() => { this.toastEl.hidden = true }, 3400)
  }

  // ---------- wiring ----------

  private wire(): void {
    const el = this.element
    this.input.addEventListener('input', () => { this.query = this.input.value; this.selected = 0; el.querySelector<HTMLElement>('.kb-clear')!.hidden = !this.query; this.render() })
    this.input.addEventListener('keydown', ev => {
      if (ev.key === 'Escape' && this.query) { ev.stopPropagation(); this.clearSearch() }
      else if (ev.key === 'ArrowDown') { ev.preventDefault(); this.list.focus() }
      else if (ev.altKey && ev.code === 'KeyK') { ev.preventDefault(); ev.stopPropagation(); this.setRecordSearch(true) }
    })
    el.querySelector('.kb-clear')!.addEventListener('click', () => { this.clearSearch(); this.input.focus() })
    el.querySelector<HTMLSelectElement>('.kb-filter')!.addEventListener('change', ev => { this.filter = (ev.target as HTMLSelectElement).value as Filter; this.selected = 0; this.render() })
    el.querySelector('.kb-rec')!.addEventListener('click', () => this.setRecordSearch(!this.recordSearch))
    this.live.addEventListener('keydown', ev => {
      if (ev.key === 'Escape') { ev.stopPropagation(); this.setRecordSearch(false); return }
      if (isModifierOnly(ev.code)) return
      ev.preventDefault(); ev.stopPropagation()
      const now = Date.now()
      const k = chordOfEvent(ev)
      // A second key within 1.5 s after a first one extends the search to the chord.
      this.recordKeys = this.recordKeys.length === 1 && now - this.recordAt < 1500 ? [this.recordKeys[0]!, k] : [k]
      this.recordAt = now
      this.live.innerHTML = `${chordHtml(this.recordKeys)} <span class="ph">Esc desliga</span>`
      this.selected = 0
      this.render()
    })
    el.querySelector('.kb-links [data-act="open-json"]')!.addEventListener('click', () => this.host.openFile())
    el.querySelector('.kb-links [data-act="reset-all"]')!.addEventListener('click', () => { if (!this.overridesCount()) { this.toast('Nada alterado: tudo já está no padrão'); return } this.openConfirmReset() })
    this.list.addEventListener('click', ev => {
      const tr = (ev.target as HTMLElement).closest<HTMLElement>('tr.r')
      if (!tr) return
      this.selected = Number(tr.dataset.i)
      const r = this.visible[this.selected]
      if (!r) return
      const w = (ev.target as HTMLElement).closest<HTMLElement>('button[data-w]')
      if (w) { this.toggleWhere(r, w.dataset.w as Where); return }
      const a = (ev.target as HTMLElement).closest<HTMLElement>('button[data-a]')
      if (a) { this.act(a.dataset.a!, r); return }
      this.select(this.selected)
    })
    this.list.addEventListener('dblclick', ev => {
      const tr = (ev.target as HTMLElement).closest<HTMLElement>('tr.r')
      if (!tr || (ev.target as HTMLElement).closest('button')) return
      const r = this.visible[Number(tr.dataset.i)]
      if (r && !r.fixed) this.openRecord(r, 'edit')
    })
    this.list.addEventListener('keydown', ev => {
      const n = this.visible.length
      if (!n) return
      if (ev.key === 'ArrowDown') { ev.preventDefault(); this.select(Math.min(n - 1, this.selected + 1)) }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); this.select(Math.max(0, this.selected - 1)) }
      else if (ev.key === 'Home') { ev.preventDefault(); this.select(0) }
      else if (ev.key === 'End') { ev.preventDefault(); this.select(n - 1) }
      else if (ev.key === 'Enter') { ev.preventDefault(); this.recordSelected() }
      else if (ev.key === 'Delete') { ev.preventDefault(); const r = this.visible[this.selected]; if (r?.b && !r.fixed) this.act('remove', r) }
    })
    this.element.addEventListener('contextmenu', ev => { if ((ev.target as HTMLElement).closest('.kb-head, .kb-foot')) { ev.preventDefault(); this.host.onTabMenu(this.id, ev) } })
  }

  private clearSearch(): void {
    this.query = ''; this.input.value = ''
    this.element.querySelector<HTMLElement>('.kb-clear')!.hidden = true
    this.render()
  }

  private setRecordSearch(on: boolean): void {
    this.recordSearch = on
    this.recordKeys = []
    const search = this.element.querySelector<HTMLElement>('.kb-search')!
    this.element.querySelector<HTMLElement>('.kb-rec')!.setAttribute('aria-pressed', String(on))
    search.classList.toggle('rec', on)
    this.input.hidden = on
    this.live.hidden = !on
    this.query = ''; this.input.value = ''
    this.element.querySelector<HTMLElement>('.kb-clear')!.hidden = true
    if (on) { this.live.innerHTML = '<span class="ph">tecle o atalho…</span>'; this.live.focus() } else { this.live.innerHTML = ''; this.input.focus() }
    this.render()
  }

  /** Enter / Ctrl+K Ctrl+K: record the selected row. */
  recordSelected(): void {
    const r = this.visible[this.selected]
    if (r && !r.fixed) this.openRecord(r, 'edit')
  }

  private setBindings(command: string, list: Keybinding[], others?: Map<string, Keybinding[]>): void {
    const keep = this.table.bindings.filter(b => b.command !== command && !others?.has(b.command))
    const next = [...keep, ...list.map(b => ({ ...b, command }))]
    if (others) for (const [id, bs] of others) next.push(...bs.map(b => ({ ...b, command: id })))
    // Order: the defaults' order for what matches a default, then the rest (the user's), so hints keep the usual key first.
    const rank = (b: Keybinding): number => { const i = this.defaults.findIndex(d => d.command === b.command && sameKeys(d.keys, b.keys)); return i === -1 ? this.defaults.length : i }
    next.sort((a, b) => rank(a) - rank(b))
    this.host.apply(next)
    this.render()
  }

  private toggleWhere(r: Row, w: Where): void {
    if (!r.b || r.fixed) return
    const list = this.table.bindingsOf(r.c.id).map(b => ({ ...b, where: [...b.where] }))
    const b = list[r.index]!
    if (b.where.includes(w)) {
      if (b.where.length === 1) { this.toast('Um atalho vale em pelo menos um lugar: tire o atalho em vez disso'); return }
      b.where = b.where.filter(x => x !== w)
    } else b.where.push(w)
    this.setBindings(r.c.id, list)
    if (w === 'terminal') {
      const use = terminalUse(b.keys[0]!)
      this.toast(b.where.includes('terminal') ? `<b>${escapeHtml(chordLabel(b.keys[0]!))}</b> agora é do app também no terminal` : `<b>${escapeHtml(chordLabel(b.keys[0]!))}</b> passa ao programa do terminal${use ? ` (${escapeHtml(use)})` : ''}`)
    }
  }

  private act(a: string, r: Row): void {
    if (a === 'edit') this.openRecord(r, 'edit')
    else if (a === 'add') this.openRecord(r, 'add')
    else if (a === 'remove') { const list = this.table.bindingsOf(r.c.id).filter((_, i) => i !== r.index); this.setBindings(r.c.id, list); this.toast(`<b>${escapeHtml(r.c.title)}</b> ficou sem esse atalho (↺ volta ao padrão)`) }
    else if (a === 'reset') { this.setBindings(r.c.id, this.defaults.filter(b => b.command === r.c.id).map(b => ({ ...b, where: [...b.where] }))); this.toast(`<b>${escapeHtml(r.c.title)}</b> voltou ao padrão`) }
  }

  // ---------- dialogs ----------

  private openConfirmReset(): void {
    const v = this.veil
    v.hidden = false
    const n = this.overridesCount()
    v.innerHTML = `<div class="rec" role="dialog" aria-modal="true"><h3><span class="i"></span><span class="nm">Restaurar todos os padrões?</span></h3><p class="sub">${n} comando(s) voltam ao atalho padrão e <code>keybindings.json</code> fica vazio (<code>[]</code>). Não dá para desfazer pela tela.</p><div class="acts"><span class="sp"></span><button type="button" class="btn cancel" data-x="c">Cancelar <kbd>Esc</kbd></button><button type="button" class="btn primary warnb" data-x="ok">Restaurar <kbd>Enter</kbd></button></div></div>`
    v.querySelector('h3 .i')!.replaceWith(icon('arrow-counter-clockwise'))
    const close = (): void => { v.hidden = true; v.innerHTML = ''; v.onkeydown = null; this.list.focus() }
    v.querySelector<HTMLElement>('[data-x=c]')!.onclick = close
    v.querySelector<HTMLElement>('[data-x=ok]')!.onclick = () => { close(); this.host.resetAll(); this.render(); this.toast('Todos os atalhos voltaram ao padrão') }
    v.onkeydown = ev => { ev.stopPropagation(); if (ev.key === 'Escape') close(); if (ev.key === 'Enter') v.querySelector<HTMLElement>('[data-x=ok]')!.click() }
    v.querySelector<HTMLElement>('[data-x=ok]')!.focus()
  }

  /** The record dialog: a veil over the list, the keys typed into it, the conflict and the terminal's use shown, Enter assigns. */
  private openRecord(r: Row, mode: 'edit' | 'add'): void {
    const v = this.veil
    v.hidden = false
    const c = r.c
    const cur = mode === 'edit' ? r.b : null
    let chord: Chord[] = []
    let where: Where[] = cur ? [...cur.where] : [...WHERE_ALL]
    let whereTouched = false
    v.innerHTML = `<div class="rec" role="dialog" aria-modal="true" aria-label="Gravar atalho">
      <h3><span class="i"></span><span class="nm">${mode === 'add' ? 'Outro atalho para' : 'Atalho para'} «${escapeHtml(c.title)}»</span></h3>
      <p class="sub">${cur ? `Hoje: ${chordHtml(cur.keys)} · a nova combinação substitui esta.` : 'Este comando não tem atalho; tecle a combinação desejada.'}</p>
      <div class="cap" tabindex="0"><span class="ph">Pressione a combinação desejada…</span></div>
      <div class="msg warn conf" hidden></div>
      <div class="msg info term" hidden></div>
      <div class="where"><span>Onde vale:</span><span class="sc">${WHERE_ALL.map(w => `<button type="button" data-w="${w}" aria-pressed="${where.includes(w)}" class="${w === 'terminal' ? 'pass' : ''}">${WHERE_LABEL[w]}</button>`).join('')}</span><span class="where-note"></span></div>
      <div class="acts"><span class="hint"><span><kbd>Enter</kbd> confirma</span><span><kbd>Esc</kbd> cancela</span><span><kbd>Backspace</kbd> apaga</span></span><span class="sp"></span><button type="button" class="btn cancel" data-x="c">Cancelar</button><button type="button" class="btn primary" data-x="ok" disabled>Atribuir</button></div>
    </div>`
    v.querySelector('h3 .i')!.replaceWith(icon('keyboard'))
    const cap = v.querySelector<HTMLElement>('.cap')!, conf = v.querySelector<HTMLElement>('.conf')!, term = v.querySelector<HTMLElement>('.term')!
    const ok = v.querySelector<HTMLButtonElement>('[data-x=ok]')!, wn = v.querySelector<HTMLElement>('.where-note')!
    const close = (): void => { v.hidden = true; v.innerHTML = ''; v.onkeydown = null; this.dialogState = undefined; this.list.focus() }
    const paintWhere = (): void => { v.querySelectorAll<HTMLElement>('.where button').forEach(b => b.setAttribute('aria-pressed', String(where.includes(b.dataset.w as Where)))) }
    const paint = (): void => {
      if (!chord.length) {
        cap.className = 'cap'; cap.innerHTML = '<span class="ph">Pressione a combinação desejada…</span>'
        conf.hidden = true; term.hidden = true; ok.disabled = true; ok.textContent = 'Atribuir'; wn.textContent = ''
        this.dialogState = { command: c.id, keys: '', where: [...where], conflict: '', terminal: '' }
        return
      }
      cap.className = 'cap live'
      cap.innerHTML = chordHtml(chord) + (chord.length === 1 ? '<span class="wait">aguardando a 2ª tecla (opcional)… <kbd>Enter</kbd> confirma só esta</span>' : '')
      if (!whereTouched && (!cur || mode === 'add')) where = defaultWhere(chord[0]!)
      paintWhere()
      wn.textContent = defaultWhere(chord[0]!).length < 3 && !where.includes('terminal') ? 'Ctrl+letra pura: por padrão passa ao terminal' : ''
      const users = this.table.usersOf(chord, where, c.id)
      const pre = prefixIssue(this.table.bindings, chord, where, c.id)
      const parts: string[] = []
      if (users.length) parts.push(`<b>Já usado por «${escapeHtml(this.titleOf(users[0]!.command))}»</b> (${users[0]!.where.map(w => WHERE_LABEL[w]).join(', ')})${users.length > 1 ? ` e mais ${users.length - 1}` : ''}. Ao atribuir, ${users.length > 1 ? 'eles ficam' : 'ele fica'} sem esse atalho (↺ devolve).`)
      if (pre?.kind === 'is-prefix') parts.push(`<b>${escapeHtml(keysLabel(chord))} é prefixo</b> de ${pre.commands.length} atalho(s) de duas teclas (${escapeHtml(pre.commands.slice(0, 2).map(id => this.titleOf(id)).join(', '))}${pre.commands.length > 2 ? '…' : ''}). Um atalho simples aqui fica à sombra deles.`)
      if (pre?.kind === 'first-is-single') parts.push(`<b>${escapeHtml(chordLabel(chord[0]!))} já é um atalho simples</b> («${escapeHtml(this.titleOf(pre.commands[0]!))}»): ele deixa de disparar sozinho para virar prefixo.`)
      conf.hidden = !parts.length
      conf.replaceChildren(icon('warning'))
      const span = document.createElement('span'); span.innerHTML = parts.join('<span class="pre"></span>'); conf.append(span)
      const use = terminalUse(chord[0]!)
      term.hidden = !(use && where.includes('terminal'))
      if (use) { term.replaceChildren(icon('info')); const s = document.createElement('span'); s.innerHTML = `No terminal, <b>${escapeHtml(chordLabel(chord[0]!))}</b> é: ${escapeHtml(use)}. Com "Terminal" ligado, o programa deixa de receber essa tecla.<span class="pre">Desligue o chip Terminal para deixá-la passar.</span>`; term.append(s) }
      ok.disabled = false
      const first = users[0] ? this.titleOf(users[0].command) : ''
      ok.innerHTML = users.length ? `Atribuir e tirar de «${escapeHtml(first.length > 22 ? `${first.slice(0, 22)}…` : first)}» <kbd>Enter</kbd>` : 'Atribuir <kbd>Enter</kbd>'
      ok.className = `btn primary${users.length ? ' warnb' : ''}`
      this.dialogState = { command: c.id, keys: keysLabel(chord, false), where: [...where], conflict: conf.hidden ? '' : conf.textContent ?? '', terminal: term.hidden ? '' : term.textContent ?? '' }
    }
    const commit = (): void => {
      if (!chord.length) return
      const keys = chord
      const others = new Map<string, Keybinding[]>()
      for (const u of this.table.usersOf(keys, where, c.id)) {
        if (!others.has(u.command)) others.set(u.command, this.table.bindingsOf(u.command).filter(b => !(sameKeys(b.keys, keys) && b.where.some(w => where.includes(w)))))
      }
      const list = this.table.bindingsOf(c.id).map(b => ({ ...b, where: [...b.where] }))
      const binding: Keybinding = { keys, command: c.id, where: [...where], source: 'user' }
      if (mode === 'edit' && cur) list[r.index] = binding; else list.push(binding)
      close()
      this.filter = 'all'; this.element.querySelector<HTMLSelectElement>('.kb-filter')!.value = 'all'
      this.setBindings(c.id, list, others)
      this.toast(`<b>${escapeHtml(c.title)}</b> agora é ${chordHtml(keys)}`)
    }
    cap.addEventListener('keydown', ev => {
      ev.preventDefault(); ev.stopPropagation()
      if (ev.key === 'Escape') { close(); return }
      if (ev.key === 'Enter' && !ev.ctrlKey && !ev.altKey && !ev.shiftKey && !ev.metaKey) { if (!ok.disabled) commit(); return }
      if (ev.key === 'Backspace' && !ev.ctrlKey && !ev.altKey && !ev.shiftKey && !ev.metaKey) { chord.pop(); paint(); return }
      if (isModifierOnly(ev.code)) return
      if (chord.length >= 2) chord = []
      chord.push(chordOfEvent(ev))
      paint()
    })
    v.querySelectorAll<HTMLElement>('.where button').forEach(b => { b.onclick = () => {
      const w = b.dataset.w as Where
      if (where.includes(w)) { if (where.length === 1) return; where = where.filter(x => x !== w) } else where = [...where, w]
      whereTouched = true
      paintWhere()
      if (chord.length) paint()
      cap.focus()
    } })
    v.querySelector<HTMLElement>('[data-x=c]')!.onclick = close
    ok.onclick = commit
    v.onkeydown = ev => { ev.stopPropagation(); if (ev.key === 'Escape' && ev.target !== cap) close() }
    paint()
    cap.focus()
  }

  // ---------- tests ----------

  snapshot(): KeybindingsSnapshot {
    const file = this.host.fileState()
    return {
      id: this.id, query: this.query, recordSearch: this.recordSearch, filter: this.filter,
      banner: this.banner.hidden ? undefined : this.banner.textContent ?? '',
      rows: this.visible.map(r => ({ command: r.c.id, keys: r.b ? keysLabel(r.b.keys, false) : null, where: r.b ? [...r.b.where] : [], user: !r.fixed && this.isUser(r.c.id), conflict: this.conflictOf(r.b, r.c.id).length > 0, ...(r.fixed ? { fixed: r.fixed.source } : {}) })),
      selected: this.visible[this.selected]?.c.id,
      dialog: this.veil.hidden ? undefined : this.dialogState,
      overrides: this.overridesCount(),
      ...(file.error ? {} : {}),
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.toastTimer) clearTimeout(this.toastTimer)
    for (const d of this.disposers.splice(0)) d.dispose()
  }
}

function hl(text: string, words: string[]): string {
  let out = escapeHtml(text)
  for (const w of words) {
    if (!w) continue
    const re = new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig')
    out = out.replace(re, '<mark>$1</mark>')
  }
  return out
}

/** The screen's tab: a keyboard, the title, the ×; right-click opens the menu. */
export class KeybindingsTab implements ITabRenderer {
  readonly element: HTMLElement
  private api: DockviewPanelApi | undefined
  private readonly host: KeybindingsHost

  constructor(host: KeybindingsHost) {
    this.host = host
    this.element = document.createElement('div')
    this.element.className = 'tether-tab keybindings'
    const kind = document.createElement('span'); kind.className = 'kind'; kind.append(icon('keyboard'))
    const text = document.createElement('span'); text.className = 'text'; text.textContent = KEYBINDINGS_TITLE
    const close = document.createElement('button')
    close.className = 'close'; close.title = 'Fechar'; close.setAttribute('aria-label', 'Fechar atalhos de teclado')
    close.append(icon('x'))
    close.addEventListener('pointerdown', ev => ev.stopPropagation())
    close.addEventListener('click', ev => { ev.stopPropagation(); if (this.api) this.host.onClose(this.api.id) })
    this.element.append(kind, text, close)
    this.element.addEventListener('contextmenu', ev => { ev.preventDefault(); ev.stopPropagation(); if (this.api) this.host.onTabMenu(this.api.id, ev) })
    this.element.title = `${KEYBINDINGS_TITLE}\nTodos os comandos e as teclas deles; duplo clique numa linha grava outra tecla`
  }

  init(params: TabPartInitParameters): void {
    this.api = params.api
    this.element.dataset.slot = params.api.id
  }

  dispose(): void {}
}
