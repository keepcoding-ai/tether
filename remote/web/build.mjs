#!/usr/bin/env node
// One-shot esbuild build of the remote web client (no watch mode), the second browser bundle of the repository, in the
// mold of app/build.mjs's renderer: `node remote/web/build.mjs [--relay <url>] [--out <dir>] [--bench]`.
//   app.js      src/main.ts and the wire module (src/remote/), ESM for the browser, no source map
//   app.css     one sheet, in this order: the app's tokens (app/renderer/tokens.css) and its 12 hues (app/shared/palette.ts),
//               the client's own screens (app.css), what the shared screen takes from the app's sheet (shell.css), the
//               shared screen's own two sheets as they are (channels.css, regency.css), and the Regency's casing on the
//               web (regency.css)
//   index.html  the template with the relay written into <meta name="tether-relay"> and the CSP's connect-src
// With `--bench` (never in what is published): bench.html and bench.js, the Regency's screen over a made-up house
// (bench/page/regency-bench.ts), under the same CSP, to look at it and to capture it.
// The relay is this origin's relay (spec 3.2: the typed code uses the origin's default relay): `--relay`, else
// REMOTE_WEB_RELAY, else ws://localhost:8787 (the relay's default port). wss:// everywhere, ws:// only for localhost.
// The build refuses a bundle that pulled in src/remote/testing.ts (the fixed-entropy seam, spec 9.1), a module of Node, of
// the daemon or of the app's main process, or that contains eval / new Function or an HTML sink (bundle.mjs).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { paletteCss } from '../../app/shared/palette.ts'
import { bundle, repoRoot, webDir as here } from './bundle.mjs'

const args = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined }
const fail = (msg) => { console.error(`remote-web:build  ${msg}`); process.exit(2) }

const relay = flag('relay') ?? process.env.REMOTE_WEB_RELAY ?? 'ws://localhost:8787'
const out = resolve(flag('out') ?? join(here, 'dist'))
const bench = args.includes('--bench')

let u
try { u = new URL(relay) } catch { fail(`relay inválido: ${relay}`) }
const allowed = u.username === '' && u.password === '' && u.pathname === '/' && u.search === '' && u.hash === ''
  && (u.protocol === 'wss:' || (u.protocol === 'ws:' && u.hostname === 'localhost'))
if (!allowed) fail(`relay recusado (wss://host[:porta], ou ws://localhost[:porta], sem caminho): ${relay}`)
const origin = `${u.protocol}//${u.host}`

mkdirSync(out, { recursive: true })

async function script(entry, name) {
  const b = await bundle(entry, join(out, name))
  if (b.refusal) fail(`${name}: ${b.refusal}`)
  writeFileSync(join(out, name), b.js)
  return b
}

const SHEETS = [
  join(repoRoot, 'app', 'renderer', 'tokens.css'),
  undefined, // the 12 hues, generated
  join(here, 'app.css'),
  join(here, 'shell.css'),
  join(repoRoot, 'extensions', 'channels', 'renderer', 'channels.css'),
  join(repoRoot, 'extensions', 'regency', 'renderer', 'regency.css'),
  join(here, 'regency.css'),
]
const css = SHEETS.map((p) => (p === undefined ? paletteCss() : readFileSync(p, 'utf8'))).join('\n')
// The page's CSP has no `img-src data:` and no font or sheet from elsewhere: a sheet that asks for one would break silently.
if (/@import\b|url\(/i.test(css)) fail('app.css pede um recurso (@import ou url()): a CSP da página não deixa')

const app = await script(join(here, 'src', 'main.ts'), 'app.js')
writeFileSync(join(out, 'app.css'), css)
const html = readFileSync(join(here, 'index.html'), 'utf8').replaceAll('%CONNECT_SRC%', origin).replaceAll('%RELAY%', origin)
if (html.includes('%')) fail('index.html com marcador sem valor')
writeFileSync(join(out, 'index.html'), html)

let benchNote = ''
if (bench) {
  const b = await script(join(here, 'bench', 'page', 'regency-bench.ts'), 'bench.js')
  writeFileSync(join(out, 'bench.html'), readFileSync(join(here, 'bench', 'bench.html'), 'utf8'))
  benchNote = `, bancada com ${Math.round(b.js.length / 1024)} KiB de bench.js`
}
console.log(`remote-web:build  ${out} (relay ${origin}, ${Math.round(app.js.length / 1024)} KiB de app.js, ${Math.round(css.length / 1024)} KiB de app.css${benchNote})`)
