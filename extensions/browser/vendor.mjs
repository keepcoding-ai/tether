#!/usr/bin/env node
// Vendors the Tether Browser server bundle into extensions/browser/vendor/tether-browser/ and writes
// vendor/manifest.json (sha256 of every vendored file):
//
//   node extensions/browser/vendor.mjs [--from <packages/browser/dist/tether-browser>]
//
// The bundle comes from "npm run build:tether" in packages/browser (workspace/atrium). --from defaults to
// ../../../atrium/packages/browser/dist/tether-browser relative to this repository (the atrium monorepo layout). The
// copy is refused when the folder disagrees with its own manifest.
//
// The browser hands' behaviour the tether used to patch locally in this bundle (the `declined` outcome and its note, the
// cancellation of WebAskUser as `Tether.cancelAsk`, the title and page reads within the action timeout, failing
// `PAGE_NOT_READABLE`) lives in the source now (packages/browser, branch fix/browser-hands-patches in workspace/atrium).
// test/unit/ext.browser-vendor-patches.test.ts still reads the bundle for those pieces, so a copy that drops one fails there.
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditBundle, manifestOf, VENDOR_BUNDLE_DIR, VENDOR_MANIFEST } from './vendor-rules-sync.ts'

const here = dirname(fileURLToPath(import.meta.url))
const vendorDir = join(here, 'vendor')
const args = process.argv.slice(2)
const i = args.indexOf('--from')
const from = resolve(i !== -1 && args[i + 1] ? args[i + 1] : join(here, '..', '..', '..', 'atrium', 'packages', 'browser', 'dist', 'tether-browser'))

if (!existsSync(from)) { console.error(`bundle não encontrado em ${from}: rode "npm run build:tether" em packages/browser`); process.exit(2) }
const problems = auditBundle(from)
if (problems.length) { console.error(`${from} não bate com o próprio manifesto:\n  ${problems.join('\n  ')}`); process.exit(2) }

rmSync(vendorDir, { recursive: true, force: true })
mkdirSync(vendorDir, { recursive: true })
cpSync(from, join(vendorDir, VENDOR_BUNDLE_DIR), { recursive: true })
const manifest = manifestOf(vendorDir)
writeFileSync(join(vendorDir, VENDOR_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`vendorizado: ${manifest.name} ${manifest.version} (${manifest.contentSha256.slice(0, 12)}), ${Object.keys(manifest.files).length} arquivos → ${vendorDir}`)
