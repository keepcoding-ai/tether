// One-shot esbuild build of the Electron app into app/dist (no watch mode):
//   main.cjs      Electron main process (CommonJS, node platform, electron external)
//   preload.cjs   sandboxed preload (CommonJS)
//   renderer.js   browser bundle (ESM) with xterm + dockview-core
//   dockview.css  dockview-core's stylesheet. The ESM build of dockview-core 8 ships no CSS file: the
//                 styles exist only as a string injected by its UMD bundle, so they are extracted from it.
//   tether.ico/png the app icon (window, taskbar, Start Menu shortcut), drawn by app/icon.mjs
import { build } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeIcons } from './icon.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, 'dist')

const common = { bundle: true, sourcemap: true, logLevel: 'warning', target: 'es2024' }
// src/daemon/client.ts reads import.meta.url only as spawnDaemon's default mainPath (the app always passes one); CJS has none.
const node = { platform: 'node', format: 'cjs', external: ['electron'], logOverride: { 'empty-import-meta': 'silent' } }

function extractDockviewCss() {
  const umd = readFileSync(join(here, '..', 'node_modules', 'dockview-core', 'dist', 'dockview-core.js'), 'utf8')
  const m = /s\.textContent = ("(?:[^"\\]|\\.)*");\s*\n\s*document\.head\.appendChild\(s\)/.exec(umd)
  if (!m) throw new Error('dockview-core: CSS string not found in dist/dockview-core.js (did the package layout change?)')
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'dockview.css'), JSON.parse(m[1]))
}

extractDockviewCss()
writeIcons(out)
await Promise.all([
  build({ ...common, ...node, entryPoints: [join(here, 'main', 'main.ts')], outfile: join(out, 'main.cjs') }),
  build({ ...common, ...node, entryPoints: [join(here, 'preload', 'preload.ts')], outfile: join(out, 'preload.cjs') }),
  build({ ...common, entryPoints: [join(here, 'renderer', 'main.ts')], outfile: join(out, 'renderer.js'), platform: 'browser', format: 'esm' }),
])
console.log('app build ok → app/dist')
