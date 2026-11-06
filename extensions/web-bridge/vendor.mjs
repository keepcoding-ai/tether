#!/usr/bin/env node
// Vendors the Tether-branded build of the Atrium Bridge into extensions/web-bridge/vendor/:
//   vendor/extension/        the extension folder people "Load unpacked" (dist/<brand>/extension of the bridge build)
//   vendor/build-info.json   its contract: version, extension id, sha256 of the bundle and of the extension tree
//   vendor/atrium-bridge.mjs the daemon + MCP shell bundle (shared by every brand; a plain file, no dependencies)
//   vendor/manifest.json     sha256 of every vendored file, checked by the unit test and by main before installing
//
//   node extensions/web-bridge/vendor.mjs [--from <bridge dist dir>] [--brand tether]
//
// `--from` defaults to ../../chrome-extensions/bridge/dist relative to this repository (the atrium monorepo layout);
// build it first with `node scripts/build.ts --brand brands/tether.json` in chrome-extensions/bridge. The copy is
// refused when build-info.json disagrees with the files it describes.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashTree, isBuildInfo, manifestOf, sha256, VENDOR_BUILD_INFO, VENDOR_BUNDLE, VENDOR_EXTENSION_DIR, VENDOR_MANIFEST } from './vendor-rules.ts'

const here = dirname(fileURLToPath(import.meta.url))
const vendorDir = join(here, 'vendor')

const args = process.argv.slice(2)
const opt = (name, fallback) => { const i = args.indexOf(name); return i !== -1 && args[i + 1] ? args[i + 1] : fallback }
const brand = opt('--brand', 'tether')
const from = resolve(opt('--from', join(here, '..', '..', '..', '..', 'chrome-extensions', 'bridge', 'dist')))

const infoPath = join(from, brand, VENDOR_BUILD_INFO)
const extensionDir = join(from, brand, 'extension')
if (!existsSync(infoPath) || !existsSync(extensionDir)) {
  console.error(`build por marca não encontrado em ${join(from, brand)}: rode "node scripts/build.ts --brand brands/${brand}.json" no chrome-extensions/bridge, ou passe --from <dist>`)
  process.exit(2)
}
const info = JSON.parse(readFileSync(infoPath, 'utf8'))
if (!isBuildInfo(info)) { console.error(`${infoPath}: build-info inválido`); process.exit(2) }
const bundle = resolve(dirname(infoPath), info.bundle.file)
if (!existsSync(bundle)) { console.error(`bundle não encontrado: ${bundle}`); process.exit(2) }
if (sha256(readFileSync(bundle)) !== info.bundle.sha256) { console.error(`${bundle}: sha256 não bate com o build-info (build antigo?)`); process.exit(2) }
if (hashTree(extensionDir) !== info.extension.sha256) { console.error(`${extensionDir}: a árvore não bate com o build-info (build antigo?)`); process.exit(2) }

rmSync(vendorDir, { recursive: true, force: true })
mkdirSync(vendorDir, { recursive: true })
cpSync(extensionDir, join(vendorDir, VENDOR_EXTENSION_DIR), { recursive: true })
cpSync(bundle, join(vendorDir, VENDOR_BUNDLE))
// The vendored build-info points at the bundle beside it (the brand build keeps it one folder up).
writeFileSync(join(vendorDir, VENDOR_BUILD_INFO), `${JSON.stringify({ ...info, bundle: { ...info.bundle, file: VENDOR_BUNDLE }, extension: { ...info.extension, dir: VENDOR_EXTENSION_DIR } }, null, 2)}\n`)
const manifest = manifestOf(vendorDir, info)
writeFileSync(join(vendorDir, VENDOR_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`vendorizado: ${info.name} ${info.version} (${info.extensionId}), ${Object.keys(manifest.files).length} arquivos → ${vendorDir}`)
