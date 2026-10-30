// Renders the app icon (two linked panes on a dark rounded square) straight into PNG/ICO/ICNS files, with
// no dependencies: a tiny supersampled rasterizer of rounded rectangles + a PNG encoder (node:zlib) + an
// ICO container (Windows) + an ICNS container (macOS). Called by app/build.mjs; the Start Menu shortcut and
// the window point at app/dist/tether.ico, the Tether.app bundle at app/dist/tether.icns.
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** ICO sizes (the format tops out at 256 px). */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
/** ICNS sizes: the modern PNG-bearing types, 1x and 2x of 16/32/128/256/512 (see ICNS_TYPES). */
const ICNS_SIZES = [16, 32, 64, 128, 256, 512, 1024]
const SIZES = [...new Set([...ICO_SIZES, ...ICNS_SIZES])].sort((a, b) => a - b)
/** Supersampling grid per axis; large images get a 2×2 grid (the edges are already smooth, 1024 px at 4×4 takes ~2 s). */
const supersampleFor = (size) => (size >= 512 ? 2 : 4)

const BG = [0x1b, 0x1b, 0x1f]
const BG_EDGE = [0x3a, 0x3a, 0x44]
const PANE = [0x8e, 0xc8, 0xff] // light blue: the panes
const LINK = [0xff, 0xb8, 0x5c] // amber: the link between them

/** Signed distance from (x, y) to a rounded rectangle; coordinates in the unit square [0, 1]. */
function roundedRect(x, y, x0, y0, x1, y1, r) {
  const cx = Math.max(x0 + r - x, 0, x - (x1 - r))
  const cy = Math.max(y0 + r - y, 0, y - (y1 - r))
  return Math.hypot(cx, cy) - r
}

/**
 * Layers, painted in order, each a filled shape (inside = distance ≤ 0) or a stroke (|distance| ≤ width/2).
 * Geometry is in the unit square, so one description serves every size.
 */
const layers = [
  { color: BG_EDGE, inside: (x, y) => roundedRect(x, y, 0.02, 0.02, 0.98, 0.98, 0.22) },
  { color: BG, inside: (x, y) => roundedRect(x, y, 0.06, 0.06, 0.94, 0.94, 0.19) },
  // left pane (filled) and right pane (outlined): the two terminals
  { color: PANE, inside: (x, y) => roundedRect(x, y, 0.16, 0.24, 0.46, 0.76, 0.05) },
  { color: PANE, inside: (x, y) => Math.abs(roundedRect(x, y, 0.54, 0.24, 0.84, 0.76, 0.05)) - 0.035 },
  // the link: a bar through both panes, with a dark halo so it reads on the filled pane
  { color: BG, inside: (x, y) => roundedRect(x, y, 0.30, 0.42, 0.70, 0.58, 0.08) },
  { color: LINK, inside: (x, y) => roundedRect(x, y, 0.34, 0.455, 0.66, 0.545, 0.045) },
]

/** RGBA pixels (top-down) of the icon at `size` px, antialiased by supersampling. */
export function rasterize(size) {
  const px = new Uint8Array(size * size * 4)
  const n = supersampleFor(size)
  for (let py = 0; py < size; py++) {
    for (let pxx = 0; pxx < size; pxx++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const x = (pxx + (sx + 0.5) / n) / size
          const y = (py + (sy + 0.5) / n) / size
          let color
          for (const layer of layers) if (layer.inside(x, y) <= 0) color = layer.color
          if (color) { r += color[0]; g += color[1]; b += color[2]; a += 255 }
        }
      }
      const samples = n * n
      const o = (py * size + pxx) * 4
      if (a > 0) {
        // Straight (non-premultiplied) alpha: average the colour over the covered samples only.
        const covered = a / 255
        px[o] = Math.round(r / covered); px[o + 1] = Math.round(g / covered); px[o + 2] = Math.round(b / covered)
      }
      px[o + 3] = Math.round(a / samples)
    }
  }
  return px
}

// ---------- PNG ----------

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

export function encodePng(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0 // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0 // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------- ICO ----------

/** A classic 32-bpp BMP entry (BITMAPINFOHEADER + bottom-up BGRA + 1-bpp AND mask): what every Windows reads. */
function bmpEntry(size, rgba) {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8) // XOR + AND masks
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(size * size * 4, 20)
  const xor = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4
      const d = ((size - 1 - y) * size + x) * 4
      xor[d] = rgba[s + 2]; xor[d + 1] = rgba[s + 1]; xor[d + 2] = rgba[s]; xor[d + 3] = rgba[s + 3]
    }
  }
  const maskRow = Math.ceil(size / 32) * 4
  const and = Buffer.alloc(maskRow * size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (rgba[(y * size + x) * 4 + 3] === 0) and[(size - 1 - y) * maskRow + (x >> 3)] |= 0x80 >> (x & 7)
    }
  }
  return Buffer.concat([header, xor, and])
}

