// The image viewer: which files it takes (app/shared/preview.ts), the zoom and placement rules (app/shared/image-view.ts),
// the pane's identity in the layout (extensions/note/layouts.ts) and the disk read (app/main/image-files.ts).
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readImage } from '../../app/main/image-files.ts'
import { clampZoom, fitScale, formatBytes, formatZoom, MAX_ZOOM, MIN_ZOOM, placeAxis, zoomOffset } from '../../app/shared/image-view.ts'
import { imageMime, isImagePath, isPreviewablePath, isSvgPath, previewKindOf, previewParams, withPreview } from '../../app/shared/preview.ts'
import { imagePreviewLayout, mdPreviewLayout, previewPaneOptions } from '../../extensions/note/layouts.ts'
import { tempDirs } from './tmp.helpers.ts'

const tmp = tempDirs('tether-imgp-')
after(() => tmp.cleanup())

describe('which files the viewer opens', () => {
  test('every image format, case-insensitively; nothing else', () => {
    for (const p of ['a.png', 'A.JPG', 'x/y.jpeg', 'a.gif', 'a.webp', 'a.bmp', 'a.ico', 'a.avif', 'C:\a b\i.SVG']) assert.equal(isImagePath(p), true, p)
    for (const p of ['a.md', 'a.png.txt', 'png', 'a.html', 'a.tiff', '']) assert.equal(isImagePath(p), false, p)
  })
  test('an SVG is also text: it has its picture as a preview, a bitmap does not', () => {
    assert.equal(isSvgPath('icon.svg'), true)
    assert.equal(isSvgPath('icon.png'), false)
    assert.equal(isPreviewablePath('icon.svg'), true)
    assert.equal(isPreviewablePath('photo.png'), false)
  })
  test('the blob type follows the extension', () => {
    assert.equal(imageMime('a.SVG'), 'image/svg+xml')
    assert.equal(imageMime('a.jpg'), 'image/jpeg')
    assert.equal(imageMime('a.ico'), 'image/x-icon')
  })
})

describe('zoom and placement', () => {
  test('fit never enlarges a small picture and shrinks a big one to the box', () => {
    assert.equal(fitScale(32, 32, 800, 600), 1)
    assert.equal(fitScale(1600, 600, 800, 600), 0.5)
    assert.equal(fitScale(400, 1200, 800, 600), 0.5)
    assert.equal(fitScale(0, 0, 800, 600), 1)
    assert.equal(fitScale(100000, 10, 100, 100), MIN_ZOOM)
  })
  test('the zoom stays within its limits', () => {
    assert.equal(clampZoom(0.001), MIN_ZOOM)
    assert.equal(clampZoom(1000), MAX_ZOOM)
    assert.equal(clampZoom(2), 2)
  })
  test('a picture that fits an axis is centered, one that overflows is held inside the box', () => {
    assert.equal(placeAxis(800, 200, 123), 300)
    assert.equal(placeAxis(800, 1000, 50), 0)
    assert.equal(placeAxis(800, 1000, -500), -200)
    assert.equal(placeAxis(800, 1000, -100), -100)
  })
  test('zooming keeps the point under the cursor fixed', () => {
    // The point of the picture under x=300 when its left edge is at 100 and the zoom 1 is 200; at zoom 2 it must still be at 300.
    const offset = zoomOffset(300, 100, 1, 2)
    assert.equal(offset + 200 * 2, 300)
  })
  test('the status words', () => {
    assert.equal(formatBytes(812), '812 B')
    assert.equal(formatBytes(2048), '2,0 KB')
    assert.equal(formatBytes(34 * 1024), '34 KB')
    assert.equal(formatBytes(1.5 * 1024 * 1024), '1,5 MB')
    assert.equal(formatZoom(0.5), '50%')
  })
})

describe('the pane in the layout', () => {
  test('params round trip with the image kind and the pane type owns it', () => {
    const params = withPreview(undefined, { path: 'C:\a\icon.svg', kind: 'image' })
    assert.equal(previewParams(params)?.kind, 'image')
    assert.equal(previewKindOf(params), 'image')
    const saved = { id: 'preview:x', params }
    assert.equal(imagePreviewLayout.owns!(saved), true)
    assert.equal(mdPreviewLayout.owns!(saved), false)
    const options = previewPaneOptions('preview:x', 'C:\a\icon.svg', 'image', undefined)
    assert.equal(options.component, 'image-preview')
    assert.equal(options.tabComponent, 'md-preview-tab')
    assert.equal(previewKindOf(options.params), 'image')
  })
})

describe('reading the file', () => {
  test('bytes and size of an image; a missing file is said as missing', async () => {
    const dir = tmp.make()
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'dot.png')
    writeFileSync(file, Buffer.from([1, 2, 3, 4]))
    const ok = await readImage(file)
    assert.equal(ok.ok, true)
    if (ok.ok) { assert.deepEqual([...ok.bytes], [1, 2, 3, 4]); assert.equal(ok.size, 4) }
    const gone = await readImage(join(dir, 'gone.png'))
    assert.deepEqual(gone.ok === false && gone.missing, true)
    const folder = await readImage(dir)
    assert.equal(folder.ok, false)
  })
})
