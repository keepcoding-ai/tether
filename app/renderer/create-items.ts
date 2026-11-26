// What a manager's "+ Novo" can make in a desk (TetherUi.create.items), pure (unit-tested): the chooser's own items
// (chooser-rules.ts: the profiles by engine, the extensions' items, the empty pane) as data, the recent profiles first
// (most recent first), then the rest in the chooser's order. The folder is the one the chooser suggests while its field is
// untouched (effectiveFolder), so the same profile opens in the same place from either.
import type { CreateItem } from './ext-api.ts'
import { type ChooserItem, effectiveFolder } from './chooser-rules.ts'

/** One chooser item as a CreateItem. */
export function createItemOf(item: ChooserItem, recent: boolean): CreateItem {
  const profile = item.kind === 'profile'
  const kind: CreateItem['kind'] = profile ? 'profile' : item.kind === 'empty' ? 'empty' : 'item'
  return {
    id: item.id,
    kind,
    group: item.group,
    name: item.name,
    ...(item.hintNone ? {} : { hint: item.hint }),
    icon: item.icon,
    ...(profile ? { engine: item.group, profileId: item.id } : { itemId: item.kind }),
    ...(item.unsafe ? { unsafe: true } : {}),
    ...(item.default ? { default: true } : {}),
    // choiceNeedsFolder's rule on the item itself: only a process (a profile) needs one.
    needsFolder: profile,
    ...(item.cwd ? { folder: effectiveFolder(item, '', false).folder } : {}),
    ...(recent ? { recent: true } : {}),
  }
}

/** The chooser's items as "+ Novo" lists them: the recent profiles first (in `recentIds` order), then the others as the chooser has them. */
export function createItemsOf(items: readonly ChooserItem[], recentIds: readonly string[]): CreateItem[] {
  const recent = recentIds.map(id => items.find(i => i.id === id && i.kind === 'profile')).filter((i): i is ChooserItem => !!i)
  return [...recent.map(i => createItemOf(i, true)), ...items.filter(i => !recent.includes(i)).map(i => createItemOf(i, false))]
}
