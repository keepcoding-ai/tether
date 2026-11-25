// The channels extension's channels between its renderer and main sides (the bus `ext:channels:<channel>`), for attachments
// (slice A1). Main looks at files the person chose (size, folder or not, a small thumbnail of an image) and stages a print pasted
// from the clipboard as a file; it never copies into a channel (the daemon does, on `say`) and never sends a file's bytes to the
// renderer beyond the thumbnail.

/** A file the box may attach, as main saw it. */
export interface AttachInfo {
  /** Absolute path on disk (for a pasted print, its staged copy). */
  path: string
  /** The name it goes by in the channel (a pasted print's generated name; otherwise the file's own). */
  name: string
  size: number
  isDirectory: boolean
  missing: boolean
  /** A small data: URL of an image (at most THUMB_PX on its longest side), when main could make one. */
  thumb?: string
  /** Staged by main (a pasted print): main deletes it once it was sent or taken out. */
  staged?: true
}

/** The longest side of a chip's thumbnail. */
export const THUMB_PX = 88
/** The most paths one `inspect` looks at. */
export const INSPECT_MAX = 64

export interface ChannelsIpc {
  invoke: {
    /** Looks at files the person pasted (paths from the clipboard). */
    inspect(paths: string[]): AttachInfo[]
    /** Opens the system's file picker (several at once); [] when cancelled. */
    pick(): AttachInfo[]
    /** Stages the clipboard's image as a PNG named `name`; undefined when the clipboard holds no image. */
    stageImage(name: string): AttachInfo | undefined
    /** Deletes staged prints (only inside the staging folder). */
    discard(paths: string[]): void
  }
}
