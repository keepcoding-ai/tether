// The toolbar's overflow (DOM): measures the real widths (ResizeObserver, not a fixed breakpoint) and applies the plan of
// toolbar-overflow-rules.ts. A collapsed icon gets `data-tb-collapsed` (display:none; every one is also an item of the ☰
// menu); the search gets `.compact` (a magnifier icon, expanded by session-search.ts). Always on the bar: ☰, the bell, and
// any icon showing an alert or state (connection down, a status icon in warn/error, a pressed toggle, a counter).
import { planToolbar } from './toolbar-overflow-rules.ts'

const ATTR = 'data-tb-collapsed'

/** An icon that must stay: the bell, ☰, a pressed toggle, a counter, the connection when down, a status icon in warn/error. */
function isPinned(el: HTMLElement): boolean {
  if (el.id === 'bell-wrap' || el.querySelector('#btn-menu, #btn-bell')) return true
  if (el.matches('[aria-pressed="true"]') || el.querySelector('[aria-pressed="true"], .ib-count:not([hidden])')) return true
  if (el.querySelector('#conn.off')) return true
  return !!el.querySelector('.status-btn[data-state="warn"], .status-btn[data-state="error"]')
}

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
    const lefts = [...left.children] as HTMLElement[]
    const rights = ([...right.children] as HTMLElement[]).filter(el => el !== search)
    // Natural widths first (synchronous: nothing paints in between).
    for (const el of [...lefts, ...rights, search]) el.removeAttribute(ATTR)
    const gap = parseFloat(getComputedStyle(left).columnGap) || 0
    const ss = getComputedStyle(search)
    const plan = planToolbar({
      inner, gap,
      left: lefts.map(el => ({ width: el.offsetWidth, pinned: isPinned(el) })),
      right: rights.map(el => ({ width: el.offsetWidth, pinned: isPinned(el) })),
      searchFull: 180 + (parseFloat(ss.marginRight) || 0) + gap,
      searchIcon: 30 + gap,
    })
    lefts.forEach((el, i) => el.toggleAttribute(ATTR, plan.collapsedLeft.includes(i)))
    rights.forEach((el, i) => el.toggleAttribute(ATTR, plan.collapsedRight.includes(i)))
    search.toggleAttribute(ATTR, plan.hideSearch)
    if (search.classList.contains('compact') !== plan.compactSearch) {
      search.classList.toggle('compact', plan.compactSearch)
      if (!plan.compactSearch) { search.classList.remove('expanded'); search.style.left = ''; search.style.width = '' }
    }
  }
  const refresh = (): void => { if (!frame) frame = requestAnimationFrame(pass) }

  const ro = new ResizeObserver(refresh)
  ro.observe(bar); ro.observe(left); ro.observe(right)
  // Icons that gain or lose a state (a counter, a pressed button, a connection or status change) or appear (the extensions' status icons).
  const mo = new MutationObserver(refresh)
  mo.observe(left, { subtree: true, attributes: true, attributeFilter: ['hidden', 'aria-pressed'], childList: true })
  mo.observe(right, { subtree: true, attributes: true, attributeFilter: ['hidden', 'class', 'data-state'] })
  mo.observe(bar.querySelector('#status-area')!, { childList: true })
  void document.fonts?.ready.then(refresh)
  refresh()
  return { refresh }
}
