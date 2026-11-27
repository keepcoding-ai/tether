// A QR code encoder, pure (no DOM, no dependency): byte mode, error correction L or M, versions 1 to 40, the mask chosen by
// the standard's penalty (ISO/IEC 18004, the method of Project Nayuki's reference encoder). The pairing screen draws the
// matrix as SVG; the payload is the PWA's link with the `#pair=` fragment, never a query (fio-spec 3.2, B-2).

export type QrLevel = 'L' | 'M'

export interface QrMatrix {
  /** The side in modules (21 for version 1, 4 more per version). */
  size: number
  version: number
  mask: number
  /** Row by row, `size * size` cells: 1 is a dark module. */
  cells: Uint8Array
}

/** [L, M]: error correction codewords per block, by version (index 0 unused). */
const ECC_PER_BLOCK: readonly (readonly number[])[] = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
]
/** [L, M]: number of error correction blocks, by version (index 0 unused). */
const ECC_BLOCKS: readonly (readonly number[])[] = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
]
const LEVEL_INDEX: Record<QrLevel, number> = { L: 0, M: 1 }
/** The two bits of the level in the format information. */
const LEVEL_FORMAT: Record<QrLevel, number> = { L: 1, M: 0 }

function rawDataModules(ver: number): number {
  let r = (16 * ver + 128) * ver + 64
  if (ver >= 2) {
    const n = Math.floor(ver / 7) + 2
    r -= (25 * n - 10) * n - 55
    if (ver >= 7) r -= 36
  }
  return r
}

const dataCodewords = (ver: number, lv: number): number =>
  Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[lv]![ver]! * ECC_BLOCKS[lv]![ver]!

// ---- Reed-Solomon over GF(2^8), polynomial 0x11D ----------------------------------------------------------------------

function gfMul(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z & 0xff
}

function rsDivisor(degree: number): number[] {
  const r = new Array<number>(degree).fill(0)
  r[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) {
      r[j] = gfMul(r[j]!, root)
      if (j + 1 < r.length) r[j]! ^= r[j + 1]!
    }
    root = gfMul(root, 0x02)
  }
  return r
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const r = new Array<number>(divisor.length).fill(0)
  for (const b of data) {
    const factor = b ^ r.shift()!
    r.push(0)
    for (let i = 0; i < divisor.length; i++) r[i]! ^= gfMul(divisor[i]!, factor)
  }
  return r
}

// ---- the matrix ---------------------------------------------------------------------------------------------------------

class Grid {
  readonly size: number
  readonly dark: Uint8Array
  readonly fixed: Uint8Array
  constructor(size: number) {
    this.size = size
    this.dark = new Uint8Array(size * size)
    this.fixed = new Uint8Array(size * size)
  }
  get(x: number, y: number): boolean { return this.dark[y * this.size + x] === 1 }
  setFixed(x: number, y: number, on: boolean): void {
    this.dark[y * this.size + x] = on ? 1 : 0
    this.fixed[y * this.size + x] = 1
  }
}

function alignmentPositions(ver: number): number[] {
  if (ver === 1) return []
  const n = Math.floor(ver / 7) + 2
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2
  const r = [6]
  for (let pos = ver * 4 + 17 - 7; r.length < n; pos -= step) r.splice(1, 0, pos)
  return r
}

function drawFunctionPatterns(g: Grid, ver: number): void {
  const s = g.size
  for (let i = 0; i < s; i++) { g.setFixed(6, i, i % 2 === 0); g.setFixed(i, 6, i % 2 === 0) }
  const finder = (cx: number, cy: number): void => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy))
      const x = cx + dx
      const y = cy + dy
      if (x >= 0 && x < s && y >= 0 && y < s) g.setFixed(x, y, d !== 2 && d !== 4)
    }
  }
  finder(3, 3)
  finder(s - 4, 3)
  finder(3, s - 4)
  const pos = alignmentPositions(ver)
  const last = pos.length - 1
  for (let i = 0; i < pos.length; i++) for (let j = 0; j < pos.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) g.setFixed(pos[i]! + dx, pos[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
  }
  drawFormatBits(g, 'M', 0) // reserves the cells; the real bits come after the mask is chosen
  if (ver >= 7) {
    let rem = ver
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const bits = (ver << 12) | rem
    for (let i = 0; i < 18; i++) {
      const on = ((bits >>> i) & 1) !== 0
      const a = s - 11 + (i % 3)
      const b = Math.floor(i / 3)
      g.setFixed(a, b, on)
      g.setFixed(b, a, on)
    }
  }
}

