// The tree sticky scroll port (app/renderer/vscode-tree-sticky-scroll.ts): the state computation over a real IndexTreeModel
// and a fake list of fixed heights (a RangeMap with the list's top padding, fed by the model's splices), with no DOM.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { IndexTreeModel, type ITreeElement, type ITreeNode } from '../../app/shared/vscode-index-tree-model.ts'
import { RangeMap } from '../../app/shared/vscode-range-map.ts'
import {
  computeStickyState, createStickyScrollContext, nodePositionTopBelowWidget, type IStickyScrollContext, type IStickyScrollList,
} from '../../app/renderer/vscode-tree-sticky-scroll.ts'

const PAD = 6
/** A project root is 28px high, any other row 26px (the explorer's heights). */
const heightOf = (node: ITreeNode<string>): number => node.depth === 1 ? 28 : 26

class FakeList implements IStickyScrollList<ITreeNode<string>> {
  nodes: ITreeNode<string>[] = []
  map = new RangeMap(PAD)
  scrollTop = 0
  renderHeight: number

  constructor(model: IndexTreeModel<string>, renderHeight: number) {
    this.renderHeight = renderHeight
    model.onDidSpliceRenderedNodes(({ start, deleteCount, elements }) => {
      this.nodes = this.nodes.slice(0, start).concat(elements, this.nodes.slice(start + deleteCount))
      this.map.splice(start, deleteCount, elements.map(e => ({ size: heightOf(e) })))
    })
  }

  get length(): number { return this.nodes.length }
  get firstVisibleIndex(): number { return this.map.indexAt(this.scrollTop) }
  indexAt(position: number): number { return this.map.indexAt(position) }
  getElementTop(index: number): number { return this.map.positionAt(index) }
  getElementHeight(index: number): number { return heightOf(this.nodes[index]!) }
  element(index: number): ITreeNode<string> { return this.nodes[index]! }
}

interface Setup { model: IndexTreeModel<string>; list: FakeList; ctx: IStickyScrollContext<string>; node(path: string): ITreeNode<string> }

function setup(elements: ITreeElement<string>[], renderHeight: number): Setup {
  const model = new IndexTreeModel<string>('test', '')
  const list = new FakeList(model, renderHeight)
  model.splice([0], 0, elements)
  const ctx = createStickyScrollContext(list, model, { paddingTop: PAD })
  return { model, list, ctx, node: path => list.nodes.find(n => n.element === path)! }
}

const files = (dir: string, prefix: string, n: number): ITreeElement<string>[] =>
  Array.from({ length: n }, (_, i) => ({ element: `${dir}/${prefix}${i + 1}` }))
const folder = (path: string, children: ITreeElement<string>[], collapsed = false): ITreeElement<string> => ({ element: path, collapsible: true, collapsed, children })

/** The sticky rows at a scroll position: `path@position`. */
function stickyAt(s: Setup, scrollTop: number): string[] {
  s.list.scrollTop = scrollTop
  return (computeStickyState(s.ctx)?.stickyNodes ?? []).map(n => `${n.node.element}@${n.position}`)
}

/*
 * R            index 0   top 6     (28)
 *   a          index 1   top 34
 *     b        index 2   top 60
 *       c      index 3   top 86
 *         c1…c5   4–8    top 112…216 (c5 ends at 242)
 *       b1…b5     9–13   top 242…346 (b5 ends at 372)
 *     a1…a5       14–18  top 372…476 (a5 ends at 502)
 *   z1…z5         19–23  top 502…606
 */
const nested = (): Setup => setup([folder('R', [
  folder('R/a', [folder('R/a/b', [folder('R/a/b/c', files('R/a/b/c', 'c', 5)), ...files('R/a/b', 'b', 5)]), ...files('R/a', 'a', 5)]),
  ...files('R', 'z', 5),
])], 400)

