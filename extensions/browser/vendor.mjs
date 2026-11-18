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
// LOCAL PATCH in the vendored server.mjs (both manifests rehashed by hand): WebAskUser knows the `declined` outcome ("Não
// consigo ajudar") and says so in its description and answer text. The source still lacks it: before vendoring again, carry the
// same change into packages/browser/src/core/tool-texts.ts (ask_user description, CONTROL_TEXTS.declined),
// src/host/tab-control.ts (askUser's outcome check) and src/host/adopt-mcp.ts (the answer text), or a new copy drops it.
//
// LOCAL PATCH 2 (both manifests rehashed; test/unit/ext.browser-vendor-patches.test.ts says which part a new copy lost):
//   - src/host/register-tools.ts: `tool.handler(args, { progress, signal: extra.signal })`, the MCP SDK's abort signal (aborted
//     on the client's `notifications/cancelled`); BrowserMcpTool's handler context gains `signal?: AbortSignal`.
//   - src/host/tab-control.ts: `CANCEL_ASK = 'Tether.cancelAsk'` and `cancelAsk(targetId)` (`call(...)`, errors swallowed; an
//     unknown method only marks it missing).
//   - src/host/adopt-mcp.ts (askUser): on `ctx.signal` abort, or already aborted when the request goes out, `control.cancelAsk
//     (targetId)`; the listener is removed in the `finally`. The host then answers the pending `Tether.askUser` `dismissed`.
//   - src/browser.ts (navigate): `stage('navigate')` before `goto`; the title read goes through `titleWithin(t, timeoutNow())`
//     (`stage('title')`, `inFlight('Runtime.callFunctionOn', () => page.title())` raced with the action timeout), which fails
//     `PAGE_NOT_READABLE`. playwright-core's `title()` waits for its utility world with no deadline.
//   - src/core/catalog.ts: `PAGE_NOT_READABLE` in BROWSER_ERROR_CODES (and its README entry).
//   Worth carrying too (not patched here): the same bounded read in `infoOf` (WebTabs) and `readPage` (title and
//   `locator.count()`), which also wait for the utility world without a deadline.
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
