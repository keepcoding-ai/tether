// Keyboard focus follows the active dockview panel, one frame later (the element may not be laid out yet).
// The deferred focus checks, when its frame comes, that the panel is STILL the active one. Without that check two
// activations inside one frame (a layout restore, panes activated in a row while frames are throttled) leave two
// stale focus calls in that frame; each focus makes its group active again (dockview activates the group that gets
// focus), which re-arms its own deferred focus: the panes then steal the keyboard from each other on every frame
// and keystrokes land in whichever pane holds it at that instant. Pure: no DOM, no dockview import.

/** What the follower needs from a dockview panel api. */
export interface ActivePanelApi {
  readonly isActive: boolean
  onDidActiveChange(fn: (e: { isActive: boolean }) => void): { dispose(): void }
}

export type FrameFn = (fn: () => void) => unknown

const nextFrame: FrameFn = fn => requestAnimationFrame(fn)

/** Focuses on the next frame, only if the panel is still active then. */
export function focusIfStillActive(api: Pick<ActivePanelApi, 'isActive'>, focus: () => void, frame: FrameFn = nextFrame): void {
  frame(() => { if (api.isActive) focus() })
}

/** Every activation of the panel moves the keyboard to it (on the next frame, if it is still active). */
export function followActive(api: ActivePanelApi, focus: () => void, frame: FrameFn = nextFrame): { dispose(): void } {
  return api.onDidActiveChange(({ isActive }) => { if (isActive) focusIfStillActive(api, focus, frame) })
}
