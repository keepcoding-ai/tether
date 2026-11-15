/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Port of VS Code's tree sticky scroll: while the tree scrolls, the ancestors of the first visible row stay drawn on top
// of the viewport, each one until its last descendant scrolls past (the last one is pushed up by it).
// Origin: https://github.com/microsoft/vscode, commit 9cc2376778e119f759ff710c1238fdc58d402d7a
//   src/vs/base/browser/ui/tree/abstractTree.ts (StickyScrollNode, stickyScrollNodeStateEquals, stickyScrollNodeEquals,
//                                               StickyScrollState, IStickyScrollDelegate, DefaultStickyScrollDelegate,
//                                               StickyScrollController, StickyScrollWidget: setState, renderState,
//                                               rerender, updateRootHeight, getRootHeight, createElement, setVisible)
//   src/vs/base/common/arrays.ts                (equals: inlined)
// The state computation (update/findStickyState and the controller's helpers) is in plain functions over minimal views of
// the list and the model (IStickyScrollList, IStickyScrollModel), so it runs without a DOM.
// Left out: stickyScrollNodeSourceRangeProvider, explicit/estimated/dynamic sticky heights and stickyScrollMaxNodeHeight
// (rows have a fixed height: a node's source range is its whole row), probeDynamicHeights and onDidChangeHeight,
// updateSourceNodeVisibility and the `source-node-partially-visible` classes, StickyScrollFocus (keyboard navigation
// inside the widget, onDidChangeHasFocus, onContextMenu: the caller delegates the mouse events itself), the accessibility
// provider (the widget is aria-hidden: the real rows stay the accessible tree), the Proxy copy of the node handed to the
// renderer, compressed nodes, templates (one renderer), updateOptions and validateStickySettings (fixed limits).
//
// Deviations:
// - getParentNode never returns the model's hidden root: VS Code's explorer runs on an ObjectTreeModel, whose parent
//   location of a top-level node is `null` (the root's element), so the controller stops there; the IndexTreeModel
//   answers `[]` for it, which is taken as "no parent" here.
// - A sticky row gets no `id` (upstream it reuses the real row's id, which would make two elements share it while the
//   real row is rendered).
// - The controller is told the list's padding at the top (`paddingTop`) and the limits in its constructor.

import type { ITreeNode } from '../shared/vscode-index-tree-model.ts'
import type { Event } from '../shared/vscode-event.ts'
import type { IDisposable } from '../shared/vscode-lifecycle.ts'

export interface StickyScrollNode<T> {
  readonly node: ITreeNode<T>
  readonly startIndex: number
  readonly endIndex: number
  readonly height: number
  readonly position: number
}

function stickyScrollNodeStateEquals<T>(node1: StickyScrollNode<T>, node2: StickyScrollNode<T>): boolean {
  return node1.position === node2.position && stickyScrollNodeEquals(node1, node2)
}

function stickyScrollNodeEquals<T>(node1: StickyScrollNode<T>, node2: StickyScrollNode<T>): boolean {
  return node1.node.element === node2.node.element &&
    node1.startIndex === node2.startIndex &&
    node1.height === node2.height &&
    node1.endIndex === node2.endIndex
}

function equals<T>(one: readonly T[], other: readonly T[], itemEquals: (a: T, b: T) => boolean): boolean {
  if (one.length !== other.length) {
    return false
  }
  for (let i = 0; i < one.length; i++) {
    if (!itemEquals(one[i]!, other[i]!)) {
      return false
    }
  }
  return true
}

export class StickyScrollState<T> {

  readonly stickyNodes: StickyScrollNode<T>[]

  constructor(stickyNodes: StickyScrollNode<T>[] = []) {
    this.stickyNodes = stickyNodes
  }

  get count(): number { return this.stickyNodes.length }

  equal(state: StickyScrollState<T>): boolean {
    return equals(this.stickyNodes, state.stickyNodes, stickyScrollNodeStateEquals)
  }

  contains(element: ITreeNode<T>): boolean {
    return this.stickyNodes.some(node => node.node.element === element.element)
  }

  lastNodePartiallyVisible(): boolean {
    if (this.count === 0) {
      return false
    }

    const lastStickyNode = this.stickyNodes[this.count - 1]!
    if (this.count === 1) {
      return lastStickyNode.position !== 0
    }

    const secondLastStickyNode = this.stickyNodes[this.count - 2]!
    return secondLastStickyNode.position + secondLastStickyNode.height !== lastStickyNode.position
  }

