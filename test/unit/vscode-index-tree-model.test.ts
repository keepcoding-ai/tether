// The IndexTreeModel port (app/shared/vscode-index-tree-model.ts): the flat list of rendered rows is rebuilt only from
// the onDidSpliceRenderedNodes events (as VS Code's indexTreeModel.test.ts does), and must match the tree after every
// splice and collapse; list indices and render counts follow collapsed nodes.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { IndexTreeModel, type ITreeElement, type ITreeNode, type ITreeListSpliceData } from '../../app/shared/vscode-index-tree-model.ts'

interface Harness {
  model: IndexTreeModel<string>
  list: ITreeNode<string>[]
  splices: { start: number; deleteCount: number; elements: string[] }[]
}

function harness(options?: { collapseByDefault?: boolean }): Harness {
  const model = new IndexTreeModel<string>('test', 'root', options)
  const h: Harness = { model, list: [], splices: [] }
  model.onDidSpliceRenderedNodes(({ start, deleteCount, elements }: ITreeListSpliceData<string, void>) => {
    // Concatenation, not Array#splice with spread arguments, so a 50k-row splice cannot overflow the stack.
    h.list = h.list.slice(0, start).concat(elements, h.list.slice(start + deleteCount))
    h.splices.push({ start, deleteCount, elements: elements.map(e => e.element) })
  })
  return h
}

const rows = (h: Harness): string[] => h.list.map(n => n.element)
const leaf = (element: string): ITreeElement<string> => ({ element })