describe('tree sticky scroll', () => {
  test('nothing sticks at the top (scrolled no further than the list padding)', () => {
    const s = nested()
    assert.deepEqual(stickyAt(s, 0), [])
    assert.deepEqual(stickyAt(s, PAD), [])
    s.list.renderHeight = 0
    assert.deepEqual(stickyAt(s, 100), [], 'nothing with an empty viewport')
  })

  test('one level: a root over its files', () => {
    const s = setup([folder('R', files('R', 'f', 40))], 400)
    assert.deepEqual(stickyAt(s, 100), ['R@0'])
  })

  test('the ancestors of the first row under the widget stick, each below the one above', () => {
    const s = nested()
    // Scrolled a little: R covers a's row, which covers b's, which covers c's: they all stick.
    assert.deepEqual(stickyAt(s, 20), ['R@0', 'R/a@28', 'R/a/b@54', 'R/a/b/c@80'])
    // Past c's subtree: three levels.
    assert.deepEqual(stickyAt(s, 250), ['R@0', 'R/a@28', 'R/a/b@54'])
  })

  test('the last descendant pushes its sticky ancestor up, then the ancestor leaves', () => {
    const s = nested()
    // b5 ends 77px under the viewport's top: b (26px, would sit at 54) is pushed up to 77 - 26.
    const at295 = computeStickyStateAt(s, 295)
    assert.deepEqual(stickyAt(s, 295), ['R@0', 'R/a@28', 'R/a/b@51'])
    const at300 = computeStickyStateAt(s, 300)
    assert.deepEqual(stickyAt(s, 300), ['R@0', 'R/a@28', 'R/a/b@46'])
    assert.equal(at300!.animationStateChanged(at295!), true, 'only the last node moved: the widget just moves its top')
    assert.equal(at300!.lastNodePartiallyVisible(), true)
    // b5 has scrolled past the widget: b is gone.
    assert.deepEqual(stickyAt(s, 330), ['R@0', 'R/a@28'])
  })

  test('at most 7 rows stick', () => {
    let chain: ITreeElement<string> = folder('R/d1/d2/d3/d4/d5/d6/d7/d8/d9', files('R/d1/d2/d3/d4/d5/d6/d7/d8/d9', 'f', 40))
    for (let i = 8; i >= 1; i--) chain = folder(`R${Array.from({ length: i }, (_, k) => `/d${k + 1}`).join('')}`, [chain])
    const s = setup([folder('R', [chain])], 2000)
    const sticky = stickyAt(s, 600)
    assert.equal(sticky.length, 7)
    assert.deepEqual(sticky.map(x => x.split('@')[0]), ['R', 'R/d1', 'R/d1/d2', 'R/d1/d2/d3', 'R/d1/d2/d3/d4', 'R/d1/d2/d3/d4/d5', 'R/d1/d2/d3/d4/d5/d6'])
    // Revealing a file under d9: its 7 nearest ancestors (d9 to d3) are what can cover it.
    assert.equal(nodePositionTopBelowWidget(s.ctx, s.node('R/d1/d2/d3/d4/d5/d6/d7/d8/d9/f20')), 7 * 26)
  })

  test('the widget never takes more than 40% of the viewport', () => {
    let chain: ITreeElement<string> = folder('R/d1/d2/d3/d4/d5', files('R/d1/d2/d3/d4/d5', 'f', 40))
    for (let i = 4; i >= 1; i--) chain = folder(`R${Array.from({ length: i }, (_, k) => `/d${k + 1}`).join('')}`, [chain])
    const s = setup([folder('R', [chain])], 300)
    // 120px at most: R (28) + d1, d2, d3 (26 each) = 106; d4 would end at 132.
    assert.deepEqual(stickyAt(s, 400).map(x => x.split('@')[0]), ['R', 'R/d1', 'R/d1/d2', 'R/d1/d2/d3'])
  })

  test('a collapsed folder or one with no rows under it does not stick', () => {
    const s = setup([folder('R', [folder('R/x', files('R/x', 'x', 3), true), folder('R/e', []), ...files('R', 'f', 30)])], 400)
    assert.deepEqual(stickyAt(s, 10), ['R@0'], 'collapsed x is the first row under R: nothing more sticks')
    assert.deepEqual(stickyAt(s, 40), ['R@0'], 'empty e is the first row under R: nothing more sticks')
  })

  test('nodePositionTopBelowWidget sums the heights of the ancestors', () => {
    const s = nested()
    assert.equal(nodePositionTopBelowWidget(s.ctx, s.node('R')), 0)
    assert.equal(nodePositionTopBelowWidget(s.ctx, s.node('R/a')), 28)
    assert.equal(nodePositionTopBelowWidget(s.ctx, s.node('R/a/b/c/c1')), 28 + 3 * 26)
    // Scrolled so that b1 sits right under its ancestors: they are exactly what sticks, ending where b1 starts.
    const b1 = s.list.nodes.indexOf(s.node('R/a/b/b1'))
    const below = nodePositionTopBelowWidget(s.ctx, s.node('R/a/b/b1'))
    assert.equal(below, 28 + 2 * 26)
    const top = s.list.getElementTop(b1) - below
    assert.deepEqual(stickyAt(s, top), ['R@0', 'R/a@28', 'R/a/b@54'])
    assert.equal(s.list.getElementTop(b1) - top, 54 + 26, 'b1 starts at the widget\'s bottom')
  })

  test('the state follows the model: a collapsed folder stops sticking', () => {
    const s = nested()
    assert.deepEqual(stickyAt(s, 20), ['R@0', 'R/a@28', 'R/a/b@54', 'R/a/b/c@80'])
    s.model.setCollapsed([0, 0, 0], true) // b
    assert.deepEqual(stickyAt(s, 20), ['R@0', 'R/a@28'])
  })
})

function computeStickyStateAt(s: Setup, scrollTop: number): ReturnType<typeof computeStickyState> {
  s.list.scrollTop = scrollTop
  return computeStickyState(s.ctx)
}
