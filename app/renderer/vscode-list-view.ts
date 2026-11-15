/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Port of VS Code's ListView, the virtual list that keeps in the DOM only the rows of the range around the viewport,
// recycling row elements as they leave it, over a RangeMap that maps list index to pixel position.
// Origin: https://github.com/microsoft/vscode, commit 9cc2376778e119f759ff710c1238fdc58d402d7a
//   src/vs/base/browser/ui/list/listView.ts   (ListView: splice/_splice, render, getVisibleRange, getRenderRange,
//                                             insertItemInDOM, updateItemInDOM, removeItemFromDOM, layout, the
//                                             index/position queries, scrollTop, scrollHeight, getElementDomId, dispose)
//   src/vs/base/browser/ui/list/rowCache.ts   (RowCache: alloc, release, transact)
//   src/vs/base/browser/ui/list/listWidget.ts (List.reveal, List.getRelativeTop, List.getElementID, List.getElementTop)
//   src/vs/base/common/arrays.ts              (splice: inlined)
// Left out: dynamic heights (supportDynamicHeights, probes, _rerender's measuring, updateElementHeight,
// withScrollAnchorAtBottom), horizontal scrolling and row width measurement, drag and drop, touch and gestures, the
// mouse/keyboard event getters, mouse wheel handling and the ScrollableElement/Scrollable pair, smooth scrolling,
// transformOptimization, scrollToActiveElement, accessibility beyond `id` and `role` (aria-setsize/posinset/checked:
// the caller sets them), data-last-element/data-parity, currentSelectionBounds and user selection, multiple templates
// (one renderer, no templateId, no renderTemplate/disposeTemplate), updateOptions, firstMostlyVisibleIndex.
//
// Deviations, all from scrolling natively instead of through VS Code's ScrollableElement:
// - The container given to the constructor is the scrolling element. The list appends one `rowsContainer` to it, in
//   flow, whose height is the content height; rows are absolutely positioned at their top inside it. Nothing is
//   translated (no `rowsContainer.style.top = -renderTop`, no transform).
// - The rendered range is the visible range plus `overscan` rows on each side (default 10). The browser paints a
//   native scroll before the `scroll` event reaches script, so without spare rows a fast scroll shows blank space for
//   a frame.
// - `lastVisibleIndex` is the last row inside the viewport, not the last rendered row (with overscan they differ).
// - Setting `scrollTop` (and `reveal`) renders the new range at once, reading the position back from the container so
//   the browser's clamping is honoured; the `scroll` event that follows finds nothing to change. `splice` does the same
//   check when the content shrank under the viewport and the browser clamped the position.
// - `onDidScroll` carries `{ scrollTop, height, scrollHeight }` instead of VS Code's ScrollEvent.
// - `rerender()` redraws every rendered row (upstream it only re-measures dynamic heights); `updateElement(index)`
//   redraws one.
// - A row taken from the cache, or reused by a splice, reaches the renderer clean: no children and no attributes;
//   the list then sets `role`, `id`, `data-index` and the position styles. Listeners the renderer adds to the row
//   element itself must be removed in `disposeElement`.

import { Range, RangeMap, shift, type IRange } from '../shared/vscode-range-map.ts'
import { Emitter, type Event } from '../shared/vscode-event.ts'
import type { IDisposable } from '../shared/vscode-lifecycle.ts'

export interface IListVirtualDelegate<T> {
  getHeight(element: T): number
}

export interface IListRenderer<T> {
  renderElement(element: T, index: number, row: HTMLElement): void
  disposeElement?(element: T, index: number, row: HTMLElement): void
}

export interface IListViewOptions {
  /** Rows rendered beyond each edge of the viewport. Defaults to 10. */
  readonly overscan?: number
  readonly paddingTop?: number
  readonly paddingBottom?: number
  /** `role` of every row. Defaults to 'listitem'. */
  readonly rowRole?: string
}

export interface IListScrollEvent {
  readonly scrollTop: number
  readonly height: number
  readonly scrollHeight: number
}

/** The part of a RangeMap the range computations read. */
export interface IRangeMapQuery {
  readonly count: number
  indexAt(position: number): number
  indexAfter(position: number): number
}

