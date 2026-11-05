// The pane-type registry (F9, slice 0a): every kind of pane (terminal, note, previews, empty pane, shortcuts screen,
// and later the ones extensions contribute) registers what the core needs to know about it in one place, instead of
// fixed if/else chains spread over main.ts. Two layers:
//   PaneLayout  what layout.json needs (pure, unit-tested): the dockview component and tab names, the id prefix, whether
//               a slot sits behind the pane, and the dockview options of a pane moved or restored from its saved state.
//   PaneType    the live side (main.ts or an extension): create the content and tab, find a live instance, its folder,
//               the context flags while active, what "reopen the last closed pane" needs.
// Compatibility rule: component names, tab names, id prefixes and params never change, they are in the person's layout.json.
// The shape follows VS Code's EditorPaneRegistry (src/vs/workbench/browser/editor.ts @7faf984): registering returns a
// disposable that unregisters, and when several descriptors match the same input one of them is preferred (VS Code asks
// the input, `prefersEditorPane`; here the type's `owns`). This module stays pure (type-only dockview import) for the unit tests.
import type { AddPanelOptions, IContentRenderer, ITabRenderer } from 'dockview-core'
import { toDisposable, type IDisposable } from '../shared/vscode-lifecycle.ts'

export type Disposable = IDisposable

/** What a pane is in layout.json: its id, title and params (a live dockview panel has the same fields). */
export interface SavedPane {
  id: string
  title?: string | undefined
  params?: Record<string, unknown> | undefined
}

export interface PaneLayout {
  /** The type's id ('terminal', 'note', 'md-preview'…). */
  id: string
  /** The prefix of its pane ids ('note:' ⇒ 'note:…'); '' = the fallback type (the terminal: its id is the slot id). */
  idPrefix: string
  /** The dockview content component name (saved in layout.json). */
  component: string
  /** The dockview tab component name (saved in layout.json). */
  tabComponent: string
  /** A slot in tetherd sits behind it: false ⇒ never an orphan for the restore, never pruned. */
  hasSlot: boolean
  /** Among types sharing a prefix, whether this one owns the saved pane (the previews tell md from html by their params). */
  owns?(pane: SavedPane): boolean
  /** The dockview options of a pane from its saved state (moving a pane between desks rebuilds it from these). */
  optionsOf(pane: SavedPane): AddPanelOptions
}

/** What "reopen the last closed pane" keeps: `key` dedupes; `reopen` returns false when it no longer makes sense. */
export interface ClosedEntry {
  key: string
  reopen(): boolean
}

export interface PaneType extends PaneLayout {
  /** The icon of the tab strip's hidden-tabs list (an IconName of icons.ts). */
  icon: string
  create(): IContentRenderer
  /** The tab renderer for `tabComponent`; types sharing a tab name let one of them create it. */
  createTab?(): ITabRenderer
  /** A live pane of this type has this id. */
  has(id: string): boolean
  /** Its opening folder (the chooser's suggestion, "abrir pasta"). */
  cwdOf?(id: string): string | undefined
  /** Context flags while it is the active pane ('markdown.note', 'markdown.preview', 'keybindings.screen'). */
  contextFlags?(id: string): readonly string[]
  /** What closing it leaves for "reopen the last closed pane"; undefined = nothing to reopen. */
  closedEntry?(id: string): ClosedEntry | undefined
}

export class PaneRegistry<T extends PaneLayout = PaneType> {
  private readonly types: T[] = []

  register(type: T): Disposable {
    if (this.types.some(t => t.id === type.id)) throw new Error(`tipo de painel duplicado: ${type.id}`)
    this.types.push(type)
    return toDisposable(() => { const i = this.types.indexOf(type); if (i !== -1) this.types.splice(i, 1) })
  }

  all(): readonly T[] { return this.types }

  get(id: string): T | undefined { return this.types.find(t => t.id === id) }

  /** The type creating a content component; unknown names fall back to the terminal (dockview's default). */
  byComponent(name: string): T | undefined {
    return this.types.find(t => t.component === name) ?? this.fallback()
  }

  /** The type creating a tab component; unknown names fall back to the terminal's tab. */
  byTab(name: string): T | undefined {
    const named = this.types.filter(t => t.tabComponent === name)
    return named.find(t => typeof (t as { createTab?: unknown }).createTab === 'function') ?? named[0] ?? this.fallback()
  }

  /** The type of a pane id by prefix (the longest non-empty prefix wins), else the fallback. */
  byId(id: string): T | undefined {
    return this.prefixed(id)[0] ?? this.fallback()
  }

  /** The type of a saved pane: prefix first, then `owns` among types sharing it; else the fallback. */
  bySaved(pane: SavedPane): T | undefined {
    const candidates = this.prefixed(pane.id)
    return candidates.find(t => !t.owns || t.owns(pane)) ?? this.fallback()
  }

  /** The dockview options of a saved (or moved) pane. */
  optionsOf(pane: SavedPane): AddPanelOptions {
    const type = this.bySaved(pane)
    if (!type) throw new Error(`nenhum tipo de painel para ${pane.id}`)
    return type.optionsOf(pane)
  }

  /** A pane with no slot behind it: never an orphan, never pruned. */
  isSlotless(id: string): boolean {
    const type = this.prefixed(id)[0]
    return !!type && !type.hasSlot
  }

  private prefixed(id: string): T[] {
    return this.types.filter(t => t.idPrefix !== '' && id.startsWith(t.idPrefix)).sort((a, b) => b.idPrefix.length - a.idPrefix.length)
  }

  private fallback(): T | undefined { return this.types.find(t => t.idPrefix === '') }
}

/** The live type of a pane id: the registered type that has a live instance with it. */
export function liveTypeOf(registry: PaneRegistry<PaneType>, id: string): PaneType | undefined {
  return registry.all().find(t => t.has(id))
}
