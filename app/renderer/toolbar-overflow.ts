// The toolbar's overflow (DOM): measures the real widths (ResizeObserver, not a fixed breakpoint) and applies the plan of
// toolbar-overflow-rules.ts. A collapsed left action gets `data-tb-collapsed` (display:none; every one is also an item of
// the ☰ menu); the search gets `.compact` (a magnifier icon, expanded by session-search.ts). Always on the bar: ☰, bell,
// the status icons, and any icon showing a state (pressed, counter).
import { planToolbar } from './toolbar-overflow-rules.ts'

const isPinned = (el: HTMLElement): boolean => !!el.querySelector('[aria-pressed="true"], .ib-count:not([hidden])') || el.matches('[aria-pressed="true"]')

export function setupToolbarOverflow(bar: HTMLElement): { refresh(): void } {
  const left = bar.querySelector<HTMLElement>('.tb-left')!
  const right = bar.querySelector<HTMLElement>('.tb-right')!
  const search = bar.querySelector<HTMLElement>('#session-search')!
  let frame = 0

  const pass = (): void => {
    frame = 0
    const cs = getComputedStyle(bar)
    const inner = bar.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
    if (inner <= 0) return // hidden window: nothing is laid out
    const items = [...left.children] as HTMLElement[]
    for (const el of items) el.removeAttribute('data-tb-collapsed') // natural widths first (synchronous: nothing paints in between)
    const gap = parseFloat(getComputedStyle(left).columnGap) || 0
    const ss = getComputedStyle(search)
    // The search expanded over the capsule is out of the flow: it takes nothing from the right side.
    const inFlow = ss.position !== 'absolute'
    const rightRest = right.offsetWidth - (inFlow ? search.offsetWidth + parseFloat(ss.marginRight) + gap : 0)
    const ICON = 30 + gap
    const plan = planToolbar({
      inner, gap, rightRest,
      left: items.map(el => ({ width: el.offsetWidth, pinned: isPinned(el) })),
      searchFull: 180 + 6 + gap, searchIcon: ICON,
    })
    items.forEach((el, i) => el.toggleAttribute('data-tb-collapsed', plan.collapsed.includes(i)))
    if (search.classList.contains('compact') !== plan.compactSearch) {
      search.classList.toggle('compact', plan.compactSearch)
      if (!plan.compactSearch) { search.classList.remove('expanded'); search.style.left = ''; search.style.width = '' }
    }
  }
  const refresh = (): void => { if (!frame) frame = requestAnimationFrame(pass) }

  new ResizeObserver(refresh).observe(bar)
  // Icons that gain or lose a state (a counter, a pressed button) or appear (the extensions' status icons).
  const mo = new MutationObserver(refresh)
  mo.observe(left, { subtree: true, attributes: true, attributeFilter: ['hidden', 'aria-pressed'], childList: true })
  mo.observe(right, { subtree: true, attributes: true, attributeFilter: ['hidden'] })
  mo.observe(bar.querySelector('#status-area')!, { childList: true })
  refresh()
  return { refresh }
}
