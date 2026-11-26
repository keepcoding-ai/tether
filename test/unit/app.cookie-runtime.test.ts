// E15: the everyday launcher's runtime copy with the cookie fuse (app/shared/cookie-runtime.ts, app/install.mjs
// prepareCookieRuntime). The copy is made from a fake Electron dist with a fake flip: no real binary is touched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { COOKIE_RUNTIME_FLAG, cookieRuntimeDir, handoffArgs, hashTree, parseManifest, RUNTIME_MANIFEST, runtimeReusable, runtimeVerdict, wantsHandoff } from '../../app/shared/cookie-runtime.ts'
import { isPrivateDir } from '../../extensions/browser/private-dir.ts'
// @ts-expect-error app/install.mjs is plain JavaScript (no declaration file)
import { prepareCookieRuntime } from '../../app/install.mjs'

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')
const FILES = { 'tether.exe': sha('copy'), 'ffmpeg.dll': sha('dll'), 'locales/pt-BR.pak': sha('pak') }
const manifest = (over: object = {}): string => JSON.stringify({ v: 2, electronVersion: '45.1.0', fuse: 'EnableCookieEncryption', sourceSha256: sha('src'), exeSha256: sha('copy'), files: FILES, ...over })

test('cookie runtime: the folder is per Electron version under the home', () => {
  assert.equal(cookieRuntimeDir('H', '45.1.0'), join('H', 'runtime', 'electron-45.1.0-cookiefuse'))
})

test('cookie runtime: the manifest must be ours, whole', () => {
  assert.ok(parseManifest(manifest()))
  assert.equal(parseManifest(undefined), undefined)
  assert.equal(parseManifest('{'), undefined)
  assert.equal(parseManifest(manifest({ v: 1 })), undefined, 'a manifest of the executable only (before N-M3) is not enough')
  assert.equal(parseManifest(manifest({ files: undefined })), undefined)
  assert.equal(parseManifest(manifest({ files: { ...FILES, 'x.dll': 'abc' } })), undefined)
  assert.equal(parseManifest(manifest({ files: { ...FILES, 'tether.exe': sha('other') } })), undefined, 'the executable is in the file list with its hash')
  assert.equal(parseManifest(manifest({ fuse: 'RunAsNode' })), undefined)
  assert.equal(parseManifest(manifest({ exeSha256: 'abc' })), undefined)
})

test('cookie runtime: the launch verdict (absent, invalid, other version, not private, altered, ok), hashing only when needed', () => {
  let hashed = 0
  const h = (v: Record<string, string> | undefined) => () => { hashed++; return v }
  const mine = (): boolean => true
  assert.deepEqual(runtimeVerdict({ manifestText: undefined, runningVersion: '45.1.0', privateDir: mine, files: h(FILES) }), { ok: false, reason: 'ausente' })
  assert.deepEqual(runtimeVerdict({ manifestText: 'x', runningVersion: '45.1.0', privateDir: mine, files: h(FILES) }), { ok: false, reason: 'manifesto inválido' })
  assert.deepEqual(runtimeVerdict({ manifestText: manifest(), runningVersion: '46.0.0', privateDir: mine, files: h(FILES) }), { ok: false, reason: 'versão diferente' })
  assert.deepEqual(runtimeVerdict({ manifestText: manifest(), runningVersion: '45.1.0', privateDir: () => false, files: h(FILES) }), { ok: false, reason: 'pasta não privada' })
  assert.equal(hashed, 0, 'no hash before the cheap checks pass')
  assert.deepEqual(runtimeVerdict({ manifestText: manifest(), runningVersion: '45.1.0', privateDir: mine, files: h(undefined) }), { ok: false, reason: 'ausente' })
  assert.deepEqual(runtimeVerdict({ manifestText: manifest(), runningVersion: '45.1.0', privateDir: mine, files: () => { throw new Error("ENOENT: no such file or directory, scandir 'x/resources/default_app.asar'") } }), { ok: false, reason: "leitura falhou: ENOENT: no such file or directory, scandir 'x/resources/default_app.asar'" }, 'a read error is the reason, not "ausente"')
  assert.deepEqual(runtimeVerdict({ manifestText: manifest(), runningVersion: '45.1.0', privateDir: mine, files: () => { throw 'boom' } }), { ok: false, reason: 'leitura falhou: boom' })
  assert.deepEqual(runtimeVerdict({ manifestText: manifest(), runningVersion: '45.1.0', privateDir: mine, files: h({ ...FILES, 'tether.exe': sha('other') }) }), { ok: false, reason: 'executável alterado' })
  assert.deepEqual(runtimeVerdict({ manifestText: manifest(), runningVersion: '45.1.0', privateDir: mine, files: h({ ...FILES, 'ffmpeg.dll': sha('planted') }) }), { ok: false, reason: 'arquivos alterados' })
  assert.deepEqual(runtimeVerdict({ manifestText: manifest(), runningVersion: '45.1.0', privateDir: mine, files: h({ ...FILES, 'version.dll': sha('planted') }) }), { ok: false, reason: 'arquivos alterados' }, 'a file added next to the executable')
  const { 'ffmpeg.dll': _gone, ...missing } = FILES
  assert.deepEqual(runtimeVerdict({ manifestText: manifest(), runningVersion: '45.1.0', privateDir: mine, files: h(missing) }), { ok: false, reason: 'arquivos alterados' })
  assert.deepEqual(runtimeVerdict({ manifestText: manifest(), runningVersion: '45.1.0', privateDir: mine, files: h({ ...FILES }) }), { ok: true })
})

