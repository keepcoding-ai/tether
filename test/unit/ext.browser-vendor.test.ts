// The vendored Tether Browser server (extensions/browser/vendor/tether-browser/): every file matches vendor/manifest.json
// and the bundle's own manifest, nothing is left outside them, and a tampered, missing or extra file is caught.
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditVendor, BUNDLE_SERVER, contentHashOf, sha256, VENDOR_BUNDLE_DIR, VENDOR_MANIFEST, walk, relPath, type VendorManifest } from '../../extensions/browser/vendor-rules.ts'
import { walk as walkSync, manifestOf } from '../../extensions/browser/vendor-rules-sync.ts'
import { tempDirs } from './tmp.helpers.ts'

const root = fileURLToPath(new URL('../../', import.meta.url))
const vendorDir = join(root, 'extensions', 'browser', 'vendor')
const tmp = tempDirs('tether-browser-vendor-')
after(() => tmp.cleanup())

describe('browser: vendored server', () => {
  test('vendor/ is intact: every file matches the manifests and nothing is left outside them', async () => {
    assert.deepEqual(await auditVendor(vendorDir), [])
    const m = JSON.parse(readFileSync(join(vendorDir, VENDOR_MANIFEST), 'utf8')) as VendorManifest
    assert.equal(m.name, 'tether-browser')
    assert.match(m.contentSha256, /^[0-9a-f]{64}$/)
    assert.ok(`${VENDOR_BUNDLE_DIR}/${BUNDLE_SERVER}` in m.files)
    assert.ok(!(VENDOR_MANIFEST in m.files), 'the manifest does not list itself')
    const onDisk = (await walk(vendorDir)).map(f => relPath(vendorDir, f)).filter(r => r !== VENDOR_MANIFEST).sort()
    assert.deepEqual(Object.keys(m.files).sort(), onDisk)
  })

  test('a changed, missing or extra file is caught', async () => {
    const copy = join(tmp.make(), 'vendor')
    cpSync(vendorDir, copy, { recursive: true })
    writeFileSync(join(copy, VENDOR_BUNDLE_DIR, BUNDLE_SERVER), '// tampered')
    writeFileSync(join(copy, VENDOR_BUNDLE_DIR, 'extra.js'), '1')
    rmSync(join(copy, VENDOR_BUNDLE_DIR, 'node_modules', 'playwright-core', 'package.json'))
    const problems = (await auditVendor(copy)).join('\n')
    assert.match(problems, /server\.mjs: sha256 difere do manifesto/)
    assert.match(problems, /extra\.js: fora do manifesto/)
    assert.match(problems, /playwright-core\/package\.json: ausente/)
  })

  test('a vendor folder without manifest is reported', async () => {
    assert.deepEqual(await auditVendor(tmp.make()), [`${VENDOR_MANIFEST} ausente`])
  })

  test('the synchronous twin (vendoring script) agrees with the async audit', async () => {
    assert.deepEqual(walkSync(vendorDir), await walk(vendorDir))
    const m = JSON.parse(readFileSync(join(vendorDir, VENDOR_MANIFEST), 'utf8')) as VendorManifest
    assert.deepEqual(manifestOf(vendorDir).files, m.files)
  })

  test('the audit keeps the event loop answering (no synchronous fs/hash) and still fails closed on a tampered byte', async () => {
    // A temp vendor folder of ~96 MB in 12 files, with a bundle manifest that matches it.
    const dir = join(tmp.make(), 'vendor')
    const bundle = join(dir, VENDOR_BUNDLE_DIR)
    mkdirSync(bundle, { recursive: true })
    const files: Record<string, string> = {}
    const ours: Record<string, string> = {}
    for (let i = 0; i < 12; i++) {
      const name = i === 0 ? BUNDLE_SERVER : `chunk-${i}.bin`
      const data = randomBytes(8 * 1024 * 1024)
      writeFileSync(join(bundle, name), data)
      files[name] = sha256(data)
      ours[`${VENDOR_BUNDLE_DIR}/${name}`] = sha256(data)
    }
    const bm = { name: 'tether-browser', version: '0.0.0', playwrightCore: '0', commit: 'x', contentSha256: contentHashOf(files), files }
    const bmText = JSON.stringify(bm)
    writeFileSync(join(bundle, 'manifest.json'), bmText)
    ours[`${VENDOR_BUNDLE_DIR}/manifest.json`] = sha256(bmText)
    writeFileSync(join(dir, VENDOR_MANIFEST), JSON.stringify({ name: bm.name, version: bm.version, contentSha256: bm.contentSha256, files: ours }))

    let worst = 0
    let last = performance.now()
    const timer = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last - 10); last = now }, 10)
    last = performance.now()
    const problems = await auditVendor(dir)
    clearInterval(timer)
    assert.deepEqual(problems, [])
    assert.ok(worst < 50, `the loop was blocked for ${Math.round(worst)} ms during the audit`)

    // Fails closed: one flipped byte is refused.
    const target = join(bundle, 'chunk-3.bin')
    const bytes = readFileSync(target)
    bytes[100] = ~bytes[100]! & 0xff
    writeFileSync(target, bytes)
    const bad = await auditVendor(dir)
    assert.ok(bad.some(p => /chunk-3\.bin: sha256 difere do manifesto/.test(p)), bad.join(' | '))
  })
})
