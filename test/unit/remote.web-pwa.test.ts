// The remote web client as an installed app: the manifest, the icons, and the service worker that keeps the shell and nothing
// else. Proven on the real output of the build (remote/web/build.mjs into a temporary folder) and on the worker's pure rule.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { cacheName, shellKey } from '../../remote/web/src/shell-cache.ts'
// @ts-expect-error a plain .mjs module of the build, with no types
import { webDir } from '../../remote/web/bundle.mjs'

const dir = webDir as string
let out = ''

function walk(root: string, at = root): string[] {
  return readdirSync(at).flatMap(n => {
    const p = join(at, n)
    return statSync(p).isDirectory() ? walk(root, p) : [relative(root, p).replaceAll('\\', '/')]
  })
}

before(() => {
  out = mkdtempSync(join(tmpdir(), 'tether-web-pwa-'))
  execFileSync(process.execPath, [join(dir, 'build.mjs'), '--out', out], { stdio: 'pipe' })
})
after(() => { rmSync(out, { recursive: true, force: true }) })

const listOf = (sw: string): string[] => JSON.parse(/\[("[^"\]]+"(?:,\s*"[^"\]]+")*)\]/.exec(sw)?.[0] ?? '[]') as string[]

describe('the service worker of the shell', () => {
  test('its list is the files of the build and nothing else (sw.js itself is the browser\'s)', () => {
    const sw = readFileSync(join(out, 'sw.js'), 'utf8')
    const files = listOf(sw)
    assert.deepEqual([...files].sort(), walk(out).filter(f => f !== 'sw.js').sort())
    assert.deepEqual(files, ['app.css', 'app.js', 'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/icon.svg', 'index.html', 'manifest.webmanifest'])
    for (const f of files) assert.doesNotMatch(f, /bench|^\/|\.\./)
  })

  test('the version is the hash of the shell: same build, same version; a changed file, another', () => {
    const version = (s: string): string | undefined => /"([0-9a-f]{12})"/.exec(s)?.[1]
    const v = version(readFileSync(join(out, 'sw.js'), 'utf8'))
    assert.match(v ?? '', /^[0-9a-f]{12}$/)
    assert.equal(cacheName('abc'), 'tether-shell-abc')
    const again = mkdtempSync(join(tmpdir(), 'tether-web-pwa-'))
    try {
      execFileSync(process.execPath, [join(dir, 'build.mjs'), '--out', again], { stdio: 'pipe' })
      assert.equal(version(readFileSync(join(again, 'sw.js'), 'utf8')), v)
      const other = mkdtempSync(join(tmpdir(), 'tether-web-pwa-'))
      try {
        execFileSync(process.execPath, [join(dir, 'build.mjs'), '--out', other, '--relay', 'wss://other.example'], { stdio: 'pipe' })
        assert.notEqual(version(readFileSync(join(other, 'sw.js'), 'utf8')), v)
      } finally { rmSync(other, { recursive: true, force: true }) }
    } finally { rmSync(again, { recursive: true, force: true }) }
  })

  test('only a GET of a file of the shell, in the scope and on the origin, is its own', () => {
    const files = ['index.html', 'app.js', 'icons/icon.svg']
    const scope = 'https://tether.example/app/'
    const key = (method: string, url: string): string | undefined => shellKey(method, url, scope, files)
    assert.equal(key('GET', 'https://tether.example/app/'), 'index.html')
    assert.equal(key('GET', 'https://tether.example/app/?c=c_abc&tab=tether'), 'index.html')
    assert.equal(key('GET', 'https://tether.example/app/index.html'), 'index.html')
    assert.equal(key('GET', 'https://tether.example/app/app.js'), 'app.js')
    assert.equal(key('GET', 'https://tether.example/app/icons/icon.svg'), 'icons/icon.svg')
    for (const [m, u] of [
      ['POST', 'https://tether.example/app/app.js'],
      ['GET', 'https://tether.example/app/sw.js'],
      ['GET', 'https://tether.example/app/other.js'],
      ['GET', 'https://tether.example/app/../secret'],
      ['GET', 'https://tether.example/app.js'],
      ['GET', 'https://tether.example/'],
      ['GET', 'https://evil.example/app/app.js'],
      ['GET', 'wss://tether.example/app/app.js'],
      ['GET', 'not a url'],
    ] as const) assert.equal(key(m, u), undefined, `${m} ${u}`)
  })

  test('the worker takes over on the next visit, never under a screen, and never keeps what is not the shell', () => {
    const src = readFileSync(join(dir, 'src', 'sw.ts'), 'utf8').replace(/\/\/.*$/gm, '')
    assert.doesNotMatch(src, /skipWaiting|clients\s*\.\s*claim|\.addAll\s*\(|importScripts|WebSocket|indexedDB/)
    // The one write into a cache is the install's, of the listed files.
    assert.equal(src.match(/\.put\s*\(/g)?.length, 1)
  })
})

describe('the manifest and the install', () => {
  const manifest = (): Record<string, unknown> => JSON.parse(readFileSync(join(out, 'manifest.webmanifest'), 'utf8')) as Record<string, unknown>

  test('has what installs it on Android and on iPhone', () => {
    const m = manifest()
    assert.equal(m.name, 'Tether')
    assert.equal(m.short_name, 'Tether')
    assert.equal(m.display, 'standalone')
    assert.equal(m.start_url, './')
    assert.equal(m.scope, './')
    assert.match(String(m.theme_color), /^#[0-9a-f]{6}$/i)
    assert.match(String(m.background_color), /^#[0-9a-f]{6}$/i)
    // The colours are the screen's dark theme (app/renderer/tokens.css: --bg).
    assert.equal(m.theme_color, '#1b1b1f')
    const icons = m.icons as { src: string; sizes: string; type: string; purpose: string }[]
    const has = (sizes: string, purpose: string): boolean => icons.some(i => i.sizes === sizes && i.purpose === purpose && i.type === 'image/png')
    assert.ok(has('192x192', 'any') && has('512x512', 'any') && has('512x512', 'maskable'))
    const built = new Set(walk(out))
    for (const i of icons) assert.ok(built.has(i.src), `${i.src} is in the build`)
  })

  test('the icons are real PNGs of the size they say', () => {
    for (const [file, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['icon-maskable-512.png', 512], ['apple-touch-icon.png', 180]] as const) {
      const b = readFileSync(join(out, 'icons', file))
      assert.equal(b.subarray(1, 4).toString('latin1'), 'PNG')
      assert.equal(b.readUInt32BE(16), size)
      assert.equal(b.readUInt32BE(20), size)
    }
  })

  test('the page links the manifest and the iOS metas, and the CSP stays strict', () => {
    const html = readFileSync(join(out, 'index.html'), 'utf8')
    assert.match(html, /<link rel="manifest" href="manifest\.webmanifest">/)
    assert.match(html, /<link rel="apple-touch-icon" href="icons\/apple-touch-icon\.png">/)
    assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes">/)
    assert.match(html, /<meta name="viewport"[^>]*viewport-fit=cover/)
    const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? ''
    assert.match(csp, /worker-src 'self'(;|$)/)
    assert.match(csp, /manifest-src 'self'(;|$)/)
    assert.match(csp, /default-src 'none'/)
    assert.doesNotMatch(csp, /unsafe-|data:|\*/)
    // Everything the page asks for is in the shell the worker keeps.
    const files = new Set(listOf(readFileSync(join(out, 'sw.js'), 'utf8')))
    for (const href of [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map(x => x[1] as string)) assert.ok(files.has(href), `${href} is in the shell`)
  })
})
