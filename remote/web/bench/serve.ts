// Bench server of the remote web client: serves a built bundle (remote/web/build.mjs) as static files, for the E2E and
// to look at the page by hand. Serve mode only (no watch, no rebuild). `node remote/web/bench/serve.ts --dir <dist>
// [--port N] [--shell]` (port 0 picks a free one); prints one JSON line `{"event":"web.listening","port":N}` on stdout.
// It knows a closed set of files (index.html, app.js, app.css, and the bench page of a `--bench` build: bench.html,
// bench.js; with `--shell`, the service worker, the manifest and the icons), sends them with `no-store`, and answers 404 to anything else (a file of the set that the folder does not
// have included): no directory listing, no path outside the folder.
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined }
const dir = resolve(flag('dir') ?? join(import.meta.dirname, '..', 'dist'))
const port = Number(flag('port') ?? 8780)
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('porta inválida')

const FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  '/bench.html': { file: 'bench.html', type: 'text/html; charset=utf-8' },
  '/bench.js': { file: 'bench.js', type: 'text/javascript; charset=utf-8' },
}

// `--shell`: the installable shell too (the service worker, the manifest, the icons), for a bench that needs a service
// worker (Web Push, RR4 4.4). Off by default: the other benches keep a page with no worker in front of it.
const SHELL: Record<string, { file: string; type: string }> = {
  '/sw.js': { file: 'sw.js', type: 'text/javascript; charset=utf-8' },
  '/manifest.webmanifest': { file: 'manifest.webmanifest', type: 'application/manifest+json' },
  '/icons/icon.svg': { file: 'icons/icon.svg', type: 'image/svg+xml' },
  ...Object.fromEntries(['apple-touch-icon', 'icon-192', 'icon-512', 'icon-maskable-512'].map((n) => [`/icons/${n}.png`, { file: `icons/${n}.png`, type: 'image/png' }])),
}
const served = args.includes('--shell') ? { ...FILES, ...SHELL } : FILES

const server = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname
  const f = Object.hasOwn(served, path) ? served[path] : undefined
  if ((req.method !== 'GET' && req.method !== 'HEAD') || !f) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('não encontrado'); return }
  let body: Buffer
  try { body = readFileSync(join(dir, f.file)) } catch { res.writeHead(404); res.end(); return }
  res.writeHead(200, {
    'content-type': f.type, 'content-length': body.length, 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
  })
  res.end(req.method === 'HEAD' ? undefined : body)
})

server.listen(port, 'localhost', () => {
  const a = server.address()
  process.stdout.write(`${JSON.stringify({ event: 'web.listening', port: typeof a === 'object' && a ? a.port : port, dir })}\n`)
})
const stop = (): void => { server.close(() => process.exit(0)) }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
