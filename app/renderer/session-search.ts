// The toolbar's session search (DOM): a compact input at the start of .tb-right; typing lists the matching sessions
// of every desk under it, Enter or a click jumps to one. The ranking is session-search-rules.ts; main.ts feeds the
// live sessions (read on every keystroke, so renames show at once) and does the jump.
import { highlightRuns } from './fuzzy.ts'
import { moveSelection, searchSessions, type SearchHit, type SearchSession } from './session-search-rules.ts'

export interface SessionSearchHost {
  /** The sessions that have a tab, in the desks' order. */
  sessions(): SearchSession[]
  /** Brings the session's pane to the front and focuses it. */
  jump(slotId: string): void
}

export interface SessionSearch {
  /** Puts the caret in the box (the chord). */
  focus(): void
}

export function setupSessionSearch(wrap: HTMLElement, host: SessionSearchHost): SessionSearch {
  const input = wrap.querySelector<HTMLInputElement>('input')!
  const list = wrap.querySelector<HTMLElement>('.ss-list')!
  let hits: SearchHit[] = []
  let selected = -1

  const close = (): void => { list.hidden = true; input.setAttribute('aria-expanded', 'false') }

  const render = (): void => {
    list.replaceChildren()
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
      place.textContent = h.place
      row.append(title, place)
      // mousedown, not click: the input's blur would close the list before the click lands.
      row.addEventListener('mousedown', e => { e.preventDefault(); go(i) })
      list.append(row)
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

  const update = (): void => {
    hits = searchSessions(input.value, host.sessions())
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
  input.addEventListener('focus', () => { if (input.value.trim() !== '') update() })
  input.addEventListener('blur', close)
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      selected = moveSelection(selected, e.key === 'ArrowDown' ? 1 : -1, hits.length)
      render()
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

  return { focus: () => { input.focus(); input.select() } }
}
