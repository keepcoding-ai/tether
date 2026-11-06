// The command palette (Ctrl+Shift+P; the default mode an extension registers, Ctrl+P's quick open, uses the same box): a box at the top of the
// window with a search field and the commands the registry offers right now, ranked by palette-rules.ts.
// Keys: type to filter, ↑/↓ (wrapping) and PageUp/PageDown move, Enter runs, Esc closes, a click on an item
// runs it, a click outside closes. The chords of the two modes switch the mode while the box is open. The
// matched ranges are highlighted, the key hint sits at the right of each row; the order is VS Code's: the
// recently used first, then the others by title, under two separators. A modal <dialog>, so the terminals get no key while it is up; the backdrop is
// clear (the box is a tool over the work, the way VS Code shows it), and the look is the app's dialog language.
import type { CommandRegistry } from './commands.ts'
import { icon, ICON_NAMES, type IconName } from './icons.ts'
import { initialInput, parsePaletteInput, rankCommands, type PaletteMode, type RankedCommand } from './palette-rules.ts'
import { shortcutOf } from './shortcuts.ts'
import { rangeRuns } from './word-filter.ts'

const PAGE = 8
const ICON_SET = new Set<string>(ICON_NAMES)

/** Commands name icons as strings (the registry stays pure); an unknown name falls back to a neutral mark. */
function iconEl(name: string): SVGSVGElement {
  return icon((ICON_SET.has(name) ? name : 'question') as IconName)
}

/** While a mode's list is still being read, the box asks again this often. */
export const PENDING_POLL_MS = 250

/** The empty box when no extension registered a default mode. */
export const COMMANDS_HINT = 'Digite > para procurar um comando.'

/** One answer of a mode's search, ready to be shown (the mode keeps what it needs to draw it). */
export interface PaletteSearch {
  /** The list is still being read: the box asks again shortly with the same text. */
  pending: boolean
  /** Appends the rows (`li.pal-item[data-file]`, the path to open) under their separators; returns how many items there are. */
  render(list: HTMLUListElement, idBase: string): number
  /** The text under the list when it came back with no rows. */
  emptyText(): string
}

/**
 * What the box shows for text without `>` (VS Code's default quick access provider): the quick-open extension registers
 * one (TetherUi.palette.registerMode). Rows are files; a click or Enter opens one, Ctrl+Enter beside the focused pane.
 */
export interface PaletteModeProvider {
  id: string
  /** The command that opens the box in this mode: pressing its chord in the open box switches to the mode. */
  command: string
  /** The empty box, before anything is typed. */
  hint: string
  /** While the first answer is on its way. */
  searchingText: string
  /** The box opened in this mode: a fresh session. */
  begin(): void
  /** The box closed (any way): the session ends. */
  end(): void
  /** Searches; null when a newer search replaced this one. Never throws: a failure comes back as a search that says why. */
  search(text: string): Promise<PaletteSearch | null>
  /** Opens the file of a row. */
  open(path: string, side: boolean): Promise<void>
}

export class CommandPalette {
  private readonly input: HTMLInputElement
  private readonly list: HTMLUListElement
  private readonly empty: HTMLElement
  private ranked: RankedCommand[] = []
  private selected = 0
  private seq = 0
  readonly dialog: HTMLDialogElement
  private readonly registry: CommandRegistry
  /** The mode without `>`, when an extension registered one (quick open: files of the focused pane's folder). */
  private readonly provider: () => PaletteModeProvider | undefined
  private fileSeq = 0
  private pollTimer: ReturnType<typeof setTimeout> | undefined

