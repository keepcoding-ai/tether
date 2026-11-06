#!/usr/bin/env node
// `npm run bridge:build`: the Tether Bridge from this repository's brand, end to end (f7-bridge-marca §3.1/§3.2):
//   1. brand-derive   the bridge's scripts/brand-derive.ts on brand/brand.json: the PNGs and logos the extension packs,
//                     from brand/src/{light,dark}/*.svg into brand/assets/bridge/ (COMMITTED, with .derived.json; a
//                     second run with unchanged SVGs is a no-op) and the previews in brand/assets/preview/;
//   2. build --brand  the bridge's scripts/build.ts: dist/atrium-bridge.mjs (the shared bundle) and dist/tether/
//                     {extension,build-info.json} with the tether's name, id, icons, texts and runtime defaults;
//   3. vendor         extensions/web-bridge/vendor.mjs --from <bridge>/dist: the three artifacts into vendor/ and the
//                     sha256 manifest refreshed. brand/brand.schema.json is refreshed from the bridge's copy when it moved.
// The bridge is not a dependency of the tether: its SOURCE checkout comes from `--bridge <dir>`, TETHER_BRIDGE_SRC or
// ../../chrome-extensions/bridge (bridge-source.ts). It needs its own `npm ci`; derive needs a Chromium (CHROME_PATH
// or one the bridge knows). Flags: `--bridge <dir>`, `--force` (re-derive even with unchanged SVGs).
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bridgeSourceProblems, describeBridgeSource, resolveBridgeSource } from './bridge-source.ts'
import { VENDOR_BUILD_INFO } from './vendor-rules.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const brandFile = join(root, 'brand', 'brand.json')
const schemaFile = join(root, 'brand', 'brand.schema.json')
const vendorDir = join(here, 'vendor')

const args = process.argv.slice(2)
const force = args.includes('--force')
const src = resolveBridgeSource(root, args)
const fail = (msg) => { console.error(`bridge:build  ${msg}`); process.exit(2) }

const problems = bridgeSourceProblems(src.dir)
if (problems.length) fail(`fonte do bridge inutilizável em ${describeBridgeSource(src)}:\n  ${problems.join('\n  ')}`)
if (!existsSync(brandFile)) fail(`${brandFile} ausente`)
const brand = JSON.parse(readFileSync(brandFile, 'utf8'))
console.log(`bridge:build  fonte do bridge: ${describeBridgeSource(src)}`)

/** Runs `node <script> …` inside the bridge checkout, output shown; exits with the step's code on failure. */
function step(name, script, extra) {
  console.log(`bridge:build  ${name}: node ${script} ${extra.join(' ')}`)
  const r = spawnSync(process.execPath, [join(src.dir, script), ...extra], { cwd: src.dir, stdio: 'inherit' })
  if (r.status !== 0) fail(`${name} saiu com ${r.status ?? r.signal}`)
}

step('brand-derive', 'scripts/brand-derive.ts', [brandFile, '--preview', ...(force ? ['--force'] : [])])
step('build --brand', 'scripts/build.ts', ['--brand', brandFile])

// The schema copy next to brand.json (only autocomplete in the editor) follows the bridge's scripts/brand.ts.
const bridgeSchema = join(src.dir, 'brand.schema.json')
const lf = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
if (existsSync(bridgeSchema) && (!existsSync(schemaFile) || lf(bridgeSchema) !== lf(schemaFile))) {
  copyFileSync(bridgeSchema, schemaFile)
  console.log(`bridge:build  ${relative(root, schemaFile)} atualizado da cópia do bridge`)
}

const dist = join(src.dir, 'dist')
console.log(`bridge:build  vendor: node extensions/web-bridge/vendor.mjs --from ${dist} --brand ${brand.slug}`)
const v = spawnSync(process.execPath, [join(here, 'vendor.mjs'), '--from', dist, '--brand', brand.slug], { cwd: root, stdio: 'inherit' })
if (v.status !== 0) fail(`vendor saiu com ${v.status ?? v.signal}`)

// What landed: the brand of the vendored build is this repository's.
const info = JSON.parse(readFileSync(join(vendorDir, VENDOR_BUILD_INFO), 'utf8'))
if (info.brand?.slug !== brand.slug || info.brand?.name !== brand.name) fail(`o build vendorizado leva a marca ${JSON.stringify(info.brand?.slug)} "${info.brand?.name}", não ${brand.slug} "${brand.name}"`)
console.log(`bridge:build ok → ${relative(root, vendorDir)}: "${info.brand.name}" ${info.version} (${info.extensionId}), capabilities ${Object.keys(info.brand.capabilities ?? {}).join('/') || 'nenhuma'}`)
console.log('bridge:build  commite brand/assets/bridge/, brand/assets/preview/ e extensions/web-bridge/vendor/; reinicie o tetherd para a cópia nova valer')
