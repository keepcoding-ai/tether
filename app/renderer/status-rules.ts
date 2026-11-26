// The top bar's status area as pure rules (no DOM, unit-tested): the manifest declares an icon (`contributes.status`),
// `activate` registers what it says (title, popover, badge, state), and the registry orders what the bar draws.
// An icon is drawn only while both halves exist: a disabled extension declares nothing, a failed one never registers.
import { toDisposable, type IDisposable } from '../shared/vscode-lifecycle.ts'

/** `idle` grey (nothing to do), `normal`, `busy` accent (something is happening now), `warn` amber, `error` red. */
export type StatusState = 'idle' | 'normal' | 'busy' | 'warn' | 'error'
export const STATUS_STATES: readonly StatusState[] = ['idle', 'normal', 'busy', 'warn', 'error']

/** A number on the icon, a plain dot, or nothing. A zero or a negative number is no badge. */
export type StatusBadge = number | 'dot' | undefined

/** A row of the right-click menu (structurally the same as ext-api.ts ContextMenuEntry, kept here so this file stays DOM- and icon-free). */
export type StatusMenuEntry = { icon: string; label: string; run(): void; danger?: boolean; disabled?: boolean; checked?: boolean } | 'sep'

/** What an extension registers for a declared status icon. */
export interface StatusItem {
  /** The id the manifest declared. */
  id: string
  /** The tooltip, asked on every (re)draw. */
  title(): string
  /** Fills the popover a click opens; called on every open and on every `update()` while it is open. */
  render(popover: HTMLElement): void
  badge?(): StatusBadge
  /** The icon's colour state; `normal` when absent. */
  state?(): StatusState
  /** The right-click menu. */
  menu?(): StatusMenuEntry[]
}

/** The disposable of a registration; `update()` asks the core to draw the item again (and its popover, if open). */
export interface StatusHandle extends IDisposable {
  update(): void
}

/** The manifest's entry plus the extension that declared it. */
export interface StatusDescriptor {
  id: string
  icon: string
  order?: number
  extension: string
}

export interface StatusEntry {
  desc: StatusDescriptor
  item: StatusItem
}

/** `id` set: only that item changed; unset: the list changed. */
export type StatusChange = { id?: string }

const STATUS_ID = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/

export class StatusRegistry {
  private readonly descs: StatusDescriptor[] = []
  private readonly items = new Map<string, StatusItem>()
  private readonly listeners = new Set<(c: StatusChange) => void>()

  /** The manifest half. */
  declare(desc: StatusDescriptor): IDisposable {
    if (!STATUS_ID.test(desc.id)) throw new Error(`id de status malformado: ${desc.id}`)
    if (this.descs.some(d => d.id === desc.id)) throw new Error(`status declarado duas vezes: ${desc.id}`)
    this.descs.push(desc)
    this.fire({})
    return toDisposable(() => {
      const i = this.descs.indexOf(desc)
      if (i === -1) return
      this.descs.splice(i, 1)
      this.items.delete(desc.id)
      this.fire({})
    })
  }

  /** The activation half; the id must be declared, once. */
  register(item: StatusItem): StatusHandle {
    if (!this.descs.some(d => d.id === item.id)) throw new Error(`status não declarado no manifesto: ${item.id}`)
    if (this.items.has(item.id)) throw new Error(`status registrado duas vezes: ${item.id}`)
    this.items.set(item.id, item)
    this.fire({})
    return {
      update: () => { if (this.items.get(item.id) === item) this.fire({ id: item.id }) },
      dispose: () => { if (this.items.get(item.id) === item) { this.items.delete(item.id); this.fire({}) } },
    }
  }

  /** What the bar draws: declared and registered, by `order` then id. */
  all(): StatusEntry[] {
    const out: StatusEntry[] = []
    for (const desc of this.descs) { const item = this.items.get(desc.id); if (item) out.push({ desc, item }) }
    return out.sort((a, b) => (a.desc.order ?? 1000) - (b.desc.order ?? 1000) || (a.desc.id < b.desc.id ? -1 : 1))
  }

  onDidChange(listener: (c: StatusChange) => void): IDisposable {
    this.listeners.add(listener)
    return toDisposable(() => { this.listeners.delete(listener) })
  }

  private fire(c: StatusChange): void { for (const l of [...this.listeners]) l(c) }
}

/**
 * A status icon as data (TetherUi.status.items): what the top bar draws of it now. `title` is its tooltip (the state in one
 * sentence), `badge` its number or dot (absent: none).
 */
export interface StatusView {
  id: string
  /** The extension that declared it. */
  extension: string
  icon: string
  title: string
  state: StatusState
  badge?: number | 'dot'
}

/** The bar's entries as views, in the bar's order; an item whose callback throws shows as itself with what did not throw. */
export function statusViewsOf(entries: readonly StatusEntry[]): StatusView[] {
  return entries.map(({ desc, item }) => {
    const title = attempt(() => item.title(), desc.id)
    const state = stateView(attempt(() => item.state?.(), undefined))
    const raw = attempt(() => item.badge?.(), undefined)
    const view = badgeView(raw)
    const badge: number | 'dot' | undefined = !view ? undefined : view.dot ? 'dot' : Math.floor(raw as number)
    return { id: desc.id, extension: desc.extension, icon: desc.icon, title, state, ...(badge !== undefined ? { badge } : {}) }
  })
}

function attempt<T>(fn: () => T, fallback: T): T {
  try { return fn() } catch { return fallback }
}

/** What the badge draws: '' for none, the number (99+ above 99) or '' with the dot flag. */
export function badgeView(b: StatusBadge): { text: string; dot: boolean } | undefined {
  if (b === 'dot') return { text: '', dot: true }
  if (typeof b === 'number' && Number.isFinite(b) && b > 0) return { text: b > 99 ? '99+' : String(Math.floor(b)), dot: false }
  return undefined
}

/** A state from an extension's callback, tolerant: anything unknown is `normal`. */
export function stateView(s: StatusState | undefined): StatusState {
  return s && STATUS_STATES.includes(s) ? s : 'normal'
}
