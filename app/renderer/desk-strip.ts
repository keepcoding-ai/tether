// The strip of desks above the frames: one chip per desk (colour bar, name, attention badge), a "+" for a new
// desk after the current one. Click switches; double-click renames in place; right-click opens the desk's
// menu (built by the host with the app's context menu); dragging a chip reorders the row. The strip owns
// no state: the host calls `render` with the row as it is.
import { colorOf, DESK_COLORS, type DeskInfo, MAX_DESK_NAME } from './desks.ts'
import { icon } from './icons.ts'

export interface DeskStripHost {
  switchTo(id: string): void
  create(side: 'before' | 'after', relativeTo: string): void
  rename(id: string, name: string): void
  recolor(id: string, color: number): void
  move(id: string, to: number): void
  menu(id: string, x: number, y: number): void
  /** Hints shown in the tooltips ("Ctrl+1", "Ctrl+Alt+N"). */
  hint(what: 'go' | 'new', position?: number): string
}

/** What a desk's badge says: how many panes finished (done) or wait for the user (waiting). */
export interface DeskAttention { done: number; waiting: number }

export class DeskStrip {
  readonly element: HTMLElement
  private readonly list: HTMLElement
  private readonly host: DeskStripHost
  private readonly addButton: HTMLButtonElement
  private renaming: string | undefined
  private dragging: string | undefined

  constructor(element: HTMLElement, host: DeskStripHost) {
    this.element = element
    this.host = host
    element.setAttribute('role', 'tablist')
    element.setAttribute('aria-label', 'Mesas')
    this.list = document.createElement('div')
    this.list.className = 'desk-chips'
    const add = document.createElement('button')
    add.className = 'desk-add'
    add.type = 'button'
    add.append(icon('plus'))
    add.addEventListener('mousedown', ev => ev.preventDefault())
    add.addEventListener('click', () => { const active = this.list.querySelector<HTMLElement>('.desk-chip.active'); this.host.create('after', active?.dataset.desk ?? '') })
    this.addButton = add
    element.append(this.list, add)
  }

  render(desks: readonly DeskInfo[], active: string, attention: (deskId: string) => DeskAttention): void {
    if (this.renaming) return // the input in a chip is being edited: repainting would drop it
    this.addButton.title = `Nova mesa depois da atual (${this.host.hint('new')})`
    this.list.replaceChildren(...desks.map((d, i) => this.chip(d, i, d.id === active, attention(d.id))))
  }

  private chip(d: DeskInfo, index: number, active: boolean, att: DeskAttention): HTMLElement {
    const chip = document.createElement('div')
    chip.className = 'desk-chip'
    chip.classList.toggle('active', active)
    chip.dataset.desk = d.id
    chip.setAttribute('role', 'tab')
    chip.setAttribute('aria-selected', String(active))
    chip.style.setProperty('--desk-color', colorOf(d.color))
    chip.draggable = true
    const bar = document.createElement('span'); bar.className = 'desk-bar'
    const name = document.createElement('span'); name.className = 'desk-name'; name.textContent = d.name
    chip.append(bar, name)
    const total = att.done + att.waiting
    if (total > 0) {
      const badge = document.createElement('span')
      badge.className = `desk-badge ${att.waiting > 0 ? 'waiting' : 'done'}`
      badge.textContent = String(total)
      chip.append(badge)
    }
    const go = index < 9 ? ` (${this.host.hint('go', index + 1)})` : ''
    const what = total === 0 ? '' : `\n${[att.waiting ? `${att.waiting} esperando você` : '', att.done ? `${att.done} terminou` : ''].filter(Boolean).join(', ')}`
    chip.title = `${d.name}${go}${what}\nDuplo clique renomeia; clique direito: mais opções; arraste para reordenar.`
    chip.addEventListener('mousedown', ev => { if (ev.button === 0 && !(ev.target as Element).closest('input')) ev.preventDefault() })
    chip.addEventListener('click', () => this.host.switchTo(d.id))
    chip.addEventListener('dblclick', ev => { ev.preventDefault(); this.startRename(d.id) })
    chip.addEventListener('contextmenu', ev => { ev.preventDefault(); ev.stopPropagation(); this.host.menu(d.id, ev.clientX, ev.clientY) })
    chip.addEventListener('dragstart', ev => {
      this.dragging = d.id
      ev.dataTransfer?.setData('application/x-tether-desk', d.id)
      if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move'
      chip.classList.add('dragging')
    })
    chip.addEventListener('dragend', () => { this.dragging = undefined; this.clearDrop(); chip.classList.remove('dragging') })
    chip.addEventListener('dragover', ev => {
      if (!this.dragging) return
      ev.preventDefault()
      const after = this.isAfter(chip, ev.clientX)
      this.clearDrop()
      chip.classList.add(after ? 'drop-after' : 'drop-before')
    })
    chip.addEventListener('dragleave', () => chip.classList.remove('drop-before', 'drop-after'))
    chip.addEventListener('drop', ev => {
      const id = this.dragging
      if (!id) return
      ev.preventDefault()
      const chips = [...this.list.querySelectorAll<HTMLElement>('.desk-chip')].map(c => c.dataset.desk!)
      const others = chips.filter(x => x !== id)
      const at = others.indexOf(d.id) + (this.isAfter(chip, ev.clientX) ? 1 : 0)
      this.clearDrop()
      if (id !== d.id) this.host.move(id, Math.max(0, at))
    })
    return chip
  }

