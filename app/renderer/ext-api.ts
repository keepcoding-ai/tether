// `TetherUi`: what the renderer offers an extension's `activate` (F9). It grows per slice (study §3.2); slice 0a has
// the pane-type registry. Every registration returns a disposable (app/shared/vscode-lifecycle.ts).
import type { IDisposable } from '../shared/vscode-lifecycle.ts'
import type { PaneType } from './pane-registry.ts'

export type { IDisposable as Disposable } from '../shared/vscode-lifecycle.ts'
export type { PaneType } from './pane-registry.ts'

export interface TetherUi {
  /** The extension's id. */
  readonly id: string
  panes: {
    register(type: PaneType): IDisposable
  }
}
