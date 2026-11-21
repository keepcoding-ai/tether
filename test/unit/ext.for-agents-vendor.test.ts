// The vendored terminal without a screen (extensions/for-agents/vendor/xterm-headless): it matches its manifest and the pins,
// a copy that disagrees is not loaded, it is imported once and only when asked, and the core does not depend on it.
import assert from 'node:assert/strict'
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createXtermLoader, defaultVendorDir } from '../../extensions/for-agents/screen/loader.ts'
import { auditVendor, VENDOR_ENTRY, VENDOR_PACKAGE_DIR, XTERM_INTEGRITY, XTERM_VERSION, type ScreenVendorManifest } from '../../extensions/for-agents/screen/vendor-rules.ts'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** A throwaway copy of the vendor folder, removed after `fn`. */
async function withCopy(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'tether-for-agents-vendor-'))
  try {
    await cp(defaultVendorDir(), dir, { recursive: true })
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('o pacote vendorizado da tela', () => {
  test('confere com o manifesto e com as fixações (versão 6.0.0 e integrity do npm)', async () => {
    assert.deepEqual(await auditVendor(defaultVendorDir()), [])
    const m = JSON.parse(await readFile(join(defaultVendorDir(), 'manifest.json'), 'utf8')) as ScreenVendorManifest
    assert.equal(m.name, '@xterm/headless')
    assert.equal(m.version, XTERM_VERSION)
    assert.equal(XTERM_VERSION, '6.0.0')
    assert.equal(m.integrity, XTERM_INTEGRITY)
    assert.match(m.integrity, /^sha512-/)
    assert.ok(`${VENDOR_PACKAGE_DIR}/${VENDOR_ENTRY}` in m.files)
    const pkg = JSON.parse(await readFile(join(defaultVendorDir(), VENDOR_PACKAGE_DIR, 'package.json'), 'utf8')) as { version: string; dependencies?: unknown }
    assert.equal(pkg.version, '6.0.0')
    assert.equal(pkg.dependencies, undefined, 'o pacote não traz dependências próprias')
  })

  test('arquivo alterado, ausente ou a mais: a conferência acusa, e o carregador não importa', async () => {
    await withCopy(async dir => {
      const entry = join(dir, VENDOR_PACKAGE_DIR, VENDOR_ENTRY)
      await writeFile(entry, `${await readFile(entry, 'utf8')}\n// adulterado\n`)
      assert.match((await auditVendor(dir)).join('|'), /sha256 difere/)
      let imported = 0
      const load = createXtermLoader(dir, async () => { imported++; return {} })
      await assert.rejects(load(), /não confere com o manifesto/)
      assert.equal(imported, 0)
    })
    await withCopy(async dir => {
      await rm(join(dir, VENDOR_PACKAGE_DIR, 'package.json'))
      assert.match((await auditVendor(dir)).join('|'), /package\.json: ausente/)
    })
    await withCopy(async dir => {
      await writeFile(join(dir, VENDOR_PACKAGE_DIR, 'extra.js'), 'x')
      assert.match((await auditVendor(dir)).join('|'), /extra\.js: fora do manifesto/)
    })
    await withCopy(async dir => {
      const p = join(dir, 'manifest.json')
      const m = JSON.parse(await readFile(p, 'utf8')) as ScreenVendorManifest
      await writeFile(p, JSON.stringify({ ...m, version: '6.0.1' }))
      assert.match((await auditVendor(dir)).join('|'), /versão 6\.0\.1 difere/)
    })
  })

  test('nada do que o empacotamento deixa de fora (electron-builder.yml: .md, .map) está no manifesto', async () => {
    const m = JSON.parse(await readFile(join(defaultVendorDir(), 'manifest.json'), 'utf8')) as ScreenVendorManifest
    const yml = await readFile(join(ROOT, 'electron-builder.yml'), 'utf8')
    assert.match(yml, /"!\*\*\/\*\.md"/)
    assert.match(yml, /"!\*\*\/\*\.map"/)
    for (const f of Object.keys(m.files)) assert.doesNotMatch(f, /\.(md|map)$/, f)
  })

  test('a cópia com fim de linha CRLF (autocrlf do git no Windows) continua conferindo', async () => {
    await withCopy(async dir => {
      for (const f of [join(dir, VENDOR_PACKAGE_DIR, VENDOR_ENTRY), join(dir, VENDOR_PACKAGE_DIR, 'package.json')]) {
        await writeFile(f, (await readFile(f, 'utf8')).replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'))
      }
      assert.deepEqual(await auditVendor(dir), [])
      const load = createXtermLoader(dir, p => import(pathToFileURL(p).href))
      assert.equal(typeof (await load()).Terminal, 'function')
    })
  })

  test('sem manifesto: não confere', async () => {
    await withCopy(async dir => {
      await rm(join(dir, 'manifest.json'))
      assert.match((await auditVendor(dir)).join('|'), /manifest\.json ausente/)
    })
  })

  test('importado uma vez, só quando pedido, e exporta Terminal; uma falha não fica guardada', async () => {
    let imported = 0
    const load = createXtermLoader(defaultVendorDir(), p => { imported++; return import(pathToFileURL(p).href) })
    assert.equal(imported, 0, 'criar o carregador não importa nada')
    const [a, b] = await Promise.all([load(), load()])
    assert.equal(imported, 1)
    assert.strictEqual(a, b)
    assert.equal(typeof a.Terminal, 'function')
    assert.strictEqual(await load(), a)
    assert.equal(imported, 1)

    await withCopy(async dir => {
      const entry = join(dir, VENDOR_PACKAGE_DIR, VENDOR_ENTRY)
      const good = await readFile(entry, 'utf8')
      await writeFile(entry, 'tampered')
      const again = createXtermLoader(dir, async () => ({ Terminal: class {} }))
      await assert.rejects(again(), /não confere/)
      await writeFile(entry, good)
      assert.equal(typeof (await again()).Terminal, 'function', 'a cópia consertada carrega na leitura seguinte')
    })
  })

  test('o núcleo não depende dele: fora de package.json, e o código da tela só usa fs assíncrono', async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts: Record<string, string> }
    assert.ok(!Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).some(k => k.startsWith('@xterm/headless')))
    assert.equal(pkg.scripts['for-agents:vendor'], 'node extensions/for-agents/vendor.mjs')
    const dir = join(ROOT, 'extensions', 'for-agents', 'screen')
    for (const f of (await readdir(dir)).filter(f => f.endsWith('.ts'))) {
      const src = await readFile(join(dir, f), 'utf8')
      assert.doesNotMatch(src, /from 'node:fs'/, `${f}: usa node:fs síncrono`)
      assert.doesNotMatch(src, /\w+Sync\(/, `${f}: chamada síncrona`)
      assert.doesNotMatch(src, /^import .*@xterm/m, `${f}: importa o pacote por nome`)
    }
  })
})
