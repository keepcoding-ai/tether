/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Port of VS Code's event primitives, reduced to what the tree model and the virtual list need: an `Event` is a
// function that registers a listener and returns its disposable; an `Emitter` owns the listener set; an
// `EventBufferer` holds the fires of its emitters until the outermost buffered operation ends.
// Origin: https://github.com/microsoft/vscode, commit 9cc2376778e119f759ff710c1238fdc58d402d7a
//   src/vs/base/common/event.ts   (Event, Emitter, EventBufferer)
// Left out: the Event namespace combinators (map, filter, debounce, any, once...), EmitterOptions (onWillAddFirstListener
// and friends), the leak monitor, delivery queues, `thisArgs`/disposable-store arguments to an Event, Relay, PauseableEmitter,
// AsyncEmitter. The bufferer queues fires itself (`queue`) instead of wrapping events (`wrapEvent`); the order of delivery
// is the same. Pure, no DOM.

import { toDisposable, type IDisposable } from './vscode-lifecycle.ts'

export type Event<E> = (listener: (e: E) => void) => IDisposable

/**
 * Listener set exposed as an `Event`. While its bufferer is buffering, fires are queued and delivered, in order, when
 * the outermost buffered operation ends (VS Code's EventBufferer.wrapEvent).
 */
export class Emitter<E> {
  private readonly listeners = new Set<(e: E) => void>()
  private readonly bufferer: EventBufferer | undefined

  constructor(bufferer?: EventBufferer) {
    this.bufferer = bufferer
  }

  readonly event: Event<E> = listener => {
    this.listeners.add(listener)
    return toDisposable(() => { this.listeners.delete(listener) })
  }

  fire(e: E): void {
    if (this.bufferer?.queue(() => this.deliver(e))) return
    this.deliver(e)
  }

  /** Drops every listener; later fires reach no one. */
  dispose(): void {
    this.listeners.clear()
  }

  private deliver(e: E): void {
    for (const l of [...this.listeners]) l(e)
  }
}

export class EventBufferer {
  private depth = 0
  private readonly pending: (() => void)[] = []

  /** Queues `fire` when a buffered operation is running; false means deliver now. */
  queue(fire: () => void): boolean {
    if (this.depth === 0) return false
    this.pending.push(fire)
    return true
  }

  bufferEvents<R>(fn: () => R): R {
    this.depth++
    try {
      return fn()
    } finally {
      if (--this.depth === 0) {
        const flush = this.pending.splice(0, this.pending.length)
        for (const f of flush) f()
      }
    }
  }
}
