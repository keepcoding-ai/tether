// What the vendored Tether Browser server is (vendor/tether-browser/, built by packages/browser `npm run build:tether`),
// as pure rules shared by the vendoring script (vendor.mjs) and the unit test. Two manifests guard it: the bundle's own
// (vendor/tether-browser/manifest.json: sha256 per file and `contentSha256`, written by its build) and ours
// (vendor/manifest.json: sha256 of EVERY vendored file, the bundle's manifest included), so a changed, missing or extra
// file is caught either way. Everything here is asynchronous (the tetherd's loop runs it); the synchronous twins for the
// vendoring script live in vendor-rules-sync.ts.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
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

/** sha256 of a file, fed in chunks as it is read, so the loop gets turns between them. */
export async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256')
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer)
  return h.digest('hex')
}

const isFile = (p: string): Promise<boolean> => stat(p).then(s => s.isFile(), () => false)

export async function walk(dir: string): Promise<string[]> {
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const out: string[] = []
  for (const e of entries) {
    if (e.isDirectory()) out.push(...await walk(join(dir, e.name)))
    else out.push(join(dir, e.name))
  }
  return out
}

export const relPath = (root: string, file: string): string => relative(root, file).split('\\').join('/')

/** The bundle's `contentSha256` recipe (packages/browser scripts/build-tether.ts). */
export const contentHashOf = (files: Record<string, string>): string => sha256(Object.entries(files).map(([f, h]) => `${f}\n${h}\n`).join(''))

/** What is wrong with a bundle folder against its own manifest: files changed, missing or extra, and the content hash. */
export async function auditBundle(bundleDir: string): Promise<string[]> {
  const path = join(bundleDir, BUNDLE_MANIFEST)
  if (!await isFile(path)) return [`${BUNDLE_MANIFEST} ausente`]
  let m: BundleManifest
  try { m = JSON.parse(await readFile(path, 'utf8')) as BundleManifest } catch { return [`${BUNDLE_MANIFEST} ilegível`] }
  if (!m.files || typeof m.files !== 'object') return [`${BUNDLE_MANIFEST} sem files`]
  const problems: string[] = []
  for (const [r, hash] of Object.entries(m.files)) {
    const p = join(bundleDir, r)
    if (!await isFile(p)) { problems.push(`${r}: ausente`); continue }
    if (await sha256File(p) !== hash) problems.push(`${r}: sha256 difere do manifesto do bundle`)
  }
  for (const f of await walk(bundleDir)) {
    const r = relPath(bundleDir, f)
    if (r !== BUNDLE_MANIFEST && !(r in m.files)) problems.push(`${r}: fora do manifesto do bundle`)
  }
  if (!(BUNDLE_SERVER in m.files)) problems.push(`${BUNDLE_SERVER}: fora do manifesto do bundle`)
  if (contentHashOf(m.files) !== m.contentSha256) problems.push('contentSha256 não bate com os arquivos do manifesto do bundle')
  return problems
}

/** What is wrong with the vendor folder (our manifest + the bundle's own). Empty = intact. Fails closed: anything unreadable is a problem. */
export async function auditVendor(vendorDir: string): Promise<string[]> {
  const path = join(vendorDir, VENDOR_MANIFEST)
  if (!await isFile(path)) return [`${VENDOR_MANIFEST} ausente`]
  let manifest: VendorManifest
  try { manifest = JSON.parse(await readFile(path, 'utf8')) as VendorManifest } catch { return [`${VENDOR_MANIFEST} ilegível`] }
  if (!manifest.files || typeof manifest.files !== 'object') return [`${VENDOR_MANIFEST} sem files`]
  const problems: string[] = []
  for (const [r, hash] of Object.entries(manifest.files)) {
    const p = join(vendorDir, r)
    if (!await isFile(p)) { problems.push(`${r}: ausente`); continue }
    if (await sha256File(p) !== hash) problems.push(`${r}: sha256 difere do manifesto`)
  }
  for (const f of await walk(vendorDir)) {
    const r = relPath(vendorDir, f)
    if (r !== VENDOR_MANIFEST && !(r in manifest.files)) problems.push(`${r}: fora do manifesto`)
  }
  const bundleDir = join(vendorDir, VENDOR_BUNDLE_DIR)
  if (!await stat(bundleDir).then(s => s.isDirectory(), () => false)) return [...problems, `${VENDOR_BUNDLE_DIR}/: ausente`]
  problems.push(...(await auditBundle(bundleDir)).map(p => `${VENDOR_BUNDLE_DIR}: ${p}`))
  return problems
}
