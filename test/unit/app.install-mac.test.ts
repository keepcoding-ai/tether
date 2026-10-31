// The macOS side of app/install.mjs: the Tether.app bundle written into an injected prefix (never the real
// ~/Applications), with no Electron started. Skipped off macOS: the bundle shape and plutil are macOS-only.
import { test, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDirs } from './tmp.helpers.ts'
// @ts-expect-error app/install.mjs is plain JavaScript (no declaration file)
import { AUMID, BUNDLE_NAME, ForeignBundleError, defaultMacPrefix, installMacBundle, macPrefixes, readMacBundle, readMacBundles, registerMacBundle, uninstallMacBundle, uninstallMacBundles } from '../../app/install.mjs'
// @ts-expect-error app/icon.mjs is plain JavaScript (no declaration file)
import { encodeIcns, rasterize, readIcnsIndex } from '../../app/icon.mjs'

const tmp = tempDirs('tether-install-')
after(() => tmp.cleanup())

/** A fake repo: dist with main.cjs + tether.icns, and a fake Electron binary path (never executed). */
function fixture() {
  const dir = tmp.make()
  const repo = join(dir, 'repo')
  const dist = join(repo, 'app', 'dist')
  mkdirSync(dist, { recursive: true })
  writeFileSync(join(dist, 'main.cjs'), '// fake main\n')
  writeFileSync(join(dist, 'tether.icns'), encodeIcns([16, 32].map((size) => ({ size, rgba: rasterize(size) }))))
  const electron = join(dir, "Electron's.app", 'Contents', 'MacOS', 'Electron')
  const prefix = join(dir, 'Applications')
  const args = { prefix, repo, dist, electron, version: '9.9.9', nodeDir: '/opt/node/bin' }
  return { dir, prefix, repo, electron, args, bundle: join(prefix, BUNDLE_NAME) }
}

