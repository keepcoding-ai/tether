// The app icon DERIVED from the brand (f7-bridge-marca §2.1, brand system v2): brand/src/light/icon.svg (or logo.svg
// when there is no icon) is rasterised full-bleed into every size Windows, macOS and the tray need, and encoded with
// app/icon.mjs into tether.ico, tether.icns, tether.png and the three tray PNGs. The rasteriser is Electron itself
// (app/brand-raster.electron.mjs, a hidden window drawing the SVG on a canvas): no new dependency, and Chromium
// renders the SVG exactly as the Guga sees it. Because a Chromium PNG varies by version, the raster is NOT part of
// `npm run app:build`: `npm run brand:derive` (app/brand-derive.mjs) writes the files under brand/assets/app/, which
// are committed together with icons.derived.json (the sha256 of the SVG they came from, line endings normalised).
// The build only checks that manifest against the SVGs and copies the files into app/dist; stale → it fails and
// names the command to run, so a plain build stays reproducible and never spawns Electron.
//
// This module is the pure part (no Electron): sizes, the source chain, encoding RGBA bitmaps into the files, the
// manifest and the freshness check. It is imported by the derive script, the build and the unit tests.
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
// @ts-expect-error app/icon.mjs is plain JavaScript (no declaration file)
import { encodeIcns, encodeIco, encodePng, overlayDot } from './icon.mjs'
import { MASK_ASSET, MASK_SOURCE, maskAsset } from './brand-mask.ts'

/** ICO sizes (the format tops out at 256 px). */
export const ICO_SIZES: readonly number[] = [16, 24, 32, 48, 64, 128, 256]
/** ICNS sizes: the modern PNG-bearing types, 1x and 2x of 16/32/128/256/512 (ICNS_TYPES in icon.mjs). */
export const ICNS_SIZES: readonly number[] = [16, 32, 64, 128, 256, 512, 1024]
/** The dock/Start Menu PNG (app.dock.setIcon). */
export const PNG_SIZE = 256
/** The tray icon. */
export const TRAY_SIZE = 32
/** Every distinct size the raster must produce, ascending. */
export const ALL_SIZES: readonly number[] = [...new Set([...ICO_SIZES, ...ICNS_SIZES, PNG_SIZE, TRAY_SIZE])].sort((a, b) => a - b)

/** The OS icon chain (brand-derivation): the first that exists wins. Paths relative to the repository. */
export const ICON_SOURCE_CHAIN: readonly string[] = ['brand/src/light/icon.svg', 'brand/src/light/logo.svg']
/** Where the derived files and their manifest live (committed). */
export const ICON_ASSET_DIR = 'brand/assets/app'
export const ICON_MANIFEST = `${ICON_ASSET_DIR}/icons.derived.json`
/** The command that regenerates every derived brand asset (named in every staleness error). */
export const DERIVE_COMMAND = 'npm run brand:derive'

/** The files the derive writes and the build copies into app/dist, by name. */
export const ICON_FILES = ['tether.ico', 'tether.icns', 'tether.png', 'tray.png', 'tray-active.png', 'tray-attention.png'] as const
export type IconFile = (typeof ICON_FILES)[number]

export type Rgb = readonly [number, number, number]
/** Status dots on the tray icon: green while an agent runs, amber when one finished its turn or waits for you. */
export const TRAY_DOT_ACTIVE: Rgb = [0x3f, 0xcf, 0x6e]
export const TRAY_DOT_ATTENTION: Rgb = [0xf0, 0xa8, 0x2c]

/** The manifest: what was derived from what. Sorted and without a date: it only changes when a source changes. */
export interface IconManifest {
  version: 1
  /** sha256 (line endings normalised) of the source SVG, keyed by its path relative to the repository. */
  sources: Record<string, string>
  /** Each written file: its source and the pixel sizes it carries. */
  targets: Record<string, { source: string; sizes: number[] }>
  /** What rasterised the SVG (informative: a different Chromium may paint slightly different pixels). */
  renderer: string
}

// Line endings are normalised before hashing: the SVG is checked out as CRLF on Windows and LF elsewhere (autocrlf).
export const svgHash = (svg: string): string => createHash('sha256').update(svg.replace(/\r\n?/g, '\n')).digest('hex')

/** Parses `#rrggbb` into an RGB triple. */
export function hexRgb(hex: string): Rgb {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim())
  if (!m) throw new Error(`cor inválida: ${hex} (esperado #rrggbb)`)
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)]
}

/** The first SVG of the chain that exists under `root`; throws naming the whole chain when none does. */
export function resolveIconSource(root: string): string {
  const found = ICON_SOURCE_CHAIN.find(rel => existsSync(join(root, rel)))
  if (!found) throw new Error(`nenhum SVG de ícone na marca: esperado um de ${ICON_SOURCE_CHAIN.join(', ')}`)
  return found
}

/** The manifest the derive writes for `source` (its text) rendered by `renderer`. */
export function iconManifest(source: string, svg: string, renderer: string): IconManifest {
  const target = (sizes: readonly number[]) => ({ source, sizes: [...sizes] })
  return {
    version: 1,
    sources: { [source]: svgHash(svg) },
    targets: {
      'tether.ico': target(ICO_SIZES),
      'tether.icns': target(ICNS_SIZES),
      'tether.png': target([PNG_SIZE]),
      'tray.png': target([TRAY_SIZE]),
      'tray-active.png': target([TRAY_SIZE]),
      'tray-attention.png': target([TRAY_SIZE]),
    },
    renderer,
  }
}

