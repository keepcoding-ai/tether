// The fixed right end of a pane's tab strip (dockview `createRightHeaderActionComponent`, one per group):
// "+" (a new empty tab in this group, the chooser inside it), "+N" (the tabs that do not fit), the status-bar
// toggle and "⋯" (the pane menu). They act on the group's active panel and never move: the tab list shrinks to its left.
//
// Overflow is measured here, not by dockview's own list (`disableTabsOverflowList`): the native one counts the
// tabs scrolled out of a scrolling strip, so which tabs hide follows the scroll position, not use. Here the
// strip never scrolls: tabs shrink to a minimum width, then the tab used longest ago is hidden
// (`.tab-hidden` on dockview's `.dv-tab`), and picking one in the "+N" moves it (`moveTo`, saved with the
// layout) into the place of the visible tab used longest ago. Rules in tab-strip-rules.ts.
import type { IDockviewGroupPanel, IDockviewPanel, IGroupHeaderProps, IHeaderActionsRenderer } from 'dockview-core'
import { icon, type IconName } from './icons.ts'
import { detailsLabel, detailsOpen } from './pane-details.ts'
import { shortcutHint } from './shortcuts.ts'
import { fitTabs, hiddenTabs, pickIndex, touchTab } from './tab-strip-rules.ts'

/** One hidden tab as the "+N" lists it. */
export interface HiddenTab { id: string; icon: IconName; label: string; attention: boolean; busy?: boolean }

export interface TabStripHost {
  /** What the "+N" shows for a pane: agent icon, title, attention. */
  describe(id: string): { icon: IconName; label: string; attention: boolean; busy?: boolean }
  /** The "+N" list at (x, y); `pick` brings one back. `opener` is the "+N" button (aria-expanded, focus return). */
  showHidden(x: number, y: number, tabs: HiddenTab[], pick: (id: string) => void, opener: HTMLElement): void
  /** Whether the pane is hibernated: it leaves the strip for the moon menu (unless it is the active tab). */
  isAsleep(id: string): boolean
  /** The moon menu at (x, y): one entry per hibernated tab; `wake` wakes it and makes it active. */
  showAsleep(x: number, y: number, tabs: HiddenTab[], wake: (id: string) => void, opener: HTMLElement): void
  /** "⋯": the pane menu (the same one as a right-click on the tab). `opener` is the "⋯" button. */
  paneMenu(id: string, x: number, y: number, opener: HTMLElement): void
  toggleDetails(id: string): void
  /** The "+": an empty pane as a new tab beside `activeId` (the group's active pane), origin `add`. */
  addTab(activeId: string): void
  /** Whether the pane is a markdown note (the button that opens its preview beside it shows only then). */
  canPreview(id: string): boolean
  /** The button: the pane's markdown preview to its side (VS Code's editor-title button). */
  previewSide(id: string): void
}

/** The title of the "+" button (the chord follows). */
export const ADD_TAB_LABEL = 'Nova aba'

/** The title of the preview button. */
export const PREVIEW_SIDE_LABEL = 'Abrir prévia ao lado'

/** The title of the "⋯" button. */
export const PANE_MENU_LABEL = 'Menu do painel'

export class TabStripActions implements IHeaderActionsRenderer {
  readonly element: HTMLElement
  private readonly add: HTMLButtonElement
  private readonly more: HTMLButtonElement
  /** The moon: the hibernated tabs, out of the strip (the same as the desk capsule's moon). */
  private readonly sleep: HTMLButtonElement
  private readonly sleepCount = document.createTextNode('')
  private asleep: string[] = []
  private readonly toggle: HTMLButtonElement
  private readonly preview: HTMLButtonElement
  private readonly dots: HTMLButtonElement
  private group: IDockviewGroupPanel | undefined
  /** Use stamps of this group's tabs (session only). */
  private readonly used = new Map<string, number>()
  private hidden: string[] = []
  private disposers: Array<() => void> = []
  private paramsSub: (() => void) | undefined
  private frame = 0
  /** The "+N" count: one text node whose data changes, so a re-measure with the same count writes nothing. */
  private readonly moreCount = document.createTextNode('')
  private moreDot: HTMLElement | undefined
  private observer: MutationObserver | undefined

  private readonly host: TabStripHost

