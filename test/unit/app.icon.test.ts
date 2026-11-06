// The app icon derived from the brand (app/brand-icons.ts + the encoders of app/icon.mjs), without Electron:
//   - the ICNS container: magic, lengths and the element types macOS expects (iconutil unpacks it on macOS);
//   - the ICO container: one directory entry per Windows size, PNG only for 256;
//   - the files encoded from RGBA bitmaps, the tray dots over the ring colour, the manifest (sha256 of the SVG,
//     line endings normalised, no date);
//   - the freshness check the build runs: the committed brand/assets/app is in step with the SVGs; a changed SVG,
//     a missing file or a changed chain are named, with `npm run brand:derive` as the fix;
//   - the source chain icon.svg → logo.svg.
// The real raster (Electron offscreen) is exercised by `npm run brand:derive`, whose output is what is committed.
import { test, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tempDirs } from './tmp.helpers.ts'
import { gradientRgba } from './icon.helpers.ts'
// @ts-expect-error app/icon.mjs is plain JavaScript (no declaration file)
import { encodeIcns, encodePng, ICNS_TYPES, readIcnsIndex } from '../../app/icon.mjs'
import {
  ALL_SIZES, assertBrandAssetsFresh, brandAssetProblems, copyIconAssets, DERIVE_COMMAND, encodeIconFiles, hexRgb, ICNS_SIZES,
  ICO_SIZES, ICON_ASSET_DIR, ICON_FILES, ICON_MANIFEST, ICON_SOURCE_CHAIN, iconManifest, resolveIconSource, svgHash, TRAY_SIZE, writeIconAssets,
} from '../../app/brand-icons.ts'
import { MASK_ASSET, MASK_SOURCE } from '../../app/brand-mask.ts'

const tmp = tempDirs('tether-icon-')
after(() => tmp.cleanup())

const root = resolve(import.meta.dirname, '..', '..')
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const bitmaps = (): Map<number, Uint8Array> => new Map(ALL_SIZES.map(size => [size, gradientRgba(size)]))
const pngSize = (png: Buffer): [number, number] => [png.readUInt32BE(16), png.readUInt32BE(20)]

/** A copy of the repo's brand folder (SVGs + committed assets) in a temp root, to break things in. */
function brandCopy(): string {
  const dir = tmp.make()
  cpSync(join(root, 'brand'), join(dir, 'brand'), { recursive: true })
  return dir
}

describe('encoders (app/icon.mjs)', () => {
  test('encodeIcns: header, total length, one PNG element per declared type', () => {
    const sizes = [16, 32, 256]
    const buf: Buffer = encodeIcns(sizes.map((size) => ({ size, rgba: gradientRgba(size) })))
    assert.equal(buf.toString('latin1', 0, 4), 'icns')
    assert.equal(buf.readUInt32BE(4), buf.length)
    const index: { type: string; length: number }[] = readIcnsIndex(buf)
    assert.deepEqual(index.map((e) => e.type), ['icp4', 'icp5', 'ic11', 'ic08', 'ic13'])
    let o = 8
    for (const e of index) {
      const png = buf.subarray(o + 8, o + e.length)
      assert.ok(png.subarray(0, 8).equals(PNG_MAGIC), `${e.type}: payload is a PNG`)
      assert.equal(png.readUInt32BE(16), png.readUInt32BE(20), `${e.type}: square`)
      o += e.length
    }
    assert.equal(o, buf.length)
    assert.throws(() => readIcnsIndex(Buffer.from('nope')), /not an ICNS/)
  })

  test('encodePng: square by default, rectangular with a height (the contact sheet)', () => {
    assert.deepEqual(pngSize(encodePng(8, gradientRgba(8))), [8, 8])
    assert.deepEqual(pngSize(encodePng(8, new Uint8Array(8 * 3 * 4), 3)), [8, 3])
  })
})