  animationStateChanged(previousState: StickyScrollState<T>): boolean {
    if (!equals(this.stickyNodes, previousState.stickyNodes, stickyScrollNodeEquals)) {
      return false
    }

    if (this.count === 0) {
      return false
    }

    const lastStickyNode = this.stickyNodes[this.count - 1]!
    const previousLastStickyNode = previousState.stickyNodes[previousState.count - 1]!

    return lastStickyNode.position !== previousLastStickyNode.position
  }
}

export interface IStickyScrollDelegate<T> {
  constrainStickyScrollNodes(stickyNodes: StickyScrollNode<T>[], stickyScrollMaxItemCount: number, maxWidgetHeight: number): StickyScrollNode<T>[]
}

export class DefaultStickyScrollDelegate<T> implements IStickyScrollDelegate<T> {

  constrainStickyScrollNodes(stickyNodes: StickyScrollNode<T>[], stickyScrollMaxItemCount: number, maxWidgetHeight: number): StickyScrollNode<T>[] {

    for (let i = 0; i < stickyNodes.length; i++) {
      const stickyNode = stickyNodes[i]!
      const stickyNodeBottom = stickyNode.position + stickyNode.height
      if (stickyNodeBottom > maxWidgetHeight || i >= stickyScrollMaxItemCount) {
        return stickyNodes.slice(0, i)
      }
    }

    return stickyNodes
  }
}

// --- Pure state computation (no DOM) ---

/** The part of the list the sticky scroll reads (VS Code's List/ListView names). */
export interface IStickyScrollList<T> {
  readonly scrollTop: number
  readonly renderHeight: number
  readonly firstVisibleIndex: number
  readonly length: number
  indexAt(position: number): number
  getElementTop(index: number): number
  getElementHeight(index: number): number
  element(index: number): T
}

/** The part of the tree model the sticky scroll reads. */
export interface IStickyScrollModel<T> {
  getNodeLocation(node: ITreeNode<T>): number[]
  getParentNodeLocation(location: number[]): number[] | undefined
  getNode(location: number[]): ITreeNode<T>
  getListIndex(location: number[]): number
  getListRenderCount(location: number[]): number
  has(location: number[]): boolean
}

export interface IStickyScrollContext<T> {
  readonly view: IStickyScrollList<ITreeNode<T>>
  readonly model: IStickyScrollModel<T>
  /** The list's padding above its first row. */
  readonly paddingTop: number
  readonly stickyScrollMaxItemCount: number
  readonly maxWidgetViewRatio: number
  readonly stickyScrollDelegate: IStickyScrollDelegate<T>
}

export const STICKY_SCROLL_MAX_ITEM_COUNT = 7
export const MAX_WIDGET_VIEW_RATIO = 0.4

export function createStickyScrollContext<T>(view: IStickyScrollList<ITreeNode<T>>, model: IStickyScrollModel<T>, options: {
  paddingTop?: number; stickyScrollMaxItemCount?: number; stickyScrollDelegate?: IStickyScrollDelegate<T>
} = {}): IStickyScrollContext<T> {
  return {
    view,
    model,
    paddingTop: options.paddingTop ?? 0,
    stickyScrollMaxItemCount: Math.max(options.stickyScrollMaxItemCount ?? STICKY_SCROLL_MAX_ITEM_COUNT, 1),
    maxWidgetViewRatio: MAX_WIDGET_VIEW_RATIO,
    stickyScrollDelegate: options.stickyScrollDelegate ?? new DefaultStickyScrollDelegate<T>(),
  }
}

function getNodeAtHeight<T>(ctx: IStickyScrollContext<T>, height: number): ITreeNode<T> | undefined {
  let index
  if (height === 0) {
    index = ctx.view.firstVisibleIndex
  } else {
    index = ctx.view.indexAt(height + ctx.view.scrollTop)
  }

  if (index < 0 || index >= ctx.view.length) {
    return undefined
  }

  return ctx.view.element(index)
}

/** The state the widget shows now (StickyScrollController.update), or undefined when nothing sticks. */
export function computeStickyState<T>(ctx: IStickyScrollContext<T>): StickyScrollState<T> | undefined {
  const firstVisibleNode = getNodeAtHeight(ctx, ctx.paddingTop)

  // Don't render anything if there are no elements
  if (!firstVisibleNode || ctx.view.scrollTop <= ctx.paddingTop || ctx.view.renderHeight === 0) {
    return undefined
  }

  return findStickyState(ctx, firstVisibleNode)
}

