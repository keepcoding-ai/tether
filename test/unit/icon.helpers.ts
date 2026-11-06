// Test pixels for the icon encoders: a square straight-alpha RGBA bitmap with a diagonal gradient and transparent
// corners (so alpha paths are exercised), the stand-in for the brand's SVG rasterised by Electron.
export function gradientRgba(size: number): Uint8Array {
  const px = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4
      const corner = (x < size / 8 || x >= size - size / 8) && (y < size / 8 || y >= size - size / 8)
      px[o] = Math.round((x / Math.max(1, size - 1)) * 255)
      px[o + 1] = Math.round((y / Math.max(1, size - 1)) * 255)
      px[o + 2] = 0x80
      px[o + 3] = corner ? 0 : 255
    }
  }
  return px
}
