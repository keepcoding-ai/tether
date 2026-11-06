// The product's monogram (app/shared/brand.ts `icon`) DERIVED from the brand's mask (brand/src/light/mask.svg, brand system
// v2: one monochrome silhouette, recolourable). Derived, never drawn by hand: the SVG is read, every colour becomes
// `currentColor`, ids/title/desc go away, and the drawing is fitted tight (no margin) and centred in a 24x24 viewBox.
// The result is committed as brand/assets/app/mask.json (with the sha256 of its source) because the three hosts import
// brand.ts and plain Node cannot import an .svg: `npm run app:build` rewrites it, and test/unit/brand.test.ts fails when
// the committed file is older than the SVG.
//
// Tight fit needs the drawing's bounding box. Without a renderer it is computed only for untransformed <rect>s (the
// mask today); any other shape (<path>, <circle>…, or a `transform`) falls back to the SVG's own viewBox (full-bleed).
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const MASK_SOURCE = 'brand/src/light/mask.svg'
export const MASK_ASSET = 'brand/assets/app/mask.json'
const SIZE = 24

export interface MaskAsset { source: string; sha256: string; icon: string }
interface Box { x: number; y: number; w: number; h: number }

// Line endings are normalised before hashing: the SVG is checked out as CRLF on Windows and LF elsewhere (autocrlf).
const sha256 = (s: string): string => createHash('sha256').update(s.replace(/\r\n/g, '\n')).digest('hex')
const round = (n: number): string => String(Math.round(n * 10000) / 10000)

/** The 24x24 `currentColor` monogram derived from a mask SVG's text. */
export function maskIcon(svg: string): string {
  const root = /<svg\b([^>]*)>([\s\S]*)<\/svg>/.exec(svg)
  if (!root || root[1] === undefined || root[2] === undefined) throw new Error(`${MASK_SOURCE}: no <svg> element`)
  const viewBox = /\bviewBox="([^"]+)"/.exec(root[1])?.[1]?.trim().split(/[\s,]+/).map(Number)
  if (!viewBox || viewBox.length !== 4 || viewBox.some(n => !Number.isFinite(n))) throw new Error(`${MASK_SOURCE}: viewBox missing or malformed`)
  let body = root[2]
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(title|desc|metadata)\b[\s\S]*?<\/\1>/g, '')
    .replace(/<(sodipodi:namedview|defs)\b[\s\S]*?<\/\1>/g, '')
  // Every explicit colour becomes currentColor (attributes and Inkscape-style `style="fill:#…"`); `none` stays none.
  body = body
    .replace(/\b(fill|stroke)="(?!none"|currentColor")[^"]*"/g, '$1="currentColor"')
    .replace(/\b(fill|stroke):\s*(?!none\b|currentColor\b)[^;"]+/g, '$1:currentColor')
    .replace(/\s+id="[^"]*"/g, '')
    .replace(/\s+inkscape:[\w-]+="[^"]*"/g, '')
    .replace(/\s+sodipodi:[\w-]+="[^"]*"/g, '')
    .replace(/\s+xmlns:(inkscape|sodipodi)="[^"]*"/g, '')
    .replace(/>\s+</g, '><')
    .trim()
  const box = tightBox(body) ?? { x: viewBox[0]!, y: viewBox[1]!, w: viewBox[2]!, h: viewBox[3]! }
  if (!(box.w > 0 && box.h > 0)) throw new Error(`${MASK_SOURCE}: empty drawing`)
  const s = SIZE / Math.max(box.w, box.h)
  const tx = (SIZE - box.w * s) / 2 - box.x * s
  const ty = (SIZE - box.h * s) / 2 - box.y * s
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" fill="currentColor"><g transform="translate(${round(tx)} ${round(ty)}) scale(${round(s)})">${body}</g></svg>`
}

/** Bounding box of the drawing when it is made only of untransformed <rect>s; undefined otherwise (use the viewBox). */
function tightBox(body: string): Box | undefined {
  if (/<(path|circle|ellipse|polygon|polyline|line|use|image|text)\b/.test(body) || /\btransform=/.test(body)) return undefined
  const rects = [...body.matchAll(/<rect\b([^>]*)>/g)]
  if (rects.length === 0) return undefined
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [, attrs] of rects) {
    const n = (name: string): number => Number(new RegExp(`\\b${name}="([^"]+)"`).exec(attrs ?? '')?.[1] ?? NaN)
    const x = n('x') || 0, y = n('y') || 0, w = n('width'), h = n('height')
    if (!Number.isFinite(w) || !Number.isFinite(h)) return undefined
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h)
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** The committed asset's content for a mask SVG's text. */
export function maskAsset(svg: string): MaskAsset {
  return { source: MASK_SOURCE, sha256: sha256(svg), icon: maskIcon(svg) }
}

/** Reads the mask and (re)writes brand/assets/app/mask.json under `root` (the repository). Returns the asset. */
export function writeMaskAsset(root: string): MaskAsset {
  const asset = maskAsset(readFileSync(join(root, MASK_SOURCE), 'utf8'))
  mkdirSync(join(root, 'brand', 'assets', 'app'), { recursive: true })
  writeFileSync(join(root, MASK_ASSET), JSON.stringify(asset, null, 2) + '\n')
  return asset
}
