/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Submenu behavior of the ≡ menu, after VS Code's menu widget.
// Origin: https://github.com/microsoft/vscode, commit 7faf984945fefaceb533ca1d851697a2e72e4e68
//   src/vs/base/browser/ui/menu/menu.ts   (SubmenuMenuActionViewItem: a submenu opens on hover after a short delay, on
//                                          ArrowRight/Enter/click; closes on ArrowLeft/Escape, returning the focus to its row;
//                                          the submenu is placed beside the row, flipped to the other side when the viewport
//                                          has no room, and kept inside the viewport vertically)
// Adapted: the submenu is a `position: fixed` <ul> nested in its row (so the root's scrolling fallback does not clip it), and
// the pointer's trip to it is protected by a "safe triangle" (the apex is the last pointer position over the opener's row, the
// base is the submenu's near edge): while the pointer is inside it, hovering the rows in between does not switch or close.
// The geometry is pure (unit-tested); the controller is the only DOM here.

export interface Rect { left: number; top: number; right: number; bottom: number }
export interface Point { x: number; y: number }

/** Delay before a hovered submenu row opens (VS Code: 250 ms; a little shorter here, the menu is small). */
export const SUBMENU_SHOW_DELAY = 150
/** Delay before leaving the opener for another row closes/switches the submenu. */
export const SUBMENU_HIDE_DELAY = 150
/** Margin kept between a submenu and the viewport edge. */
const EDGE = 4

export interface SubmenuPlacement { left: number; top: number; side: 'right' | 'left'; maxHeight: number }

/**
 * Where a submenu of `size` goes: on the right of the menu (`parent`), overlapping its border by 2 px so the pointer never
 * crosses a gap; flipped to the left when it does not fit on the right and the left has more room; top aligned with the row
 * (less the menu's padding) and slid up to stay inside the viewport; taller than the viewport → capped (it scrolls).
 */
export function placeSubmenu(parent: Rect, row: Rect, size: { width: number; height: number }, viewport: { width: number; height: number }): SubmenuPlacement {
  const roomRight = viewport.width - EDGE - (parent.right - 2)
  const roomLeft = parent.left + 2 - EDGE
  const side: 'right' | 'left' = size.width <= roomRight || roomRight >= roomLeft ? 'right' : 'left'
  let left = side === 'right' ? parent.right - 2 : parent.left + 2 - size.width
  left = Math.max(EDGE, Math.min(left, viewport.width - EDGE - size.width))
  const maxHeight = Math.max(0, viewport.height - EDGE * 2)
  const height = Math.min(size.height, maxHeight)
  const top = Math.max(EDGE, Math.min(row.top - 5, viewport.height - EDGE - height))
  return { left, top, side, maxHeight }
}

/** Whether `p` lies inside the triangle (a, b, c), edges included. */
export function inTriangle(p: Point, a: Point, b: Point, c: Point): boolean {
  const cross = (o: Point, u: Point, v: Point): number => (u.x - o.x) * (v.y - o.y) - (u.y - o.y) * (v.x - o.x)
  const d1 = cross(a, b, p), d2 = cross(b, c, p), d3 = cross(c, a, p)
  const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0
  return !(neg && pos)
}

/** The safe triangle toward a submenu: apex at the pointer's last spot over the opener, base the submenu's near edge. */
export function safeTriangle(apex: Point, sub: Rect, side: 'right' | 'left'): [Point, Point, Point] {
  const x = side === 'right' ? sub.left : sub.right
  return [apex, { x, y: sub.top }, { x, y: sub.bottom }]
}

export interface SubmenuController {
  /** Closes every open submenu and cancels pending hovers (call when the menu opens or closes). */
  closeAll(): void
  /** Keyboard inside the menu: arrows/Home/End within the focused list, ArrowRight/Enter/Space open a submenu, ArrowLeft/Escape close it. True when handled. */
  handleKey(ev: KeyboardEvent): boolean
  /** A click on a submenu row opens it (no command to run). True when the click was on a submenu row. */
  handleClick(ev: MouseEvent): boolean
}

const ROW = 'li[role^=menuitem]'