describe('encodeIconFiles', () => {
  test('writes the six files: ico with every Windows size, icns with every modern type, 256 png, three 32 px trays', () => {
    const files = encodeIconFiles(bitmaps(), hexRgb('#1b1b1f'))
    assert.deepEqual([...files.keys()], [...ICON_FILES])
    const ico = files.get('tether.ico')!
    assert.equal(ico.readUInt16LE(2), 1, 'ICO type')
    assert.equal(ico.readUInt16LE(4), ICO_SIZES.length, 'one entry per size')
    const entrySizes = ICO_SIZES.map((_, i) => ico[6 + i * 16] || 256)
    assert.deepEqual(entrySizes, [...ICO_SIZES])
    const index: { type: string }[] = readIcnsIndex(files.get('tether.icns')!)
    assert.deepEqual(index.map(e => e.type).sort(), Object.values(ICNS_TYPES as Record<string, string[]>).flat().sort())
    assert.deepEqual(pngSize(files.get('tether.png')!), [256, 256])
    for (const name of ['tray.png', 'tray-active.png', 'tray-attention.png'] as const) assert.deepEqual(pngSize(files.get(name)!), [TRAY_SIZE, TRAY_SIZE], name)
    // the dots change the tray; the plain tray is the bare bitmap
    assert.notDeepEqual(files.get('tray-active.png'), files.get('tray.png'))
    assert.notDeepEqual(files.get('tray-attention.png'), files.get('tray-active.png'))
    assert.deepEqual(files.get('tray.png'), encodePng(TRAY_SIZE, gradientRgba(TRAY_SIZE)))
  })

  test('refuses a missing or mis-sized bitmap', () => {
    const b = bitmaps()
    b.delete(1024)
    assert.throws(() => encodeIconFiles(b, [0, 0, 0]), /1024 px ausente/)
    b.set(1024, new Uint8Array(3))
    assert.throws(() => encodeIconFiles(b, [0, 0, 0]), /1024 px com 3 bytes/)
  })

  test('every ALL_SIZES is needed by some file and the sizes are the ones each container carries', () => {
    assert.deepEqual([...ALL_SIZES], [...new Set([...ICO_SIZES, ...ICNS_SIZES, 256, TRAY_SIZE])].sort((a, b) => a - b))
    assert.deepEqual(ICO_SIZES, [16, 24, 32, 48, 64, 128, 256])
    assert.deepEqual(ICNS_SIZES, [16, 32, 64, 128, 256, 512, 1024])
  })
})

