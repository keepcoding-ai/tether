// The web's floating menu (the place of the app's context menu, for a device that converses): a speech's reactions and
// "Copiar", a poll's votes, the list behind "+N". The shared screen builds the rows (channel-pane.ts) and asks the host to
// show them; this is how the web shows them. At a point on the desk and the TV, a sheet from the bottom on the phone.
// The keys of a menu: the arrows walk the rows, Enter or Space run one, Esc or Tab close it, a press outside closes it.
// It lives in the body as `#ctx-menu`, the id the shared screen watches to give the focus back to the speech it came from.
// Every text goes in as a text node.
import type { ContextMenuEntry, ContextMenuHeading, ContextMenuItem } from '../../../app/renderer/ext-api.ts'
import { icon, ICON_NAMES, type IconName } from '../../../app/renderer/icons.ts'
import { el } from './ui-lite.ts'

type Row = ContextMenuEntry | ContextMenuHeading

export interface WebMenu {
  open(x: number, y: number, rows: readonly Row[]): void
  close(): void
  isOpen(): boolean
}

export interface WebMenuDeps {
  /** The phone: the menu is a sheet from the bottom, over a veil. */
  sheet(): boolean
  /** The tier of the screen (the menu's size follows it). */
  tier(): string
}

const isHeading = (r: Row): r is ContextMenuHeading => typeof r === 'object' && 'heading' in r
const isItem = (r: Row): r is ContextMenuItem => typeof r === 'object' && 'label' in r

export function createMenu(deps: WebMenuDeps): WebMenu {
  let box: HTMLElement | undefined
  let veil: HTMLElement | undefined
  let off: (() => void) | undefined

  const close = (): void => {
    off?.()
    off = undefined
    veil?.remove()
    veil = undefined
    // Removed from the body: the shared screen sees `#ctx-menu` go and gives the focus back to its speech.
    box?.remove()
    box = undefined
  }

  const buttons = (): HTMLButtonElement[] => (box ? [...box.querySelectorAll<HTMLButtonElement>('button.rr-mi:not([disabled])')] : [])

  const open = (x: number, y: number, rows: readonly Row[]): void => {
    close()
    const sheet = deps.sheet()
    const m = el('div', 'rr-menu')
    m.id = 'ctx-menu'
    m.setAttribute('role', 'menu')
    m.dataset.form = sheet ? 'sheet' : 'point'
    m.dataset.tier = deps.tier()
    let label = ''
    for (const r of rows) {
      if (r === 'sep') { const s = el('div', 'rr-msep'); s.setAttribute('role', 'separator'); m.append(s); continue }
      if (isHeading(r)) { if (!label) label = r.heading; const h = el('div', 'rr-mh', r.heading); h.setAttribute('role', 'presentation'); m.append(h); continue }
      if (!isItem(r)) continue
      const b = el('button', `rr-mi${r.danger ? ' danger' : ''}`)
      b.type = 'button'
      b.tabIndex = -1
      b.setAttribute('role', r.checked !== undefined ? 'menuitemcheckbox' : 'menuitem')
      if (r.checked !== undefined) b.setAttribute('aria-checked', String(r.checked))
      if (r.disabled) b.disabled = true
      const mark = el('span', 'rr-mi-ic')
      mark.setAttribute('aria-hidden', 'true')
      if (r.checked) mark.append(icon('check'))
      else if ((ICON_NAMES as readonly string[]).includes(r.icon)) mark.append(icon(r.icon as IconName))
      b.append(mark, el('span', 'rr-mi-l', r.label))
      if (r.hint) b.append(el('span', 'rr-mi-k', r.hint))
      b.addEventListener('click', () => { close(); r.run() })
      m.append(b)
    }
    if (label) m.setAttribute('aria-label', label)
    m.addEventListener('keydown', ev => {
      const all = buttons()
      const at = all.indexOf(document.activeElement as HTMLButtonElement)
      const go = (i: number): void => { all[(i + all.length) % all.length]?.focus() }
      if (ev.key === 'ArrowDown') { ev.preventDefault(); go(at + 1) }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); go(at < 0 ? -1 : at - 1) }
      else if (ev.key === 'Home') { ev.preventDefault(); go(0) }
      else if (ev.key === 'End') { ev.preventDefault(); go(-1) }
      else if (ev.key === 'Escape' || ev.key === 'Tab' || ev.key === 'GoBack' || ev.key === 'BrowserBack') { ev.preventDefault(); ev.stopPropagation(); close() }
      else return
      ev.stopPropagation()
    })
    if (sheet) {
      const v = el('div', 'rr-menu-veil')
      v.addEventListener('click', close)
      document.body.append(v)
      veil = v
    }
    document.body.append(m)
    box = m
    if (!sheet) {
      // At the point, kept inside the window.
      const r = m.getBoundingClientRect()
      m.style.left = `${Math.max(8, Math.min(x, window.innerWidth - r.width - 8))}px`
      m.style.top = `${Math.max(8, Math.min(y, window.innerHeight - r.height - 8))}px`
    }
    const onDown = (ev: Event): void => { if (ev.target instanceof Node && !m.contains(ev.target) && ev.target !== veil) close() }
    const onBlur = (): void => close()
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('blur', onBlur)
    // A point drifts from its speech when the window changes size; the sheet holds the bottom (the phone's bars come and go).
    if (!sheet) window.addEventListener('resize', onBlur)
    off = () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('resize', onBlur)
    }
    buttons()[0]?.focus()
  }

  return { open, close, isOpen: () => box !== undefined }
}
