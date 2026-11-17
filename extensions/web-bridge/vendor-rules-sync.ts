// SYNCHRONOUS twins of the rules in vendor-rules.ts, for the vendoring script (vendor.mjs) and tests only: nothing the
// tetherd loads may import this file (test/unit/arch.sync-ratchet.test.ts counts synchronous fs in the daemon's graph).
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { relPath, sha256, VENDOR_MANIFEST, type BuildInfo, type VendorManifest } from './vendor-rules.ts'

export { isBuildInfo, sha256, VENDOR_BUILD_INFO, VENDOR_BUNDLE, VENDOR_EXTENSION_DIR, VENDOR_MANIFEST } from './vendor-rules.ts'

/** Every file under `dir`, depth first, names sorted (the order the tree hash depends on). */
export function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap(e => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
}

/**
 * The bridge build's tree hash: one line per file, `relative path \0 sha256 \n`, hashed. `ignore` (relative paths,
 * forward slashes) leaves files out: the installed folder carries files the build does not (its seed, bridge.json),
 * and without them its hash is the build's again.
 */
export function hashTree(dir: string, ignore: ReadonlySet<string> = new Set()): string {
  const h = createHash('sha256')
  for (const f of walk(dir)) {
    const r = relPath(dir, f)
    if (ignore.has(r)) continue
    h.update(`${r}\0${sha256(readFileSync(f))}\n`)
  }
  return h.digest('hex')
}

/** The manifest of a vendor folder as it is now (every file but the manifest). */
export function manifestOf(vendorDir: string, info: BuildInfo): VendorManifest {
  const files: Record<string, string> = {}
  for (const f of walk(vendorDir)) {
    const r = relPath(vendorDir, f)
    if (r === VENDOR_MANIFEST) continue
    files[r] = sha256(readFileSync(f))
  }
  return { version: info.version, extensionId: info.extensionId, files }
}

