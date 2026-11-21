#!/usr/bin/env node
// Vendors @xterm/headless (the terminal without a screen that turns an agent's raw output into text) into
// extensions/for-agents/vendor/xterm-headless/ and writes vendor/manifest.json (sha256 of every vendored file):
//
//   node extensions/for-agents/vendor.mjs [--from <headless-6.0.0.tgz>]
//
// The tarball comes from the public npm registry (a plain GET of the pinned URL: nothing about the user or the project is
// sent). Its npm integrity is checked against the one pinned in screen/vendor-rules.ts before anything is written; --from
// takes a tarball already on disk and is checked the same way. Only the code and package.json are kept (no maps, README,
// no typings). The core has zero runtime dependencies: the package lives here, vendored, and is loaded by import() on the
// first screen read (screen/loader.ts), never listed in package.json.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { integrityOf, relPath, sha256Text, VENDOR_KEEP, VENDOR_MANIFEST, VENDOR_PACKAGE_DIR, XTERM_INTEGRITY, XTERM_PACKAGE, XTERM_TARBALL, XTERM_VERSION } from './screen/vendor-rules.ts'

const here = dirname(fileURLToPath(import.meta.url))
const vendorDir = join(here, 'vendor')
const args = process.argv.slice(2)
const i = args.indexOf('--from')
const cString = (buf, from, to) => { const s = buf.toString('utf8', from, to); const z = s.indexOf('\0'); return z === -1 ? s : s.slice(0, z) }

/** The regular files of a ustar archive (npm's tarballs): { path inside the archive: bytes }. */
function untar(tar) {
  const out = {}
  let off = 0
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512)
    if (h.every(b => b === 0)) break
    const name = cString(h, 0, 100)
    const prefix = cString(h, 345, 500)
    const size = parseInt(cString(h, 124, 136).trim() || '0', 8)
    const type = String.fromCharCode(h[156] || 48)
    off += 512
    if (type === '0') out[(prefix ? `${prefix}/` : '') + name] = tar.subarray(off, off + size)
    off += Math.ceil(size / 512) * 512
  }
  return out
}

let tgz
if (i !== -1 && args[i + 1]) tgz = readFileSync(resolve(args[i + 1]))
else {
  const res = await fetch(XTERM_TARBALL)
  if (!res.ok) { console.error(`${XTERM_TARBALL}: HTTP ${res.status}`); process.exit(2) }
  tgz = Buffer.from(await res.arrayBuffer())
}
const got = integrityOf(tgz)
if (got !== XTERM_INTEGRITY) { console.error(`o tarball não bate com a integrity fixada\n  esperado ${XTERM_INTEGRITY}\n  veio     ${got}`); process.exit(2) }

const files = untar(gunzipSync(tgz))
const pkg = JSON.parse(String(files['package/package.json'] ?? '{}'))
if (pkg.name !== XTERM_PACKAGE || pkg.version !== XTERM_VERSION) { console.error(`o package.json do tarball diz ${pkg.name}@${pkg.version}`); process.exit(2) }
for (const keep of VENDOR_KEEP) if (!files[`package/${keep}`]) { console.error(`package/${keep} ausente do tarball`); process.exit(2) }

rmSync(vendorDir, { recursive: true, force: true })
for (const keep of VENDOR_KEEP) {
  const dest = join(vendorDir, VENDOR_PACKAGE_DIR, keep)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, files[`package/${keep}`])
}

const walk = dir => readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)).flatMap(e => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
const manifestFiles = {}
for (const f of walk(vendorDir)) manifestFiles[relPath(vendorDir, f)] = sha256Text(readFileSync(f))
const manifest = { name: XTERM_PACKAGE, version: XTERM_VERSION, source: XTERM_TARBALL, integrity: XTERM_INTEGRITY, files: manifestFiles }
writeFileSync(join(vendorDir, VENDOR_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`vendorizado: ${manifest.name} ${manifest.version}, ${Object.keys(manifestFiles).length} arquivos → ${vendorDir}`)
