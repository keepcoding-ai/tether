#!/usr/bin/env node
// One-shot esbuild build of the remote web client (no watch mode), the second browser bundle of the repository, in the
// mold of app/build.mjs's renderer: `node remote/web/build.mjs [--relay <url>] [--out <dir>]`.
//   app.js      src/main.ts and the wire module (src/remote/), ESM for the browser, no source map
//   app.css     copied as is
//   index.html  the template with the relay written into <meta name="tether-relay"> and the CSP's connect-src
// The relay is this origin's relay (spec 3.2: the typed code uses the origin's default relay): `--relay`, else
// REMOTE_WEB_RELAY, else ws://localhost:8787 (the relay's default port). wss:// everywhere, ws:// only for localhost.
// The build refuses a bundle that pulled in src/remote/testing.ts (the fixed-entropy seam, spec 9.1) or that contains
// eval / new Function.
import { build } from 'esbuild'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined }
const fail = (msg) => { console.error(`remote-web:build  ${msg}`); process.exit(2) }

const relay = flag('relay') ?? process.env.REMOTE_WEB_RELAY ?? 'ws://localhost:8787'
const out = resolve(flag('out') ?? join(here, 'dist'))

let u
try { u = new URL(relay) } catch { fail(`relay inválido: ${relay}`) }
const allowed = u.username === '' && u.password === '' && u.pathname === '/' && u.search === '' && u.hash === ''
  && (u.protocol === 'wss:' || (u.protocol === 'ws:' && u.hostname === 'localhost'))
if (!allowed) fail(`relay recusado (wss://host[:porta], ou ws://localhost[:porta], sem caminho): ${relay}`)
const origin = `${u.protocol}//${u.host}`

mkdirSync(out, { recursive: true })
const result = await build({
  bundle: true, platform: 'browser', format: 'esm', target: 'es2022', logLevel: 'warning', sourcemap: false,
  legalComments: 'none', metafile: true, charset: 'utf8',
  entryPoints: [join(here, 'src', 'main.ts')], outfile: join(out, 'app.js'),
})
const inputs = Object.keys(result.metafile.inputs)
if (inputs.some((p) => /src[\\/]remote[\\/]testing\.ts$/.test(p))) fail('o bundle puxou src/remote/testing.ts (costura de teste)')
if (inputs.some((p) => /(^|[\\/])node:/.test(p))) fail('o bundle puxou um módulo do Node')
const js = readFileSync(join(out, 'app.js'), 'utf8')
if (/\beval\s*\(|new\s+Function\s*\(/.test(js)) fail('o bundle tem eval ou new Function')

copyFileSync(join(here, 'app.css'), join(out, 'app.css'))
const html = readFileSync(join(here, 'index.html'), 'utf8').replaceAll('%CONNECT_SRC%', origin).replaceAll('%RELAY%', origin)
if (html.includes('%')) fail('index.html com marcador sem valor')
writeFileSync(join(out, 'index.html'), html)
console.log(`remote-web:build  ${out} (relay ${origin}, ${Math.round(js.length / 1024)} KiB de app.js)`)
