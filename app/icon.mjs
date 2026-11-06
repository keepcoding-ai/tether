// Image encoders for the app icon, with no dependencies: a PNG encoder (node:zlib), an ICO container (Windows),
// an ICNS container (macOS) and the tray's status dot. The pixels come from the brand's SVG rasterised by Electron
// (app/brand-derive.mjs → app/brand-icons.ts); nothing is drawn here. The Start Menu shortcut and the window point
// at app/dist/tether.ico, the Tether.app bundle at app/dist/tether.icns.
import { deflateSync } from 'node:zlib'

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

/** Encodes straight-alpha RGBA pixels (top-down, `width*height*4` bytes) as an 8-bit RGBA PNG; square when `height` is omitted. */
export function encodePng(width, rgba, height = width) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
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

// ---------- tray ----------

/** Paints an antialiased dot (centre/radius in the unit square, colour [r, g, b]) over straight-alpha RGBA pixels, in place. */
export function overlayDot(rgba, size, cx, cy, r, color) {
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