  constructor(host: TabStripHost) {
    this.host = host
    this.element = document.createElement('div')
    this.element.className = 'tab-actions'
    this.add = document.createElement('button')
    this.add.className = 'tab-act add'; this.add.dataset.action = 'add-tab'; this.add.type = 'button'
    const addTitle = `${ADD_TAB_LABEL} (${shortcutHint('pane.new-tab')})`
    this.add.title = addTitle; this.add.setAttribute('aria-label', ADD_TAB_LABEL)
    this.add.append(icon('plus'))
    this.more = document.createElement('button')
    this.more.className = 'tab-more'; this.more.dataset.action = 'more'; this.more.hidden = true
    this.more.type = 'button'; this.more.setAttribute('aria-haspopup', 'menu'); this.more.setAttribute('aria-expanded', 'false')
    this.more.append(this.moreCount)
    this.sleep = document.createElement('button')
    this.sleep.className = 'tab-more tab-sleep'; this.sleep.dataset.action = 'asleep'; this.sleep.hidden = true
    this.sleep.type = 'button'; this.sleep.setAttribute('aria-haspopup', 'menu'); this.sleep.setAttribute('aria-expanded', 'false')
    this.sleep.append(icon('moon'), this.sleepCount)
    this.preview = document.createElement('button')
    this.preview.className = 'tab-act'; this.preview.dataset.action = 'md-preview-side'; this.preview.type = 'button'; this.preview.hidden = true
    this.preview.title = PREVIEW_SIDE_LABEL; this.preview.setAttribute('aria-label', PREVIEW_SIDE_LABEL)
    this.preview.append(icon('square-split-horizontal'))
    this.toggle = document.createElement('button')
    this.toggle.className = 'tab-act'; this.toggle.dataset.action = 'status-bar'; this.toggle.type = 'button'
    this.toggle.append(icon('rows'))
    this.dots = document.createElement('button')
    this.dots.className = 'tab-act'; this.dots.dataset.action = 'pane-menu'
    this.dots.title = PANE_MENU_LABEL; this.dots.setAttribute('aria-label', PANE_MENU_LABEL); this.dots.setAttribute('aria-haspopup', 'menu'); this.dots.setAttribute('aria-expanded', 'false'); this.dots.type = 'button'
    this.dots.append(icon('dots-three'))
    this.element.append(this.preview, this.toggle, this.dots)
    // The "+N" is not one of the actions: it lives in the tab row right after the last visible tab (placed by measure).
    this.more.addEventListener('pointerdown', ev => ev.stopPropagation())
    this.sleep.addEventListener('pointerdown', ev => ev.stopPropagation())
    this.sleep.addEventListener('click', ev => { ev.stopPropagation(); this.openAsleep() })
    this.sleep.addEventListener('keydown', ev => { if (ev.key === 'ArrowDown') { ev.preventDefault(); this.openAsleep() } })
    // The "+" sits outside .tab-actions (right after the "+N"), so it needs its own guard against dockview's group drag.
    this.add.addEventListener('pointerdown', ev => ev.stopPropagation())
    // Buttons, not drag handles: dockview must not start a group drag from here.
    this.element.addEventListener('pointerdown', ev => ev.stopPropagation())
    this.add.addEventListener('click', ev => { ev.stopPropagation(); const id = this.activeId(); if (id) this.host.addTab(id) })
    this.more.addEventListener('click', ev => { ev.stopPropagation(); this.openHidden() })
    this.more.addEventListener('keydown', ev => { if (ev.key === 'ArrowDown') { ev.preventDefault(); this.openHidden() } })
    this.dots.addEventListener('keydown', ev => { if (ev.key === 'ArrowDown') { ev.preventDefault(); this.dots.click() } })
    this.preview.addEventListener('click', ev => { ev.stopPropagation(); const id = this.activeId(); if (id) this.host.previewSide(id) })
    this.toggle.addEventListener('click', ev => { ev.stopPropagation(); const id = this.activeId(); if (id) this.host.toggleDetails(id) })
    this.dots.addEventListener('click', ev => {
      ev.stopPropagation()
      const id = this.activeId()
      const r = this.dots.getBoundingClientRect()
      if (id) this.host.paneMenu(id, r.right - 4, r.bottom + 2, this.dots)
    })
  }

