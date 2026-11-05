// Scroll sync between a markdown editor and its preview, by source line (the way VS Code does it). The renderer
// stamps every block it draws with the lines it came from (`data-line`, `data-line-end`, 0-based, end exclusive: the
// `map` of markdown-it); the preview measures those blocks and these two functions convert between a (fractional)
// source line and a pixel offset. Pure, so the mapping is unit-tested without a browser.

/** A rendered block: the source lines [start, end) and where it sits in the preview's document, in pixels. */
export interface LineBlock { start: number; end: number; top: number; height: number }

/** The pixel offset of a source line (fractional: 3.5 is halfway through line 3); undefined with no blocks. */
export function offsetOfLine(blocks: readonly LineBlock[], line: number): number | undefined {
  if (blocks.length === 0) return undefined
  // The innermost block holding the line (children come after their parent in document order).
  let inside: LineBlock | undefined
  for (const b of blocks) if (b.start <= line && line < b.end && b.end > b.start) inside = b
  if (inside) return inside.top + ((line - inside.start) / (inside.end - inside.start)) * inside.height
  // In the gap between two blocks (blank lines), or before the first / after the last.
  let prev: LineBlock | undefined
  let next: LineBlock | undefined
  for (const b of blocks) {
    if (b.end <= line && (!prev || b.top + b.height >= prev.top + prev.height)) prev = b
    if (b.start > line && (!next || b.start < next.start)) next = b
  }
  if (prev && next) {
    const from = prev.top + prev.height
    const span = next.start - prev.end
    return span > 0 ? from + ((line - prev.end) / span) * (next.top - from) : from
  }
  if (next) return next.start > 0 ? (line / next.start) * next.top : 0
  return prev ? prev.top + prev.height : 0
}

/** The (fractional) source line shown at a pixel offset; undefined with no blocks. */
export function lineAtOffset(blocks: readonly LineBlock[], y: number): number | undefined {
  if (blocks.length === 0) return undefined
  let inside: LineBlock | undefined
  for (const b of blocks) if (b.top <= y && y < b.top + b.height && b.height > 0) inside = b
  if (inside) return inside.start + ((y - inside.top) / inside.height) * (inside.end - inside.start)
  let prev: LineBlock | undefined
  let next: LineBlock | undefined
  for (const b of blocks) {
    if (b.top + b.height <= y && (!prev || b.end >= prev.end)) prev = b
    if (b.top > y && (!next || b.top < next.top)) next = b
  }
  if (prev && next) {
    const from = prev.top + prev.height
    const span = next.top - from
    return span > 0 ? prev.end + ((y - from) / span) * (next.start - prev.end) : prev.end
  }
  if (next) return next.top > 0 ? (y / next.top) * next.start : 0
  return prev ? prev.end : 0
}