export function encodeIco(images) {
  const dir = Buffer.alloc(6)
  dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(images.length, 4)
  const entries = []
  const blobs = []
  let offset = 6 + images.length * 16
  for (const { size, rgba } of images) {
    // Only the 256-px image goes in as PNG (the BMP form would be 256 KiB); the rest as BMP.
    const blob = size >= 256 ? encodePng(size, rgba) : bmpEntry(size, rgba)
    const e = Buffer.alloc(16)
    e[0] = size & 0xff; e[1] = size & 0xff; e[2] = 0; e[3] = 0
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6)
    e.writeUInt32LE(blob.length, 8); e.writeUInt32LE(offset, 12)
    entries.push(e); blobs.push(blob)
    offset += blob.length
  }
  return Buffer.concat([dir, ...entries, ...blobs])
}

// ---------- ICNS ----------

/**
 * ICNS element types that carry a whole PNG as payload (macOS ≥ 10.7), by pixel size: the 1x and the @2x
 * ("Retina") entry for each point size, exactly the set `iconutil -c icns` writes for a standard .iconset.
 * The container is a plain TLV file: magic "icns", total length, then (type, length, payload) elements,
 * every length big-endian and counting its own 8-byte header.
 */
export const ICNS_TYPES = {
  16: ['icp4'],
  32: ['icp5', 'ic11'],
  64: ['ic12'],
  128: ['ic07'],
  256: ['ic08', 'ic13'],
  512: ['ic09', 'ic14'],
  1024: ['ic10'],
}

export function encodeIcns(images) {
  const elements = []
  for (const { size, rgba } of images) {
    const types = ICNS_TYPES[size]
    if (!types) continue
    const png = encodePng(size, rgba)
    for (const type of types) {
      const header = Buffer.alloc(8)
      header.write(type, 0, 4, 'latin1')
      header.writeUInt32BE(8 + png.length, 4)
      elements.push(header, png)
    }
  }
  const total = 8 + elements.reduce((n, b) => n + b.length, 0)
  const head = Buffer.alloc(8)
  head.write('icns', 0, 4, 'latin1')
  head.writeUInt32BE(total, 4)
  return Buffer.concat([head, ...elements])
}

/** Parses an ICNS container into [{ type, length }] (lengths include the 8-byte element header); throws on a malformed file. */
export function readIcnsIndex(buf) {
  if (buf.length < 8 || buf.toString('latin1', 0, 4) !== 'icns') throw new Error('not an ICNS file')
  if (buf.readUInt32BE(4) !== buf.length) throw new Error('ICNS length field does not match the file size')
  const index = []
  for (let o = 8; o < buf.length;) {
    const length = buf.readUInt32BE(o + 4)
    if (length < 8 || o + length > buf.length) throw new Error(`ICNS element at ${o} runs past the file`)
    index.push({ type: buf.toString('latin1', o, o + 4), length })
    o += length
  }
  return index
}

/** Writes <outDir>/tether.ico (Windows sizes), <outDir>/tether.icns (macOS sizes) and <outDir>/tether.png (256 px). */
export function writeIcons(outDir) {
  const images = SIZES.map(size => ({ size, rgba: rasterize(size) }))
  const bySize = new Map(images.map(i => [i.size, i]))
  writeFileSync(join(outDir, 'tether.ico'), encodeIco(ICO_SIZES.map(s => bySize.get(s))))
  writeFileSync(join(outDir, 'tether.icns'), encodeIcns(ICNS_SIZES.map(s => bySize.get(s))))
  writeFileSync(join(outDir, 'tether.png'), encodePng(256, bySize.get(256).rgba))
}

// ---------- tray ----------

const TRAY_SIZE = 32
const DOT = [0x3f, 0xcf, 0x6e] // green: an agent is running

/** Paints an antialiased dot (centre/radius in the unit square) over straight-alpha RGBA pixels. */
function overlayDot(rgba, size, cx, cy, r, color) {
  for (let py = 0; py < size; py++) {
    for (let pxx = 0; pxx < size; pxx++) {
      const d = Math.hypot((pxx + 0.5) / size - cx, (py + 0.5) / size - cy)
      const cover = Math.min(1, Math.max(0, (r - d) * size + 0.5))
      if (cover <= 0) continue
      const o = (py * size + pxx) * 4
      const a0 = rgba[o + 3] / 255
      const a = cover + a0 * (1 - cover)
      for (let c = 0; c < 3; c++) rgba[o + c] = Math.round((color[c] * cover + rgba[o + c] * a0 * (1 - cover)) / a)
      rgba[o + 3] = Math.round(a * 255)
    }
  }
}

/** Writes <outDir>/tray.png (the app icon, 32 px) and tray-active.png (the same with a green dot: an agent runs). */
export function writeTrayIcons(outDir) {
  const base = rasterize(TRAY_SIZE)
  writeFileSync(join(outDir, 'tray.png'), encodePng(TRAY_SIZE, base))
  const withDot = Uint8Array.from(base)
  overlayDot(withDot, TRAY_SIZE, 0.74, 0.74, 0.27, BG) // dark ring so the dot reads on any panel colour
  overlayDot(withDot, TRAY_SIZE, 0.74, 0.74, 0.2, DOT)
  writeFileSync(join(outDir, 'tray-active.png'), encodePng(TRAY_SIZE, withDot))
}