describe('IndexTreeModel', () => {
  test('splice at the root', () => {
    const h = harness()
    h.model.splice([0], 0, [leaf('a'), leaf('b'), leaf('c')])
    assert.deepEqual(rows(h), ['a', 'b', 'c'])
    assert.deepEqual(h.splices, [{ start: 0, deleteCount: 0, elements: ['a', 'b', 'c'] }])
    assert.equal(h.model.getListRenderCount([]), 3)
    assert.deepEqual(h.list.map(n => n.depth), [1, 1, 1])
    assert.deepEqual(h.list.map(n => n.visibleChildIndex), [0, 1, 2])

    h.model.splice([1], 1, [leaf('x'), leaf('y')])
    assert.deepEqual(rows(h), ['a', 'x', 'y', 'c'])
    assert.deepEqual(h.splices[1], { start: 1, deleteCount: 1, elements: ['x', 'y'] })
    // As upstream: the siblings after the splice point are shifted only by the deleted count, so a net insertion leaves
    // `c` at its old visibleChildIndex (1 = 2 - 1 deleted) instead of 3. Only aria-posinset reads this field.
    assert.deepEqual(h.model.getNode([]).children.map(n => n.visibleChildIndex), [0, 1, 2, 1])
    assert.equal(h.model.getNode([]).visibleChildrenCount, 4)
  })

  test('nested splice inserts rows right after the parent subtree prefix', () => {
    const h = harness()
    h.model.splice([0], 0, [
      { element: 'a', children: [leaf('a1'), leaf('a2')] },
      { element: 'b', children: [leaf('b1')] },
      leaf('c'),
    ])
    assert.deepEqual(rows(h), ['a', 'a1', 'a2', 'b', 'b1', 'c'])
    assert.equal(h.model.isCollapsible([0]), true)
    assert.equal(h.model.isCollapsible([2]), false)

    h.model.splice([1, 1], 0, [{ element: 'b2', children: [leaf('b2x')] }])
    assert.deepEqual(rows(h), ['a', 'a1', 'a2', 'b', 'b1', 'b2', 'b2x', 'c'])
    assert.deepEqual(h.splices.at(-1), { start: 5, deleteCount: 0, elements: ['b2', 'b2x'] })
    assert.equal(h.model.getListRenderCount([1]), 4)
    assert.equal(h.model.getListRenderCount([]), 8)
    assert.equal(h.model.getNode([1, 1, 0]).depth, 3)
  })

  test('collapse and expand emit the splice of the hidden rows', () => {
    const h = harness()
    h.model.splice([0], 0, [
      { element: 'a', children: [leaf('a1'), { element: 'a2', children: [leaf('a2x')] }] },
      leaf('b'),
    ])
    assert.deepEqual(rows(h), ['a', 'a1', 'a2', 'a2x', 'b'])

    const collapseEvents: string[] = []
    h.model.onDidChangeCollapseState(({ node, deep }) => collapseEvents.push(`${node.element}:${node.collapsed}:${deep}`))

    assert.equal(h.model.setCollapsed([0], true), true)
    assert.deepEqual(h.splices.at(-1), { start: 1, deleteCount: 3, elements: [] })
    assert.deepEqual(rows(h), ['a', 'b'])
    assert.equal(h.model.isCollapsed([0]), true)
    assert.equal(h.model.getListRenderCount([0]), 1)
    assert.equal(h.model.getListRenderCount([]), 2)
    assert.deepEqual(collapseEvents, ['a:true:false'])

    // no change: no event, false
    assert.equal(h.model.setCollapsed([0], true), false)
    assert.equal(h.splices.length, 2)

    assert.equal(h.model.setCollapsed([0]), true) // toggles
    assert.deepEqual(h.splices.at(-1), { start: 1, deleteCount: 0, elements: ['a1', 'a2', 'a2x'] })
    assert.deepEqual(rows(h), ['a', 'a1', 'a2', 'a2x', 'b'])
    assert.deepEqual(collapseEvents, ['a:true:false', 'a:false:false'])
  })

  test('collapse-state events are delivered after the rendered splice', () => {
    const h = harness()
    h.model.splice([0], 0, [{ element: 'a', children: [leaf('a1')] }])
    const order: string[] = []
    h.model.onDidSpliceRenderedNodes(() => order.push('splice'))
    h.model.onDidChangeCollapseState(() => order.push('collapse'))
    h.model.setCollapsed([0], true)
    assert.deepEqual(order, ['splice', 'collapse'])
  })

  test('recursive collapse marks descendants deep', () => {
    const h = harness()
    h.model.splice([0], 0, [{ element: 'a', children: [{ element: 'a1', children: [leaf('a1x')] }] }])
    const events: string[] = []
    h.model.onDidChangeCollapseState(({ node, deep }) => events.push(`${node.element}:${deep}`))
    h.model.setCollapsed([0], true, true)
    assert.deepEqual(events, ['a:false', 'a1:true'])
    assert.equal(h.model.isCollapsed([0, 0]), true)
    h.model.setCollapsed([0], false)
    assert.deepEqual(rows(h), ['a', 'a1'])
  })

  test('getListIndex and getListRenderCount with collapsed nodes', () => {
    const h = harness()
    h.model.splice([0], 0, [
      { element: 'a', collapsed: true, children: [leaf('a1'), leaf('a2')] },
      { element: 'b', children: [leaf('b1'), { element: 'b2', children: [leaf('b2x')] }] },
      leaf('c'),
    ])
    assert.deepEqual(rows(h), ['a', 'b', 'b1', 'b2', 'b2x', 'c'])
    assert.equal(h.model.getListIndex([0]), 0)
    assert.equal(h.model.getListIndex([0, 0]), -1) // under a collapsed parent
    assert.equal(h.model.getListIndex([0, 1]), -1)
    assert.equal(h.model.getListIndex([1]), 1)
    assert.equal(h.model.getListIndex([1, 1]), 3)
    assert.equal(h.model.getListIndex([1, 1, 0]), 4)
    assert.equal(h.model.getListIndex([2]), 5)
    assert.equal(h.model.getListRenderCount([0]), 1)
    assert.equal(h.model.getListRenderCount([1]), 4)
    assert.equal(h.model.getListRenderCount([]), 6)

    assert.deepEqual(h.model.getNodeLocation(h.model.getNode([1, 1, 0])), [1, 1, 0])
    assert.deepEqual(h.model.getParentNodeLocation([1, 1, 0]), [1, 1])
    assert.deepEqual(h.model.getParentNodeLocation([1]), [])
    assert.equal(h.model.getParentNodeLocation([]), undefined)
    assert.equal(h.model.has([1, 1, 0]), true)
    assert.equal(h.model.getFirstElementChild([1]), 'b1')
    assert.equal(h.model.getLastElementAncestor(), 'c')
  })

  test('splice under a collapsed parent emits no rows', () => {
    const h = harness()
    h.model.splice([0], 0, [{ element: 'a', collapsed: true, children: [leaf('a1')] }, leaf('b')])
    const before = h.splices.length
    h.model.splice([0, 1], 0, [leaf('a2'), leaf('a3')])
    assert.equal(h.splices.length, before)
    assert.deepEqual(rows(h), ['a', 'b'])
    assert.equal(h.model.getListRenderCount([]), 2)
    assert.equal(h.model.getNode([0]).children.length, 3)

    h.model.setCollapsed([0], false)
    assert.deepEqual(h.splices.at(-1), { start: 1, deleteCount: 0, elements: ['a1', 'a2', 'a3'] })
    assert.deepEqual(rows(h), ['a', 'a1', 'a2', 'a3', 'b'])
    assert.equal(h.model.getListRenderCount([]), 5)
  })

  test('collapseByDefault hides children of new nodes', () => {
    const h = harness({ collapseByDefault: true })
    h.model.splice([0], 0, [{ element: 'a', children: [leaf('a1')] }])
    assert.deepEqual(rows(h), ['a'])
    assert.equal(h.model.isCollapsed([0]), true)
  })

  test('removing a subtree deletes all its rendered rows', () => {
    const h = harness()
    h.model.splice([0], 0, [
      leaf('a'),
      { element: 'b', children: [leaf('b1'), { element: 'b2', children: [leaf('b2x'), leaf('b2y')] }] },
      leaf('c'),
    ])
    const deleted: string[] = []
    h.model.splice([1], 1, [], { onDidDeleteNode: n => deleted.push(n.element) })
    assert.deepEqual(h.splices.at(-1), { start: 1, deleteCount: 5, elements: [] })
    assert.deepEqual(rows(h), ['a', 'c'])
    assert.deepEqual(deleted, ['b', 'b1', 'b2', 'b2x', 'b2y'])
    assert.equal(h.model.getListRenderCount([]), 2)
    assert.deepEqual(h.model.getNode([]).children.map(n => n.visibleChildIndex), [0, 1])
    assert.equal(h.model.getNode([]).visibleChildrenCount, 2)

    // a nested subtree: only its rows go, the ancestors' counts follow
    h.model.splice([1], 0, [{ element: 'd', children: [{ element: 'd1', children: [leaf('d1x')] }, leaf('d2')] }])
    assert.deepEqual(rows(h), ['a', 'd', 'd1', 'd1x', 'd2', 'c'])
    h.model.splice([1, 0], 1)
    assert.deepEqual(h.splices.at(-1), { start: 2, deleteCount: 2, elements: [] })
    assert.deepEqual(rows(h), ['a', 'd', 'd2', 'c'])
    assert.equal(h.model.getListRenderCount([1]), 2)
    assert.equal(h.model.getListRenderCount([]), 4)
  })

  test('onDidChangeRenderNodeCount reports the ancestors whose count changed', () => {
    const h = harness()
    h.model.splice([0], 0, [{ element: 'a', children: [leaf('a1')] }])
    const changed: string[] = []
    h.model.onDidChangeRenderNodeCount(n => changed.push(n.element))
    h.model.splice([0, 1], 0, [leaf('a2')])
    assert.deepEqual(changed, ['a', 'root'])
  })

  test('rerender re-emits the single row', () => {
    const h = harness()
    h.model.splice([0], 0, [leaf('a'), leaf('b')])
    h.model.rerender([1])
    assert.deepEqual(h.splices.at(-1), { start: 1, deleteCount: 1, elements: ['b'] })
  })

  test('invalid locations throw', () => {
    const h = harness()
    assert.throws(() => h.model.splice([], 0, []), /Invalid tree location/)
    assert.throws(() => h.model.getListIndex([5]), /Invalid tree location/)
  })

  test('50 000 children in one splice: no stack overflow, under a second', () => {
    const h = harness()
    const children = Array.from({ length: 50_000 }, (_, i) => leaf(`f${i}`))
    const t0 = performance.now()
    h.model.splice([0], 0, [{ element: 'dir', children }])
    h.model.splice([0, 25_000], 1, [leaf('replaced')])
    h.model.setCollapsed([0], true)
    h.model.setCollapsed([0], false)
    const elapsed = performance.now() - t0
    assert.equal(h.list.length, 50_001)
    assert.equal(h.list[25_001]?.element, 'replaced')
    assert.equal(h.model.getListRenderCount([]), 50_001)
    assert.equal(h.model.getListIndex([0, 49_999]), 50_000)
    assert.ok(elapsed < 1000, `took ${elapsed.toFixed(0)} ms`)
  })
})
