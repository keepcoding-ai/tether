/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Adaptation of VS Code's menu registry: menus are lists of items contributed by id, each with a group and an order,
// and the rendered menu is the items sorted by group then order, with a separator between groups.
// Origin: https://github.com/microsoft/vscode, commit 7faf984945fefaceb533ca1d851697a2e72e4e68
//   src/vs/platform/actions/common/actions.ts   (IMenuItem, MenuRegistry.appendMenuItem/appendMenuItems/getMenuItems,
//                                                 MenuId as a typed id, appendMenuGroup for a group's presentation)
//   src/vs/platform/actions/common/menuService.ts (MenuInfo.compareMenuItems: group, then order, then a tiebreak)
// Adapted: the group order is fixed by the core (a list per menu) instead of 'navigation' first + lexical; groups the core
// does not list come after, lexically. Ties keep registration order (VS Code compares titles; titles live in the command
// registry here, outside this pure module). `when` is a function of the caller's context (no context-key language).
// An item can be a radio or a checkbox (VS Code's `toggled`), with a static initial check the renderer keeps in sync.
// Left out: submenus, alt commands, hidden-by-default state, the change event (the ≡ menu is built once at startup,
// after the extensions activate). Pure, no DOM.
import { toDisposable, DisposableStore, type IDisposable } from './vscode-lifecycle.ts'

/** A menu's id (VS Code's MenuId): a string with a type tag, so a menu is named once and shared. */
export class MenuId {
  /** The ≡ app menu of the toolbar. */
  static readonly App = new MenuId('app')
  readonly id: string
  constructor(id: string) { this.id = id }
}

export interface MenuItem<Ctx = unknown> {
  /** The command the item runs (an id of the command registry). */
  command: string
  group: string
  /** Within the group, ascending; default 0. */
  order?: number
  /** The text shown; default: the command's title (the caller resolves it). */
  label?: string
  /** An icon name (icons.ts); a radio/checkbox shows the check instead. */
  icon?: string
  kind?: 'radio' | 'checkbox'
  /** The initial check of a radio/checkbox, before the renderer syncs it with the setting. */
  checked?: boolean
  /** The radio's value attribute (the theme radios carry `data-theme`). */
  data?: Readonly<Record<string, string>>
  danger?: boolean
  /** Shown only when true for the caller's context. */
  when?: (ctx: Ctx) => boolean
}

/** A group's presentation (VS Code's IMenuGroup): an optional heading row above its items. */
export interface MenuGroup {
  id: string
  heading?: { label: string; icon?: string }
}

export type MenuEntry<Ctx = unknown> =
  | { type: 'item'; item: MenuItem<Ctx> }
  | { type: 'separator' }
  | { type: 'heading'; label: string; icon?: string }

export class MenuRegistryImpl<Ctx = unknown> {
  private readonly items = new Map<string, MenuItem<Ctx>[]>()
  private readonly groups = new Map<string, MenuGroup[]>()
  private readonly groupOrder = new Map<string, readonly string[]>()

  appendMenuItem(menu: MenuId, item: MenuItem<Ctx>): IDisposable {
    let list = this.items.get(menu.id)
    if (!list) { list = []; this.items.set(menu.id, list) }
    list.push(item)
    return toDisposable(() => { const i = list.indexOf(item); if (i !== -1) list.splice(i, 1) })
  }

  appendMenuItems(items: Iterable<{ id: MenuId; item: MenuItem<Ctx> }>): IDisposable {
    const result = new DisposableStore()
    for (const { id, item } of items) result.add(this.appendMenuItem(id, item))
    return result
  }

  getMenuItems(menu: MenuId): MenuItem<Ctx>[] {
    return [...(this.items.get(menu.id) ?? [])]
  }

  /** The latest registration of a group wins until disposed (VS Code unshifts). */
  appendMenuGroup(menu: MenuId, group: MenuGroup): IDisposable {
    let list = this.groups.get(menu.id)
    if (!list) { list = []; this.groups.set(menu.id, list) }
    list.unshift(group)
    return toDisposable(() => { const i = list.indexOf(group); if (i !== -1) list.splice(i, 1) })
  }

  getMenuGroup(menu: MenuId, group: string): MenuGroup | undefined {
    return this.groups.get(menu.id)?.find(g => g.id === group)
  }

  /** The core's fixed order of a menu's groups. */
  setGroupOrder(menu: MenuId, order: readonly string[]): void {
    this.groupOrder.set(menu.id, order)
  }

  /** The menu as rows (without `ctx`, every item; with it, the ones whose `when` holds), sorted, with a separator between groups and each group's heading. */
  build(menu: MenuId, ctx?: Ctx): MenuEntry<Ctx>[] {
    const order = this.groupOrder.get(menu.id) ?? []
    const visible = this.getMenuItems(menu).filter(i => !i.when || ctx === undefined || i.when(ctx))
    const sorted = sortMenuItems(visible, order)
    const out: MenuEntry<Ctx>[] = []
    let group: string | undefined
    for (const item of sorted) {
      if (item.group !== group) {
        if (group !== undefined) out.push({ type: 'separator' })
        group = item.group
        const heading = this.getMenuGroup(menu, group)?.heading
        if (heading) out.push({ type: 'heading', ...heading })
      }
      out.push({ type: 'item', item })
    }
    return out
  }
}

/** VS Code's compareMenuItems with the core's group order: listed groups first in that order, the rest lexically; then order; then registration. */
export function sortMenuItems<T extends { group: string; order?: number }>(items: readonly T[], groupOrder: readonly string[]): T[] {
  const rank = (g: string): number => { const i = groupOrder.indexOf(g); return i === -1 ? groupOrder.length : i }
  return items.map((item, index) => ({ item, index })).sort((a, b) => {
    if (a.item.group !== b.item.group) {
      const r = rank(a.item.group) - rank(b.item.group)
      if (r !== 0) return r
      return a.item.group.localeCompare(b.item.group)
    }
    const p = (a.item.order ?? 0) - (b.item.order ?? 0)
    return p !== 0 ? p : a.index - b.index
  }).map(x => x.item)
}