function drawFormatBits(g: Grid, level: QrLevel, mask: number): void {
  const data = (LEVEL_FORMAT[level] << 3) | mask
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  const bits = ((data << 10) | rem) ^ 0x5412
  const bit = (i: number): boolean => ((bits >>> i) & 1) !== 0
  const s = g.size
  for (let i = 0; i <= 5; i++) g.setFixed(8, i, bit(i))
  g.setFixed(8, 7, bit(6))
  g.setFixed(8, 8, bit(7))
  g.setFixed(7, 8, bit(8))
  for (let i = 9; i < 15; i++) g.setFixed(14 - i, 8, bit(i))
  for (let i = 0; i < 8; i++) g.setFixed(s - 1 - i, 8, bit(i))
  for (let i = 8; i < 15; i++) g.setFixed(8, s - 15 + i, bit(i))
  g.setFixed(8, s - 8, true)
}

function drawCodewords(g: Grid, data: readonly number[]): void {
  const s = g.size
  let i = 0
  for (let right = s - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < s; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? s - 1 - vert : vert
        if (g.fixed[y * s + x] === 0 && i < data.length * 8) {
          g.dark[y * s + x] = (data[i >>> 3]! >>> (7 - (i & 7))) & 1
          i++
        }
      }
    }
  }
}

function maskHit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0
    case 1: return y % 2 === 0
    case 2: return x % 3 === 0
    case 3: return (x + y) % 3 === 0
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
  }
}

function applyMask(g: Grid, mask: number): void {
  const s = g.size
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const i = y * s + x
    if (g.fixed[i] === 0 && maskHit(mask, x, y)) g.dark[i] = g.dark[i] === 1 ? 0 : 1
  }
}

/** The standard's penalty of a masked matrix: runs, 2x2 blocks, finder-like patterns, dark/light balance. */
export function penalty(size: number, dark: (x: number, y: number) => boolean): number {
  let score = 0
  const line = (at: (i: number) => boolean): void => {
    let run = 0
    let color = false
    for (let i = 0; i < size; i++) {
      const c = at(i)
      if (i > 0 && c === color) {
        run++
        if (run === 5) score += 3
        else if (run > 5) score++
      } else { color = c; run = 1 }
    }
    // 1:1:3:1:1 with four light modules on either side (the light quiet zone counts as light).
    const cell = (i: number): boolean => (i >= 0 && i < size ? at(i) : false)
    for (let i = -4; i < size; i++) {
      const core = cell(i) && !cell(i + 1) && cell(i + 2) && cell(i + 3) && cell(i + 4) && !cell(i + 5) && cell(i + 6)
      if (!core) continue
      const before = !cell(i - 1) && !cell(i - 2) && !cell(i - 3) && !cell(i - 4)
      const after = !cell(i + 7) && !cell(i + 8) && !cell(i + 9) && !cell(i + 10)
      if (before) score += 40
      if (after) score += 40
    }
  }
  for (let y = 0; y < size; y++) line(x => dark(x, y))
  for (let x = 0; x < size; x++) line(y => dark(x, y))
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
    const c = dark(x, y)
    if (c === dark(x + 1, y) && c === dark(x, y + 1) && c === dark(x + 1, y + 1)) score += 3
  }
  let darkCount = 0
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (dark(x, y)) darkCount++
  const total = size * size
  const k = Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1
  return score + Math.max(0, k) * 10
}