export function findStickyState<T>(ctx: IStickyScrollContext<T>, firstVisibleNode: ITreeNode<T>): StickyScrollState<T> | undefined {
  const stickyNodes: StickyScrollNode<T>[] = []
  let firstVisibleNodeUnderWidget: ITreeNode<T> | undefined = firstVisibleNode
  let stickyNodesHeight = 0

  let nextStickyNode = getNextStickyNode(ctx, firstVisibleNodeUnderWidget, undefined, stickyNodesHeight)
  while (nextStickyNode) {

    stickyNodes.push(nextStickyNode)
    stickyNodesHeight += nextStickyNode.height

    if (stickyNodes.length <= ctx.stickyScrollMaxItemCount) {
      firstVisibleNodeUnderWidget = getNextVisibleNode(ctx, nextStickyNode)
      if (!firstVisibleNodeUnderWidget) {
        break
      }
    }

    nextStickyNode = getNextStickyNode(ctx, firstVisibleNodeUnderWidget, nextStickyNode.node, stickyNodesHeight)
  }

  const contrainedStickyNodes = constrainStickyNodes(ctx, stickyNodes)
  return contrainedStickyNodes.length ? new StickyScrollState(contrainedStickyNodes) : undefined
}

function getNextVisibleNode<T>(ctx: IStickyScrollContext<T>, previousStickyNode: StickyScrollNode<T>): ITreeNode<T> | undefined {
  return getNodeAtHeight(ctx, previousStickyNode.position + previousStickyNode.height)
}

export function getNextStickyNode<T>(ctx: IStickyScrollContext<T>, firstVisibleNodeUnderWidget: ITreeNode<T>, previousStickyNode: ITreeNode<T> | undefined, stickyNodesHeight: number): StickyScrollNode<T> | undefined {
  const nextStickyNode = getAncestorUnderPrevious(ctx, firstVisibleNodeUnderWidget, previousStickyNode)
  if (!nextStickyNode) {
    return undefined
  }

  if (nextStickyNode === firstVisibleNodeUnderWidget && !nodeIsUncollapsedParent(ctx, firstVisibleNodeUnderWidget)) {
    return undefined
  }

  // The source range is the whole row (fixed heights): it starts at 0 and ends at the row's height.
  const sourceRangeEnd = getNodeHeight(ctx, nextStickyNode)
  if (!Number.isFinite(sourceRangeEnd) || sourceRangeEnd <= 0) {
    return undefined
  }
  const sourceNodeTop = ctx.view.getElementTop(getNodeIndex(ctx, nextStickyNode))
  const stickyViewportBottom = ctx.view.scrollTop + stickyNodesHeight
  if (stickyViewportBottom <= sourceNodeTop) {
    return undefined
  }

  return createStickyScrollNode(ctx, nextStickyNode, stickyNodesHeight, sourceRangeEnd)
}

function getNodeHeight<T>(ctx: IStickyScrollContext<T>, node: ITreeNode<T>): number {
  const nodeLocation = ctx.model.getNodeLocation(node)
  const index = ctx.model.getListIndex(nodeLocation)
  return index >= 0 ? ctx.view.getElementHeight(index) : 0
}

function createStickyScrollNode<T>(ctx: IStickyScrollContext<T>, node: ITreeNode<T>, currentStickyNodesHeight: number, height: number): StickyScrollNode<T> {
  const { startIndex, endIndex } = getNodeRange(ctx, node)

  const position = calculateStickyNodePosition(ctx, endIndex, currentStickyNodesHeight, height)

  return { node, position, height, startIndex, endIndex }
}

export function getAncestorUnderPrevious<T>(ctx: IStickyScrollContext<T>, node: ITreeNode<T>, previousAncestor: ITreeNode<T> | undefined = undefined): ITreeNode<T> | undefined {
  let currentAncestor: ITreeNode<T> = node
  let parentOfcurrentAncestor: ITreeNode<T> | undefined = getParentNode(ctx, currentAncestor)

  while (parentOfcurrentAncestor) {
    if (parentOfcurrentAncestor === previousAncestor) {
      return currentAncestor
    }
    currentAncestor = parentOfcurrentAncestor
    parentOfcurrentAncestor = getParentNode(ctx, currentAncestor)
  }

  if (previousAncestor === undefined) {
    return currentAncestor
  }

  return undefined
}

