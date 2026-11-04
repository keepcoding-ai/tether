// The command palette (Ctrl+Shift+P; Ctrl+P opens the same box in quick-open mode): a box at the top of the
// window with a search field and the commands the registry offers right now, ranked by palette-rules.ts.
// Keys: type to filter, ↑/↓ (wrapping) and PageUp/PageDown move, Enter runs, Esc closes, a click on an item
// runs it, a click outside closes. The chords of the two modes switch the mode while the box is open. The
// matched letters are highlighted, the key hint sits at the right of each row, the recently used ones come
// first with a "recente" tag. A modal <dialog>, so the terminals get no key while it is up; the backdrop is
// clear (the box is a tool over the work, the way VS Code shows it), and the look is the app's dialog language.
import type { CommandRegistry } from './commands.ts'
import { highlightRuns } from './fuzzy.ts'
import { icon, ICON_NAMES, type IconName } from './icons.ts'
import { initialInput, parsePaletteInput, rankCommands, type PaletteMode, type RankedCommand } from './palette-rules.ts'
import { shortcutOf } from './shortcuts.ts'

const PAGE = 8
const ICON_SET = new Set<string>(ICON_NAMES)

/** Commands name icons as strings (the registry stays pure); an unknown name falls back to a neutral mark. */
function iconEl(name: string): SVGSVGElement {
  return icon((ICON_SET.has(name) ? name : 'question') as IconName)
}

export const QUICK_OPEN_HINT = 'Ir para arquivos chega na próxima entrega. Digite > para procurar um comando.'

export class CommandPalette {
  private readonly input: HTMLInputElement
  private readonly list: HTMLUListElement
  private readonly empty: HTMLElement
  private ranked: RankedCommand[] = []
  private selected = 0
  private seq = 0
  readonly dialog: HTMLDialogElement
  private readonly registry: CommandRegistry

  constructor(dialog: HTMLDialogElement, registry: CommandRegistry) {
    this.dialog = dialog
    this.registry = registry
    this.input = dialog.querySelector<HTMLInputElement>('input')!
    this.list = dialog.querySelector<HTMLUListElement>('ul')!
    this.empty = dialog.querySelector<HTMLElement>('.pal-empty')!
    this.input.addEventListener('input', () => this.render())
    this.input.addEventListener('keydown', ev => this.onKey(ev))
    // Esc: the browser raises `cancel` on a modal dialog; it is ours (the field keeps its text until the next opening).
    dialog.addEventListener('cancel', ev => { ev.preventDefault(); this.hide() })
    // A click on the backdrop lands on the dialog element itself, never on a child.
    dialog.addEventListener('mousedown', ev => { if (ev.target === dialog) { ev.preventDefault(); this.hide() } })
    // Picking with the mouse must not move the focus out of the field.
    this.list.addEventListener('mousedown', ev => ev.preventDefault())
    this.list.addEventListener('click', ev => {
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

  /** Opens the box in a mode (or switches the mode of an open box). */
  show(mode: PaletteMode): void {
    this.input.value = initialInput(mode)
    if (!this.dialog.open) this.dialog.showModal()
    this.input.focus()
    this.input.setSelectionRange(this.input.value.length, this.input.value.length)
    this.render()
  }

  hide(): void {
    if (this.dialog.open) this.dialog.close()
  }

  /** The ids on screen, in order (tests). */
  shown(): string[] {
    return this.ranked.map(r => r.command.id)
  }

  private onKey(ev: KeyboardEvent): void {
    const op = shortcutOf(ev)
    if (op?.op === 'palette' || op?.op === 'quick-open') {
      ev.preventDefault(); ev.stopPropagation()
      const mode: PaletteMode = op.op === 'palette' ? 'commands' : 'quick-open'
      if (this.mode !== mode) this.show(mode)
      return
    }
    const n = this.ranked.length
    switch (ev.key) {
      case 'ArrowDown': ev.preventDefault(); if (n) this.select((this.selected + 1) % n); break
      case 'ArrowUp': ev.preventDefault(); if (n) this.select((this.selected - 1 + n) % n); break
      case 'PageDown': ev.preventDefault(); if (n) this.select(Math.min(n - 1, this.selected + PAGE)); break
      case 'PageUp': ev.preventDefault(); if (n) this.select(Math.max(0, this.selected - PAGE)); break
      case 'Enter': ev.preventDefault(); { const r = this.ranked[this.selected]; if (r) void this.runId(r.command.id) } break
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

  private render(): void {
    const { mode, query } = parsePaletteInput(this.input.value)
    this.list.replaceChildren()
    this.ranked = mode === 'commands' ? rankCommands(this.registry.available(), query, this.registry.recents()) : []
    this.dialog.dataset.mode = mode
    if (this.ranked.length === 0) {
      this.empty.textContent = mode === 'commands' ? `Nenhum comando para “${query}”.` : QUICK_OPEN_HINT
      this.empty.hidden = false
      this.input.removeAttribute('aria-activedescendant')
      return
    }
    this.empty.hidden = true
    const base = ++this.seq
    this.ranked.forEach((r, i) => {
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
      for (const run of highlightRuns(r.command.title, r.match.positions)) {
        if (run.hit) { const b = document.createElement('b'); b.textContent = run.text; title.append(b) }
        else title.append(document.createTextNode(run.text))
      }
      text.append(title)
      if (r.command.group) { const g = document.createElement('span'); g.className = 'pal-group'; g.textContent = r.command.group; text.append(g) }
      li.append(ic, text)
      if (r.recent && query === '') { const tag = document.createElement('span'); tag.className = 'pal-tag'; tag.textContent = 'recente'; li.append(tag) }
      const hint = this.registry.hint(r.command)
      if (hint) { const kbd = document.createElement('kbd'); kbd.textContent = hint; li.append(kbd) }
      this.list.append(li)
    })
    this.select(0, false)
  }

  private select(i: number, scroll = true): void {
    this.selected = i
    const items = this.list.children
    for (let k = 0; k < items.length; k++) {
      const li = items[k] as HTMLElement
      const on = k === i
      li.classList.toggle('selected', on)
      li.setAttribute('aria-selected', String(on))
      if (on) { this.input.setAttribute('aria-activedescendant', li.id); if (scroll) li.scrollIntoView({ block: 'nearest' }) }
    }
  }
}
