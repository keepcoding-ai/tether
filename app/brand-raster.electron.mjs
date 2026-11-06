// Electron main for app/brand-derive.mjs: rasterises one SVG, full-bleed, into square RGBA bitmaps of the sizes asked
// for, with Chromium itself (a hidden window draws the SVG on a <canvas> at each size; getImageData gives straight-
// alpha RGBA, so transparent corners survive). The whole SVG is drawn as one body (brand-derivation: one group, never
// a part). Written as JSON to the output file: { renderer, sizes: { "<px>": "<base64 rgba>" } }.
//
//   electron app/brand-raster.electron.mjs <svg path> <sizes, comma separated> <out json path>
import { app, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const [svgPath, sizesArg, outPath] = process.argv.slice(2)
if (!svgPath || !sizesArg || !outPath) { console.error('uso: electron brand-raster.electron.mjs <svg> <tamanhos> <saída.json>'); app.exit(2) }
const sizes = sizesArg.split(',').map(Number)
if (sizes.some(n => !Number.isInteger(n) || n <= 0 || n > 4096)) { console.error(`tamanhos inválidos: ${sizesArg}`); app.exit(2) }

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const svg = readFileSync(resolve(svgPath), 'utf8')
  const win = new BrowserWindow({ width: 64, height: 64, show: false, webPreferences: { offscreen: true, sandbox: true } })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><meta charset="utf-8"><title>brand raster</title>'))
  const result = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image()
    img.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(svg, 'utf8').toString('base64'))}
    await img.decode()
    const out = {}
    for (const size of ${JSON.stringify(sizes)}) {
      const canvas = document.createElement('canvas')
      canvas.width = size; canvas.height = size
      const ctx = canvas.getContext('2d', { alpha: true, colorSpace: 'srgb' })
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img, 0, 0, size, size)
      const px = ctx.getImageData(0, 0, size, size).data
      let bin = ''
      for (let i = 0; i < px.length; i += 0x8000) bin += String.fromCharCode.apply(null, px.subarray(i, i + 0x8000))
      out[size] = btoa(bin)
    }
    return out
  })()`, true)
  writeFileSync(resolve(outPath), JSON.stringify({ renderer: `electron ${process.versions.electron} (chromium ${process.versions.chrome})`, sizes: result }))
  app.exit(0)
}).catch(err => { console.error(err); app.exit(1) })
