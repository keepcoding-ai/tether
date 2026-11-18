/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Port of VS Code's IndexTreeModel, the tree addressed by index paths (`number[]` locations) that keeps, per node,
// how many rows it renders, so a virtual list can map a tree location to a flat list index and back without walking
// the whole tree. Every structural change is announced as a splice of the flat list of rendered rows.
// Origin: https://github.com/microsoft/vscode, commit 9cc2376778e119f759ff710c1238fdc58d402d7a
//   src/vs/base/browser/ui/tree/indexTreeModel.ts   (IIndexTreeNode, IIndexTreeModelOptions, IIndexTreeModelSpliceOptions,
//                                                    IndexTreeModel)
//   src/vs/base/browser/ui/tree/tree.ts             (ITreeElement, ITreeNode, ITreeModelSpliceEvent, ITreeListSpliceData,
//                                                    ICollapseStateChangeEvent, TreeError)
//   src/vs/base/common/arrays.ts                    (splice, tail: inlined)
//   src/vs/base/common/event.ts                     (Event, Emitter, EventBufferer: see ./vscode-event.ts)
// Left out: filtering (ITreeFilter, TreeVisibility, refilter, the `visibility` node field, _filterNode,
// updateNodeAfterFilterChange, the refilter Delayer), autoExpandSingleChildren, the identity diff (diffIdentityProvider,
// diffDepth, spliceSmart, LcsDiff, lastDiffIds). Every node is visible: `visible` is always true and `filterData`
// always undefined; both stay on the node so consumers of ITreeNode keep their shape. Pure, no DOM.

import { Emitter, EventBufferer, type Event } from './vscode-event.ts'

export type { Event } from './vscode-event.ts'

export interface ITreeElement<T> {
  readonly element: T
  readonly children?: Iterable<ITreeElement<T>>
  readonly collapsible?: boolean
  readonly collapsed?: boolean
}

export interface ITreeNode<T, TFilterData = void> {
  readonly element: T
  readonly children: ITreeNode<T, TFilterData>[]
  readonly depth: number
  readonly visibleChildrenCount: number
  readonly visibleChildIndex: number
  readonly collapsible: boolean
  readonly collapsed: boolean
  readonly visible: boolean
  readonly filterData: TFilterData | undefined
}

export interface ITreeModelSpliceEvent<T, TFilterData> {
  insertedNodes: ITreeNode<T, TFilterData>[]
  deletedNodes: ITreeNode<T, TFilterData>[]
}

export interface ITreeListSpliceData<T, TFilterData> {
  start: number
  deleteCount: number
  elements: ITreeNode<T, TFilterData>[]
}

export interface ICollapseStateChangeEvent<T, TFilterData> {
  node: ITreeNode<T, TFilterData>
  deep: boolean
}