test('cookie runtime: the install keeps a copy only when source, version and every file match', () => {
  const m = parseManifest(manifest())
  assert.equal(runtimeReusable(m, { electronVersion: '45.1.0', sourceSha256: sha('src'), files: { ...FILES } }), true)
  assert.equal(runtimeReusable(m, { electronVersion: '45.1.0', sourceSha256: sha('new src'), files: FILES }), false)
  assert.equal(runtimeReusable(m, { electronVersion: '45.2.0', sourceSha256: sha('src'), files: FILES }), false)
  assert.equal(runtimeReusable(m, { electronVersion: '45.1.0', sourceSha256: sha('src'), files: undefined }), false)
  assert.equal(runtimeReusable(m, { electronVersion: '45.1.0', sourceSha256: sha('src'), files: { ...FILES, 'libEGL.dll': sha('planted') } }), false, 'a planted DLL does not survive a reinstall')
  assert.equal(runtimeReusable(undefined, { electronVersion: '45.1.0', sourceSha256: sha('src'), files: FILES }), false)
})

test('cookie runtime: hand-off only with the flag and not from the copy itself; the flag is never passed on', () => {
  const copy = join('H', 'runtime', 'electron-45.1.0-cookiefuse', 'tether.exe')
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
    writeFileSync(join(dist, 'ffmpeg.dll'), 'dll')
    const home = join(base, 'home')
    let flips = 0
    const flip = async (exe: string): Promise<void> => { flips++; appendFileSync(exe, '+fuse') }
    const brand = async (exe: string): Promise<void> => { appendFileSync(exe, '+brand') }
    const r1: { dir: string, reused: boolean } = await prepareCookieRuntime({ home, sourceDist: dist, electronVersion: '45.1.0', flip, brand })
    assert.equal(r1.reused, false)
    assert.equal(r1.dir, cookieRuntimeDir(home, '45.1.0'))
    assert.equal(readFileSync(join(r1.dir, 'tether.exe'), 'utf8'), 'factory-binary+brand+fuse')
    assert.equal(readFileSync(join(dist, 'electron.exe'), 'utf8'), 'factory-binary', 'the source is never written')
    assert.ok(existsSync(join(r1.dir, 'locales', 'pt-BR.pak')))
    const m = parseManifest(readFileSync(join(r1.dir, RUNTIME_MANIFEST), 'utf8'))!
    assert.equal(m.sourceSha256, sha('factory-binary'))
    assert.equal(m.exeSha256, sha('factory-binary+brand+fuse'))
    assert.deepEqual(m.files, { 'tether.exe': sha('factory-binary+brand+fuse'), 'ffmpeg.dll': sha('dll'), 'locales/pt-BR.pak': sha('pak') })
    assert.deepEqual(hashTree(r1.dir), m.files, 'the manifest covers every file of the copy')
    assert.equal(isPrivateDir(join(home, 'runtime')), true, "the install made <home>/runtime its owner's alone")
    assert.equal(isPrivateDir(r1.dir, { inherited: true }), true, 'and the copy inside it')
    const verdict = (): unknown => runtimeVerdict({ manifestText: readFileSync(join(r1.dir, RUNTIME_MANIFEST), 'utf8'), runningVersion: '45.1.0', privateDir: () => isPrivateDir(join(home, 'runtime')), files: () => hashTree(r1.dir) })
    assert.deepEqual(verdict(), { ok: true })

    const r2 = await prepareCookieRuntime({ home, sourceDist: dist, electronVersion: '45.1.0', flip, brand })
    assert.equal(r2.reused, true)
    assert.equal(flips, 1)

    appendFileSync(join(r1.dir, 'tether.exe'), 'tampered')
    assert.deepEqual(verdict(), { ok: false, reason: 'executável alterado' })
    const r3 = await prepareCookieRuntime({ home, sourceDist: dist, electronVersion: '45.1.0', flip, brand })
    assert.equal(r3.reused, false, 'an altered copy is redone')
    assert.equal(readFileSync(join(r3.dir, 'tether.exe'), 'utf8'), 'factory-binary+brand+fuse')

    // N-M3: a DLL altered, or one planted next to the executable, fails the launch and does not survive a reinstall.
    writeFileSync(join(r3.dir, 'ffmpeg.dll'), 'planted')
    assert.deepEqual(verdict(), { ok: false, reason: 'arquivos alterados' })
    assert.equal((await prepareCookieRuntime({ home, sourceDist: dist, electronVersion: '45.1.0', flip, brand })).reused, false)
    assert.equal(readFileSync(join(r3.dir, 'ffmpeg.dll'), 'utf8'), 'dll')
    writeFileSync(join(r3.dir, 'version.dll'), 'planted')
    assert.deepEqual(verdict(), { ok: false, reason: 'arquivos alterados' })
    assert.equal((await prepareCookieRuntime({ home, sourceDist: dist, electronVersion: '45.1.0', flip, brand })).reused, false)
    assert.equal(existsSync(join(r3.dir, 'version.dll')), false)
    assert.deepEqual(verdict(), { ok: true })

    // A new Electron version: a new copy, the old one removed.
    writeFileSync(join(dist, 'electron.exe'), 'factory-binary-46')
    const r4 = await prepareCookieRuntime({ home, sourceDist: dist, electronVersion: '46.0.0', flip, brand })
    assert.equal(r4.reused, false)
    assert.equal(existsSync(r1.dir), false, 'the copy of the old version is gone')
    assert.equal(existsSync(`${r4.dir}.tmp-${process.pid}`), false, 'no temp folder left')

    // A flip that fails leaves no half copy behind.
    const failing = async (): Promise<void> => { throw new Error('flip failed') }
    writeFileSync(join(dist, 'electron.exe'), 'factory-binary-47')
    await assert.rejects(prepareCookieRuntime({ home, sourceDist: dist, electronVersion: '47.0.0', flip: failing, brand }), /flip failed/)
    assert.equal(existsSync(cookieRuntimeDir(home, '47.0.0')), false)
    assert.equal(existsSync(`${cookieRuntimeDir(home, '47.0.0')}.tmp-${process.pid}`), false)
    assert.ok(existsSync(r4.dir), 'a failed install leaves the working copy alone')

    // A runtime folder that cannot be made private stops the install before anything is copied.
    const refuse = (): void => { throw new Error('não ficou privada') }
    await assert.rejects(prepareCookieRuntime({ home: join(base, 'other'), sourceDist: dist, electronVersion: '47.0.0', flip, brand, privatize: refuse }), /não ficou privada/)
    assert.equal(existsSync(cookieRuntimeDir(join(base, 'other'), '47.0.0')), false)
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('exe identity: the rcedit options name the product "tether" and carry the tether icon', async () => {
  const { identityOptions, EXE_ICON } = await import('../../app/exe-identity.mjs')
  const o = identityOptions({ version: '1.2.3' })
  assert.equal(o.icon, EXE_ICON)
  assert.ok(existsSync(EXE_ICON), 'the icon is the brand one that ships in the repo')
  assert.equal(o['version-string'].FileDescription, 'tether', 'the Task Manager reads FileDescription')
  assert.equal(o['version-string'].ProductName, 'tether')
  assert.equal(o['version-string'].OriginalFilename, 'tether.exe')
  assert.equal(o['product-version'], '1.2.3')
})