/** The bytes as data codewords of `ver`: mode, count, data, terminator, padding. */
function dataBits(bytes: Uint8Array, ver: number, lv: number): number[] {
  const bits: number[] = []
  const put = (v: number, n: number): void => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1) }
  put(0b0100, 4)
  put(bytes.length, ver <= 9 ? 8 : 16)
  for (const b of bytes) put(b, 8)
  const cap = dataCodewords(ver, lv) * 8
  put(0, Math.min(4, cap - bits.length))
  put(0, (8 - (bits.length % 8)) % 8)
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8)
  const out: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]!
    out.push(b)
  }
  return out
}

function withEcc(data: readonly number[], ver: number, lv: number): number[] {
  const blocks = ECC_BLOCKS[lv]![ver]!
  const eccLen = ECC_PER_BLOCK[lv]![ver]!
  const raw = Math.floor(rawDataModules(ver) / 8)
  const short = blocks - (raw % blocks)
  const shortLen = Math.floor(raw / blocks)
  const div = rsDivisor(eccLen)
  const all: number[][] = []
  for (let i = 0, k = 0; i < blocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < short ? 0 : 1))
    k += dat.length
    const ecc = rsRemainder(dat, div)
    if (i < short) dat.push(0)
    all.push([...dat, ...ecc])
  }
  const out: number[] = []
  for (let i = 0; i < all[0]!.length; i++) {
    for (let j = 0; j < all.length; j++) if (i !== shortLen - eccLen || j >= short) out.push(all[j]![i]!)
  }
  return out
}

/** The smallest version that holds `byteLength` bytes at `level`, or undefined past version 40. */
export function versionFor(byteLength: number, level: QrLevel = 'M'): number | undefined {
  const lv = LEVEL_INDEX[level]
  for (let v = 1; v <= 40; v++) {
    const need = 4 + (v <= 9 ? 8 : 16) + byteLength * 8
    if (need <= dataCodewords(v, lv) * 8) return v
  }
  return undefined
}

/** Encodes `text` (UTF-8) in byte mode. `mask` fixed is for tests; otherwise the one with the lowest penalty. */
export function encodeQr(text: string, opts: { level?: QrLevel; mask?: number; version?: number } = {}): QrMatrix {
  const level = opts.level ?? 'M'
  const lv = LEVEL_INDEX[level]
  const bytes = new TextEncoder().encode(text)
  const ver = opts.version ?? versionFor(bytes.length, level)
  if (ver === undefined || ver < 1 || ver > 40 || versionFor(bytes.length, level)! > ver) throw new RangeError('texto longo demais para um QR')
  const size = ver * 4 + 17
  const codewords = withEcc(dataBits(bytes, ver, lv), ver, lv)
  const base = new Grid(size)
  drawFunctionPatterns(base, ver)
  drawCodewords(base, codewords)
  const tryMask = (mask: number): Grid => {
    const g = new Grid(size)
    g.dark.set(base.dark)
    g.fixed.set(base.fixed)
    applyMask(g, mask)
    drawFormatBits(g, level, mask)
    return g
  }
  let best = opts.mask ?? -1
  if (best < 0) {
    let low = Infinity
    for (let m = 0; m < 8; m++) {
      const g = tryMask(m)
      const p = penalty(size, (x, y) => g.get(x, y))
      if (p < low) { low = p; best = m }
    }
  }
  const g = tryMask(best)
  return { size, version: ver, mask: best, cells: g.dark }
}

/** The dark modules as one SVG path (`M x y h1 v1 h-1 z` per module, runs merged), in module units, for a viewBox with a quiet zone. */
export function qrPath(m: QrMatrix, quiet = 4): string {
  const parts: string[] = []
  for (let y = 0; y < m.size; y++) {
    let x = 0
    while (x < m.size) {
      if (m.cells[y * m.size + x] !== 1) { x++; continue }
      let run = 1
      while (x + run < m.size && m.cells[y * m.size + x + run] === 1) run++
      parts.push(`M${x + quiet} ${y + quiet}h${run}v1h-${run}z`)
      x += run
    }
  }
  return parts.join('')
}
