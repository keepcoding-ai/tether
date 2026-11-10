// The panel-pad-manager extension's channels between its renderer and main sides (`ext:panel-pad-manager:<channel>`).
// Main validates the argument: it comes from the renderer.
import type { NoteRead } from '../../app/shared/api.ts'

export interface PanelPadManagerChannels {
  invoke: {
    /** A note file's text, for the manager's read-only preview of a note pane. */
    read: (path: string) => NoteRead
  }
}