export function calculateStickyNodePosition<T>(ctx: IStickyScrollContext<T>, lastDescendantIndex: number, stickyRowPositionTop: number, stickyNodeHeight: number): number {
  const lastChildHeight = ctx.view.getElementHeight(lastDescendantIndex)
  const bottomOfLastChild = ctx.view.getElementTop(lastDescendantIndex) + lastChildHeight - ctx.view.scrollTop

  if (stickyRowPositionTop + stickyNodeHeight > bottomOfLastChild && stickyRowPositionTop <= bottomOfLastChild) {
    return bottomOfLastChild - stickyNodeHeight
  }

  return stickyRowPositionTop
}

export function constrainStickyNodes<T>(ctx: IStickyScrollContext<T>, stickyNodes: StickyScrollNode<T>[]): StickyScrollNode<T>[] {
  if (stickyNodes.length === 0) {
    return []
  }

  // Check if sticky nodes need to be constrained
  const maximumStickyWidgetHeight = ctx.view.renderHeight * ctx.maxWidgetViewRatio
  const lastStickyNode = stickyNodes[stickyNodes.length - 1]!
  if (stickyNodes.length <= ctx.stickyScrollMaxItemCount && lastStickyNode.position + lastStickyNode.height <= maximumStickyWidgetHeight) {
    return stickyNodes
  }

  // constrain sticky nodes
  const constrainedStickyNodes = ctx.stickyScrollDelegate.constrainStickyScrollNodes(stickyNodes, ctx.stickyScrollMaxItemCount, maximumStickyWidgetHeight)

  if (!constrainedStickyNodes.length) {
    return []
  }

  // Validate constraints
  const lastConstrainedStickyNode = constrainedStickyNodes[constrainedStickyNodes.length - 1]!
  if (constrainedStickyNodes.length > ctx.stickyScrollMaxItemCount || lastConstrainedStickyNode.position + lastConstrainedStickyNode.height > maximumStickyWidgetHeight) {
    throw new Error('stickyScrollDelegate violates constraints')
  }

  return constrainedStickyNodes
}

function getParentNode<T>(ctx: IStickyScrollContext<T>, node: ITreeNode<T>): ITreeNode<T> | undefined {
  const nodeLocation = ctx.model.getNodeLocation(node)
  const parentLocation = ctx.model.getParentNodeLocation(nodeLocation)
  // `[]` is the model's hidden root (see the header).
  return parentLocation && parentLocation.length > 0 ? ctx.model.getNode(parentLocation) : undefined
}

function nodeIsUncollapsedParent<T>(ctx: IStickyScrollContext<T>, node: ITreeNode<T>): boolean {
  const nodeLocation = ctx.model.getNodeLocation(node)
  return ctx.model.getListRenderCount(nodeLocation) > 1
}

function getNodeIndex<T>(ctx: IStickyScrollContext<T>, node: ITreeNode<T>): number {
  const nodeLocation = ctx.model.getNodeLocation(node)
  const nodeIndex = ctx.model.getListIndex(nodeLocation)
  return nodeIndex
}

function getNodeRange<T>(ctx: IStickyScrollContext<T>, node: ITreeNode<T>): { startIndex: number; endIndex: number } {
  const nodeLocation = ctx.model.getNodeLocation(node)
  const startIndex = ctx.model.getListIndex(nodeLocation)

  if (startIndex < 0) {
    throw new Error('Node not found in tree')
  }

  const renderCount = ctx.model.getListRenderCount(nodeLocation)
  const endIndex = startIndex + renderCount - 1

  return { startIndex, endIndex }
}

/** How much of the viewport's top the ancestors of `node` would cover once it scrolls up to them (the reveal's padding). */
export function nodePositionTopBelowWidget<T>(ctx: IStickyScrollContext<T>, node: ITreeNode<T>): number {
  const ancestors: ITreeNode<T>[] = []
  let currentAncestor = getParentNode(ctx, node)
  while (currentAncestor) {
    ancestors.push(currentAncestor)
    currentAncestor = getParentNode(ctx, currentAncestor)
  }

  let widgetHeight = 0
  for (let i = 0; i < ancestors.length && i < ctx.stickyScrollMaxItemCount; i++) {
    widgetHeight += getNodeHeight(ctx, ancestors[i]!)
  }
  return widgetHeight
}

// --- Controller and widget (DOM) ---

/** The list as the controller listens to it. */
export interface IStickyScrollListView<T> extends IStickyScrollList<T> {
  readonly onDidScroll: Event<unknown>
  readonly onDidChangeContentHeight: Event<number>
}

