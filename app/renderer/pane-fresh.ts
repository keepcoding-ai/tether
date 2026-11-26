// The quick view's `fresh` plan (pane-loan-rules.ts): for a type that declares `peek: 'fresh'`, the card shows a COPY of the
// pane, built by the type's own `create()` from a copy of the tab's params, and the tab is never touched (no notice, no eye,
// no move: a `<webview>` reloads when it changes parent, and the tab's page keeps running as it was). Nothing here knows a
// type: any type that can be built twice from its params takes part by declaring `peek: 'fresh'`.
//
// The copy lives outside dockview, so it gets a stand-in for dockview's panel api (`standInApi`): always visible and active,
// its own title and params (what it writes there stays in it), events that never fire, and the layout calls (maximize, close,
// setActive) as no-ops: the copy has no group and no place in the layout. Its id is its own (`freshCopyOf`), so the type's
// maps keyed by the pane id keep the tab's instance, and anything aimed at the tab's id never reaches the copy.
//
// Closing the card disposes the copy; the tab going away (closed, moved, the window going) disposes it too and tells the card.
import type { GroupPanelPartInitParameters, IContentRenderer } from 'dockview-core'
import { freshCopyOf, type FreshSource } from './pane-loan-rules.ts'
import type { ShellLoan } from './pane-shell.ts'

type Listener<T> = (event: T) => void
interface Disposable { dispose(): void }

/** A tiny event of the stand-in api: listeners can come and go; `fire` is only used for what the copy does to itself. */
function emitter<T>(): { on: (l: Listener<T>) => Disposable; fire: (e: T) => void } {
  const ls = new Set<Listener<T>>()
  return {
    on: l => { ls.add(l); return { dispose: () => { ls.delete(l) } } },
    fire: e => { for (const l of [...ls]) { try { l(e) } catch (err) { console.error('pane-fresh event', err) } } },
  }
}

/** The stand-in for dockview's panel api a copy outside dockview is initialised with (the members the pane types read). */
export function standInApi(copy: { id: string; title: string; params: Record<string, unknown> }): unknown {
  let title = copy.title
  let params = copy.params
  const titleE = emitter<{ title: string }>()
  const paramsE = emitter<Record<string, unknown>>()
  const never = (): Disposable => ({ dispose: () => {} })
  return {
    id: copy.id,
    get title() { return title },
    get isVisible() { return true },
    get isActive() { return true },
    get isGroupActive() { return true },
    get isFocused() { return false },
    get width() { return 0 },
    get height() { return 0 },
    get group() { return undefined },
    get location() { return { type: 'grid' } },
    onDidActiveChange: never,
    onDidVisibilityChange: never,
    onDidFocusChange: never,
    onDidDimensionsChange: never,
    onDidActiveGroupChange: never,
    onDidGroupChange: never,
    onDidLocationChange: never,
    onWillFocus: never,
    onDidTitleChange: titleE.on,
    onDidParametersChange: paramsE.on,
    setTitle: (t: string) => { title = t; titleE.fire({ title: t }) },
    updateParameters: (p: Record<string, unknown>) => { params = { ...params, ...p }; paramsE.fire(params) },
    getParameters: () => params,
    setActive: () => {},
    setVisible: () => {},
    setRenderer: () => {},
    close: () => {},
    maximize: () => {},
    exitMaximized: () => {},
    isMaximized: () => false,
    moveTo: () => {},
    setSize: () => {},
  }
}

export interface FreshRequest {
  /** The tab's pane: its id, title and params, as the copy starts from them. */
  source: FreshSource
  /** The type's own `create()`. */
  create(): IContentRenderer
  /** Where the copy goes (the card's body holder). */
  host: HTMLElement
  /** The tab went away while the copy was shown: the copy is already disposed and out of the host. */
  lost(): void
  /** Hears the tab's pane go away (pane-shell.ts `whenGone`); returns the function that stops hearing. */
  whenGone(gone: () => void): () => void
}

let copies = 0

/** Builds the copy into `req.host` and returns it as a loan: `giveBack` disposes it, `focus` gives it the keyboard. */
export function lendFresh(req: FreshRequest): ShellLoan {
  const copy = freshCopyOf(req.source, ++copies)
  const content = req.create()
  content.init({ params: copy.params, api: standInApi(copy), title: copy.title } as unknown as GroupPanelPartInitParameters)
  req.host.append(content.element)
  content.onShow?.()
  let done = false
  let ro: ResizeObserver | undefined
  if (content.layout) {
    const fit = (): void => { if (!done) content.layout?.(req.host.clientWidth, req.host.clientHeight) }
    ro = new ResizeObserver(fit)
    ro.observe(req.host)
    fit()
  }
  let forget = (): void => {}
  const end = (): void => {
    if (done) return
    done = true
    ro?.disconnect()
    forget()
    try { content.dispose?.() } finally { content.element.remove() }
  }
  forget = req.whenGone(() => { if (done) return; end(); req.lost() })
  return { part: content.element, fresh: true, focus: () => content.focus?.(), giveBack: end }
}
