// The cookie-runtime hash INSIDE Electron: `node:fs` there reads a `.asar` as a folder and the walk of a runtime copy dies on
// `resources/default_app.asar`; with Electron's `original-fs` the hash is the one plain Node computes. Runs the real
// node_modules electron binary (a hidden-less main process, no window) over a temporary folder with an `.asar` file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { hashTree } from '../../app/shared/cookie-runtime.ts'

const electronPath = createRequire(import.meta.url)('electron') as string

test('cookie runtime: hashTree with original-fs inside Electron equals the Node hash over a folder with an .asar file', { timeout: 120_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'tether-cookie-asar-'))
  try {
    const dir = join(root, 'copy')
    mkdirSync(join(dir, 'resources'), { recursive: true })
    mkdirSync(join(dir, 'locales'))
    // Not a valid asar archive: exactly what makes the shimmed fs fail, as default_app.asar does in a real copy.
    writeFileSync(join(dir, 'resources', 'default_app.asar'), Buffer.from('not really an archive, just bytes'))
    writeFileSync(join(dir, 'tether.exe'), 'exe')
    writeFileSync(join(dir, 'locales', 'pt-BR.pak'), 'pak')
    const expected = hashTree(dir)
    assert.ok(expected['resources/default_app.asar'], 'the plain Node walk covers the .asar file')

    const out = join(root, 'out.json')
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const r = spawnSync(electronPath, [join(import.meta.dirname, 'fixtures', 'cookie-runtime-hash.electron.mjs'), dir, out], { env, encoding: 'utf8', timeout: 90_000 })
    assert.equal(r.status, 0, `electron exited ${r.status}: ${r.stderr}`)
    const got = JSON.parse(readFileSync(out, 'utf8')) as { electron: string, original: { files?: Record<string, string>, error?: string }, shim: { files?: Record<string, string>, error?: string } }
    assert.ok(got.electron, 'it ran inside Electron')
    assert.equal(got.original.error, undefined, 'original-fs reads the .asar as a file')
    assert.deepEqual(got.original.files, expected, 'same hashes as plain Node')
    console.log(`electron ${got.electron}: default fs -> ${got.shim.error ?? 'also read it (the shim did not bite on this folder)'}`)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
