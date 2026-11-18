// The action bar: the pinned items of a menu shown outside it, plus the "⋯" that opens the whole menu (rules in action-bar-rules.ts).
import { actionBarItems, type MenuItem } from './action-bar-rules.ts'
import type { ContextMenuEntry, MenuPin } from './ext-api.ts'
import { icon, type IconName } from './icons.ts'

export interface ActionBarOptions {
  /** The complete menu; read again on every refresh(). The bar shows its pinned items. */
  entries(): ContextMenuEntry[]
  /** aria-label of the toolbar. */
  label: string
  /** Opens the complete menu at the "⋯" (page coordinates; the opener, for the focus to come back). */
  openMenu(x: number, y: number, opener: HTMLElement): void
  /** Extra class of the "⋯" button (the pad header keeps `pad-more`). */
  moreClass?: string
  /** 'spread' (default): text items on the left, icons and "⋯" on the right. 'end': everything packed at the end. */
  align?: 'spread' | 'end'
}
export interface ActionBar { readonly element: HTMLElement; refresh(): void; dispose(): void }

export function createActionBar(o: ActionBarOptions): ActionBar {
  const bar = document.createElement('div')
  bar.className = `action-bar ab-${o.align ?? 'spread'}`
  bar.setAttribute('role', 'toolbar')
  bar.setAttribute('aria-label', o.label)

  const button = (e: MenuItem, level: MenuPin): HTMLButtonElement => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `ab-act ab-${level}`
    btn.draggable = false
    btn.dataset.pin = level
    btn.dataset.label = e.label
    btn.title = e.label
    btn.setAttribute('aria-label', e.label)
    btn.disabled = !!e.disabled
    if (e.danger) btn.classList.add('danger')
    if (e.checked !== undefined) btn.setAttribute('aria-pressed', String(!!e.checked))
    btn.append(icon(e.icon as IconName))
    if (level !== 'icon') { const t = document.createElement('span'); t.className = 'ab-text'; t.textContent = e.label.replace(/…$/, ''); btn.append(t) }
    btn.addEventListener('click', ev => { ev.stopPropagation(); e.run() })
    return btn
  }

  const more = document.createElement('button')
  more.type = 'button'
  more.className = `ab-act ab-more${o.moreClass ? ` ${o.moreClass}` : ''}`
  more.draggable = false
  more.title = 'Mais ações da prancheta'
  more.setAttribute('aria-label', 'Mais ações da prancheta')
  more.setAttribute('aria-haspopup', 'menu')
  more.append(icon('dots-three'))
  more.addEventListener('click', ev => { const r = more.getBoundingClientRect(); ev.stopPropagation(); o.openMenu(r.left, r.bottom + 4, more) })

  /** Shrinks the bar until it fits: icons leave (right to left), then texts go (last to first, the highlight last). */
  const fit = (): void => {
    const icons = [...bar.querySelectorAll<HTMLElement>('.ab-icon')]
    const texts = [...bar.querySelectorAll<HTMLElement>('.ab-primary, .ab-highlight')]
    for (const b of icons) b.hidden = false
    for (const b of texts) b.classList.remove('ab-compact')
    const over = (): boolean => bar.scrollWidth > bar.clientWidth
    if (!over()) return
    for (const b of [...icons].reverse()) { b.hidden = true; if (!over()) return }
    for (const b of [...texts].reverse()) { b.classList.add('ab-compact'); if (!over()) return }
  }

  const refresh = (): void => {
    const focusedLabel = bar.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.label ?? (document.activeElement === more ? '' : undefined) : undefined
    const entries = o.entries()
    const items = actionBarItems(entries)
    const texts = [...items.primary.map(e => button(e, 'primary')), ...(items.highlight ? [button(items.highlight, 'highlight')] : [])]
    // Highlight first: it is the bar's main action.
    if (items.highlight) texts.unshift(texts.pop()!)
    const sp = document.createElement('span'); sp.className = 'ab-sp'
    bar.replaceChildren(...texts, sp, ...items.icon.map(e => button(e, 'icon')), more)
    fit()
    if (focusedLabel !== undefined) {
      const target = focusedLabel === '' ? more : [...bar.querySelectorAll<HTMLElement>('.ab-act[data-label]')].find(b => b.dataset.label === focusedLabel && !b.hidden)
      target?.focus()
    }
  }

  const ro = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => fit())
  ro?.observe(bar)
  refresh()
  return { element: bar, refresh, dispose: () => ro?.disconnect() }
}