  constructor(dialog: HTMLDialogElement, registry: CommandRegistry, provider: () => PaletteModeProvider | undefined = () => undefined) {
    this.dialog = dialog
    this.registry = registry
    this.provider = provider
    this.input = dialog.querySelector<HTMLInputElement>('input')!
    this.list = dialog.querySelector<HTMLUListElement>('ul')!
    this.empty = dialog.querySelector<HTMLElement>('.pal-empty')!
    this.input.addEventListener('input', () => this.render())
    this.input.addEventListener('keydown', ev => this.onKey(ev))
    // Esc: the browser raises `cancel` on a modal dialog; it is ours (the field keeps its text until the next opening).
    dialog.addEventListener('cancel', ev => { ev.preventDefault(); this.hide() })
    // The box closed (any way): the default mode's search session ends (quick open: main drops its list and cache).
    dialog.addEventListener('close', () => this.provider()?.end())
    // A click on the backdrop lands on the dialog element itself, never on a child.
    dialog.addEventListener('mousedown', ev => { if (ev.target === dialog) { ev.preventDefault(); this.hide() } })
    // Picking with the mouse must not move the focus out of the field.
    this.list.addEventListener('mousedown', ev => ev.preventDefault())
    this.list.addEventListener('click', ev => {
      const file = (ev.target as HTMLElement).closest<HTMLElement>('li[data-file]')
      if (file) { void this.openFile(file.dataset.file!, ev.ctrlKey || ev.metaKey); return }
      const li = (ev.target as HTMLElement).closest<HTMLElement>('li[data-command]')
      if (li) void this.runId(li.dataset.command!)
    })
  }

  get open(): boolean {
    return this.dialog.open
  }

  /** The mode the box is in right now (undefined while closed). */
  get mode(): PaletteMode | undefined {
    return this.dialog.open ? parsePaletteInput(this.input.value).mode : undefined
  }

  /** Opens the box in a mode (or switches the mode of an open box); `query` pre-fills the search ("Tema" for Ctrl+K Ctrl+T). */
  show(mode: PaletteMode, query = ''): void {
    this.input.value = initialInput(mode) + query
    if (!this.dialog.open) this.dialog.showModal()
    if (mode === 'default') { this.provider()?.begin(); delete this.dialog.dataset.mode } // a fresh list, not the last query's
    this.input.focus()
    this.input.setSelectionRange(this.input.value.length, this.input.value.length)
    this.render()
  }

  hide(): void {
    if (this.dialog.open) this.dialog.close()
  }

  /** The ids on screen, in order (tests): command ids, or file paths in Quick Open. */
  shown(): string[] {
    return [...this.list.querySelectorAll<HTMLElement>('li.pal-item')].map(li => li.dataset.command ?? li.dataset.file ?? '')
  }

  private onKey(ev: KeyboardEvent): void {
    const id = shortcutOf(ev)
    const provider = this.provider()
    if (id === 'palette.show' || (provider && id === provider.command)) {
      ev.preventDefault(); ev.stopPropagation()
      const mode: PaletteMode = id === 'palette.show' ? 'commands' : 'default'
      if (this.mode !== mode) this.show(mode)
      return
    }
    const n = this.list.querySelectorAll('li.pal-item').length
    switch (ev.key) {
      case 'ArrowDown': ev.preventDefault(); if (n) this.select((this.selected + 1) % n); break
      case 'ArrowUp': ev.preventDefault(); if (n) this.select((this.selected - 1 + n) % n); break
      case 'PageDown': ev.preventDefault(); if (n) this.select(Math.min(n - 1, this.selected + PAGE)); break
      case 'PageUp': ev.preventDefault(); if (n) this.select(Math.max(0, this.selected - PAGE)); break
      case 'Enter': ev.preventDefault(); {
        const li = this.list.querySelectorAll<HTMLElement>('li.pal-item')[this.selected]
        if (li?.dataset.file) void this.openFile(li.dataset.file, ev.ctrlKey || ev.metaKey) // Ctrl+Enter: beside
        else if (li?.dataset.command) void this.runId(li.dataset.command)
      } break
      case 'Escape': ev.preventDefault(); ev.stopPropagation(); this.hide(); break
      case 'Tab': ev.preventDefault(); break // the field is the only stop
      default: return
    }
  }

  private async runId(id: string): Promise<void> {
    // Closed first: the command may open a dialog of its own, and the focus goes back to where it was.
    this.hide()
    await this.registry.run(id, 'palette')
  }

  private async openFile(path: string, side: boolean): Promise<void> {
    this.hide()
    await this.provider()?.open(path, side)
  }

