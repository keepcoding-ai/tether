// The top bar's status area (left of the connection icon): one icon button per registered status, with an optional
// badge, the tooltip from `title()` and a popover the extension fills. A click opens it (pinned until a click outside
// or Esc, like the connection popover); one popover at a time. Colours are theme tokens only.
import { icon, ICON_NAMES, type IconName } from './icons.ts'
import { badgeView, stateView, type StatusEntry, type StatusMenuEntry, type StatusRegistry } from './status-rules.ts'

export interface StatusBarDeps {
  contextMenu(x: number, y: number, entries: StatusMenuEntry[]): void
}

export class StatusBar {
  private openId: string | undefined
  private readonly wraps = new Map<string, HTMLElement>()
  private readonly host: HTMLElement
  private readonly registry: StatusRegistry
  private readonly deps: StatusBarDeps

  constructor(host: HTMLElement, registry: StatusRegistry, deps: StatusBarDeps) {
    this.host = host
    this.registry = registry
    this.deps = deps
    registry.onDidChange(c => { if (c.id) this.refresh(c.id); else this.render() })
    // Capture phase: the connection and theme buttons stop their clicks, which must still close this popover.
    document.addEventListener('click', ev => { if (this.openId && !this.wraps.get(this.openId)?.contains(ev.target as Node)) this.close() }, true)
    document.addEventListener('keydown', ev => {
      if (ev.key !== 'Escape' || !this.openId) return
      const btn = this.button(this.openId)
      const inside = !!btn && this.wraps.get(this.openId)!.contains(document.activeElement) && document.activeElement !== btn
      this.close()
      if (inside) btn?.focus()
    }, true)
  }

  /** Closes the open popover (the other toolbar popups call it when they open). */
  close(): void {
    const id = this.openId
    this.openId = undefined
    if (!id) return
    const wrap = this.wraps.get(id)
    wrap?.classList.remove('pinned')
    this.button(id)?.setAttribute('aria-expanded', 'false')
  }

  /**
   * Opens the icon's popover (the one a click opens), closing any other; already open: it stays. False when the icon is not
   * drawn (undeclared, unregistered, or its extension is off).
   */
  show(id: string): boolean {
    const current = this.registry.all().find(x => x.desc.id === id)
    const wrap = this.wraps.get(id)
    if (!current || !wrap) return false
    if (this.openId === id) return true
    this.close()
    this.openId = id
    this.fill(current, wrap)
    wrap.classList.add('pinned')
    this.button(id)?.setAttribute('aria-expanded', 'true')
    return true
  }

  /** Draws every registered status again (the list changed). */
  render(): void {
    const entries = this.registry.all()
    const keep = new Set(entries.map(e => e.desc.id))
    if (this.openId && !keep.has(this.openId)) this.openId = undefined
    for (const [id, wrap] of this.wraps) if (!keep.has(id)) { wrap.remove(); this.wraps.delete(id) }
    entries.forEach((e, i) => {
      let wrap = this.wraps.get(e.desc.id)
      if (!wrap) { wrap = this.build(e); this.wraps.set(e.desc.id, wrap) }
      if (this.host.children[i] !== wrap) this.host.insertBefore(wrap, this.host.children[i] ?? null)
      this.paint(e, wrap)
    })
  }

  private button(id: string): HTMLButtonElement | null { return this.wraps.get(id)?.querySelector('.status-btn') ?? null }

  private refresh(id: string): void {
    const e = this.registry.all().find(x => x.desc.id === id)
    const wrap = this.wraps.get(id)
    if (!e || !wrap) return
    this.paint(e, wrap)
    if (this.openId === id) this.fill(e, wrap)
  }

  private build(e: StatusEntry): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'dropdown status-wrap'
    wrap.dataset.status = e.desc.id
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'ib status-btn'
    btn.setAttribute('aria-haspopup', 'dialog')
    btn.setAttribute('aria-expanded', 'false')
    const name = (ICON_NAMES as string[]).includes(e.desc.icon) ? e.desc.icon as IconName : 'circle-fill'
    btn.append(icon(name))
    const badge = document.createElement('span')
    badge.className = 'status-badge'
    badge.hidden = true
    btn.append(badge)
    const pop = document.createElement('div')
    pop.className = 'popover status-pop'
    pop.setAttribute('role', 'dialog')
    pop.id = `status-pop-${e.desc.id}`
    btn.setAttribute('aria-controls', pop.id)
    wrap.append(btn, pop)
    btn.addEventListener('click', ev => {
      ev.stopPropagation()
      if (this.openId === e.desc.id) { this.close(); return }
      this.show(e.desc.id)
    })
    btn.addEventListener('contextmenu', ev => {
      const entries = this.registry.all().find(x => x.desc.id === e.desc.id)?.item.menu?.()
      if (!entries?.length) return
      ev.preventDefault()
      this.close()
      this.deps.contextMenu(ev.clientX, ev.clientY, entries)
    })
    return wrap
  }

  private paint(e: StatusEntry, wrap: HTMLElement): void {
    const btn = wrap.querySelector<HTMLButtonElement>('.status-btn')!
    const title = e.item.title()
    btn.title = title
    btn.setAttribute('aria-label', title)
    btn.dataset.state = stateView(e.item.state?.())
    const view = badgeView(e.item.badge?.())
    const badge = btn.querySelector<HTMLElement>('.status-badge')!
    badge.hidden = !view
    badge.classList.toggle('dot', !!view?.dot)
    badge.textContent = view?.text ?? ''
  }

  private fill(e: StatusEntry, wrap: HTMLElement): void {
    const pop = wrap.querySelector<HTMLElement>('.status-pop')!
    pop.replaceChildren()
    e.item.render(pop)
  }
}