/** The model as the controller listens to it. */
export interface IStickyScrollTreeModel<T> extends IStickyScrollModel<T> {
  readonly onDidSpliceRenderedNodes: Event<{ readonly start: number; readonly deleteCount: number }>
  readonly onDidChangeCollapseState: Event<unknown>
}

/** Draws a node into a sticky row element (the tree's own row renderer). */
export type StickyRowRenderer<T> = (node: ITreeNode<T>, row: HTMLElement) => void

export interface IStickyScrollOptions {
  readonly paddingTop?: number
  readonly stickyScrollMaxItemCount?: number
  /** Class names of the widget's root and of each sticky row. */
  readonly containerClassName?: string
  readonly rowClassName?: string
}

class StickyScrollWidget<T> implements IDisposable {

  private readonly _rootDomNode: HTMLElement
  private readonly rowClassName: string
  private _previousState: StickyScrollState<T> | undefined
  private _previousElements: HTMLElement[] = []
  get state(): StickyScrollState<T> | undefined { return this._previousState }

  private readonly renderer: StickyRowRenderer<T>

  constructor(container: HTMLElement, renderer: StickyRowRenderer<T>, containerClassName: string, rowClassName: string) {
    this.renderer = renderer
    this.rowClassName = rowClassName
    this._rootDomNode = container.ownerDocument.createElement('div')
    this._rootDomNode.className = `${containerClassName} empty`
    this._rootDomNode.setAttribute('aria-hidden', 'true')
    container.appendChild(this._rootDomNode)
  }

  get height(): number {
    if (!this._previousState) {
      return 0
    }
    return this.getRootHeight(this._previousState)
  }

  get domNode(): HTMLElement {
    return this._rootDomNode
  }

  get count(): number {
    return this._previousState?.count ?? 0
  }

  getNode(node: ITreeNode<T>): StickyScrollNode<T> | undefined {
    return this._previousState?.stickyNodes.find(stickyNode => stickyNode.node === node)
  }

  /** The sticky node an element of the widget belongs to. */
  nodeOfElement(element: HTMLElement): ITreeNode<T> | undefined {
    const index = this._previousElements.findIndex(e => e === element || e.contains(element))
    return index >= 0 ? this._previousState?.stickyNodes[index]?.node : undefined
  }

  /** The rendered sticky rows, top to bottom, with their nodes. */
  rows(): [HTMLElement, ITreeNode<T>][] {
    const state = this._previousState
    if (!state) return []
    return this._previousElements.map((element, i) => [element, state.stickyNodes[i]!.node])
  }

  setState(state: StickyScrollState<T> | undefined): void {

    const wasVisible = !!this._previousState && this._previousState.count > 0
    const isVisible = !!state && state.count > 0

    // If state has not changed, do nothing
    if ((!wasVisible && !isVisible) || (wasVisible && isVisible && this._previousState!.equal(state!))) {
      return
    }

    // Update visibility of the widget if changed
    if (wasVisible !== isVisible) {
      this.setVisible(isVisible)
    }

    if (!isVisible) {
      this._previousState = undefined
      this.clearElements()
      return
    }

    const lastStickyNode = state!.stickyNodes[state!.count - 1]!

    // If the new state is only a change in the last node's position, update the position of the last element
    if (this._previousState && state!.animationStateChanged(this._previousState)) {
      this._previousElements[this._previousState.count - 1]!.style.top = `${lastStickyNode.position}px`
    }
    // create new dom elements
    else {
      this.renderState(state!)
    }

    this._previousState = state

    this.updateRootHeight(state!)
  }

  private clearElements(): void {
    for (const element of this._previousElements) element.remove()
    this._previousElements = []
  }

  private renderState(state: StickyScrollState<T>): void {
    this.clearElements()

    // Appended from the last to the first, so a pushed-up last row slides under the ones above it.
    const elements: HTMLElement[] = new Array(state.count)
    for (let stickyIndex = state.count - 1; stickyIndex >= 0; stickyIndex--) {
      const stickyNode = state.stickyNodes[stickyIndex]!

      const element = this.createElement(stickyNode)
      elements[stickyIndex] = element

      this._rootDomNode.appendChild(element)
    }

    this._previousElements = elements
  }

  rerender(): void {
    if (this._previousState) {
      this.renderState(this._previousState)
      this.updateRootHeight(this._previousState)
    }
  }

