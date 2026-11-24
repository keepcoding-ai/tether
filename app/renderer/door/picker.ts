// The list picker (the `pick` block of TetherUi): a box at the top of the window, in the palette's language, that an extension's
// command opens when the person asks for it and that resolves with what was chosen. One step (`list`) or two (`steps`); the
// rules (rows, selection, back and close) are in picker-rules.ts. One modal <dialog>, made on first use and kept.
// Keys: type to filter, ↑/↓ (wrapping) and PageUp/PageDown move, Enter chooses, 1 to 9 choose the row of that number while the
// filter is empty, Esc goes back (second step) or closes, a click on a row chooses, a click outside closes. Rows with a group
// are drawn under its heading. The row on top (`featured`) is selected when the box opens. When it closes, the
// focus goes back to what had it before; nothing is shown unless a command asked.
import type { PickItem, PickManySpec, PickSpec } from '../ext-api.ts'
import { normalizeHue } from './desk-seal-rules.ts'
import { PICK_NUMBERED, confirmText, groupHeading, manyChosen, manyCount, manyFooter, moveSelection, numberedRow, orderedItems, rankPicks, reselect, runList, runMany, runSteps, toggleMark, type Ask, type AskContext, type PickAnswer, type PickRow } from './picker-rules.ts'

/** The icon for a name the app has; undefined for one it does not (the row then draws without one). */
type MakeIcon = (name: string) => SVGSVGElement | undefined
let makeIcon: MakeIcon | undefined
/** The tab's emblem chip (tab-emblems.ts imports icons.ts too, so it loads with them). */
let makeBadge: ((e: NonNullable<PickItem<unknown>['emblem']>) => HTMLElement) | undefined

/** icons.ts holds the SVG text (a build-time import), so it is loaded on first use: this file stays loadable by the unit tests. */
async function loadIcons(): Promise<MakeIcon> {
  if (makeIcon) return makeIcon
  makeBadge = (await import('../tab-emblems.ts')).emblemBadge
  const { ICON_NAMES, icon } = await import('../icons.ts')
  const names = ICON_NAMES as readonly string[]
  makeIcon = name => (names.includes(name) ? icon(name as Parameters<typeof icon>[0]) : undefined)
  return makeIcon
}

export const LOADING_TEXT = 'Carregando…'
export const NOTHING_TEXT = 'Nada para escolher.'
export const FAILED_TEXT = 'Não foi possível montar a lista.'

export class Picker {
  private dialog: HTMLDialogElement | undefined
  /** Settles the ask on screen (a newer picker takes the place of an open one). */
  private settleCurrent: ((a: PickAnswer<never>) => void) | undefined
  /** What had the focus before the box opened; the focus goes back there when it closes. */
  private opener: Element | null = null
  private session = 0

  /** True while a picker is on screen. */
  get open(): boolean { return this.dialog?.open ?? false }

  list<T>(spec: PickSpec<T>): Promise<T | undefined> {
    return this.within(ask => runList(ask, spec))
  }

  steps<A, B>(first: PickSpec<A>, second: (a: A) => PickSpec<B>): Promise<{ first: A; second: B } | undefined> {
    return this.within(ask => runSteps(ask, first, second))
  }

  many<T>(spec: PickManySpec<T>): Promise<T[] | undefined> {
    return this.within(ask => runMany(ask, spec))
  }

  /** The box stays open from the first ask to the last answer; a newer picker closes this one (it resolves as closed). */
  private async within<R>(body: (ask: Ask) => Promise<R | undefined>): Promise<R | undefined> {
    if (typeof document === 'undefined') return undefined
    const icons = await loadIcons()
    this.settleCurrent?.({ kind: 'close' })
    const mine = ++this.session
    const dialog = (this.dialog ??= this.build(icons))
    if (!dialog.open) {
      this.opener = document.activeElement
      dialog.showModal()
    }
    try {
      return await body((spec, ctx) => this.ask(dialog, icons, spec, ctx))
    } finally {
      if (this.session === mine) {
        if (dialog.open) dialog.close()
        const back = this.opener
        this.opener = null
        if (back instanceof HTMLElement && back.isConnected) back.focus()
      }
    }
  }

  private build(icons: MakeIcon): HTMLDialogElement {
    const d = document.createElement('dialog')
    d.className = 'picker'
    d.innerHTML = `<div class="pk-head"><span class="pk-title"></span><span class="pk-step"></span></div>
<div class="pk-field"><span class="pk-lens"></span><input type="text" role="combobox" aria-expanded="true" aria-autocomplete="list" spellcheck="false" autocomplete="off"><kbd>Esc</kbd></div>
<ul class="pk-list" role="listbox"></ul>
<p class="pk-empty" hidden></p>
<div class="pk-foot" hidden><span class="pk-hint"></span><button type="button" class="pk-confirm"></button></div>`
    d.querySelector('.pk-lens')!.append(icons('magnifying-glass') ?? '')
    d.querySelector('input')!.setAttribute('aria-controls', (d.querySelector('ul')!.id = 'picker-list'))
    document.body.append(d)
    return d
  }