  private isAfter(chip: HTMLElement, x: number): boolean {
    const r = chip.getBoundingClientRect()
    return x > r.left + r.width / 2
  }

  private clearDrop(): void {
    for (const c of this.list.querySelectorAll('.drop-before, .drop-after')) c.classList.remove('drop-before', 'drop-after')
  }

  /** Puts an input in the desk's chip: Enter keeps the name, Esc or an empty name keeps the old one. */
  startRename(id: string): void {
    const chip = this.list.querySelector<HTMLElement>(`.desk-chip[data-desk="${CSS.escape(id)}"]`)
    const name = chip?.querySelector<HTMLElement>('.desk-name')
    if (!chip || !name || this.renaming) return
    this.renaming = id
    const input = document.createElement('input')
    input.className = 'desk-rename'
    input.value = name.textContent ?? ''
    input.maxLength = MAX_DESK_NAME
    input.spellcheck = false
    input.setAttribute('aria-label', 'Nome da mesa')
    chip.draggable = false
    name.replaceWith(input)
    let done = false
    const finish = (commit: boolean): void => {
      if (done) return
      done = true
      this.renaming = undefined
      if (commit) this.host.rename(id, input.value)
      else this.host.rename(id, name.textContent ?? '') // repaints with the old name
    }
    input.addEventListener('keydown', ev => {
      ev.stopPropagation()
      if (ev.key === 'Enter') { ev.preventDefault(); finish(true) }
      else if (ev.key === 'Escape') { ev.preventDefault(); finish(false) }
    })
    input.addEventListener('blur', () => finish(true))
    input.addEventListener('click', ev => ev.stopPropagation())
    input.focus()
    input.select()
  }

  /** A small palette at (x, y): picking a swatch recolours the desk; a click elsewhere or Esc closes it. */
  pickColor(id: string, current: number, x: number, y: number): void {
    document.getElementById('desk-colors')?.remove()
    const pop = document.createElement('div')
    pop.id = 'desk-colors'
    pop.className = 'desk-colors'
    pop.setAttribute('role', 'listbox')
    pop.setAttribute('aria-label', 'Cor da mesa')
    const close = (): void => { pop.remove(); document.removeEventListener('click', onDoc, true); document.removeEventListener('keydown', onKey, true) }
    const onDoc = (ev: Event): void => { if (!pop.contains(ev.target as Node)) close() }
    const onKey = (ev: KeyboardEvent): void => { if (ev.key === 'Escape') { ev.preventDefault(); close() } }
    DESK_COLORS.forEach((c, i) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'swatch'
      b.dataset.color = String(i)
      b.style.setProperty('--desk-color', c.css)
      b.title = c.name
      b.setAttribute('role', 'option')
      b.setAttribute('aria-selected', String(i === current))
      if (i === current) b.append(icon('check'))
      b.addEventListener('click', ev => { ev.stopPropagation(); close(); this.host.recolor(id, i) })
      pop.append(b)
    })
    document.body.append(pop)
    const r = pop.getBoundingClientRect()
    pop.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`
    pop.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`
    document.addEventListener('click', onDoc, true)
    document.addEventListener('keydown', onKey, true)
    pop.querySelector<HTMLElement>('[aria-selected="true"]')?.focus()
  }
}
