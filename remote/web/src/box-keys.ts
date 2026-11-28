// The TV's remote inside a box of the page (the card of "+ Novo", the form of "Novo processo"): the arrows walk its
// buttons, fields and choices by direction (the rule of which one lies that way is focus-rules.ts, the same as the
// Regency's walk); a text field keeps its own left and right for the caret; OK on a choice not yet taken takes it (a
// radio has no Enter of its own). Elsewhere (a keyboard, a finger) the box keeps the keys it has.
import { caretAtEdge, DIRECTIONS, neighbourOf, type Item } from './focus-rules.ts'

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex="0"]'
const TEXT_TYPES = new Set(['text', 'search', 'password', 'url', 'number'])

/** Walks `box` by the arrows while `on()` (the TV's tier); its own keys run after, for what the walk leaves them. */
export function walkBoxByArrows(box: HTMLElement, on: () => boolean): void {
  box.addEventListener('keydown', ev => {
    if (!on() || ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return
    const t = document.activeElement
    const dir = DIRECTIONS[ev.key]
    if (dir) {
      if (t instanceof HTMLInputElement && TEXT_TYPES.has(t.type)
        && !caretAtEdge({ kind: 'text', value: t.value, start: t.selectionStart ?? 0, end: t.selectionEnd ?? 0 }, dir)) return
      const all = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(e => !e.closest('[hidden], fieldset:disabled') && e.getClientRects().length > 0)
      const items: Item[] = all.map((e, i) => { const r = e.getBoundingClientRect(); return { key: String(i), rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } } })
      const at = t instanceof HTMLElement ? all.indexOf(t) : -1
      const next = at < 0 ? '0' : neighbourOf(items[at]!, items, dir)
      ev.preventDefault()
      ev.stopPropagation()
      if (next !== undefined) { const e = all[Number(next)]; e?.focus(); e?.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }
      return
    }
    if (ev.key === 'Enter' && t instanceof HTMLInputElement && (t.type === 'radio' || t.type === 'checkbox') && !t.checked && box.contains(t)) {
      ev.preventDefault()
      ev.stopPropagation()
      t.click()
    }
  }, true)
}