describe('install.mjs (macOS bundle)', { skip: process.platform !== 'darwin' && 'o bundle Tether.app e o plutil só existem no macOS' }, () => {
  test('install: the bundle tree, a valid Info.plist with our identifier, an executable launcher, the icns', () => {
    const f = fixture()
    assert.equal(installMacBundle(f.args), f.bundle)
    assert.deepEqual(readdirSync(join(f.bundle, 'Contents')).sort(), ['Info.plist', 'MacOS', 'PkgInfo', 'Resources'])
    const plist = join(f.bundle, 'Contents', 'Info.plist')
    const lint = spawnSync('plutil', ['-lint', plist], { encoding: 'utf8' })
    assert.equal(lint.status, 0, lint.stdout + lint.stderr)
    const text = readFileSync(plist, 'utf8')
    assert.match(text, new RegExp(`<key>CFBundleIdentifier</key>\\s*<string>${AUMID.replace(/\./g, '\\.')}</string>`))
    assert.match(text, /<key>CFBundleName<\/key>\s*<string>Tether<\/string>/)
    assert.match(text, /<key>CFBundleDisplayName<\/key>\s*<string>Tether<\/string>/)
    assert.match(text, /<key>CFBundleExecutable<\/key>\s*<string>tether<\/string>/)
    assert.match(text, /<key>CFBundleIconFile<\/key>\s*<string>tether<\/string>/)
    assert.match(text, /<key>CFBundleShortVersionString<\/key>\s*<string>9\.9\.9<\/string>/)
    assert.match(text, /<key>CFBundlePackageType<\/key>\s*<string>APPL<\/string>/)
    const launcher = join(f.bundle, 'Contents', 'MacOS', 'tether')
    assert.ok(statSync(launcher).mode & 0o111, 'launcher is executable')
    const script = readFileSync(launcher, 'utf8')
    assert.ok(script.startsWith('#!/bin/sh\n'))
    assert.ok(script.includes(`cd '${f.repo}'`), 'cwd is the repo root')
    assert.ok(script.includes(`'${f.electron.replace(/'/g, `'\\''`)}'`), 'the Electron path is quoted for sh')
    assert.ok(script.includes(`'${join(f.repo, 'app', 'dist', 'main.cjs')}'`), 'runs app/dist/main.cjs')
    assert.ok(!/npm|build\.mjs/.test(script.split('\n').filter((l) => !l.startsWith('#')).join('\n')), 'never builds, no npm')
    assert.ok(script.includes("PATH='/opt/node/bin':"), 'the installing node goes first on PATH')
    const index: { type: string }[] = readIcnsIndex(readFileSync(join(f.bundle, 'Contents', 'Resources', 'tether.icns')))
    assert.deepEqual(index.map((e) => e.type), ['icp4', 'icp5', 'ic11'])
    assert.equal(readMacBundle({ prefix: f.prefix }).installed, true)
  })

  test('install is idempotent: reinstalling over our bundle rewrites it and leaves no temp dir behind', () => {
    const f = fixture()
    installMacBundle(f.args)
    writeFileSync(join(f.bundle, 'Contents', 'stale.txt'), 'old')
    installMacBundle({ ...f.args, version: '10.0.0' })
    assert.deepEqual(readdirSync(f.prefix), [BUNDLE_NAME])
    assert.ok(!existsSync(join(f.bundle, 'Contents', 'stale.txt')), 'the old tree is replaced, not merged')
    assert.match(readFileSync(join(f.bundle, 'Contents', 'Info.plist'), 'utf8'), /10\.0\.0/)
  })

  test('a Tether.app that is not ours is refused by install and by uninstall, and left untouched', () => {
    const f = fixture()
    mkdirSync(join(f.bundle, 'Contents'), { recursive: true })
    const foreign = '<plist><dict><key>CFBundleIdentifier</key><string>com.other.app</string></dict></plist>'
    writeFileSync(join(f.bundle, 'Contents', 'Info.plist'), foreign)
    assert.throws(() => installMacBundle(f.args), ForeignBundleError)
    assert.throws(() => uninstallMacBundle({ prefix: f.prefix }), /não é o nosso/)
    assert.equal(readFileSync(join(f.bundle, 'Contents', 'Info.plist'), 'utf8'), foreign)
    assert.deepEqual(readdirSync(f.prefix), [BUNDLE_NAME], 'no temp dir left behind')
    const r = readMacBundle({ prefix: f.prefix })
    assert.equal(r.installed, false)
    assert.equal(r.identifier, 'com.other.app')
  })

  test('install refuses when the build output is missing instead of writing a broken bundle', () => {
    const f = fixture()
    assert.throws(() => installMacBundle({ ...f.args, dist: join(f.dir, 'nowhere') }), /app:build/)
    assert.ok(!existsSync(f.bundle))
  })

  test('uninstall removes only our bundle; absent is a no-op', () => {
    const f = fixture()
    assert.equal(uninstallMacBundle({ prefix: f.prefix }), false)
    installMacBundle(f.args)
    writeFileSync(join(f.prefix, 'Other.app'), 'not a dir, just a neighbour')
    assert.equal(uninstallMacBundle({ prefix: f.prefix }), true)
    assert.deepEqual(readdirSync(f.prefix), ['Other.app'])
    assert.equal(readMacBundle({ prefix: f.prefix }).installed, false)
  })

  test('default prefix: /Applications when the user can write there, else ~/Applications, each with its reason', () => {
    const [system, user] = macPrefixes()
    assert.equal(system, '/Applications')
    assert.ok(user.endsWith('/Applications') && user !== system)
    const asked: string[] = []
    const yes = defaultMacPrefix({ writable: (dir: string) => { asked.push(dir); return true } })
    assert.deepEqual(yes, { prefix: system, reason: '/Applications é gravável pelo usuário' })
    const no = defaultMacPrefix({ writable: () => false })
    assert.equal(no.prefix, user)
    assert.match(no.reason, /não é gravável/)
    assert.ok(no.reason.includes(user), 'the reason names the fallback folder')
    assert.deepEqual(asked, [system], 'only the system folder is probed')
  })

  test('uninstallMacBundles removes our copies from every prefix and names each one; read lists both', () => {
    const f = fixture()
    const other = join(f.dir, 'OtherApplications')
    installMacBundle(f.args)
    installMacBundle({ ...f.args, prefix: other })
    const prefixes = [f.prefix, other, join(f.dir, 'empty')]
    const read = readMacBundles({ prefixes })
    assert.deepEqual(read.map((r: { installed: boolean }) => r.installed), [true, true, false])
    assert.deepEqual(read.map((r: { bundleDir: string }) => r.bundleDir), prefixes.map((p) => join(p, BUNDLE_NAME)))
    const removed = uninstallMacBundles({ prefixes })
    assert.deepEqual(removed, [f.bundle, join(other, BUNDLE_NAME)])
    assert.ok(!existsSync(f.bundle) && !existsSync(join(other, BUNDLE_NAME)))
    assert.deepEqual(uninstallMacBundles({ prefixes }), [], 'second pass finds nothing')
  })

  test('registerMacBundle calls lsregister -f / -u on the bundle and turns any failure into a warning text', () => {
    const calls: { cmd: string, args: string[] }[] = []
    const ok = (cmd: string, args: string[]) => { calls.push({ cmd, args }); return { status: 0 } }
    assert.equal(registerMacBundle('/x/Tether.app', { exec: ok }), undefined)
    assert.equal(registerMacBundle('/x/Tether.app', { remove: true, exec: ok }), undefined)
    assert.deepEqual(calls.map((c) => c.args), [['-f', '/x/Tether.app'], ['-u', '/x/Tether.app']])
    assert.ok(calls.every((c) => c.cmd.endsWith('/LaunchServices.framework/Support/lsregister')))
    assert.match(registerMacBundle('/x/Tether.app', { exec: () => ({ status: 3, stderr: 'boom' }) }) as string, /código 3: boom/)
    assert.match(registerMacBundle('/x/Tether.app', { exec: () => ({ error: new Error('ENOENT') }) }) as string, /ENOENT/)
    assert.match(registerMacBundle('/x/Tether.app', { exec: () => { throw new Error('thrown') } }) as string, /thrown/)
  })
})