  /** Quick Open's rows: the search runs in main (a worker); an answer that arrives after a newer keystroke is dropped. */
  private async renderFiles(text: string): Promise<void> {
    const qo = this.provider()!
    const seq = ++this.fileSeq
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = undefined }
    const s = await qo.search(text)
    if (!s || seq !== this.fileSeq || !this.dialog.open || this.mode !== 'default') return
    this.list.replaceChildren()
    this.ranked = []
    const n = s.render(this.list, `pal-opt-${++this.seq}`)
    this.dialog.dataset.pending = String(s.pending)
    if (n === 0) {
      this.empty.textContent = s.emptyText()
      this.empty.hidden = false
      this.input.removeAttribute('aria-activedescendant')
    } else {
      this.empty.hidden = true
      this.select(0, false)
    }
    // The list is still being read: ask again with the same text while the box shows it.
    if (s.pending) this.pollTimer = setTimeout(() => { this.pollTimer = undefined; if (this.dialog.open && this.input.value === text) void this.renderFiles(text) }, PENDING_POLL_MS)
  }

  private render(): void {
    const { mode, query } = parsePaletteInput(this.input.value)
    const provider = this.provider()
    if (mode === 'default' && provider) {
      // Coming from the command list (or a closed box): its rows go now, not when main answers.
      if (this.dialog.dataset.mode !== mode || this.ranked.length > 0) {
        this.ranked = []
        this.list.replaceChildren()
        this.empty.textContent = this.input.value.trim() === '' ? provider.hint : provider.searchingText
        this.empty.hidden = false
        this.input.removeAttribute('aria-activedescendant')
      }
      this.dialog.dataset.mode = mode
      void this.renderFiles(this.input.value)
      return
    }
    this.fileSeq++
    this.list.replaceChildren()
    this.ranked = mode === 'commands' ? rankCommands(this.registry.available(), query, this.registry.recents()) : []
    this.dialog.dataset.mode = mode
    if (this.ranked.length === 0) {
      this.empty.textContent = mode === 'commands' ? `Nenhum comando para “${query}”.` : COMMANDS_HINT
      this.empty.hidden = false
      this.input.removeAttribute('aria-activedescendant')
      return
    }
    this.empty.hidden = true
    const base = ++this.seq
    const sepBefore = new Map<number, string>()
    const firstRecent = this.ranked.findIndex(r => r.section === 'recent')
    const firstOther = this.ranked.findIndex(r => r.section === 'other')
    if (firstRecent >= 0) sepBefore.set(firstRecent, 'usados recentemente')
    if (firstOther >= 0) sepBefore.set(firstOther, 'outros comandos')
    this.ranked.forEach((r, i) => {
      const label = sepBefore.get(i)
      if (label) {
        const sep = document.createElement('li'); sep.className = 'pal-sep'; sep.setAttribute('role', 'presentation'); sep.textContent = label
        this.list.append(sep)
      }
      const li = document.createElement('li')
      li.id = `pal-opt-${base}-${i}`
      li.setAttribute('role', 'option')
      li.dataset.command = r.command.id
      li.className = 'pal-item'
      if (r.command.danger) li.classList.add('danger')
      const ic = document.createElement('span'); ic.className = 'pal-icon'
      if (r.command.icon) ic.append(iconEl(r.command.icon))
      const text = document.createElement('span'); text.className = 'pal-text'
      const title = document.createElement('span'); title.className = 'pal-title'
      for (const run of rangeRuns(r.command.title, r.title)) {
        if (run.hit) { const b = document.createElement('b'); b.textContent = run.text; title.append(b) }
        else title.append(document.createTextNode(run.text))
      }
      text.append(title)
      if (r.command.group) {
        const g = document.createElement('span'); g.className = 'pal-group'
        for (const run of rangeRuns(r.command.group, r.group)) {
          if (run.hit) { const b = document.createElement('b'); b.textContent = run.text; g.append(b) }
          else g.append(document.createTextNode(run.text))
        }
        text.append(g)
      }
      li.append(ic, text)
      const hint = this.registry.hint(r.command)
      if (hint) { const kbd = document.createElement('kbd'); kbd.textContent = hint; li.append(kbd) }
      this.list.append(li)
    })
    this.select(0, false)
  }

  private select(i: number, scroll = true): void {
    this.selected = i
    const items = this.list.querySelectorAll<HTMLElement>('li.pal-item')
    for (let k = 0; k < items.length; k++) {
      const li = items[k]!
      const on = k === i
      li.classList.toggle('selected', on)
      li.setAttribute('aria-selected', String(on))
      if (on) { this.input.setAttribute('aria-activedescendant', li.id); if (scroll) li.scrollIntoView({ block: 'nearest' }) }
    }
  }
}