  init(params: IGroupHeaderProps): void {
    this.group = params.group
    const g = params.api
    const active = (): void => {
      const p = this.group?.activePanel
      if (p) touchTab(this.used, p.id)
      this.watchParams(p)
      this.paintToggle()
      this.measure()
    }
    this.disposers.push(g.onDidActivePanelChange(active).dispose)
    this.disposers.push(params.containerApi.onDidRemovePanel(p => { this.used.delete(p.id); this.schedule() }).dispose)
    active()
    // Tabs added, removed, reordered or retitled, and attention changes: measure again. Only these are
    // observed (not `class`), so hiding a tab does not trigger a new pass. The strip's own buttons live inside
    // the observed header: what measuring writes there is dropped (here and by `takeRecords` in measure), or
    // every pass would schedule the next one.
    const mo = new MutationObserver(records => { if (records.some(r => !this.ownMutation(r))) this.schedule() })
    this.observer = mo
    const ro = new ResizeObserver(() => this.schedule())
    queueMicrotask(() => {
      const head = this.header()
      if (!head) return
      mo.observe(head, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-attention', 'data-mark', 'data-slot', 'data-glyph'] })
      ro.observe(head)
      this.measure()
    })
    this.disposers.push(() => mo.disconnect(), () => ro.disconnect())
  }

  /** The hidden tabs (for tests and the "+N"). */
  hiddenIds(): readonly string[] { return this.hidden }

  private activeId(): string | undefined { return this.group?.activePanel?.id }

  private header(): HTMLElement | null { return this.element.closest<HTMLElement>('.dv-tabs-and-actions-container') }

  private watchParams(p: IDockviewPanel | undefined): void {
    this.paramsSub?.()
    this.paramsSub = p ? p.api.onDidParametersChange(() => this.paintToggle()).dispose : undefined
  }

  private paintToggle(): void {
    const p = this.group?.activePanel
    this.element.hidden = !p
    this.preview.hidden = !p || !this.host.canPreview(p.id)
    const open = detailsOpen(p?.params)
    const title = `${detailsLabel(open)} (${shortcutHint('pane.details')})`
    if (this.toggle.title !== title) this.toggle.title = title
    if (this.toggle.getAttribute('aria-label') !== detailsLabel(open)) this.toggle.setAttribute('aria-label', detailsLabel(open))
    if (this.toggle.getAttribute('aria-pressed') !== String(open)) this.toggle.setAttribute('aria-pressed', String(open))
  }

  /** Whether a mutation record is this strip's own doing: inside its buttons, or the placing of "+N" and "+". */
  private ownMutation(r: MutationRecord): boolean {
    const own = (n: Node): boolean => this.more.contains(n) || this.sleep.contains(n) || this.add.contains(n) || this.element.contains(n)
    if (own(r.target)) return true
    if (r.type !== 'childList') return false
    for (const n of r.addedNodes) if (!own(n)) return false
    for (const n of r.removedNodes) if (!own(n)) return false
    return true
  }

  private schedule(): void {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.measure() })
  }

  /** The strip's tabs in their DOM order, by panel id. */
  private tabs(head: HTMLElement): Map<string, HTMLElement> {
    const m = new Map<string, HTMLElement>()
    for (const el of head.querySelectorAll<HTMLElement>('.dv-tabs-container > .dv-tab')) {
      const id = el.querySelector<HTMLElement>('[data-slot]')?.dataset.slot
      if (id) m.set(id, el)
    }
    return m
  }

  private measure(): void {
    const head = this.header()
    const list = head?.querySelector<HTMLElement>('.dv-tabs-container')
    if (!head || !list) return
    // Right after the tabs, before dockview's void and the actions: the "+N" and the "+" read as the end of the tab row.
    // dockview may wrap the tab list in a scroller (.dv-scrollable): the "+N" goes after the wrapper, never inside it.
    const row = list.parentElement?.classList.contains('dv-scrollable') ? list.parentElement : list
    if (this.more.previousElementSibling !== row || this.sleep.previousElementSibling !== this.more || this.add.previousElementSibling !== this.sleep) row.after(this.more, this.sleep, this.add)
    const els = this.tabs(head)
    // Hibernated tabs leave the strip for the moon (the active one always shows); the rest share the room.
    const active = this.activeId()
    this.asleep = [...els.keys()].filter(id => id !== active && this.host.isAsleep(id))
    const sleeping = new Set(this.asleep)
    const order = [...els.keys()].filter(id => !sleeping.has(id))
    // Writes only what changed: an unchanged pass must leave the DOM (and the layout) untouched.
    const apply = (vis: readonly string[]): void => {
      const v = new Set(vis)
      for (const [id, el] of els) {
        const hide = !v.has(id) || sleeping.has(id)
        if (el.classList.contains('tab-hidden') !== hide) el.classList.toggle('tab-hidden', hide)
      }
      const none = vis.length === order.length
      if (this.more.hidden !== none) this.more.hidden = none
      const count = `+${order.length - vis.length}`
      if (this.moreCount.data !== count) this.moreCount.data = count
    }
    // The trial passes show and hide the "+N" (its width changes the room); a hidden element loses the focus, so a
    // keyboard user sitting on it would be thrown to <body> by any re-measure. Put it back when it is still there.
    const hadFocus = document.activeElement === this.more
    const fits = (vis: readonly string[]): boolean => { apply(vis); return list.scrollWidth <= list.clientWidth + 1 }
    const vis = fitTabs(order, this.activeId(), this.used, fits)
    apply(vis)
    if (hadFocus && !this.more.hidden && document.activeElement !== this.more) this.more.focus({ preventScroll: true })
    this.hidden = hiddenTabs(order, vis)
    this.paintMore()
    this.paintSleep()
    // Everything queued up to here is either this pass's own writes or a change this pass has already read.
    this.observer?.takeRecords()
  }

  private paintMore(): void {
    const n = this.hidden.length
    const attention = this.hidden.some(id => this.host.describe(id).attention)
    const busy = !attention && this.hidden.some(id => this.host.describe(id).busy)
    if (this.more.classList.contains('attention') !== attention) this.more.classList.toggle('attention', attention)
    if (this.more.classList.contains('busy') !== busy) this.more.classList.toggle('busy', busy)
    if (attention && !this.moreDot) {
      this.moreDot = document.createElement('span'); this.moreDot.className = 'more-dot'; this.more.append(this.moreDot)
    } else if (!attention && this.moreDot) {
      this.moreDot.remove(); this.moreDot = undefined
    }
    const label = n === 1 ? '1 aba escondida' : `${n} abas escondidas`
    if (this.more.title !== label) this.more.title = label
    if (this.more.getAttribute('aria-label') !== label) this.more.setAttribute('aria-label', label)
  }

  private paintSleep(): void {
    const n = this.asleep.length
    if (this.sleep.hidden !== (n === 0)) this.sleep.hidden = n === 0
    if (this.sleepCount.data !== String(n)) this.sleepCount.data = String(n)
    const label = n === 1 ? '1 guia hibernada' : `${n} guias hibernadas`
    if (this.sleep.title !== label) this.sleep.title = label
    if (this.sleep.getAttribute('aria-label') !== label) this.sleep.setAttribute('aria-label', label)
  }

  private openAsleep(): void {
    if (this.asleep.length === 0) return
    const r = this.sleep.getBoundingClientRect()
    const list = this.asleep.map(id => ({ id, ...this.host.describe(id) }))
    this.host.showAsleep(r.left, r.bottom + 2, list, id => this.wake(id), this.sleep)
  }

  /** Waking from the moon: the tab comes back to its place in the strip and becomes active (the host starts it). */
  private wake(id: string): void {
    const panel = this.group?.panels.find(p => p.id === id)
    if (!panel) return
    touchTab(this.used, id)
    panel.api.setActive()
    this.measure()
  }

  private openHidden(): void {
    const head = this.header()
    if (!head || this.hidden.length === 0) return
    const r = this.more.getBoundingClientRect()
    const list = this.hidden.map(id => ({ id, ...this.host.describe(id) }))
    this.host.showHidden(r.left, r.bottom + 2, list, id => this.pick(id), this.more)
  }

  /** Picking in the "+N": the tab moves into the place of the visible tab used longest ago and becomes active. */
  private pick(id: string): void {
    const g = this.group
    const head = this.header()
    const panel = g?.panels.find(p => p.id === id)
    if (!g || !head || !panel) return
    const order = [...this.tabs(head).keys()]
    const visible = order.filter(x => !this.hidden.includes(x))
    const index = pickIndex(order, visible, id, this.activeId(), this.used)
    if (index !== undefined) panel.api.moveTo({ group: g as Parameters<typeof panel.api.moveTo>[0]["group"], index })
    touchTab(this.used, id)
    panel.api.setActive()
    this.measure()
  }

  dispose(): void {
    if (this.frame) cancelAnimationFrame(this.frame)
    this.paramsSub?.()
    for (const d of this.disposers) d()
    this.disposers = []
    this.observer = undefined
  }
}
