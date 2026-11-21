// What the vendored terminal without a screen is (vendor/xterm-headless/: @xterm/headless 6.0.0 from the public npm
// registry), as pure rules shared by the vendoring script (vendor.mjs), the loader and the unit test. Two pins guard it:
// the npm integrity of the tarball (checked by the script when it downloads) and our manifest (vendor/manifest.json: sha256
// of EVERY vendored file), so a changed, missing or extra file is caught when the package is loaded. Everything here is
// asynchronous (the tetherd's loop runs it): no synchronous fs in this file.
import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

export const XTERM_PACKAGE = '@xterm/headless'
export const XTERM_VERSION = '6.0.0'
export const XTERM_TARBALL = 'https://registry.npmjs.org/@xterm/headless/-/headless-6.0.0.tgz'
/** The integrity the npm registry publishes for that tarball (dist.integrity). */
export const XTERM_INTEGRITY = 'sha512-5Yj1QINYCyzrZtf8OFIHi47iQtI+0qYFPHmouEfG8dHNxbZ9Tb9YGSuLcsEwj9Z+OL75GJqPyJbyoFer80a2Hw=='
/** The folder under vendor/ that holds the package, and the file the loader imports (ESM build, no dependencies). */
export const VENDOR_PACKAGE_DIR = 'xterm-headless'
export const VENDOR_ENTRY = 'lib-headless/xterm-headless.mjs'
export const VENDOR_MANIFEST = 'manifest.json'
/**
 * What is kept of the tarball (paths inside `package/`): the code and its package.json. Maps, typings and the README stay out:
 * electron-builder.yml leaves the .md and .map files out of the packaged app, and a file listed in the manifest but missing
 * there would fail the check at the first read.
 */
export const VENDOR_KEEP: readonly string[] = ['package.json', VENDOR_ENTRY]

export interface ScreenVendorManifest {
  name: string
  version: string
  source: string
  /** The tarball's npm integrity, as the script verified it. */
  integrity: string
  /** sha256 (EOL-insensitive, see sha256Text) of every file under vendor/, by path relative to vendor/ with forward slashes (this manifest left out). */
  files: Record<string, string>
}

export const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')
/**
 * sha256 of a vendored text file with CRLF read as LF: git's autocrlf may turn the LF bytes of the vendored files into CRLF on
 * a Windows checkout (the repository's .gitattributes does not cover this folder), and the manifest must hold either way.
 */
export const sha256Text = (data: Buffer): string => sha256(Buffer.from(data.toString('latin1').replaceAll('\r\n', '\n'), 'latin1'))
export const relPath = (root: string, file: string): string => relative(root, file).split('\\').join('/')

/** The npm integrity string (`sha512-<base64>`) of a tarball. */
export const integrityOf = (tgz: Buffer): string => `sha512-${createHash('sha512').update(tgz).digest('base64')}`

export async function walk(dir: string): Promise<string[]> {
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const out: string[] = []
  for (const e of entries) {
    if (e.isDirectory()) out.push(...await walk(join(dir, e.name)))
    else out.push(join(dir, e.name))
  }
  return out
}

/** What is wrong with the vendor folder against its manifest and the pins. Empty = intact. */
export async function auditVendor(vendorDir: string): Promise<string[]> {
  let manifest: ScreenVendorManifest
  try { manifest = JSON.parse(await readFile(join(vendorDir, VENDOR_MANIFEST), 'utf8')) as ScreenVendorManifest } catch { return [`${VENDOR_MANIFEST} ausente ou ilegível`] }
  if (!manifest.files || typeof manifest.files !== 'object') return [`${VENDOR_MANIFEST} sem files`]
  const problems: string[] = []
  if (manifest.name !== XTERM_PACKAGE) problems.push(`nome ${String(manifest.name)} difere de ${XTERM_PACKAGE}`)
  if (manifest.version !== XTERM_VERSION) problems.push(`versão ${String(manifest.version)} difere da fixada ${XTERM_VERSION}`)
  if (manifest.integrity !== XTERM_INTEGRITY) problems.push('integrity do manifesto difere da fixada')
  for (const [r, hash] of Object.entries(manifest.files)) {
    const p = join(vendorDir, r)
    if (!(await stat(p).then(s => s.isFile(), () => false))) { problems.push(`${r}: ausente`); continue }
    if (sha256Text(await readFile(p)) !== hash) problems.push(`${r}: sha256 difere do manifesto`)
  }
  for (const f of await walk(vendorDir)) {
    const r = relPath(vendorDir, f)
    if (r !== VENDOR_MANIFEST && !(r in manifest.files)) problems.push(`${r}: fora do manifesto`)
  }
  if (!(`${VENDOR_PACKAGE_DIR}/${VENDOR_ENTRY}` in manifest.files)) problems.push(`${VENDOR_PACKAGE_DIR}/${VENDOR_ENTRY}: fora do manifesto`)
  return problems
}