// --- Pure range computations (no DOM) ---

/** Rows intersecting [renderTop, renderTop + renderHeight). */
export function getVisibleRange(rangeMap: IRangeMapQuery, renderTop: number, renderHeight: number): IRange {
  const start = rangeMap.indexAt(renderTop)
  return {
    start,
    // Clamp so a collapsed viewport (renderHeight <= 0) cannot produce an inverted range.
    end: Math.max(start, rangeMap.indexAfter(renderTop + renderHeight - 1))
  }
}

/** The visible range widened by `overscan` rows on each side, within [0, count]. */
export function getRenderRange(rangeMap: IRangeMapQuery, renderTop: number, renderHeight: number, overscan: number): IRange {
  const visible = getVisibleRange(rangeMap, renderTop, renderHeight)
  const count = rangeMap.count
  return {
    start: Math.max(0, Math.min(visible.start, count) - overscan),
    end: Math.min(count, visible.end + overscan)
  }
}

export interface IRenderRanges {
  /** Ranges to insert, in the order to walk them (each one from its end to its start, as `render` does). */
  readonly rangesToInsert: IRange[]
  readonly rangesToRemove: IRange[]
}

/** What moving the rendered range from `previous` to `next` inserts and removes, when the items did not change. */
export function getRenderRanges(previous: IRange, next: IRange): IRenderRanges {
  return {
    rangesToInsert: Range.relativeComplement(next, previous).reverse(),
    rangesToRemove: Range.relativeComplement(previous, next)
  }
}

export interface ISpliceRanges {
  /** Rendered rows the splice deletes, in indices from before the splice: their rows can be reused. */
  readonly removeRange: IRange
  /** Rendered rows that survive and stay rendered, in indices from after the splice: only their position moves. */
  readonly updateRange: IRange
  /** Surviving rendered rows that fall out of the new render range, in indices from after the splice. */
  readonly removeRanges: IRange[]
  /** Rows to render, in indices from after the splice, in the order to walk them (each from its end to its start). */
  readonly insertRanges: IRange[]
}

/**
 * The DOM work of replacing `deleteCount` items at `start` by `insertCount` new ones, given the render range before
 * the splice (over the old items) and the render range after it (over the new items), as ListView._splice computes it.
 */
export function getSpliceRanges(
  previousRenderRange: IRange,
  renderRange: IRange,
  start: number,
  deleteCount: number,
  insertCount: number,
  previousLength: number
): ISpliceRanges {
  const deleteRange = { start, end: start + deleteCount }
  const removeRange = Range.intersect(previousRenderRange, deleteRange)
  const previousRestRange: IRange = { start: start + deleteCount, end: previousLength }
  const previousRenderedRestRange = Range.intersect(previousRestRange, previousRenderRange)
  const previousUnrenderedRestRanges = Range.relativeComplement(previousRestRange, previousRenderRange)

  const delta = insertCount - deleteCount
  const renderedRestRange = shift(previousRenderedRestRange, delta)
  const updateRange = Range.intersect(renderRange, renderedRestRange)
  const removeRanges = Range.relativeComplement(renderedRestRange, renderRange)
  const unrenderedRestRanges = previousUnrenderedRestRanges.map(r => shift(r, delta))
  const elementsRange = { start, end: start + insertCount }
  const insertRanges = [elementsRange, ...unrenderedRestRanges]
    .map(r => Range.intersect(renderRange, r))
    .filter(r => !Range.isEmpty(r))
    .reverse()

  return { removeRange, updateRange, removeRanges, insertRanges }
}

// --- Row cache ---

interface IRow {
  domNode: HTMLElement
}

/** Pool of released row elements (one template), with a transaction that skips detaching a row reused right away. */
class RowCache implements IDisposable {
  private cache: IRow[] = []
  private readonly transactionNodesPendingRemoval = new Set<HTMLElement>()
  private inTransaction = false
  private readonly doc: Document

  constructor(doc: Document) {
    this.doc = doc
  }