export class TreeError extends Error {
  constructor(user: string, message: string) {
    super(`TreeError [${user}] ${message}`)
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

// Exported for tests
export interface IIndexTreeNode<T, TFilterData = void> extends ITreeNode<T, TFilterData> {
  readonly parent: IIndexTreeNode<T, TFilterData> | undefined
  readonly children: IIndexTreeNode<T, TFilterData>[]
  visibleChildrenCount: number
  visibleChildIndex: number
  collapsible: boolean
  collapsed: boolean
  renderNodeCount: number
  visible: boolean
  filterData: TFilterData | undefined
}

export interface IIndexTreeModelOptions {
  readonly collapseByDefault?: boolean // defaults to false
  readonly allowNonCollapsibleParents?: boolean // defaults to false
}

export interface IIndexTreeModelSpliceOptions<T, TFilterData> {
  /**
   * Callback for when a node is created.
   */
  onDidCreateNode?: (node: ITreeNode<T, TFilterData>) => void

  /**
   * Callback for when a node is deleted.
   */
  onDidDeleteNode?: (node: ITreeNode<T, TFilterData>) => void
}

interface CollapsibleStateUpdate {
  readonly collapsible: boolean
}

interface CollapsedStateUpdate {
  readonly collapsed: boolean
  readonly recursive: boolean
}

type CollapseStateUpdate = CollapsibleStateUpdate | CollapsedStateUpdate

function isCollapsibleStateUpdate(update: CollapseStateUpdate): update is CollapsibleStateUpdate {
  return 'collapsible' in update
}

export class IndexTreeModel<T extends Exclude<unknown, undefined>, TFilterData = void> {

  readonly rootRef: number[] = []

  private root: IIndexTreeNode<T, TFilterData>
  private eventBufferer = new EventBufferer()

  private readonly _onDidSpliceModel = new Emitter<ITreeModelSpliceEvent<T, TFilterData>>()
  readonly onDidSpliceModel: Event<ITreeModelSpliceEvent<T, TFilterData>> = this._onDidSpliceModel.event

  private readonly _onDidSpliceRenderedNodes = new Emitter<ITreeListSpliceData<T, TFilterData>>()
  readonly onDidSpliceRenderedNodes: Event<ITreeListSpliceData<T, TFilterData>> = this._onDidSpliceRenderedNodes.event

  private readonly _onDidChangeCollapseState = new Emitter<ICollapseStateChangeEvent<T, TFilterData>>(this.eventBufferer)
  readonly onDidChangeCollapseState: Event<ICollapseStateChangeEvent<T, TFilterData>> = this._onDidChangeCollapseState.event

  private readonly _onDidChangeRenderNodeCount = new Emitter<ITreeNode<T, TFilterData>>(this.eventBufferer)
  readonly onDidChangeRenderNodeCount: Event<ITreeNode<T, TFilterData>> = this._onDidChangeRenderNodeCount.event

  private user: string
  private collapseByDefault: boolean
  private allowNonCollapsibleParents: boolean

  constructor(
    user: string,
    rootElement: T,
    options: IIndexTreeModelOptions = {}
  ) {
    this.user = user
    this.collapseByDefault = typeof options.collapseByDefault === 'undefined' ? false : options.collapseByDefault
    this.allowNonCollapsibleParents = options.allowNonCollapsibleParents ?? false

    this.root = {
      parent: undefined,
      element: rootElement,
      children: [],
      depth: 0,
      visibleChildrenCount: 0,
      visibleChildIndex: -1,
      collapsible: false,
      collapsed: false,
      renderNodeCount: 0,
      visible: true,
      filterData: undefined
    }
  }

  splice(
    location: number[],
    deleteCount: number,
    toInsert: Iterable<ITreeElement<T>> = [],
    options: IIndexTreeModelSpliceOptions<T, TFilterData> = {},
  ): void {
    if (location.length === 0) {
      throw new TreeError(this.user, 'Invalid tree location')
    }

    this.spliceSimple(location, deleteCount, toInsert, options)
  }

  private spliceSimple(
    location: number[],
    deleteCount: number,
    toInsert: Iterable<ITreeElement<T>> = [],
    { onDidCreateNode, onDidDeleteNode }: IIndexTreeModelSpliceOptions<T, TFilterData>,
  ): void {
    const { parentNode, listIndex, revealed, visible } = this.getParentNodeWithListIndex(location)
    const treeListElementsToInsert: ITreeNode<T, TFilterData>[] = []

    const lastIndex = location[location.length - 1]!

    // figure out what's the visible child start index right before the
    // splice point
    let visibleChildStartIndex = 0

    for (let i = lastIndex; i >= 0 && i < parentNode.children.length; i--) {
      const child = parentNode.children[i]!

      if (child.visible) {
        visibleChildStartIndex = child.visibleChildIndex
        break
      }
    }

    const nodesToInsert: IIndexTreeNode<T, TFilterData>[] = []
    let insertedVisibleChildrenCount = 0
    let renderNodeCount = 0

    for (const el of toInsert) {
      const child = this.createTreeNode(el, parentNode, revealed, treeListElementsToInsert, onDidCreateNode)
      nodesToInsert.push(child)
      renderNodeCount += child.renderNodeCount

      if (child.visible) {
        child.visibleChildIndex = visibleChildStartIndex + insertedVisibleChildrenCount++
      }
    }

    const deletedNodes = splice(parentNode.children, lastIndex, deleteCount, nodesToInsert)

    // figure out what is the count of deleted visible children
    let deletedVisibleChildrenCount = 0

    for (const child of deletedNodes) {
      if (child.visible) {
        deletedVisibleChildrenCount++
      }
    }

    // and adjust for all visible children after the splice point
    if (deletedVisibleChildrenCount !== 0) {
      for (let i = lastIndex + nodesToInsert.length; i < parentNode.children.length; i++) {
        const child = parentNode.children[i]!

        if (child.visible) {
          child.visibleChildIndex -= deletedVisibleChildrenCount
        }
      }
    }

    // update parent's visible children count
    parentNode.visibleChildrenCount += insertedVisibleChildrenCount - deletedVisibleChildrenCount

    if (deletedNodes.length > 0 && onDidDeleteNode) {
      const visit = (node: ITreeNode<T, TFilterData>) => {
        onDidDeleteNode(node)
        node.children.forEach(visit)
      }

      deletedNodes.forEach(visit)
    }

    if (revealed && visible) {
      const visibleDeleteCount = deletedNodes.reduce((r, node) => r + (node.visible ? node.renderNodeCount : 0), 0)

      this._updateAncestorsRenderNodeCount(parentNode, renderNodeCount - visibleDeleteCount)
      this._onDidSpliceRenderedNodes.fire({ start: listIndex, deleteCount: visibleDeleteCount, elements: treeListElementsToInsert })
    }

    this._onDidSpliceModel.fire({ insertedNodes: nodesToInsert, deletedNodes })
  }

  rerender(location: number[]): void {
    if (location.length === 0) {
      throw new TreeError(this.user, 'Invalid tree location')
    }

    const { node, listIndex, revealed } = this.getTreeNodeWithListIndex(location)

    if (node.visible && revealed) {
      this._onDidSpliceRenderedNodes.fire({ start: listIndex, deleteCount: 1, elements: [node] })
    }
  }

  has(location: number[]): boolean {
    return this.hasTreeNode(location)
  }

  getListIndex(location: number[]): number {
    const { listIndex, visible, revealed } = this.getTreeNodeWithListIndex(location)
    return visible && revealed ? listIndex : -1
  }

  getListRenderCount(location: number[]): number {
    return this.getTreeNode(location).renderNodeCount
  }

  isCollapsible(location: number[]): boolean {
    return this.getTreeNode(location).collapsible
  }

  setCollapsible(location: number[], collapsible?: boolean): boolean {
    const node = this.getTreeNode(location)

    if (typeof collapsible === 'undefined') {
      collapsible = !node.collapsible
    }

    const update: CollapsibleStateUpdate = { collapsible }
    return this.eventBufferer.bufferEvents(() => this._setCollapseState(location, update))
  }

  isCollapsed(location: number[]): boolean {
    return this.getTreeNode(location).collapsed
  }

  setCollapsed(location: number[], collapsed?: boolean, recursive?: boolean): boolean {
    const node = this.getTreeNode(location)

    if (typeof collapsed === 'undefined') {
      collapsed = !node.collapsed
    }

    const update: CollapsedStateUpdate = { collapsed, recursive: recursive || false }
    return this.eventBufferer.bufferEvents(() => this._setCollapseState(location, update))
  }

  private _setCollapseState(location: number[], update: CollapseStateUpdate): boolean {
    const { node, listIndex, revealed } = this.getTreeNodeWithListIndex(location)

    return this._setListNodeCollapseState(node, listIndex, revealed, update)
  }

  private _setListNodeCollapseState(node: IIndexTreeNode<T, TFilterData>, listIndex: number, revealed: boolean, update: CollapseStateUpdate): boolean {
    const result = this._setNodeCollapseState(node, update, false)

    if (!revealed || !node.visible || !result) {
      return result
    }

    const previousRenderNodeCount = node.renderNodeCount
    const toInsert = this.updateNodeAfterCollapseChange(node)
    const deleteCount = previousRenderNodeCount - (listIndex === -1 ? 0 : 1)
    this._onDidSpliceRenderedNodes.fire({ start: listIndex + 1, deleteCount: deleteCount, elements: toInsert.slice(1) })

    return result
  }

  private _setNodeCollapseState(node: IIndexTreeNode<T, TFilterData>, update: CollapseStateUpdate, deep: boolean): boolean {
    let result: boolean

    if (node === this.root) {
      result = false
    } else {
      if (isCollapsibleStateUpdate(update)) {
        result = node.collapsible !== update.collapsible
        node.collapsible = update.collapsible
      } else if (!node.collapsible) {
        result = false
      } else {
        result = node.collapsed !== update.collapsed
        node.collapsed = update.collapsed
      }

      if (result) {
        this._onDidChangeCollapseState.fire({ node, deep })
      }
    }

    if (!isCollapsibleStateUpdate(update) && update.recursive) {
      for (const child of node.children) {
        result = this._setNodeCollapseState(child, update, true) || result
      }
    }

    return result
  }

  expandTo(location: number[]): void {
    this.eventBufferer.bufferEvents(() => {
      let node = this.getTreeNode(location)

      while (node.parent) {
        node = node.parent
        location = location.slice(0, location.length - 1)

        if (node.collapsed) {
          this._setCollapseState(location, { collapsed: false, recursive: false })
        }
      }
    })
  }

  private createTreeNode(
    treeElement: ITreeElement<T>,
    parent: IIndexTreeNode<T, TFilterData>,
    revealed: boolean,
    treeListElements: ITreeNode<T, TFilterData>[],
    onDidCreateNode?: (node: ITreeNode<T, TFilterData>) => void
  ): IIndexTreeNode<T, TFilterData> {
    const node: IIndexTreeNode<T, TFilterData> = {
      parent,
      element: treeElement.element,
      children: [],
      depth: parent.depth + 1,
      visibleChildrenCount: 0,
      visibleChildIndex: -1,
      collapsible: typeof treeElement.collapsible === 'boolean' ? treeElement.collapsible : (typeof treeElement.collapsed !== 'undefined'),
      collapsed: typeof treeElement.collapsed === 'undefined' ? this.collapseByDefault : treeElement.collapsed,
      renderNodeCount: 1,
      visible: true,
      filterData: undefined
    }

    if (revealed) {
      treeListElements.push(node)
    }

    const childElements = treeElement.children || []
    const childRevealed = revealed && !node.collapsed

    let visibleChildrenCount = 0
    let renderNodeCount = 1

    for (const el of childElements) {
      const child = this.createTreeNode(el, node, childRevealed, treeListElements, onDidCreateNode)
      node.children.push(child)
      renderNodeCount += child.renderNodeCount

      if (child.visible) {
        child.visibleChildIndex = visibleChildrenCount++
      }
    }

    if (!this.allowNonCollapsibleParents) {
      node.collapsible = node.collapsible || node.children.length > 0
    }

    node.visibleChildrenCount = visibleChildrenCount

    if (!node.collapsed) {
      node.renderNodeCount = renderNodeCount
    }

    onDidCreateNode?.(node)

    return node
  }

  private updateNodeAfterCollapseChange(node: IIndexTreeNode<T, TFilterData>): ITreeNode<T, TFilterData>[] {
    const previousRenderNodeCount = node.renderNodeCount
    const result: ITreeNode<T, TFilterData>[] = []

    this._updateNodeAfterCollapseChange(node, result)
    this._updateAncestorsRenderNodeCount(node.parent, result.length - previousRenderNodeCount)

    return result
  }

  private _updateNodeAfterCollapseChange(node: IIndexTreeNode<T, TFilterData>, result: ITreeNode<T, TFilterData>[]): number {
    if (node.visible === false) {
      return 0
    }

    result.push(node)
    node.renderNodeCount = 1

    if (!node.collapsed) {
      for (const child of node.children) {
        node.renderNodeCount += this._updateNodeAfterCollapseChange(child, result)
      }
    }

    this._onDidChangeRenderNodeCount.fire(node)
    return node.renderNodeCount
  }

  private _updateAncestorsRenderNodeCount(node: IIndexTreeNode<T, TFilterData> | undefined, diff: number): void {
    if (diff === 0) {
      return
    }

    while (node) {
      node.renderNodeCount += diff
      this._onDidChangeRenderNodeCount.fire(node)
      node = node.parent
    }
  }

  // cheap
  private hasTreeNode(location: number[], node: IIndexTreeNode<T, TFilterData> = this.root): boolean {
    if (!location || location.length === 0) {
      return true
    }

    const index = location[0]!
    const rest = location.slice(1)

    if (index < 0 || index > node.children.length) {
      return false
    }

    return this.hasTreeNode(rest, node.children[index]!)
  }

  // cheap
  private getTreeNode(location: number[], node: IIndexTreeNode<T, TFilterData> = this.root): IIndexTreeNode<T, TFilterData> {
    if (!location || location.length === 0) {
      return node
    }

    const index = location[0]!
    const rest = location.slice(1)

    if (index < 0 || index > node.children.length) {
      throw new TreeError(this.user, 'Invalid tree location')
    }

    return this.getTreeNode(rest, node.children[index]!)
  }

  // expensive
  private getTreeNodeWithListIndex(location: number[]): { node: IIndexTreeNode<T, TFilterData>; listIndex: number; revealed: boolean; visible: boolean } {
    if (location.length === 0) {
      return { node: this.root, listIndex: -1, revealed: true, visible: false }
    }

    const { parentNode, listIndex, revealed, visible } = this.getParentNodeWithListIndex(location)
    const index = location[location.length - 1]!

    if (index < 0 || index > parentNode.children.length) {
      throw new TreeError(this.user, 'Invalid tree location')
    }

    const node = parentNode.children[index]!

    return { node, listIndex, revealed, visible: visible && node.visible }
  }

  private getParentNodeWithListIndex(location: number[], node: IIndexTreeNode<T, TFilterData> = this.root, listIndex: number = 0, revealed = true, visible = true): { parentNode: IIndexTreeNode<T, TFilterData>; listIndex: number; revealed: boolean; visible: boolean } {
    const index = location[0]!
    const rest = location.slice(1)

    if (index < 0 || index > node.children.length) {
      throw new TreeError(this.user, 'Invalid tree location')
    }

    // Linear in the number of preceding siblings at each level of the path.
    for (let i = 0; i < index; i++) {
      listIndex += node.children[i]!.renderNodeCount
    }

    revealed = revealed && !node.collapsed
    visible = visible && node.visible

    if (rest.length === 0) {
      return { parentNode: node, listIndex, revealed, visible }
    }

    return this.getParentNodeWithListIndex(rest, node.children[index]!, listIndex + 1, revealed, visible)
  }

  getNode(location: number[] = []): ITreeNode<T, TFilterData> {
    return this.getTreeNode(location)
  }

  // Linear in the number of siblings at each level of the path (indexOf).
  getNodeLocation(node: ITreeNode<T, TFilterData>): number[] {
    const location: number[] = []
    let indexTreeNode = node as IIndexTreeNode<T, TFilterData>

    while (indexTreeNode.parent) {
      location.push(indexTreeNode.parent.children.indexOf(indexTreeNode))
      indexTreeNode = indexTreeNode.parent
    }

    return location.reverse()
  }

  getParentNodeLocation(location: number[]): number[] | undefined {
    if (location.length === 0) {
      return undefined
    } else if (location.length === 1) {
      return []
    } else {
      return location.slice(0, -1)
    }
  }

  getFirstElementChild(location: number[]): T | undefined {
    const node = this.getTreeNode(location)

    if (node.children.length === 0) {
      return undefined
    }

    return node.children[0]!.element
  }

  getLastElementAncestor(location: number[] = []): T | undefined {
    const node = this.getTreeNode(location)

    if (node.children.length === 0) {
      return undefined
    }

    return this._getLastElementAncestor(node)
  }

  private _getLastElementAncestor(node: ITreeNode<T, TFilterData>): T {
    if (node.children.length === 0) {
      return node.element
    }

    return this._getLastElementAncestor(node.children[node.children.length - 1]!)
  }
}
