// The ICNS container written by app/icon.mjs: magic, lengths and the element types macOS expects, without
// any external tool. On macOS, iconutil additionally unpacks it into the standard .iconset.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDirs } from './tmp.helpers.ts'
// @ts-expect-error app/icon.mjs is plain JavaScript (no declaration file)
import { encodeIcns, ICNS_TYPES, rasterize, readIcnsIndex, writeIcons } from '../../app/icon.mjs'

const tmp = tempDirs('tether-icon-')
after(() => tmp.cleanup())

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

test('encodeIcns: header, total length, one PNG element per declared type', () => {
  const sizes = [16, 32, 256]
  const buf: Buffer = encodeIcns(sizes.map((size) => ({ size, rgba: rasterize(size) })))
  assert.equal(buf.toString('latin1', 0, 4), 'icns')
  assert.equal(buf.readUInt32BE(4), buf.length)
  const index: { type: string; length: number }[] = readIcnsIndex(buf)
  assert.deepEqual(index.map((e) => e.type), ['icp4', 'icp5', 'ic11', 'ic08', 'ic13'])
  // each payload is a PNG whose IHDR carries the element's pixel size
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

test('writeIcons: tether.icns carries every modern type (1x and @2x) up to 1024 px', () => {
  const dir = tmp.make()
  writeIcons(dir)
  for (const f of ['tether.ico', 'tether.icns', 'tether.png']) assert.ok(existsSync(join(dir, f)), f)
  const index: { type: string; length: number }[] = readIcnsIndex(readFileSync(join(dir, 'tether.icns')))
  const expected = Object.values(ICNS_TYPES as Record<string, string[]>).flat().sort()
  assert.deepEqual(index.map((e) => e.type).sort(), expected)
})

test('iconutil unpacks tether.icns into the standard .iconset', { skip: process.platform !== 'darwin' && 'iconutil só existe no macOS' }, () => {
  const dir = tmp.make()
  const icns = join(dir, 'tether.icns')
  writeFileSync(icns, encodeIcns([16, 32, 64, 128, 256, 512, 1024].map((size) => ({ size, rgba: rasterize(size) }))))
  const r = spawnSync('iconutil', ['-c', 'iconset', '-o', join(dir, 'tether.iconset'), icns], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(readdirSync(join(dir, 'tether.iconset')).sort(), [
    'icon_128x128.png', 'icon_128x128@2x.png', 'icon_16x16.png', 'icon_16x16@2x.png', 'icon_256x256.png',
    'icon_256x256@2x.png', 'icon_32x32.png', 'icon_32x32@2x.png', 'icon_512x512.png', 'icon_512x512@2x.png',
  ])
})