  /**
   * Returns a row either by creating a new one or reusing a released one.
   * `isReusingConnectedDomNode` is true when the row's node is still in the DOM in a stale position.
   */
  alloc(): { row: IRow; isReusingConnectedDomNode: boolean } {
    let result = this.cache.pop()
    let isStale = false
    if (result) {
      isStale = this.transactionNodesPendingRemoval.delete(result.domNode)
    } else {
      result = { domNode: this.doc.createElement('div') }
    }
    return { row: result, isReusingConnectedDomNode: isStale }
  }

  release(row: IRow): void {
    if (this.inTransaction) {
      this.transactionNodesPendingRemoval.add(row.domNode)
    } else {
      row.domNode.remove()
    }
    this.cache.push(row)
  }

  /** Runs a set of changes; rows released and allocated again inside it are never detached. */
  transact(makeChanges: () => void): void {
    if (this.inTransaction) {
      throw new Error('Already in transaction')
    }
    this.inTransaction = true
    try {
      makeChanges()
    } finally {
      for (const domNode of this.transactionNodesPendingRemoval) {
        domNode.remove()
      }
      this.transactionNodesPendingRemoval.clear()
      this.inTransaction = false
    }
  }

  dispose(): void {
    this.cache = []
    this.transactionNodesPendingRemoval.clear()
  }
}

/** Array splice that inserts without spreading `newItems` as call arguments, so a huge insert cannot overflow the stack. */
function splice<T>(array: T[], start: number, deleteCount: number, newItems: T[]): T[] {
  const index = start < 0 ? Math.max(start + array.length, 0) : Math.min(start, array.length)
  const result = array.splice(index, deleteCount)
  const originalLength = array.length
  const newItemsLength = newItems.length
  array.length = originalLength + newItemsLength
  for (let i = originalLength - 1; i >= index; i--) {
    array[i + newItemsLength] = array[i]!
  }
  for (let i = 0; i < newItemsLength; i++) {
    array[i + index] = newItems[i]!
  }
  return result
}

/** Empties a row element of everything a previous render left: children and every attribute (style included). */
function cleanRow(domNode: HTMLElement): void {
  domNode.replaceChildren()
  while (domNode.attributes.length > 0) {
    domNode.removeAttribute(domNode.attributes[0]!.name)
  }
}

// --- ListView ---

interface IItem<T> {
  readonly id: string
  readonly element: T
  readonly size: number
  row: IRow | null
  /** The row's node may sit in the DOM out of index order and must be re-placed. */
  stale: boolean
}

let listViewIdPool = 0

export class ListView<T> implements IDisposable {

  private readonly domId = `list_id_${++listViewIdPool}`
  private readonly container: HTMLElement
  private readonly rowsContainer: HTMLElement
  private readonly virtualDelegate: IListVirtualDelegate<T>
  private readonly renderer: IListRenderer<T>
  private readonly cache: RowCache
  private readonly overscan: number
  private readonly paddingBottom: number
  private readonly rowRole: string

  private items: IItem<T>[] = []
  private itemId = 0
  private rangeMap: RangeMap
  private lastRenderTop = 0
  private lastRenderHeight = 0
  private _renderHeight = 0
  private _scrollHeight = 0
  private lastFiredScrollTop: number | undefined
  private lastFiredHeight: number | undefined
  private splicing = false
  private disposed = false

  private readonly onScrollListener = (): void => this.onScroll()
  private readonly resizeObserver: ResizeObserver | undefined

  private readonly _onDidScroll = new Emitter<IListScrollEvent>()
  readonly onDidScroll: Event<IListScrollEvent> = this._onDidScroll.event

  private readonly _onDidChangeContentHeight = new Emitter<number>()
  readonly onDidChangeContentHeight: Event<number> = this._onDidChangeContentHeight.event

  get contentHeight(): number { return this.rangeMap.size }
  get containerDomNode(): HTMLElement { return this.rowsContainer }