  private updateRootHeight(state: StickyScrollState<T>): void {
    this._rootDomNode.style.height = `${this.getRootHeight(state)}px`
  }

  private getRootHeight(state: StickyScrollState<T>): number {
    const lastStickyNode = state.stickyNodes[state.count - 1]!
    return Math.max(0, lastStickyNode.position + lastStickyNode.height)
  }

  private createElement(stickyNode: StickyScrollNode<T>): HTMLElement {
    const nodeIndex = stickyNode.startIndex

    // The renderer gets a clean element (it may set the class names); the widget's own class and position go on after.
    const stickyElement = this._rootDomNode.ownerDocument.createElement('div')
    this.renderer(stickyNode.node, stickyElement)

    stickyElement.classList.add(this.rowClassName)
    stickyElement.style.top = `${stickyNode.position}px`
    stickyElement.style.height = `${stickyNode.height}px`
    stickyElement.style.overflow = 'hidden'
    stickyElement.setAttribute('data-index', `${nodeIndex}`)

    return stickyElement
  }

  private setVisible(visible: boolean): void {
    this._rootDomNode.classList.toggle('empty', !visible)
  }

  dispose(): void {
    this.clearElements()
    this._rootDomNode.remove()
  }
}

export class StickyScrollController<T> implements IDisposable {

  private readonly ctx: IStickyScrollContext<T>
  private readonly model: IStickyScrollTreeModel<T>
  private readonly _widget: StickyScrollWidget<T>
  private readonly disposables: IDisposable[] = []

  get domNode(): HTMLElement {
    return this._widget.domNode
  }

  constructor(container: HTMLElement, view: IStickyScrollListView<ITreeNode<T>>, model: IStickyScrollTreeModel<T>, renderer: StickyRowRenderer<T>, options: IStickyScrollOptions = {}) {
    this.model = model
    this.ctx = createStickyScrollContext(view, model, {
      ...(options.paddingTop !== undefined ? { paddingTop: options.paddingTop } : {}),
      ...(options.stickyScrollMaxItemCount !== undefined ? { stickyScrollMaxItemCount: options.stickyScrollMaxItemCount } : {}),
    })

    this._widget = new StickyScrollWidget(container, renderer, options.containerClassName ?? 'monaco-tree-sticky-container', options.rowClassName ?? 'monaco-tree-sticky-row')
    this.disposables.push(this._widget)

    this.disposables.push(view.onDidScroll(() => this.update()))
    this.disposables.push(view.onDidChangeContentHeight(() => this.update()))
    this.disposables.push(model.onDidChangeCollapseState(() => this.update()))
    this.disposables.push(model.onDidSpliceRenderedNodes((e) => {
      const state = this._widget.state
      if (!state) {
        return
      }

      // If a sticky node is removed, recompute the state
      const hasRemovedStickyNode = e.deleteCount > 0 && state.stickyNodes.some(stickyNode => !this.model.has(this.model.getNodeLocation(stickyNode.node)))
      if (hasRemovedStickyNode) {
        this.update()
        return
      }

      // If a sticky node is updated, rerender the widget
      const shouldRerenderStickyNodes = state.stickyNodes.some(stickyNode => {
        const listIndex = this.model.getListIndex(this.model.getNodeLocation(stickyNode.node))
        return listIndex >= e.start && listIndex < e.start + e.deleteCount && state.contains(stickyNode.node)
      })

      if (shouldRerenderStickyNodes) {
        this._widget.rerender()
      }
    }))

    this.update()
  }

  get height(): number {
    return this._widget.height
  }

  get count(): number {
    return this._widget.count
  }

  get state(): StickyScrollState<T> | undefined {
    return this._widget.state
  }

  getNode(node: ITreeNode<T>): StickyScrollNode<T> | undefined {
    return this._widget.getNode(node)
  }

  nodeOfElement(element: HTMLElement): ITreeNode<T> | undefined {
    return this._widget.nodeOfElement(element)
  }

  rows(): [HTMLElement, ITreeNode<T>][] {
    return this._widget.rows()
  }

  private update(): void {
    this._widget.setState(computeStickyState(this.ctx))
  }

  nodePositionTopBelowWidget(node: ITreeNode<T>): number {
    return nodePositionTopBelowWidget(this.ctx, node)
  }

  refresh(): void {
    this.update()
  }

  rerender(): void {
    this._widget.rerender()
    this.update()
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose()
    this.disposables.length = 0
  }
}
