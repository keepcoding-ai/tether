/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Port of VS Code's disposable primitives, the lifecycle every registration in the extension model returns.
// Origin: https://github.com/microsoft/vscode, commit 7faf984945fefaceb533ca1d851697a2e72e4e68
//   src/vs/base/common/lifecycle.ts   (IDisposable, isDisposable, dispose, combinedDisposable, toDisposable,
//                                      DisposableStore; Disposable.None)
// Left out: the leak tracker (trackDisposable/markAsDisposed/setParentOfDisposable), MutableDisposable,
// RefCountedDisposable, the reference collections. `Iterable.is` is inlined. Pure, no DOM.

export interface IDisposable {
  dispose(): void
}

export function isDisposable<E>(thing: E): thing is E & IDisposable {
  return typeof thing === 'object' && thing !== null && typeof (thing as unknown as IDisposable).dispose === 'function' && (thing as unknown as IDisposable).dispose.length === 0
}

function isIterable<T>(thing: unknown): thing is Iterable<T> {
  return !!thing && typeof thing === 'object' && typeof (thing as Iterable<T>)[Symbol.iterator] === 'function'
}

/** Disposes every item (all of them, even when one throws); rethrows the one error or an AggregateError. */
export function dispose<T extends IDisposable>(disposable: T): T
export function dispose<T extends IDisposable>(disposable: T | undefined): T | undefined
export function dispose<T extends IDisposable>(disposables: Iterable<T>): Iterable<T>
export function dispose<T extends IDisposable>(arg: T | Iterable<T> | undefined): unknown {
  if (isIterable<T>(arg)) {
    const errors: unknown[] = []
    for (const d of arg) {
      if (d) {
        try { d.dispose() } catch (e) { errors.push(e) }
      }
    }
    if (errors.length === 1) throw errors[0]
    else if (errors.length > 1) throw new AggregateError(errors, 'Encountered errors while disposing of store')
    return Array.isArray(arg) ? [] : arg
  } else if (arg) {
    arg.dispose()
    return arg
  }
  return undefined
}

export function combinedDisposable(...disposables: IDisposable[]): IDisposable {
  return toDisposable(() => dispose(disposables))
}

class FunctionDisposable implements IDisposable {
  private isDisposed = false
  private readonly fn: () => void
  constructor(fn: () => void) { this.fn = fn }
  dispose(): void {
    if (this.isDisposed) return
    if (!this.fn) throw new Error('Unbound disposable context: Need to use an arrow function to preserve the value of this')
    this.isDisposed = true
    this.fn()
  }
}

/** A disposable that runs `fn` once, on the first dispose. */
export function toDisposable(fn: () => void): IDisposable {
  return new FunctionDisposable(fn)
}

export const NONE_DISPOSABLE: IDisposable = Object.freeze({ dispose() { } })

/**
 * Manages a collection of disposables: the same value registered twice is disposed once; a value added after the
 * store was disposed is not kept (a warning says it leaks), as in VS Code.
 */
export class DisposableStore implements IDisposable {
  static DISABLE_DISPOSED_WARNING = false
  private readonly toDispose = new Set<IDisposable>()
  private disposed = false

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clear()
  }

  get isDisposed(): boolean { return this.disposed }

  /** Disposes every registered value without marking the store disposed. */
  clear(): void {
    if (this.toDispose.size === 0) return
    try { dispose(this.toDispose) } finally { this.toDispose.clear() }
  }

  add<T extends IDisposable>(o: T): T {
    if (!o || o === NONE_DISPOSABLE) return o
    if ((o as unknown as DisposableStore) === this) throw new Error('Cannot register a disposable on itself!')
    if (this.disposed) {
      if (!DisposableStore.DISABLE_DISPOSED_WARNING) console.warn(new Error('Trying to add a disposable to a DisposableStore that has already been disposed of. The added object will be leaked!').stack)
    } else {
      this.toDispose.add(o)
    }
    return o
  }

  /** Removes `o` from the store and disposes it (even when it was not in the store). */
  delete<T extends IDisposable>(o: T): void {
    if (!o) return
    if ((o as unknown as DisposableStore) === this) throw new Error('Cannot dispose a disposable on itself!')
    this.toDispose.delete(o)
    o.dispose()
  }
}