  constructor(container: HTMLElement, virtualDelegate: IListVirtualDelegate<T>, renderer: IListRenderer<T>, options: IListViewOptions = {}) {
    this.container = container
    this.virtualDelegate = virtualDelegate
    this.renderer = renderer
    this.overscan = Math.max(0, options.overscan ?? 10)
    this.paddingBottom = options.paddingBottom ?? 0
    this.rowRole = options.rowRole ?? 'listitem'
    this.rangeMap = new RangeMap(options.paddingTop ?? 0)

    const doc = container.ownerDocument
    this.cache = new RowCache(doc)

    this.rowsContainer = doc.createElement('div')
    this.rowsContainer.style.position = 'relative'
    this.rowsContainer.style.width = '100%'
    this.rowsContainer.style.height = '0px'
    container.appendChild(this.rowsContainer)

    container.addEventListener('scroll', this.onScrollListener, { passive: true })
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.layout())
      this.resizeObserver.observe(container)
    }

    this.eventuallyUpdateScrollDimensions()
    this.layout()
  }

  // --- Items ---

  splice(start: number, deleteCount: number, elements: readonly T[] = []): T[] {
    if (this.splicing) {
      throw new Error('Can\'t run recursive splices.')
    }
    this.splicing = true
    try {
      return this._splice(start, deleteCount, elements)
    } finally {
      this.splicing = false
      this._onDidChangeContentHeight.fire(this.contentHeight)
    }
  }

  private _splice(start: number, deleteCount: number, elements: readonly T[]): T[] {
    const previousLength = this.items.length
    const previousRenderRange = this.getRenderRange(this.lastRenderTop, this.lastRenderHeight)
    // Clamp as Array.prototype.splice does, so the ranges below describe what really changes.
    start = Math.max(0, Math.min(start, previousLength))
    deleteCount = Math.max(0, Math.min(deleteCount, previousLength - start))

    const deleteRange = { start, end: start + deleteCount }
    const removeRange = Range.intersect(previousRenderRange, deleteRange)

    // Try to reuse rows, avoid removing them from the DOM.
    const rowsToDispose: IRow[] = []
    for (let i = removeRange.end - 1; i >= removeRange.start; i--) {
      const item = this.items[i]!
      if (item.row) {
        this.renderer.disposeElement?.(item.element, i, item.row.domNode)
        rowsToDispose.unshift(item.row)
      }
      item.row = null
      item.stale = true
    }

    const inserted = elements.map<IItem<T>>(element => ({
      id: String(this.itemId++),
      element,
      size: this.virtualDelegate.getHeight(element),
      row: null,
      stale: false
    }))

    let deleted: IItem<T>[]
    if (start === 0 && deleteCount >= previousLength) {
      this.rangeMap = new RangeMap(this.rangeMap.paddingTop)
      this.rangeMap.splice(0, 0, inserted)
      deleted = this.items
      this.items = inserted
    } else {
      this.rangeMap.splice(start, deleteCount, inserted)
      deleted = splice(this.items, start, deleteCount, inserted)
    }

    const renderRange = this.getRenderRange(this.lastRenderTop, this.lastRenderHeight)
    const ranges = getSpliceRanges(previousRenderRange, renderRange, start, deleteCount, inserted.length, previousLength)

    for (let i = ranges.updateRange.start; i < ranges.updateRange.end; i++) {
      const item = this.items[i]!
      if (item.row) {
        this.updateItemInDOM(item, i)
      }
    }

    for (const range of ranges.removeRanges) {
      for (let i = range.start; i < range.end; i++) {
        this.removeItemFromDOM(i)
      }
    }

    insert: for (const range of ranges.insertRanges) {
      for (let i = range.end - 1; i >= range.start; i--) {
        const item = this.items[i]!
        this.insertItemInDOM(i, rowsToDispose.pop())
        if (!item.row) {
          // Rendering recycled this row, invalidating the remaining insertion ranges.
          break insert
        }
      }
    }

    for (const row of rowsToDispose) {
      this.cache.release(row)
    }

    this.eventuallyUpdateScrollDimensions()

    // Shrinking content under the viewport makes the browser clamp the scroll position: follow it now.
    if (this.container.scrollTop !== this.lastRenderTop) {
      this.onScroll()
    }

    return deleted.map(i => i.element)
  }

  private eventuallyUpdateScrollDimensions(): void {
    this._scrollHeight = this.contentHeight
    this.rowsContainer.style.height = `${this.scrollHeight}px`
  }

  get length(): number {
    return this.items.length
  }

  element(index: number): T {
    return this.item(index).element
  }

  indexOf(element: T): number {
    return this.items.findIndex(item => item.element === element)
  }

  domElement(index: number): HTMLElement | null {
    const row = this.item(index).row
    return row && row.domNode
  }

  elementHeight(index: number): number {
    return this.item(index).size
  }

  getElementHeight(index: number): number {
    return this.elementHeight(index)
  }

  elementTop(index: number): number {
    return this.rangeMap.positionAt(index)
  }

  getElementTop(index: number): number {
    return this.elementTop(index)
  }

  indexAt(position: number): number {
    return this.rangeMap.indexAt(position)
  }

  indexAfter(position: number): number {
    return this.rangeMap.indexAfter(position)
  }

  getElementDomId(index: number): string {
    return `${this.domId}_${index}`
  }

  getElementID(index: number): string {
    return this.getElementDomId(index)
  }

  private item(index: number): IItem<T> {
    const item = this.items[index]
    if (!item) {
      throw new Error(`Invalid index ${index}`)
    }
    return item
  }

  // --- Viewport ---

  get renderHeight(): number {
    return this._renderHeight
  }

  get firstVisibleIndex(): number {
    return getVisibleRange(this.rangeMap, this.lastRenderTop, this.lastRenderHeight).start
  }

  get lastVisibleIndex(): number {
    return getVisibleRange(this.rangeMap, this.lastRenderTop, this.lastRenderHeight).end - 1
  }

  get scrollTop(): number {
    return this.container.scrollTop
  }

  set scrollTop(scrollTop: number) {
    this.container.scrollTop = scrollTop
    this.onScroll()
  }

  get scrollHeight(): number {
    return this._scrollHeight + this.paddingBottom
  }

  getRenderRange(renderTop: number, renderHeight: number): IRange {
    return getRenderRange(this.rangeMap, renderTop, renderHeight, this.overscan)
  }

  /** Takes the viewport height (the container's client height when omitted) and renders the range it shows. */
  layout(height?: number): void {
    if (this.disposed) return
    this._renderHeight = typeof height === 'number' ? height : this.container.clientHeight
    this.onScroll()
  }

  /**
   * Scrolls so the row at `index` shows: without `relativeTop`, only as much as needed; with it, so the row sits at
   * that fraction (0 top, 1 bottom) of the viewport. `paddingTop` is the height covered at the top (the sticky rows).
   */
  reveal(index: number, relativeTop?: number, paddingTop: number = 0): void {
    if (index < 0 || index >= this.length) {
      throw new Error(`Invalid index ${index}`)
    }

    const scrollTop = this.scrollTop
    const elementTop = this.elementTop(index)
    const elementHeight = this.elementHeight(index)

    if (typeof relativeTop === 'number') {
      // y = mx + b
      const m = elementHeight - this.renderHeight + paddingTop
      this.scrollTop = m * Math.min(Math.max(relativeTop, 0), 1) + elementTop - paddingTop
    } else {
      const viewItemBottom = elementTop + elementHeight
      const scrollBottom = scrollTop + this.renderHeight

      if (elementTop < scrollTop + paddingTop && viewItemBottom >= scrollBottom) {
        // The element is already overflowing the viewport, no-op
      } else if (elementTop < scrollTop + paddingTop || (viewItemBottom >= scrollBottom && elementHeight >= this.renderHeight)) {
        this.scrollTop = elementTop - paddingTop
      } else if (viewItemBottom >= scrollBottom) {
        this.scrollTop = viewItemBottom - this.renderHeight
      }
    }
  }

  /**
   * The position of the row at `index` as a fraction of the viewport (0 top, 1 bottom), or null when the row is not
   * entirely inside the viewport below `paddingTop`.
   */
  getRelativeTop(index: number, paddingTop: number = 0): number | null {
    if (index < 0 || index >= this.length) {
      throw new Error(`Invalid index ${index}`)
    }

    const scrollTop = this.scrollTop
    const elementTop = this.elementTop(index)
    const elementHeight = this.elementHeight(index)

    if (elementTop < scrollTop + paddingTop || elementTop + elementHeight > scrollTop + this.renderHeight) {
      return null
    }

    // y = mx + b
    const m = elementHeight - this.renderHeight + paddingTop
    return Math.abs((scrollTop + paddingTop - elementTop) / m)
  }

  // --- Render ---

  private onScroll(): void {
    if (this.disposed) return
    const renderTop = this.container.scrollTop
    const renderHeight = this._renderHeight
    if (renderTop !== this.lastRenderTop || renderHeight !== this.lastRenderHeight) {
      const previousRenderRange = this.getRenderRange(this.lastRenderTop, this.lastRenderHeight)
      this.render(previousRenderRange, renderTop, renderHeight)
    }
    // Like VS Code's ScrollEvent, a change of viewport height is announced as a scroll too.
    if (renderTop !== this.lastFiredScrollTop || renderHeight !== this.lastFiredHeight) {
      this.lastFiredScrollTop = renderTop
      this.lastFiredHeight = renderHeight
      this._onDidScroll.fire({ scrollTop: renderTop, height: renderHeight, scrollHeight: this.scrollHeight })
    }
  }

  render(previousRenderRange: IRange, renderTop: number, renderHeight: number): void {
    const renderRange = this.getRenderRange(renderTop, renderHeight)
    const { rangesToInsert, rangesToRemove } = getRenderRanges(previousRenderRange, renderRange)

    this.cache.transact(() => {
      for (const range of rangesToRemove) {
        for (let i = range.start; i < range.end; i++) {
          this.removeItemFromDOM(i)
        }
      }

      for (const range of rangesToInsert) {
        for (let i = range.end - 1; i >= range.start; i--) {
          if (this.items[i]?.row) {
            this.updateItemInDOM(this.items[i]!, i)
            continue
          }
          this.insertItemInDOM(i)
        }
      }
    })

    this.lastRenderTop = renderTop
    this.lastRenderHeight = renderHeight
  }

  /** Redraws every rendered row. */
  rerender(): void {
    const range = this.getRenderRange(this.lastRenderTop, this.lastRenderHeight)
    for (let i = range.start; i < range.end; i++) {
      this.updateElement(i)
    }
  }

  /** Redraws the row at `index`, when it is rendered. */
  updateElement(index: number): void {
    const item = this.item(index)
    if (!item.row) return
    this.renderer.disposeElement?.(item.element, index, item.row.domNode)
    this.insertItemInDOM(index)
  }

  private insertItemInDOM(index: number, row?: IRow): void {
    const item = this.item(index)

    if (!item.row) {
      if (row) {
        item.row = row
        item.stale = true
      } else {
        const result = this.cache.alloc()
        item.row = result.row
        item.stale ||= result.isReusingConnectedDomNode
      }
    }

    const domNode = item.row.domNode
    cleanRow(domNode)
    domNode.setAttribute('role', this.rowRole)

    if (item.stale || !domNode.parentElement) {
      const referenceNode = this.items[index + 1]?.row?.domNode ?? null
      if (domNode.parentElement !== this.rowsContainer || domNode.nextElementSibling !== referenceNode) {
        this.rowsContainer.insertBefore(domNode, referenceNode)
      }
      item.stale = false
    }

    this.updateItemInDOM(item, index)
    this.renderer.renderElement(item.element, index, domNode)
  }

  private updateItemInDOM(item: IItem<T>, index: number): void {
    const domNode = item.row!.domNode
    domNode.style.position = 'absolute'
    domNode.style.left = '0px'
    domNode.style.width = '100%'
    domNode.style.top = `${this.elementTop(index)}px`
    domNode.style.height = `${item.size}px`
    domNode.setAttribute('data-index', `${index}`)
    domNode.setAttribute('id', this.getElementDomId(index))
  }

  private removeItemFromDOM(index: number): void {
    const item = this.items[index]
    if (item?.row) {
      this.renderer.disposeElement?.(item.element, index, item.row.domNode)
      this.cache.release(item.row)
      item.row = null
    }
  }

  // --- Dispose ---

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const item of this.items) {
      if (item.row) {
        this.renderer.disposeElement?.(item.element, -1, item.row.domNode)
        item.row = null
      }
    }
    this.items = []
    this.container.removeEventListener('scroll', this.onScrollListener)
    this.resizeObserver?.disconnect()
    this.rowsContainer.remove()
    this.cache.dispose()
    this._onDidScroll.dispose()
    this._onDidChangeContentHeight.dispose()
  }
}
