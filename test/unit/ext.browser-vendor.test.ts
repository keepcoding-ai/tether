// The vendored Tether Browser server (extensions/browser/vendor/tether-browser/): every file matches vendor/manifest.json
// and the bundle's own manifest, nothing is left outside them, and a tampered, missing or extra file is caught.
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditVendor, BUNDLE_SERVER, VENDOR_BUNDLE_DIR, VENDOR_MANIFEST, walk, relPath, type VendorManifest } from '../../extensions/browser/vendor-rules.ts'
import { tempDirs } from './tmp.helpers.ts'

const root = fileURLToPath(new URL('../../', import.meta.url))
const vendorDir = join(root, 'extensions', 'browser', 'vendor')
const tmp = tempDirs('tether-browser-vendor-')
after(() => tmp.cleanup())

describe('browser: vendored server', () => {
  test('vendor/ is intact: every file matches the manifests and nothing is left outside them', () => {
    assert.deepEqual(auditVendor(vendorDir), [])
    const m = JSON.parse(readFileSync(join(vendorDir, VENDOR_MANIFEST), 'utf8')) as VendorManifest
    assert.equal(m.name, 'tether-browser')
    assert.match(m.contentSha256, /^[0-9a-f]{64}$/)
    assert.ok(`${VENDOR_BUNDLE_DIR}/${BUNDLE_SERVER}` in m.files)
    assert.ok(!(VENDOR_MANIFEST in m.files), 'the manifest does not list itself')
    const onDisk = walk(vendorDir).map(f => relPath(vendorDir, f)).filter(r => r !== VENDOR_MANIFEST).sort()
    assert.deepEqual(Object.keys(m.files).sort(), onDisk)
  })

  test('a changed, missing or extra file is caught', () => {
    const copy = join(tmp.make(), 'vendor')
    cpSync(vendorDir, copy, { recursive: true })
    writeFileSync(join(copy, VENDOR_BUNDLE_DIR, BUNDLE_SERVER), '// tampered')
    writeFileSync(join(copy, VENDOR_BUNDLE_DIR, 'extra.js'), '1')
    rmSync(join(copy, VENDOR_BUNDLE_DIR, 'node_modules', 'playwright-core', 'package.json'))
    const problems = auditVendor(copy).join('\n')
    assert.match(problems, /server\.mjs: sha256 difere do manifesto/)
    assert.match(problems, /extra\.js: fora do manifesto/)
    assert.match(problems, /playwright-core\/package\.json: ausente/)
  })

  test('a vendor folder without manifest is reported', () => {
    assert.deepEqual(auditVendor(tmp.make()), [`${VENDOR_MANIFEST} ausente`])
  })
})
