// The pad-notes extension's channels between its renderer and main sides (`ext:pad-notes:<channel>`). Main validates the
// argument: it comes from the renderer.
import type { NoteRead } from '../../app/shared/api.ts'

export interface PadNotesChannels {
  invoke: {
    /** A note file's text, for the manager's read-only preview. */
    read: (path: string) => NoteRead
  }
}