/** Wires the ≡ menu's submenu rows (`li.sub` holding a `ul.submenu`). */
export function attachSubmenus(menu: HTMLElement): SubmenuController {
  let openLi: HTMLElement | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let pointer: Point = { x: 0, y: 0 }
  let apex: Point | undefined
  let moved = 0

  const ulOf = (li: HTMLElement): HTMLElement => li.querySelector<HTMLElement>(':scope > ul.submenu')!
  const clear = (): void => { if (timer !== undefined) { clearTimeout(timer); timer = undefined } }

  const close = (): void => {
    clear()
    if (!openLi) return
    ulOf(openLi).hidden = true
    openLi.setAttribute('aria-expanded', 'false')
    openLi = undefined
    apex = undefined
  }

  const open = (li: HTMLElement, focusFirst: boolean): void => {
    clear()
    if (openLi === li) { if (focusFirst) focusFirstOf(li); return }
    close()
    const ul = ulOf(li)
    ul.style.maxHeight = ''
    ul.hidden = false
    const size = { width: ul.offsetWidth, height: ul.scrollHeight + (ul.offsetHeight - ul.clientHeight) }
    const p = placeSubmenu(menu.getBoundingClientRect(), li.getBoundingClientRect(), size, { width: window.innerWidth, height: window.innerHeight })
    ul.style.left = `${p.left}px`
    ul.style.top = `${p.top}px`
    ul.style.maxHeight = `${p.maxHeight}px`
    li.dataset.side = p.side
    li.setAttribute('aria-expanded', 'true')
    openLi = li
    if (focusFirst) focusFirstOf(li)
  }

  const rowsOf = (container: HTMLElement): HTMLElement[] => [...container.children].filter((c): c is HTMLElement => c instanceof HTMLElement && c.matches(ROW) && !c.hidden)
  const focusFirstOf = (li: HTMLElement): void => { rowsOf(ulOf(li))[0]?.focus() }
  const go = (li: HTMLElement | undefined): void => { li?.focus(); li?.scrollIntoView({ block: 'nearest' }) }

  /** Runs `fn` after `delay`, but not while the pointer is still moving through the safe triangle toward the open submenu. */
  const later = (delay: number, fn: () => void): void => {
    clear()
    const tick = (wait: number): void => {
      timer = setTimeout(() => {
        timer = undefined
        if (openLi && apex && !ulOf(openLi).hidden && Date.now() - moved < 120) {
          const [a, b, c] = safeTriangle(apex, ulOf(openLi).getBoundingClientRect(), (openLi.dataset.side as 'right' | 'left') ?? 'right')
          if (inTriangle(pointer, a, b, c)) { tick(60); return }
        }
        fn()
      }, wait)
    }
    tick(delay)
  }

  menu.addEventListener('mousemove', ev => {
    pointer = { x: ev.clientX, y: ev.clientY }
    moved = Date.now()
    // Over the opener's own row (not its submenu): the pointer starts its trip from here.
    if (openLi) {
      const t = ev.target as Element
      if (openLi.contains(t) && !ulOf(openLi).contains(t)) apex = pointer
    }
  })

  menu.addEventListener('mouseover', ev => {
    const li = (ev.target as Element).closest<HTMLElement>('li')
    if (!li || !menu.contains(li)) return
    const inSub = li.parentElement !== menu
    if (inSub || li === openLi) { clear(); if (li.matches(ROW)) li.focus({ preventScroll: true }); return }
    if (li.matches(ROW)) li.focus({ preventScroll: true })
    if (li.classList.contains('sub')) later(SUBMENU_SHOW_DELAY, () => open(li, false))
    else if (openLi) later(SUBMENU_HIDE_DELAY, close)
    else clear()
  })

  // The root scrolling (the fallback for a short window) would leave a fixed submenu behind.
  menu.addEventListener('scroll', close)

  return {
    closeAll: close,
    handleClick(ev) {
      const li = (ev.target as Element).closest<HTMLElement>(ROW)
      if (!li?.classList.contains('sub')) return false
      if (!ulOf(li).contains(ev.target as Node)) open(li, false)
      return true
    },
    handleKey(ev) {
      if (ev.ctrlKey || ev.altKey || ev.metaKey) return false
      const active = document.activeElement as HTMLElement | null
      const li = active && menu.contains(active) ? active.closest<HTMLElement>(ROW) : null
      const container = li ? li.parentElement as HTMLElement : menu
      const inSub = container !== menu
      const rows = rowsOf(container)
      const i = li ? rows.indexOf(li) : -1
      switch (ev.key) {
        case 'ArrowDown': ev.preventDefault(); go(rows[(i + 1) % rows.length]); return true
        case 'ArrowUp': ev.preventDefault(); go(rows[(i - 1 + rows.length) % rows.length]); return true
        case 'Home': ev.preventDefault(); go(rows[0]); return true
        case 'End': ev.preventDefault(); go(rows[rows.length - 1]); return true
        case 'ArrowRight':
          if (li?.classList.contains('sub')) { ev.preventDefault(); open(li, true); return true }
          return inSub
        case 'Enter': case ' ':
          if (li?.classList.contains('sub')) { ev.preventDefault(); open(li, true); return true }
          return false
        case 'ArrowLeft': case 'Escape':
          if (!inSub) return ev.key === 'ArrowLeft'
          ev.preventDefault()
          ev.stopPropagation()
          { const parent = container.parentElement as HTMLElement; close(); parent.focus() }
          return true
        default: return false
      }
    },
  }
}
