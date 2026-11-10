// What the vendored Tether Browser server is (vendor/tether-browser/, built by packages/browser `npm run build:tether`),
// as pure rules shared by the vendoring script (vendor.mjs) and the unit test. Two manifests guard it: the bundle's own
// (vendor/tether-browser/manifest.json: sha256 per file and `contentSha256`, written by its build) and ours
// (vendor/manifest.json: sha256 of EVERY vendored file, the bundle's manifest included), so a changed, missing or extra
// file is caught either way.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

export const VENDOR_BUNDLE_DIR = 'tether-browser'
export const VENDOR_MANIFEST = 'manifest.json'
export const BUNDLE_MANIFEST = 'manifest.json'
export const BUNDLE_SERVER = 'server.mjs'

/** The part of the bundle's manifest the host reads. */
export interface BundleManifest {
  name: string
  version: string
  playwrightCore: string
  commit: string
  contentSha256: string
  files: Record<string, string>
}

export interface VendorManifest {
  /** The bundle's name, version and content hash, copied from its manifest. */
  name: string
  version: string
  contentSha256: string
  /** sha256 of every file under vendor/, by path relative to vendor/ with forward slashes (this manifest left out). */
  files: Record<string, string>
}

export const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')

export function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap(e => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
}

export const relPath = (root: string, file: string): string => relative(root, file).split('\\').join('/')

/** The bundle's `contentSha256` recipe (packages/browser scripts/build-tether.ts). */
export const contentHashOf = (files: Record<string, string>): string => sha256(Object.entries(files).map(([f, h]) => `${f}\n${h}\n`).join(''))

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
