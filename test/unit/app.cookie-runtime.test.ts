// E15: the everyday launcher's runtime copy with the cookie fuse (app/shared/cookie-runtime.ts, app/install.mjs
// prepareCookieRuntime). The copy is made from a fake Electron dist with a fake flip: no real binary is touched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { COOKIE_RUNTIME_FLAG, cookieRuntimeDir, handoffArgs, parseManifest, RUNTIME_MANIFEST, runtimeReusable, runtimeVerdict, wantsHandoff } from '../../app/shared/cookie-runtime.ts'
// @ts-expect-error app/install.mjs is plain JavaScript (no declaration file)
import { prepareCookieRuntime } from '../../app/install.mjs'

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')
const manifest = (over: object = {}): string => JSON.stringify({ v: 1, electronVersion: '45.1.0', fuse: 'EnableCookieEncryption', sourceSha256: sha('src'), exeSha256: sha('copy'), ...over })

test('cookie runtime: the folder is per Electron version under the home', () => {
  assert.equal(cookieRuntimeDir('H', '45.1.0'), join('H', 'runtime', 'electron-45.1.0-cookiefuse'))
})

test('cookie runtime: the manifest must be ours, whole', () => {
  assert.ok(parseManifest(manifest()))
  assert.equal(parseManifest(undefined), undefined)
  assert.equal(parseManifest('{'), undefined)
  assert.equal(parseManifest(manifest({ v: 2 })), undefined)
  assert.equal(parseManifest(manifest({ fuse: 'RunAsNode' })), undefined)
  assert.equal(parseManifest(manifest({ exeSha256: 'abc' })), undefined)
})

test('cookie runtime: the launch verdict (absent, invalid, other version, altered, ok), hashing only when needed', () => {
  let hashed = 0
  const h = (v: string | undefined) => () => { hashed++; return v }
  assert.deepEqual(runtimeVerdict({ manifestText: undefined, runningVersion: '45.1.0', exeSha256: h(sha('copy')) }), { ok: false, reason: 'ausente' })
  assert.deepEqual(runtimeVerdict({ manifestText: 'x', runningVersion: '45.1.0', exeSha256: h(sha('copy')) }), { ok: false, reason: 'manifesto inválido' })
  assert.deepEqual(runtimeVerdict({ manifestText: manifest(), runningVersion: '46.0.0', exeSha256: h(sha('copy')) }), { ok: false, reason: 'versão diferente' })
  assert.equal(hashed, 0, 'no hash before the cheap checks pass')
  assert.deepEqual(runtimeVerdict({ manifestText: manifest(), runningVersion: '45.1.0', exeSha256: h(undefined) }), { ok: false, reason: 'ausente' })
  assert.deepEqual(runtimeVerdict({ manifestText: manifest(), runningVersion: '45.1.0', exeSha256: h(sha('other')) }), { ok: false, reason: 'executável alterado' })
  assert.deepEqual(runtimeVerdict({ manifestText: manifest(), runningVersion: '45.1.0', exeSha256: h(sha('copy')) }), { ok: true })
})

test('cookie runtime: the install keeps a copy only when source, version and executable all match', () => {
  const m = parseManifest(manifest())
  assert.equal(runtimeReusable(m, { electronVersion: '45.1.0', sourceSha256: sha('src'), exeSha256: sha('copy') }), true)
  assert.equal(runtimeReusable(m, { electronVersion: '45.1.0', sourceSha256: sha('new src'), exeSha256: sha('copy') }), false)
  assert.equal(runtimeReusable(m, { electronVersion: '45.2.0', sourceSha256: sha('src'), exeSha256: sha('copy') }), false)
  assert.equal(runtimeReusable(m, { electronVersion: '45.1.0', sourceSha256: sha('src'), exeSha256: undefined }), false)
  assert.equal(runtimeReusable(undefined, { electronVersion: '45.1.0', sourceSha256: sha('src'), exeSha256: sha('copy') }), false)
})

