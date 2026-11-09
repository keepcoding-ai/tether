// One-shot esbuild build of the Electron app into app/dist (no watch mode):
//   main.cjs      Electron main process (CommonJS, node platform, electron external)
//   preload.cjs   sandboxed preload (CommonJS)
//   file-index-worker.cjs  Quick Open's file index (worker thread of main). It runs rg from node_modules/@vscode/ripgrep-<platform>-<arch>
//                 (resolved from the repo root at run time, never bundled: the app runs from this repo, no asar)
//   renderer.js   browser bundle (ESM) with xterm + dockview-core
//   dockview.css  dockview-core's stylesheet. The ESM build of dockview-core 8 ships no CSS file: the
//                 styles exist only as a string injected by its UMD bundle, so they are extracted from it.
//   palette.css   the 12 desk hues (--x-{hue}, -foreground, -text) for both schemes, generated from app/shared/palette.ts
//   renderer.css  the stylesheets Monaco's modules import (esbuild gathers CSS imported from JS into a sibling file);
//                 codicon.ttf (its icon font) is copied next to it
//   editor.worker.js  Monaco's editor web worker (classic script; app/renderer/monaco.ts points MonacoEnvironment at it)
//   json.worker.js  Monaco's JSON language service worker (settings.json schema validation and completion; same pointing)
//   dialog.js     browser bundle (ESM) of the standalone dialog window (shown before the main window exists)
//   tether.ico/icns/png the app icon (window, taskbar, Start Menu shortcut, Tether.app bundle)
//   tray.png, tray-active.png, tray-attention.png  the tray icon (32 px): plain, green dot while an agent runs, amber dot when one finished or waits for you
// The icon files are COPIED from brand/assets/app/, where `npm run brand:derive` (app/brand-derive.mjs) commits them
// derived from brand/src/light/icon.svg (rasterised by Electron offscreen) together with icons.derived.json and
// mask.json (the 24x24 currentColor monogram app/shared/brand.ts imports, from mask.svg). The build never
// rasterises: it checks those manifests against the SVGs and fails, naming the command, when they are stale.
// The Phosphor icons (@phosphor-icons/core) are inlined as strings: only the ones app/renderer/icons.ts imports.
import { build } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertBrandAssetsFresh, copyIconAssets } from './brand-icons.ts'
import { paletteCss } from './shared/palette.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const out = join(here, 'dist')

const common = { bundle: true, sourcemap: true, logLevel: 'warning', target: 'es2024' }
// src/daemon/client.ts reads import.meta.url only as spawnDaemon's default mainPath (the app always passes one); CJS has none.
const browser = { platform: 'browser', format: 'esm', loader: { '.svg': 'text', '.ttf': 'file' }, assetNames: '[name]' }
// jsonc-parser: its "main" is a UMD wrapper with dynamic require("./impl/*") that esbuild can't inline; use the ESM build.
const node = { platform: 'node', format: 'cjs', external: ['electron'], alias: { 'jsonc-parser': 'jsonc-parser/lib/esm/main.js' }, logOverride: { 'empty-import-meta': 'silent' } }

function extractDockviewCss() {
  const umd = readFileSync(join(here, '..', 'node_modules', 'dockview-core', 'dist', 'dockview-core.js'), 'utf8')
  const m = /s\.textContent = ("(?:[^"\\]|\\.)*");\s*\n\s*document\.head\.appendChild\(s\)/.exec(umd)
  if (!m) throw new Error('dockview-core: CSS string not found in dist/dockview-core.js (did the package layout change?)')
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'dockview.css'), JSON.parse(m[1]))
}

assertBrandAssetsFresh(root)
extractDockviewCss()
writeFileSync(join(out, 'palette.css'), paletteCss())
copyIconAssets(root, out)
await Promise.all([
  // TETHER_TEST_EXTENSIONS=1 (E2E only) builds in the probes of extensions/index.main.ts and index.renderer.ts; every other build drops them.
  build({ ...common, ...node, define: { __TETHER_TEST_EXTENSIONS__: String(process.env.TETHER_TEST_EXTENSIONS === '1') }, entryPoints: [join(here, 'main', 'main.ts')], outfile: join(out, 'main.cjs') }),
  build({ ...common, ...node, entryPoints: [join(here, 'preload', 'preload.ts')], outfile: join(out, 'preload.cjs') }),
  build({ ...common, ...node, entryPoints: [join(here, 'preload', 'surface-shield.ts')], outfile: join(out, 'surface-shield.cjs') }),
  build({ ...common, ...node, entryPoints: [join(here, 'main', 'file-index-worker.ts')], outfile: join(out, 'file-index-worker.cjs') }),
  build({ ...common, ...node, entryPoints: [join(here, 'main', 'file-index-shard-worker.ts')], outfile: join(out, 'file-index-shard-worker.cjs') }),
  // TETHER_TEST_EXTENSIONS=1 (E2E only) builds in the probes of extensions/index.renderer.ts; every other build drops them.
  build({ ...common, ...browser, define: { __TETHER_TEST_EXTENSIONS__: String(process.env.TETHER_TEST_EXTENSIONS === '1') }, entryPoints: [join(here, 'renderer', 'main.ts')], outfile: join(out, 'renderer.js') }),
  build({ ...common, platform: 'browser', format: 'iife', entryPoints: [join(here, '..', 'node_modules', 'monaco-editor', 'esm', 'vs', 'editor', 'editor.worker.js')], outfile: join(out, 'editor.worker.js') }),
  build({ ...common, platform: 'browser', format: 'iife', entryPoints: [join(here, '..', 'node_modules', 'monaco-editor', 'esm', 'vs', 'language', 'json', 'json.worker.js')], outfile: join(out, 'json.worker.js') }),
  build({ ...common, ...browser, entryPoints: [join(here, 'renderer', 'dialog-window.ts')], outfile: join(out, 'dialog.js') }),
])
console.log('app build ok → app/dist')