describe('manifest and freshness (what npm run app:build checks)', () => {
  test('iconManifest: sha256 of the SVG with CRLF normalised, every file with its source and sizes, no date', () => {
    const lf = '<svg viewBox="0 0 1 1">\n<rect/>\n</svg>\n'
    const m = iconManifest('brand/src/light/icon.svg', lf, 'electron x')
    assert.equal(m.version, 1)
    assert.equal(m.sources['brand/src/light/icon.svg'], svgHash(lf))
    assert.equal(svgHash(lf.replace(/\n/g, '\r\n')), svgHash(lf), 'CRLF and LF hash the same')
    assert.notEqual(svgHash(lf + ' '), svgHash(lf))
    assert.deepEqual(Object.keys(m.targets), [...ICON_FILES])
    assert.deepEqual(m.targets['tether.ico'], { source: 'brand/src/light/icon.svg', sizes: [...ICO_SIZES] })
    assert.deepEqual(m.targets['tray.png'], { source: 'brand/src/light/icon.svg', sizes: [TRAY_SIZE] })
    assert.equal(m.renderer, 'electron x')
    assert.doesNotMatch(JSON.stringify(m), /\d{4}-\d{2}-\d{2}/, 'no date')
  })

  test('the committed brand/assets/app is in step with the SVGs (else: run the derive and commit)', () => {
    assert.deepEqual(brandAssetProblems(root), [], `rode ${DERIVE_COMMAND}`)
    assert.doesNotThrow(() => assertBrandAssetsFresh(root))
    const committed = JSON.parse(readFileSync(join(root, ICON_MANIFEST), 'utf8')) as { renderer: string; sources: Record<string, string> }
    assert.match(committed.renderer, /^electron \d+\.\d+\.\d+ \(chromium \d+/)
    assert.equal(committed.sources['brand/src/light/icon.svg'], svgHash(readFileSync(join(root, 'brand/src/light/icon.svg'), 'utf8')))
  })

  test('a changed icon.svg, a changed mask.svg, a missing file or a missing manifest are each named, with the command', () => {
    const dir = brandCopy()
    assert.deepEqual(brandAssetProblems(dir), [])
    writeFileSync(join(dir, 'brand/src/light/icon.svg'), readFileSync(join(dir, 'brand/src/light/icon.svg'), 'utf8') + '\n<!-- edited -->\n')
    assert.deepEqual(brandAssetProblems(dir), ['brand/src/light/icon.svg mudou depois da última derivação'])
    assert.throws(() => assertBrandAssetsFresh(dir), (e: Error) => e.message.includes(DERIVE_COMMAND) && e.message.includes('icon.svg mudou'))

    const dir2 = brandCopy()
    writeFileSync(join(dir2, MASK_SOURCE), readFileSync(join(dir2, MASK_SOURCE), 'utf8').replace('<rect', '<rect data-edited="1"'))
    rmSync(join(dir2, ICON_ASSET_DIR, 'tray-active.png'))
    assert.deepEqual(brandAssetProblems(dir2), [`${MASK_ASSET} está mais velho que ${MASK_SOURCE}`, `${ICON_ASSET_DIR}/tray-active.png não existe`])

    const dir3 = brandCopy()
    rmSync(join(dir3, ICON_MANIFEST))
    assert.deepEqual(brandAssetProblems(dir3), [`${ICON_MANIFEST} não existe`])
  })

  test('a different chain outcome (icon.svg gone → logo.svg) is stale until re-derived; writeIconAssets makes it fresh again', () => {
    const dir = brandCopy()
    rmSync(join(dir, 'brand/src/light/icon.svg'))
    assert.equal(resolveIconSource(dir), 'brand/src/light/logo.svg')
    const problems = brandAssetProblems(dir)
    assert.ok(problems.some(p => p.includes('a cadeia do ícone mudaram')), problems.join(' | '))
    const m = writeIconAssets(dir, 'brand/src/light/logo.svg', bitmaps(), hexRgb('#1b1b1f'), 'test')
    assert.equal(m.sources['brand/src/light/logo.svg'], svgHash(readFileSync(join(dir, 'brand/src/light/logo.svg'), 'utf8')))
    assert.deepEqual(brandAssetProblems(dir), [])
    for (const name of ICON_FILES) assert.ok(existsSync(join(dir, ICON_ASSET_DIR, name)), name)
    const out = join(dir, 'dist')
    copyIconAssets(dir, out)
    assert.deepEqual(readdirSync(out).sort(), [...ICON_FILES].sort())
    assert.deepEqual(readFileSync(join(out, 'tether.ico')), readFileSync(join(dir, ICON_ASSET_DIR, 'tether.ico')))
  })

  test('resolveIconSource: icon.svg first, then logo.svg, else an error naming the chain', () => {
    assert.deepEqual(ICON_SOURCE_CHAIN, ['brand/src/light/icon.svg', 'brand/src/light/logo.svg'])
    assert.equal(resolveIconSource(root), 'brand/src/light/icon.svg')
    const dir = tmp.make()
    mkdirSync(join(dir, 'brand/src/light'), { recursive: true })
    assert.throws(() => resolveIconSource(dir), /icon\.svg, brand\/src\/light\/logo\.svg/)
    writeFileSync(join(dir, 'brand/src/light/logo.svg'), '<svg/>')
    assert.equal(resolveIconSource(dir), 'brand/src/light/logo.svg')
  })

  test('hexRgb', () => {
    assert.deepEqual(hexRgb('#1B1b1f'), [0x1b, 0x1b, 0x1f])
    assert.throws(() => hexRgb('blue'), /cor inválida/)
  })
})

test('iconutil unpacks tether.icns into the standard .iconset', { skip: process.platform !== 'darwin' && 'iconutil só existe no macOS' }, () => {
  const dir = tmp.make()
  const icns = join(dir, 'tether.icns')
  writeFileSync(icns, readFileSync(join(root, ICON_ASSET_DIR, 'tether.icns')))
  const r = spawnSync('iconutil', ['-c', 'iconset', '-o', join(dir, 'tether.iconset'), icns], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(readdirSync(join(dir, 'tether.iconset')).sort(), [
    'icon_128x128.png', 'icon_128x128@2x.png', 'icon_16x16.png', 'icon_16x16@2x.png', 'icon_256x256.png',
    'icon_256x256@2x.png', 'icon_32x32.png', 'icon_32x32@2x.png', 'icon_512x512.png', 'icon_512x512@2x.png',
  ])
})
