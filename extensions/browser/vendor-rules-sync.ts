// SYNCHRONOUS twins of the rules in vendor-rules.ts, for the vendoring script (vendor.mjs) and tests only: nothing the
// tetherd loads may import this file (test/unit/arch.sync-ratchet.test.ts counts synchronous fs in the daemon's graph).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { BUNDLE_MANIFEST, BUNDLE_SERVER, contentHashOf, relPath, sha256, VENDOR_BUNDLE_DIR, VENDOR_MANIFEST, type BundleManifest, type VendorManifest } from './vendor-rules.ts'

export { VENDOR_BUNDLE_DIR, VENDOR_MANIFEST }

export function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap(e => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
}

/** The manifest of a vendor folder as it is now. */
export function manifestOf(vendorDir: string): VendorManifest {
  const bundle = JSON.parse(readFileSync(join(vendorDir, VENDOR_BUNDLE_DIR, BUNDLE_MANIFEST), 'utf8')) as BundleManifest
  const files: Record<string, string> = {}
  for (const f of walk(vendorDir)) {
    const r = relPath(vendorDir, f)
    if (r === VENDOR_MANIFEST) continue
    files[r] = sha256(readFileSync(f))
  }
  return { name: bundle.name, version: bundle.version, contentSha256: bundle.contentSha256, files }
}

/** What is wrong with a bundle folder against its own manifest: files changed, missing or extra, and the content hash. */
export function auditBundle(bundleDir: string): string[] {
  const path = join(bundleDir, BUNDLE_MANIFEST)
  if (!existsSync(path)) return [`${BUNDLE_MANIFEST} ausente`]
  let m: BundleManifest
  try { m = JSON.parse(readFileSync(path, 'utf8')) as BundleManifest } catch { return [`${BUNDLE_MANIFEST} ilegível`] }
  if (!m.files || typeof m.files !== 'object') return [`${BUNDLE_MANIFEST} sem files`]
  const problems: string[] = []
  for (const [r, hash] of Object.entries(m.files)) {
    const p = join(bundleDir, r)
    if (!existsSync(p) || !statSync(p).isFile()) { problems.push(`${r}: ausente`); continue }
    if (sha256(readFileSync(p)) !== hash) problems.push(`${r}: sha256 difere do manifesto do bundle`)
  }
  for (const f of walk(bundleDir)) {
    const r = relPath(bundleDir, f)
    if (r !== BUNDLE_MANIFEST && !(r in m.files)) problems.push(`${r}: fora do manifesto do bundle`)
  }
  if (!(BUNDLE_SERVER in m.files)) problems.push(`${BUNDLE_SERVER}: fora do manifesto do bundle`)
  if (contentHashOf(m.files) !== m.contentSha256) problems.push('contentSha256 não bate com os arquivos do manifesto do bundle')
  return problems
}

/** What is wrong with the vendor folder (our manifest + the bundle's own). Empty = intact. */
export function auditVendor(vendorDir: string): string[] {
  const path = join(vendorDir, VENDOR_MANIFEST)
  if (!existsSync(path)) return [`${VENDOR_MANIFEST} ausente`]
  let manifest: VendorManifest
  try { manifest = JSON.parse(readFileSync(path, 'utf8')) as VendorManifest } catch { return [`${VENDOR_MANIFEST} ilegível`] }
  if (!manifest.files || typeof manifest.files !== 'object') return [`${VENDOR_MANIFEST} sem files`]
  const problems: string[] = []
  for (const [r, hash] of Object.entries(manifest.files)) {
    const p = join(vendorDir, r)
    if (!existsSync(p) || !statSync(p).isFile()) { problems.push(`${r}: ausente`); continue }
    if (sha256(readFileSync(p)) !== hash) problems.push(`${r}: sha256 difere do manifesto`)
  }
  for (const f of walk(vendorDir)) {
    const r = relPath(vendorDir, f)
    if (r !== VENDOR_MANIFEST && !(r in manifest.files)) problems.push(`${r}: fora do manifesto`)
  }
  const bundleDir = join(vendorDir, VENDOR_BUNDLE_DIR)
  if (!existsSync(bundleDir)) return [...problems, `${VENDOR_BUNDLE_DIR}/: ausente`]
  problems.push(...auditBundle(bundleDir).map(p => `${VENDOR_BUNDLE_DIR}: ${p}`))
  return problems
}
