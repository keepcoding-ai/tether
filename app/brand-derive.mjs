// `npm run brand:derive`: regenerates every asset derived from the brand's SVGs (brand/src) that the app commits under
// brand/assets/app/ (f7-bridge-marca §3.2, the Guga's cycle: edit a SVG in Inkscape, run this, build):
//   mask.json           the 24 px currentColor monogram (app/brand-mask.ts, from brand/src/light/mask.svg)
//   tether.ico/icns/png, tray*.png  the app icon, rasterised full-bleed from brand/src/light/icon.svg (or logo.svg)
//                       by Electron offscreen (app/brand-raster.electron.mjs) and encoded by app/icon.mjs
//   icons.derived.json  the manifest `npm run app:build` checks (sha256 of the source SVG; stale → the build fails)
// Also writes brand/assets/preview/app-icon.png, a contact sheet of the icon at every size and the tray states, for review.
// Then the Tether Bridge's part (brand/assets/bridge/, the PNGs and logos the extension packs): the bridge's own
// scripts/brand-derive.ts, when its source checkout is on the machine (extensions/web-bridge/bridge-source.ts:
// --bridge <dir>, TETHER_BRIDGE_SRC, or ../../chrome-extensions/bridge). Without it this step is skipped with a notice:
// `npm run bridge:build` derives again anyway before packing the extension.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bridgeSourceProblems, describeBridgeSource, resolveBridgeSource } from '../extensions/web-bridge/bridge-source.ts'
import { ALL_SIZES, hexRgb, ICON_ASSET_DIR, resolveIconSource, TRAY_DOT_ACTIVE, TRAY_DOT_ATTENTION, TRAY_SIZE, writeIconAssets } from './brand-icons.ts'
import { writeMaskAsset } from './brand-mask.ts'
import { encodePng, overlayDot } from './icon.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const require = createRequire(import.meta.url)

/** Rasterises `svgRel` (relative to the repo) at every size with Electron; returns the bitmaps and the renderer's name. */
function rasterizeWithElectron(svgRel, sizes) {
  const electronPath = require('electron')
  const tmp = mkdtempSync(join(tmpdir(), 'tether-brand-'))
  try {
    const outJson = join(tmp, 'raster.json')
    const env = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_')) env[k] = v
    const r = spawnSync(electronPath, [join(here, 'brand-raster.electron.mjs'), join(root, svgRel), sizes.join(','), outJson], { stdio: ['ignore', 'inherit', 'inherit'], env, timeout: 120_000 })
    if (r.status !== 0) throw new Error(`o Electron saiu com ${r.status ?? r.signal} ao rasterizar ${svgRel}`)
    const { renderer, sizes: encoded } = JSON.parse(readFileSync(outJson, 'utf8'))
    const rgbaBySize = new Map()
    for (const size of sizes) {
      const b64 = encoded[String(size)]
      if (!b64) throw new Error(`o Electron não devolveu o bitmap de ${size} px`)
      rgbaBySize.set(size, new Uint8Array(Buffer.from(b64, 'base64')))
    }
    return { rgbaBySize, renderer }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** A contact sheet: every size side by side on the brand's light paper, then the three tray states. */
function contactSheet(rgbaBySize, sizes, paper, ring) {
  const gap = 16
  const tray = [[undefined], [TRAY_DOT_ACTIVE], [TRAY_DOT_ATTENTION]].map(([dot]) => {
    const px = Uint8Array.from(rgbaBySize.get(TRAY_SIZE))
    if (dot) { overlayDot(px, TRAY_SIZE, 0.74, 0.74, 0.27, ring); overlayDot(px, TRAY_SIZE, 0.74, 0.74, 0.2, dot) }
    return { size: TRAY_SIZE, px }
  })
  const cells = [...sizes.map(size => ({ size, px: rgbaBySize.get(size) })), ...tray]
  const width = cells.reduce((w, c) => w + c.size + gap, gap)
  const height = Math.max(...cells.map(c => c.size)) + 2 * gap
  const sheet = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) { sheet[i * 4] = paper[0]; sheet[i * 4 + 1] = paper[1]; sheet[i * 4 + 2] = paper[2]; sheet[i * 4 + 3] = 255 }
  let x = gap
  for (const { size, px } of cells) {
    const y0 = height - gap - size
    for (let y = 0; y < size; y++) for (let xx = 0; xx < size; xx++) {
      const s = (y * size + xx) * 4, a = px[s + 3] / 255
      const d = ((y0 + y) * width + x + xx) * 4
      for (let c = 0; c < 3; c++) sheet[d + c] = Math.round(px[s + c] * a + sheet[d + c] * (1 - a))
    }
    x += size + gap
  }
  return { width, height, sheet }
}

const mask = writeMaskAsset(root)
console.log(`brand:derive  mask.json ← ${mask.source} (${mask.sha256.slice(0, 12)})`)

const brand = JSON.parse(readFileSync(join(root, 'brand', 'brand.json'), 'utf8'))
const ring = hexRgb(brand.colors.light.ink)
const paper = hexRgb(brand.colors.light.paper)
const source = resolveIconSource(root)
const { rgbaBySize, renderer } = rasterizeWithElectron(source, ALL_SIZES)
const manifest = writeIconAssets(root, source, rgbaBySize, ring, renderer)
console.log(`brand:derive  ${Object.keys(manifest.targets).join(', ')} ← ${source} (${manifest.sources[source].slice(0, 12)}; ${renderer})`)

// Sizes a person can tell apart on a screen; the 512/1024 only inflate the sheet.
const sheetSizes = ALL_SIZES.filter(s => s <= 256)
const { width, height, sheet } = contactSheet(rgbaBySize, sheetSizes, paper, ring)
const previewDir = join(root, 'brand', 'assets', 'preview')
mkdirSync(previewDir, { recursive: true })
const png = encodePng(width, sheet, height)
writeFileSync(join(previewDir, 'app-icon.png'), png)
console.log(`brand:derive  preview/app-icon.png (${width}×${height}: ${sheetSizes.join('/')} px + bandeja)`)
console.log(`brand:derive ok → ${ICON_ASSET_DIR}`)

// The bridge's assets, by the bridge's own derive (same SVGs, its chains and margins), when the source is around.
const src = resolveBridgeSource(root, process.argv.slice(2))
const problems = bridgeSourceProblems(src.dir)
if (problems.length) {
  console.log(`brand:derive  assets do bridge (brand/assets/bridge) não derivados: fonte do bridge inutilizável em ${describeBridgeSource(src)}; "npm run bridge:build" deriva ao empacotar`)
} else {
  const brandFile = join(root, 'brand', 'brand.json')
  const r = spawnSync(process.execPath, [join(src.dir, 'scripts', 'brand-derive.ts'), brandFile, '--preview', ...(process.argv.includes('--force') ? ['--force'] : [])], { cwd: src.dir, stdio: 'inherit' })
  if (r.status !== 0) { console.error(`brand:derive  o brand-derive do bridge saiu com ${r.status ?? r.signal}`); process.exit(r.status ?? 1) }
  console.log(`brand:derive ok → ${relative(root, join(root, 'brand', 'assets', 'bridge'))} (bridge em ${src.dir}); "npm run bridge:build" empacota a extensão`)
}
