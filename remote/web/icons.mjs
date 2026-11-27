// The installed app's icons. `icons/icon.svg` is the mark (three columns, the Regency's own: icons/icon.svg is the source); the
// PNGs the stores of Android and iOS ask for are drawn here from the same numbers, with the PNG encoder of the app's icons
// (app/icon.mjs, node:zlib only) and no image library. `any` icons keep the rounded corners; the maskable one and the iOS one
// are full-bleed (the system cuts them), with the mark inside the safe zone (the central 80%).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { encodePng } from '../../app/icon.mjs'
import { webDir } from './bundle.mjs'

const BG = [0x1b, 0x1b, 0x1f]
const FG = [0x6a, 0xa6, 0xff]
/** The mark on a 512 grid: x, y, width, height, corner radius. */
const BARS = [[140, 156, 60, 200, 18], [226, 116, 60, 280, 18], [312, 196, 60, 160, 18]]
const FRAME_R = 112

/** Coverage (0..1) of a pixel centre by a rounded rect, antialiased over one pixel of its edge (signed distance). */
function cover(px, py, x, y, w, h, r) {
  const dx = Math.abs(px - (x + w / 2)) - (w / 2 - r)
  const dy = Math.abs(py - (y + h / 2)) - (h / 2 - r)
  const d = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r
  return Math.min(1, Math.max(0, 0.5 - d))
}

/** One icon as PNG bytes: `size` px square; `rounded` keeps the frame's corners (transparent), else the background is full-bleed. */
export function renderIcon(size, { rounded }) {
  const k = 512 / size
  const rgba = new Uint8Array(size * size * 4)
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      // Pixel space: the 512 grid scaled down by k, so the edge's antialiasing is one real pixel wide.
      const x = i + 0.5
      const y = j + 0.5
      const frame = rounded ? cover(x, y, 0, 0, size, size, FRAME_R / k) : 1
      let fg = 0
      for (const [bx, by, bw, bh, br] of BARS) fg = Math.max(fg, cover(x, y, bx / k, by / k, bw / k, bh / k, br / k))
      const o = (j * size + i) * 4
      for (let c = 0; c < 3; c++) rgba[o + c] = Math.round(BG[c] * (1 - fg) + FG[c] * fg)
      rgba[o + 3] = Math.round(frame * 255)
    }
  }
  return encodePng(size, rgba)
}

/** The files of `icons/` in the published folder, by published path. */
export function iconFiles() {
  return new Map([
    ['icons/icon.svg', readFileSync(join(webDir, 'icons', 'icon.svg'))],
    ['icons/icon-192.png', renderIcon(192, { rounded: true })],
    ['icons/icon-512.png', renderIcon(512, { rounded: true })],
    ['icons/icon-maskable-512.png', renderIcon(512, { rounded: false })],
    ['icons/apple-touch-icon.png', renderIcon(180, { rounded: false })],
  ])
}