test('cookie runtime: hand-off only with the flag and not from the copy itself; the flag is never passed on', () => {
  const copy = join('H', 'runtime', 'electron-45.1.0-cookiefuse', 'electron.exe')
  const nm = join('nm', 'electron.exe')
  const argv = [nm, 'app\\dist\\main.cjs', COOKIE_RUNTIME_FLAG]
  assert.equal(wantsHandoff(argv, nm, copy), true)
  assert.equal(wantsHandoff([nm, 'app\\dist\\main.cjs'], nm, copy), false, 'tests and npm run app never hand off')
  assert.equal(wantsHandoff([copy, 'app\\dist\\main.cjs', COOKIE_RUNTIME_FLAG], copy, copy), false)
  if (process.platform === 'win32') assert.equal(wantsHandoff([copy, COOKIE_RUNTIME_FLAG], copy.toUpperCase(), copy), false, 'Windows paths compare without case')
  assert.deepEqual(handoffArgs([...argv, '--relaunched-from=12']), ['app\\dist\\main.cjs', '--relaunched-from=12'])
})

test('cookie runtime: prepareCookieRuntime copies, flips the copy only, writes the manifest, reuses, redoes when altered', async () => {
  const base = mkdtempSync(join(tmpdir(), 'tether-e15-'))
  try {
    const dist = join(base, 'dist')
    mkdirSync(join(dist, 'locales'), { recursive: true })
    writeFileSync(join(dist, 'electron.exe'), 'factory-binary')
    writeFileSync(join(dist, 'locales', 'pt-BR.pak'), 'pak')
    const home = join(base, 'home')
    let flips = 0
    const flip = async (exe: string): Promise<void> => { flips++; appendFileSync(exe, '+fuse') }
    const r1: { dir: string, reused: boolean } = await prepareCookieRuntime({ home, sourceDist: dist, electronVersion: '45.1.0', flip })
    assert.equal(r1.reused, false)
    assert.equal(r1.dir, cookieRuntimeDir(home, '45.1.0'))
    assert.equal(readFileSync(join(r1.dir, 'electron.exe'), 'utf8'), 'factory-binary+fuse')
    assert.equal(readFileSync(join(dist, 'electron.exe'), 'utf8'), 'factory-binary', 'the source is never written')
    assert.ok(existsSync(join(r1.dir, 'locales', 'pt-BR.pak')))
    const m = parseManifest(readFileSync(join(r1.dir, RUNTIME_MANIFEST), 'utf8'))!
    assert.equal(m.sourceSha256, sha('factory-binary'))
    assert.equal(m.exeSha256, sha('factory-binary+fuse'))

    const r2 = await prepareCookieRuntime({ home, sourceDist: dist, electronVersion: '45.1.0', flip })
    assert.equal(r2.reused, true)
    assert.equal(flips, 1)

    appendFileSync(join(r1.dir, 'electron.exe'), 'tampered')
    const r3 = await prepareCookieRuntime({ home, sourceDist: dist, electronVersion: '45.1.0', flip })
    assert.equal(r3.reused, false, 'an altered copy is redone')
    assert.equal(readFileSync(join(r3.dir, 'electron.exe'), 'utf8'), 'factory-binary+fuse')

    // A new Electron version: a new copy, the old one removed.
    writeFileSync(join(dist, 'electron.exe'), 'factory-binary-46')
    const r4 = await prepareCookieRuntime({ home, sourceDist: dist, electronVersion: '46.0.0', flip })
    assert.equal(r4.reused, false)
    assert.equal(existsSync(r1.dir), false, 'the copy of the old version is gone')
    assert.equal(existsSync(`${r4.dir}.tmp-${process.pid}`), false, 'no temp folder left')

    // A flip that fails leaves no half copy behind.
    const failing = async (): Promise<void> => { throw new Error('flip failed') }
    writeFileSync(join(dist, 'electron.exe'), 'factory-binary-47')
    await assert.rejects(prepareCookieRuntime({ home, sourceDist: dist, electronVersion: '47.0.0', flip: failing }), /flip failed/)
    assert.equal(existsSync(cookieRuntimeDir(home, '47.0.0')), false)
    assert.equal(existsSync(`${cookieRuntimeDir(home, '47.0.0')}.tmp-${process.pid}`), false)
    assert.ok(existsSync(r4.dir), 'a failed install leaves the working copy alone')
  } finally { rmSync(base, { recursive: true, force: true }) }
})