/**
 * Encodes the files from straight-alpha RGBA bitmaps (one per size in ALL_SIZES, top-down, `size*size*4` bytes).
 * `ring` is the colour of the halo behind the tray dots (the tile's colour, so the dot reads on any panel).
 */
export function encodeIconFiles(rgbaBySize: ReadonlyMap<number, Uint8Array>, ring: Rgb): Map<IconFile, Buffer> {
  const at = (size: number): Uint8Array => {
    const px = rgbaBySize.get(size)
    if (!px) throw new Error(`bitmap de ${size} px ausente`)
    if (px.length !== size * size * 4) throw new Error(`bitmap de ${size} px com ${px.length} bytes (esperado ${size * size * 4})`)
    return px
  }
  const image = (size: number) => ({ size, rgba: at(size) })
  const tray = (dot?: Rgb): Buffer => {
    const px = Uint8Array.from(at(TRAY_SIZE))
    if (dot) {
      overlayDot(px, TRAY_SIZE, 0.74, 0.74, 0.27, ring)
      overlayDot(px, TRAY_SIZE, 0.74, 0.74, 0.2, dot)
    }
    return encodePng(TRAY_SIZE, px) as Buffer
  }
  return new Map<IconFile, Buffer>([
    ['tether.ico', encodeIco(ICO_SIZES.map(image)) as Buffer],
    ['tether.icns', encodeIcns(ICNS_SIZES.map(image)) as Buffer],
    ['tether.png', encodePng(PNG_SIZE, at(PNG_SIZE)) as Buffer],
    ['tray.png', tray()],
    ['tray-active.png', tray(TRAY_DOT_ACTIVE)],
    ['tray-attention.png', tray(TRAY_DOT_ATTENTION)],
  ])
}

/** Writes the files and the manifest under `root`/brand/assets/app. Returns the manifest. */
export function writeIconAssets(root: string, source: string, rgbaBySize: ReadonlyMap<number, Uint8Array>, ring: Rgb, renderer: string): IconManifest {
  const dir = join(root, ICON_ASSET_DIR)
  mkdirSync(dir, { recursive: true })
  for (const [name, bytes] of encodeIconFiles(rgbaBySize, ring)) writeFileSync(join(dir, name), bytes)
  const manifest = iconManifest(source, readFileSync(join(root, source), 'utf8'), renderer)
  writeFileSync(join(root, ICON_MANIFEST), JSON.stringify(manifest, null, 2) + '\n')
  return manifest
}

/**
 * Why the committed brand assets under `root` are out of step with their SVGs: one line per problem, empty when
 * everything is fresh. Covers the monogram (mask.json) and the app icon (icons.derived.json + its files).
 */
export function brandAssetProblems(root: string): string[] {
  const out: string[] = []
  const maskPath = join(root, MASK_ASSET)
  if (!existsSync(maskPath)) out.push(`${MASK_ASSET} não existe`)
  else if (readFileSync(maskPath, 'utf8').replace(/\r\n?/g, '\n') !== JSON.stringify(maskAsset(readFileSync(join(root, MASK_SOURCE), 'utf8')), null, 2) + '\n') {
    out.push(`${MASK_ASSET} está mais velho que ${MASK_SOURCE}`)
  }
  const manifestPath = join(root, ICON_MANIFEST)
  if (!existsSync(manifestPath)) { out.push(`${ICON_MANIFEST} não existe`); return out }
  let manifest: IconManifest
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as IconManifest } catch { out.push(`${ICON_MANIFEST} não é JSON`); return out }
  const source = resolveIconSource(root)
  const expected = iconManifest(source, readFileSync(join(root, source), 'utf8'), manifest.renderer ?? '')
  if (manifest.version !== 1) out.push(`${ICON_MANIFEST}: versão ${String(manifest.version)} (esperada 1)`)
  if (JSON.stringify(manifest.targets) !== JSON.stringify(expected.targets)) out.push(`${ICON_MANIFEST}: os alvos ou a cadeia do ícone mudaram (origem ${source})`)
  if (JSON.stringify(manifest.sources) !== JSON.stringify(expected.sources)) out.push(`${source} mudou depois da última derivação`)
  for (const name of ICON_FILES) if (!existsSync(join(root, ICON_ASSET_DIR, name))) out.push(`${ICON_ASSET_DIR}/${name} não existe`)
  return out
}

/** Throws when the committed brand assets are stale, naming each problem and the command that fixes them. */
export function assertBrandAssetsFresh(root: string): void {
  const problems = brandAssetProblems(root)
  if (problems.length > 0) throw new Error(`assets da marca desatualizados:\n  - ${problems.join('\n  - ')}\nrode ${DERIVE_COMMAND} e commite brand/assets/app/`)
}

/** Copies the committed icon files into `outDir` (app/dist). */
export function copyIconAssets(root: string, outDir: string): void {
  mkdirSync(outDir, { recursive: true })
  for (const name of ICON_FILES) copyFileSync(join(root, ICON_ASSET_DIR, name), join(outDir, name))
}
