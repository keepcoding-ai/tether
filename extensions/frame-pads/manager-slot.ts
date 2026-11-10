// The panel pad's second state: the manager of its frames. The pad shows one of two things: the focused panel's frame (the
// normal state) or the manager (the panel-pad-manager extension's view), in place; the header's button, the commands and the toasts
// switch between them. Nothing opens on the desk. This module is the state the two extensions share: frame-pads hosts the
// view and draws the switch; panel-pad-manager provides the view. One state per window (the pad is one, whichever panel it shows).
import type { FrameFilter } from '../../app/renderer/ext-api.ts'
import { toDisposable, type IDisposable } from '../../app/shared/vscode-lifecycle.ts'

export interface ManagerView {
  readonly element: HTMLElement
  /** Shows a filter, with a frame selected when given. */
  open(filter: FrameFilter, key?: string): void
  focus(): void
  dispose(): void
}

export interface ManagerProvider {
  /** The view for one panel pad; `exit` takes the pad back to its frame. */
  create(host: { exit(): void }): ManagerView
}

export interface ManagerRequest { filter: FrameFilter; key?: string }

let provider: ManagerProvider | undefined
let on = false
let request: ManagerRequest = { filter: 'all' }
const listeners = new Set<() => void>()

function emit(): void { for (const l of [...listeners]) l() }

export const padManager = {
  /** The panel-pad-manager extension's view; without one the pad has no second state (the button hides). */
  provide(p: ManagerProvider): IDisposable {
    provider = p
    emit()
    return toDisposable(() => { if (provider === p) { provider = undefined; on = false; emit() } })
  },
  provider(): ManagerProvider | undefined { return provider },
  isOn(): boolean { return on && !!provider },
  /** What the manager was last asked to show (the live views open on it). */
  request(): ManagerRequest { return request },
  /** The pad goes to the manager (or the manager changes what it shows). */
  show(filter: FrameFilter, key?: string): void {
    request = { filter, ...(key ? { key } : {}) }
    on = true
    emit()
  },
  /** The pad goes back to its frame. */
  hide(): void {
    if (!on) return
    on = false
    emit()
  },
  onDidChange(l: () => void): IDisposable { listeners.add(l); return toDisposable(() => { listeners.delete(l) }) },
}