  private ask<T>(d: HTMLDialogElement, icons: MakeIcon, spec: PickSpec<T>, ctx: AskContext): Promise<PickAnswer<T>> {
    const input = d.querySelector<HTMLInputElement>('input')!
    const list = d.querySelector<HTMLUListElement>('ul')!
    const empty = d.querySelector<HTMLElement>('.pk-empty')!
    const foot = d.querySelector<HTMLElement>('.pk-foot')!
    const confirmBtn = d.querySelector<HTMLButtonElement>('.pk-confirm')!
    const many = ctx.many
    // `pick.many`: the marks live here, by the item's value; a filter hides rows but never drops a mark.
    let marks: ReadonlySet<unknown> = new Set()
    const ac = new AbortController()
    const { signal } = ac
    return new Promise(resolve => {
      let items: readonly PickItem<T>[] = []
      let rows: PickRow<T>[] = []
      let selected = 0
      let done = false
      const settle = (a: PickAnswer<T>): void => {
        if (done) return
        done = true
        ac.abort()
        if (this.settleCurrent === settleAny) this.settleCurrent = undefined
        resolve(a)
      }
      const settleAny = (a: PickAnswer<never>): void => settle(a)
      this.settleCurrent = settleAny
      const back = (): PickAnswer<T> => (ctx.step > 1 ? { kind: 'back' } : { kind: 'close' })
      const choose = (i: number): void => { const row = rows[i]; if (row) settle({ kind: 'pick', item: row.item, query: input.value }) }

      d.classList.toggle('many', many !== undefined)
      foot.hidden = many === undefined
      if (many) list.setAttribute('aria-multiselectable', 'true'); else list.removeAttribute('aria-multiselectable')
      d.querySelector('.pk-hint')!.textContent = many ? manyFooter(many) : ''
      const confirm = (): void => {
        if (!many) return
        const ordered = orderedItems(spec.featured, items)
        const chosen = manyChosen(ordered, marks, rows[selected]?.item)
        if (chosen.length > 0) settle({ kind: 'many', items: chosen, query: input.value })
      }
      // The marks drawn on the rows, and the button's count.
      const paintMarks = (): void => {
        if (!many) return
        list.querySelectorAll<HTMLElement>('li.pk-item').forEach(li => {
          const on = marks.has(rows[Number(li.dataset.index)]?.item.value)
          li.classList.toggle('marked', on)
          li.setAttribute('aria-selected', String(on))
          li.setAttribute('aria-checked', String(on))
        })
        const n = manyCount(marks, rows[selected] !== undefined)
        confirmBtn.textContent = confirmText(many, n)
        confirmBtn.disabled = n === 0
      }
      if (many) { confirmBtn.textContent = confirmText(many, 0); confirmBtn.disabled = true }
      const toggle = (i: number): void => { const row = rows[i]; if (row) { marks = toggleMark(marks, row.item.value); paintMarks() } }
      d.setAttribute('aria-label', spec.title)
      d.querySelector('.pk-title')!.textContent = spec.title
      d.querySelector('.pk-step')!.textContent = ctx.steps > 1 ? `${ctx.step} de ${ctx.steps}${ctx.chosen ? ` · ${ctx.chosen}` : ''}` : ''
      input.placeholder = spec.placeholder ?? 'Digite para filtrar'
      input.value = ctx.query ?? ''
      input.removeAttribute('aria-activedescendant')
      list.replaceChildren()
      empty.textContent = LOADING_TEXT
      empty.hidden = false

      const select = (i: number, scroll = true): void => {
        selected = i
        const els = list.querySelectorAll<HTMLElement>('li.pk-item')
        els.forEach((li, k) => {
          const on = k === i
          li.classList.toggle('selected', on)
          // In a many box aria-selected means "marked" (paintMarks); the cursor is the active descendant.
          if (!many) li.setAttribute('aria-selected', String(on))
          if (on) { input.setAttribute('aria-activedescendant', li.id); if (scroll) li.scrollIntoView({ block: 'nearest' }) }
        })
      }

      const draw = (keep?: PickItem<T>): void => {
        rows = rankPicks(spec.featured, items, input.value)
        const made = !many && spec.create && input.value.trim() !== '' ? spec.create(input.value) : undefined
        if (made) rows.push({ item: made, featured: false, runs: [{ text: made.label, hit: false }] })
        list.replaceChildren()
        if (rows.length === 0) {
          empty.textContent = items.length === 0 && !spec.featured ? (spec.emptyText ?? NOTHING_TEXT) : `Nada para “${input.value.trim()}”.`
          empty.hidden = false
          input.removeAttribute('aria-activedescendant')
          paintMarks()
          return
        }
        empty.hidden = true
        const numbered = input.value === '' && !many
        rows.forEach((row, i) => {
          const heading = groupHeading(rows, i)
          if (heading) { const hd = document.createElement('li'); hd.className = 'pk-group'; hd.setAttribute('role', 'presentation'); hd.textContent = heading; list.append(hd) }
          const li = document.createElement('li')
          li.id = `pk-opt-${i}`
          li.className = row.featured ? 'pk-item featured' : 'pk-item'
          li.setAttribute('role', 'option')
          li.dataset.index = String(i)
          const hue = normalizeHue(row.item.hue)
          if (hue !== undefined) { li.classList.add('hued'); li.style.setProperty('--pk-hue', String(hue)) }
          const ic = document.createElement('span'); ic.className = 'pk-icon'
          const letter = Array.from(typeof row.item.letter === 'string' ? row.item.letter.trim() : '')[0]
          if (letter) { ic.classList.add('letter'); ic.textContent = letter }
          else { const glyph = row.item.icon ? icons(row.item.icon) : undefined; if (glyph) ic.append(glyph) }
          const text = document.createElement('span'); text.className = 'pk-text'
          const label = document.createElement('span'); label.className = 'pk-label'
          for (const run of row.runs) {
            if (run.hit) { const b = document.createElement('b'); b.textContent = run.text; label.append(b) }
            else label.append(document.createTextNode(run.text))
          }
          text.append(label)
          if (row.item.detail) { const dt = document.createElement('span'); dt.className = 'pk-detail'; dt.textContent = row.item.detail; text.append(dt) }
          if (numbered && i < PICK_NUMBERED) { const n = document.createElement('kbd'); n.className = 'pk-num'; n.textContent = String(i + 1); li.append(n) }
          if (many) { const box = document.createElement('span'); box.className = 'pk-check'; box.setAttribute('aria-hidden', 'true'); li.append(box) }
          li.append(ic, text)
          if (row.item.emblem && makeBadge) li.append(makeBadge(row.item.emblem))
          list.append(li)
          // The featured row is apart from the rest: a rule under it, when there is a rest.
          if (row.featured && rows.length > 1) { const sep = document.createElement('li'); sep.className = 'pk-sep'; sep.setAttribute('role', 'presentation'); list.append(sep) }
        })
        select(reselect(rows, keep), false)
        paintMarks()
      }

      input.addEventListener('input', () => draw(rows[selected]?.item), { signal })
      input.addEventListener('keydown', ev => {
        switch (ev.key) {
          case 'ArrowDown': case 'ArrowUp': case 'PageDown': case 'PageUp':
            ev.preventDefault(); if (rows.length) select(moveSelection(selected, rows.length, ev.key)); if (many) paintMarks(); break
          case 'Enter': ev.preventDefault(); if (many) confirm(); else choose(selected); break
          case ' ':
            if (!many || ev.ctrlKey || ev.altKey || ev.metaKey || ev.isComposing) break
            ev.preventDefault(); toggle(selected); break
          case 'Escape': ev.preventDefault(); ev.stopPropagation(); settle(back()); break
          case 'Tab': ev.preventDefault(); break // the field is the only stop
          default: {
            if (ev.ctrlKey || ev.altKey || ev.metaKey || ev.isComposing) break
            const n = numberedRow(ev.key, input.value, rows.length)
            if (n !== undefined) { ev.preventDefault(); choose(n) }
          }
        }
      }, { signal })
      // Esc raised by the browser itself (the keydown above normally takes it first).
      d.addEventListener('cancel', ev => { ev.preventDefault(); settle(back()) }, { signal })
      // A click on the backdrop lands on the dialog element itself, never on a child.
      d.addEventListener('mousedown', ev => { if (ev.target === d) { ev.preventDefault(); settle({ kind: 'close' }) } }, { signal })
      // Choosing with the mouse must not move the focus out of the field.
      list.addEventListener('mousedown', ev => ev.preventDefault(), { signal })
      list.addEventListener('click', ev => {
        const li = (ev.target as HTMLElement).closest<HTMLElement>('li.pk-item')
        if (!li) return
        if (!many) { choose(Number(li.dataset.index)); return }
        select(Number(li.dataset.index), false)
        toggle(Number(li.dataset.index))
      }, { signal })
      if (many) {
        // A double click confirms with the row marked (its two clicks left the mark as it was).
        list.addEventListener('dblclick', ev => {
          const li = (ev.target as HTMLElement).closest<HTMLElement>('li.pk-item')
          const row = li ? rows[Number(li.dataset.index)] : undefined
          if (!row) return
          if (!marks.has(row.item.value)) marks = toggleMark(marks, row.item.value)
          confirm()
        }, { signal })
        foot.addEventListener('mousedown', ev => ev.preventDefault(), { signal })
        confirmBtn.addEventListener('click', confirm, { signal })
      }

      input.focus()
      input.setSelectionRange(input.value.length, input.value.length)
      void (async () => {
        try {
          items = typeof spec.items === 'function' ? await spec.items() : spec.items
        } catch (err) {
          console.error('pick: the list failed', err)
          if (!done) { empty.textContent = FAILED_TEXT; empty.hidden = false }
          return
        }
        if (done) return
        draw(ctx.previous as PickItem<T> | undefined)
      })()
    })
  }
}
