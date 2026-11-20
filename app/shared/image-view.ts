// Pure rules of the image viewer (app/renderer/image-preview-panel.ts), shared with the unit tests: how big the picture is
// drawn, how far the zoom goes and how the status bar words it.

export const MIN_ZOOM = 0.05
export const MAX_ZOOM = 32
/** One Ctrl+= / Ctrl+- step, and one notch of Ctrl+wheel (a fraction of a notch for a smooth wheel). */
export const ZOOM_STEP = 1.25

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
}

/** "Ajustar à janela": the whole picture in the box, never enlarged past 100% (a small icon stays small). */
export function fitScale(width: number, height: number, boxWidth: number, boxHeight: number): number {
  if (width <= 0 || height <= 0 || boxWidth <= 0 || boxHeight <= 0) return 1
  return clampZoom(Math.min(1, boxWidth / width, boxHeight / height))
}

/** Where the picture's top-left sits in the box: centered on an axis it fits, clamped to cover the box on an axis it overflows. */
export function placeAxis(box: number, size: number, offset: number): number {
  if (size <= box) return (box - size) / 2
  return Math.min(0, Math.max(box - size, offset))
}

/** The offset that keeps the point under the cursor fixed while the zoom goes from `from` to `to` (`cursor` and `offset` are box coordinates). */
export function zoomOffset(cursor: number, offset: number, from: number, to: number): number {
  return cursor - ((cursor - offset) / from) * to
}

/** "1,2 MB", "34 KB", "812 B". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`.replace('.', ',')
  const mb = kb / 1024
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`.replace('.', ',')
}

export function formatZoom(zoom: number): string {
  return `${Math.round(zoom * 100)}%`
}
