// What the vendored copy of the Atrium Bridge is, as pure rules shared by the vendoring script (vendor.mjs), the main
// side (which refuses to install a corrupted copy) and the unit test: the files it holds, how a tree is hashed (the
// same recipe as chrome-extensions/bridge/scripts/build.ts `hashTree`, so `build-info.json` can be checked against the
// copied folder) and the manifest `vendor/manifest.json` that records every file's sha256.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/** The three artifacts of a brand build the vendoring copies (paths relative to vendor/). */
export const VENDOR_BUNDLE = 'atrium-bridge.mjs'
export const VENDOR_BUILD_INFO = 'build-info.json'
export const VENDOR_EXTENSION_DIR = 'extension'
export const VENDOR_MANIFEST = 'manifest.json'

/** The subset of the bridge's build-info.json the host reads. */
export interface BuildInfo {
  name: string
  version: string
  extensionId: string
  /**
   * The brand as the package carries it (f7-bridge-marca §1.3, "the package brings the default; the installation decides"):
   * `host` (who installs), `mcp.serverName` (the MCP shell's default name) and `capabilities` (the defaults for
   * config.capabilities). Absent in the plain Atrium build; the rest of the block (colors, tabs, icons, logos) is the extension's.
   */
  brand?: {
    slug: string
    name: string
    shortName?: string
    description?: string
    color?: string
    host?: { name: string; id?: string; url?: string }
    mcp?: { serverName?: string }
    capabilities?: Record<string, unknown>
  }
  bundle: { file: string; sha256: string; bytes: number }
  extension: { dir: string; sha256: string; files: number }
}

export interface VendorManifest {
  /** The bridge's version and extension id, copied from build-info.json. */
  version: string
  extensionId: string
  /** sha256 of every vendored file, by path relative to vendor/ with forward slashes (the manifest itself left out). */
  files: Record<string, string>
}

export const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')

/** Every file under `dir`, depth first, names sorted (the order the tree hash depends on). */
export function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap(e => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
}

const rel = (root: string, file: string): string => relative(root, file).split('\\').join('/')

/**
 * The bridge build's tree hash: one line per file, `relative path \0 sha256 \n`, hashed. `ignore` (relative paths,
 * forward slashes) leaves files out: the installed folder carries files the build does not (its seed, bridge.json),
 * and without them its hash is the build's again.
 */
export function hashTree(dir: string, ignore: ReadonlySet<string> = new Set()): string {
  const h = createHash('sha256')
  for (const f of walk(dir)) {
    const r = rel(dir, f)
    if (ignore.has(r)) continue
    h.update(`${r}\0${sha256(readFileSync(f))}\n`)
  }
  return h.digest('hex')
}

/** `file` relative to `root`, with forward slashes (the manifest's and the tree hash's spelling). */
export const relPath = rel

export function isBuildInfo(v: unknown): v is BuildInfo {
  const b = v as Partial<BuildInfo> | null
  return !!b && typeof b === 'object' && typeof b.version === 'string' && typeof b.extensionId === 'string' && /^[a-p]{32}$/.test(b.extensionId)
    && !!b.bundle && typeof b.bundle.sha256 === 'string' && !!b.extension && typeof b.extension.sha256 === 'string'
}

/** The manifest of a vendor folder as it is now (every file but the manifest). */
export function manifestOf(vendorDir: string, info: BuildInfo): VendorManifest {
  const files: Record<string, string> = {}
  for (const f of walk(vendorDir)) {
    const r = rel(vendorDir, f)
    if (r === VENDOR_MANIFEST) continue
    files[r] = sha256(readFileSync(f))
  }
  return { version: info.version, extensionId: info.extensionId, files }
}

/**
 * What is wrong with a vendor folder: files missing or changed against its manifest, a manifest that disagrees with
 * build-info.json, or an extension tree whose hash is not the one the bridge build recorded. Empty = intact.
 */
export function auditVendor(vendorDir: string): string[] {
  const problems: string[] = []
  const manifestPath = join(vendorDir, VENDOR_MANIFEST)
  const infoPath = join(vendorDir, VENDOR_BUILD_INFO)
  if (!existsSync(manifestPath)) return [`${VENDOR_MANIFEST} ausente`]
  if (!existsSync(infoPath)) return [`${VENDOR_BUILD_INFO} ausente`]
  let manifest: VendorManifest
  let info: unknown
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as VendorManifest } catch { return [`${VENDOR_MANIFEST} ilegível`] }
  try { info = JSON.parse(readFileSync(infoPath, 'utf8')) } catch { return [`${VENDOR_BUILD_INFO} ilegível`] }
  if (!isBuildInfo(info)) return [`${VENDOR_BUILD_INFO} inválido`]
  if (!manifest.files || typeof manifest.files !== 'object') return [`${VENDOR_MANIFEST} sem files`]
  if (manifest.extensionId !== info.extensionId) problems.push(`extensionId do manifesto (${manifest.extensionId}) difere do build-info (${info.extensionId})`)
  if (manifest.version !== info.version) problems.push(`versão do manifesto (${manifest.version}) difere do build-info (${info.version})`)
  for (const [r, hash] of Object.entries(manifest.files)) {
    const p = join(vendorDir, r)
    if (!existsSync(p) || !statSync(p).isFile()) { problems.push(`${r}: ausente`); continue }
    if (sha256(readFileSync(p)) !== hash) problems.push(`${r}: sha256 difere do manifesto`)
  }
  const extra = walk(vendorDir).map(f => rel(vendorDir, f)).filter(r => r !== VENDOR_MANIFEST && !(r in manifest.files))
  for (const r of extra) problems.push(`${r}: fora do manifesto`)
  if (!(VENDOR_BUNDLE in manifest.files)) problems.push(`${VENDOR_BUNDLE}: fora do manifesto`)
  const extDir = join(vendorDir, VENDOR_EXTENSION_DIR)
  if (!existsSync(extDir)) problems.push(`${VENDOR_EXTENSION_DIR}/: ausente`)
  else if (hashTree(extDir) !== info.extension.sha256) problems.push(`${VENDOR_EXTENSION_DIR}/: hash da árvore difere do build-info`)
  const bundle = join(vendorDir, VENDOR_BUNDLE)
  if (existsSync(bundle) && sha256(readFileSync(bundle)) !== info.bundle.sha256) problems.push(`${VENDOR_BUNDLE}: sha256 difere do build-info`)
  return problems
}
