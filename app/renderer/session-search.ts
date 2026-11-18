// The toolbar's session search (DOM): a compact input at the start of .tb-right; typing lists the matching sessions
// of every desk under it, Enter or a click jumps to one. The ranking is session-search-rules.ts; main.ts feeds the
// sessions, snapshotted when the box gains focus (keystrokes filter the snapshot), and does the jump.
import { highlightRuns } from './fuzzy.ts'
import { moveSelection, searchSessions, type SearchHit, type SearchSession } from './session-search-rules.ts'

export interface SessionSearchHost {
  /** The sessions that have a tab, in the desks' order. */
  sessions(): SearchSession[]
  /** Where the session's tab is ("Mesa 1", "Gaveta"); asked only for the rows shown. */
  placeOf(slotId: string): string | undefined
  /** Brings the session's pane to the front and focuses it. */
  jump(slotId: string): void
}

export interface SessionSearch {
  /** Puts the caret in the box (the chord); in the compact toolbar it first expands over the desk switcher. */
  focus(): void
}

export function setupSessionSearch(wrap: HTMLElement, host: SessionSearchHost): SessionSearch {
  const input = wrap.querySelector<HTMLInputElement>('input')!
  const list = wrap.querySelector<HTMLElement>('.ss-list')!
  let snapshot: SearchSession[] = []
  let hits: SearchHit[] = []
  let selected = -1
  let rows: HTMLElement[] = []

  const bar = wrap.closest<HTMLElement>('#toolbar')
  // Compact toolbar (toolbar-overflow.ts adds `.compact`): the box is a magnifier icon; expanded it takes the place of the desk switcher until blur or Esc.
  const expand = (): void => {
    if (!wrap.classList.contains('compact') || wrap.classList.contains('expanded')) return
    const sw = bar?.querySelector<HTMLElement>('#desk-switch')
    if (bar && sw) {
      const b = bar.getBoundingClientRect(), r = sw.getBoundingClientRect()
      const width = Math.max(r.width, 240)
      wrap.style.width = `${width}px`
      wrap.style.left = `${r.left - b.left + (r.width - width) / 2}px`
    }
    wrap.classList.add('expanded')
  }
  const collapse = (): void => { wrap.classList.remove('expanded'); wrap.style.left = ''; wrap.style.width = '' }
  wrap.querySelector<HTMLElement>('.ss-open')?.addEventListener('click', () => { expand(); input.focus() })

  const close = (): void => { list.hidden = true; input.setAttribute('aria-expanded', 'false') }

  const render = (): void => {
    list.replaceChildren()
    rows = []
    hits.forEach((h, i) => {
      const row = document.createElement('div')
      row.className = 'ss-item' + (i === selected ? ' selected' : '')
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', String(i === selected))
      const title = document.createElement('span')
      title.className = 'ss-title'
      for (const run of highlightRuns(h.label, h.positions)) {
        if (run.hit) { const b = document.createElement('b'); b.textContent = run.text; title.append(b) }
        else title.append(document.createTextNode(run.text))
      }
      const place = document.createElement('span')
      place.className = 'ss-place'
      place.textContent = host.placeOf(h.slotId) ?? ''
      row.append(title, place)
      // mousedown, not click: the input's blur would close the list before the click lands.
      row.addEventListener('mousedown', e => { e.preventDefault(); go(i) })
      list.append(row)
      rows.push(row)
    })
    if (hits.length === 0 && input.value.trim() !== '') {
      const empty = document.createElement('div')
      empty.className = 'ss-empty'
      empty.textContent = 'Nenhuma sessão encontrada'
      list.append(empty)
    }
    const show = input.value.trim() !== ''
    list.hidden = !show
    input.setAttribute('aria-expanded', String(show))
    list.querySelector('.selected')?.scrollIntoView({ block: 'nearest' })
  }

  /** Moves the selection between the existing rows, without rebuilding them. */
  const select = (next: number): void => {
    rows[selected]?.classList.remove('selected')
    rows[selected]?.setAttribute('aria-selected', 'false')
    selected = next
    const row = rows[selected]
    if (!row) return
    row.classList.add('selected')
    row.setAttribute('aria-selected', 'true')
    row.scrollIntoView({ block: 'nearest' })
  }

  const update = (): void => {
    hits = searchSessions(input.value, snapshot)
    selected = hits.length > 0 ? 0 : -1
    render()
  }

  const clear = (): void => { input.value = ''; hits = []; selected = -1; close() }

  const go = (i: number): void => {
    const h = hits[i]
    if (!h) return
    clear()
    input.blur()
    host.jump(h.slotId)
  }

  input.addEventListener('input', update)
  input.addEventListener('focus', () => { snapshot = host.sessions(); if (input.value.trim() !== '') update() })
  input.addEventListener('blur', () => { close(); collapse() })
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      select(moveSelection(selected, e.key === 'ArrowDown' ? 1 : -1, hits.length))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      go(selected)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      clear()
      input.blur()
    }
  })

  // The chord on a box that already has the caret: focus does not fire again, so the snapshot is taken here.
  return { focus: () => { expand(); if (document.activeElement === input) snapshot = host.sessions(); else input.focus(); input.select() } }
}
