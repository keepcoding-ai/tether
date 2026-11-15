/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Port of VS Code's RangeMap, the run-length map from list index to pixel position a virtual list scrolls with.
// Origin: https://github.com/microsoft/vscode, commit 9cc2376778e119f759ff710c1238fdc58d402d7a
//   src/vs/base/browser/ui/list/rangeMap.ts   (groupIntersect, shift, consolidate, IRangeMap, RangeMap)
//   src/vs/base/common/range.ts               (IRange, IRangedGroup, Range.intersect/isEmpty/intersects/relativeComplement)
// Left out: nothing of rangeMap.ts. The `Range` namespace becomes a frozen object (namespaces are not erasable syntax);
// `IRangedGroup`, declared in both files upstream, is declared once. Pure, no DOM.

export interface IRange {
  start: number
  end: number
}

export interface IRangedGroup {
  range: IRange
  size: number
}

/**
 * Returns the intersection between two ranges as a range itself.
 * Returns `{ start: 0, end: 0 }` if the intersection is empty.
 */
function intersect(one: IRange, other: IRange): IRange {
  if (one.start >= other.end || other.start >= one.end) {
    return { start: 0, end: 0 }
  }

  const start = Math.max(one.start, other.start)
  const end = Math.min(one.end, other.end)

  if (end - start <= 0) {
    return { start: 0, end: 0 }
  }

  return { start, end }
}

function isEmpty(range: IRange): boolean {
  return range.end - range.start <= 0
}

function intersects(one: IRange, other: IRange): boolean {
  return !isEmpty(intersect(one, other))
}

/** The parts of `one` outside `other`: zero, one or two ranges, in order. */
function relativeComplement(one: IRange, other: IRange): IRange[] {
  const result: IRange[] = []
  const first = { start: one.start, end: Math.min(other.start, one.end) }
  const second = { start: Math.max(other.end, one.start), end: one.end }

  if (!isEmpty(first)) {
    result.push(first)
  }

  if (!isEmpty(second)) {
    result.push(second)
  }

  return result
}

export const Range = Object.freeze({ intersect, isEmpty, intersects, relativeComplement })

export interface IItem {
  size: number
}

/**
 * Returns the intersection between a ranged group and a range.
 * Returns `[]` if the intersection is empty.
 */
export function groupIntersect(range: IRange, groups: IRangedGroup[]): IRangedGroup[] {
  const result: IRangedGroup[] = []

  for (const r of groups) {
    if (range.start >= r.range.end) {
      continue
    }

    if (range.end < r.range.start) {
      break
    }

    const intersection = Range.intersect(range, r.range)

    if (Range.isEmpty(intersection)) {
      continue
    }

    result.push({
      range: intersection,
      size: r.size
    })
  }

  return result
}

/**
 * Shifts a range by that `much`.
 */
export function shift({ start, end }: IRange, much: number): IRange {
  return { start: start + much, end: end + much }
}

/**
 * Consolidates a collection of ranged groups.
 *
 * Consolidation is the process of merging consecutive ranged groups
 * that share the same `size`.
 */
export function consolidate(groups: IRangedGroup[]): IRangedGroup[] {
  const result: IRangedGroup[] = []
  let previousGroup: IRangedGroup | null = null

  for (const group of groups) {
    const start = group.range.start
    const end = group.range.end
    const size = group.size

    if (previousGroup && size === previousGroup.size) {
      previousGroup.range.end = end
      continue
    }

    previousGroup = { range: { start, end }, size }
    result.push(previousGroup)
  }

  return result
}

/**
 * Concatenates several collections of ranged groups into a single
 * collection.
 */
function concat(...groups: IRangedGroup[][]): IRangedGroup[] {
  return consolidate(groups.reduce((r, g) => r.concat(g), []))
}

export interface IRangeMap {
  readonly size: number
  readonly count: number
  paddingTop: number
  splice(index: number, deleteCount: number, items?: IItem[]): void
  indexAt(position: number): number
  indexAfter(position: number): number
  positionAt(index: number): number
}

export class RangeMap implements IRangeMap {

  private groups: IRangedGroup[] = []
  private _size = 0
  private _paddingTop = 0

  get paddingTop(): number {
    return this._paddingTop
  }

  set paddingTop(paddingTop: number) {
    this._size = this._size + paddingTop - this._paddingTop
    this._paddingTop = paddingTop
  }

  constructor(topPadding?: number) {
    this._paddingTop = topPadding ?? 0
    this._size = this._paddingTop
  }

  splice(index: number, deleteCount: number, items: IItem[] = []): void {
    const diff = items.length - deleteCount
    const before = groupIntersect({ start: 0, end: index }, this.groups)
    const after = groupIntersect({ start: index + deleteCount, end: Number.POSITIVE_INFINITY }, this.groups)
      .map<IRangedGroup>(g => ({ range: shift(g.range, diff), size: g.size }))

    const middle = items.map<IRangedGroup>((item, i) => ({
      range: { start: index + i, end: index + i + 1 },
      size: item.size
    }))

    this.groups = concat(before, middle, after)
    this._size = this._paddingTop + this.groups.reduce((t, g) => t + (g.size * (g.range.end - g.range.start)), 0)
  }

  /**
   * Returns the number of items in the range map.
   */
  get count(): number {
    const len = this.groups.length

    if (!len) {
      return 0
    }

    return this.groups[len - 1]!.range.end
  }

  /**
   * Returns the sum of the sizes of all items in the range map.
   */
  get size(): number {
    return this._size
  }

  /**
   * Returns the index of the item at the given position.
   */
  indexAt(position: number): number {
    if (position < 0) {
      return -1
    }

    if (position < this._paddingTop) {
      return 0
    }

    let index = 0
    let size = this._paddingTop

    for (const group of this.groups) {
      const count = group.range.end - group.range.start
      const newSize = size + (count * group.size)

      if (position < newSize) {
        return index + Math.floor((position - size) / group.size)
      }

      index += count
      size = newSize
    }

    return index
  }

  /**
   * Returns the index of the item right after the item at the
   * index of the given position.
   */
  indexAfter(position: number): number {
    return Math.min(this.indexAt(position) + 1, this.count)
  }

  /**
   * Returns the start position of the item at the given index.
   */
  positionAt(index: number): number {
    if (index < 0) {
      return -1
    }

    let position = 0
    let count = 0

    for (const group of this.groups) {
      const groupCount = group.range.end - group.range.start
      const newCount = count + groupCount

      if (index < newCount) {
        return this._paddingTop + position + ((index - count) * group.size)
      }

      position += groupCount * group.size
      count = newCount
    }

    return -1
  }
}
