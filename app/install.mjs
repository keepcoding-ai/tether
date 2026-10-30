// `npm run app:install` / `npm run app:uninstall`: the launcher "tether" for the current user.
//   Windows: a Start Menu shortcut (app/shortcut.ps1).
//   macOS:   Tether.app, a thin bundle (Info.plist + a shell launcher + tether.icns), in /Applications when the
//            user can write there (the Finder's "Applications" sidebar item is that folder), else ~/Applications.
// Nothing else is installed; the app runs from this repo. Both launchers start Electron's own binary with
// app/dist/main.cjs (no npm, no console window), so a build happens here first and must be redone by hand
// (`npm run app:build` or `npm run app:install`) after code changes: the launcher never builds.
//   node app/install.mjs install | uninstall | read [--prefix <dir>]
//   (--prefix: macOS only; without it install picks /Applications or ~/Applications, uninstall/read look in both)
import { spawnSync } from 'node:child_process'
import { accessSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const require = createRequire(import.meta.url)
/** Must match APP_USER_MODEL_ID in app/main/main.ts; on macOS it is the bundle's CFBundleIdentifier. */
export const AUMID = 'studio.codr.tether'
export const BUNDLE_NAME = 'Tether.app'
/** LaunchServices' registration tool: refreshes the Finder/Spotlight view of a bundle without a re-login. */
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'

/** Where a Tether.app may live on macOS, in lookup order: the system folder first, then the user's. */
export function macPrefixes() {
  return ['/Applications', join(homedir(), 'Applications')]
}

/** Whether the current user can create entries in `dir` (false when it does not exist). */
export function isWritableDir(dir) {
  try { accessSync(dir, constants.W_OK); return true } catch { return false }
}

/**
 * The install prefix when --prefix is not given: /Applications when writable by the user, else ~/Applications.
 * `writable` is injectable so the choice can be tested without depending on the machine.
 * Returns { prefix, reason } with the reason in the user's language, ready to print.
 */
export function defaultMacPrefix({ writable = isWritableDir } = {}) {
  const [system, user] = macPrefixes()
  if (writable(system)) return { prefix: system, reason: `${system} é gravável pelo usuário` }
  return { prefix: user, reason: `${system} não é gravável pelo usuário; usando ${user}` }
}

// ---------- macOS bundle ----------

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
/** Single-quoted for /bin/sh: safe for any path (a quote inside becomes '\''). */
const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

export function infoPlist({ version }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>tether</string>
  <key>CFBundleDisplayName</key>
  <string>tether</string>
  <key>CFBundleIdentifier</key>
  <string>${AUMID}</string>
  <key>CFBundleExecutable</key>
  <string>tether</string>
  <key>CFBundleIconFile</key>
  <string>tether</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${xml(version)}</string>
  <key>CFBundleVersion</key>
  <string>${xml(version)}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`
}

/**
 * The bundle's executable: a /bin/sh launcher that execs the Electron binary from this repo's node_modules.
 * Measured on macOS 26 (Electron 45) while choosing this shape:
 *   - a symlink Contents/MacOS/tether → Electron binary makes LaunchServices attribute the process to
 *     Tether.app (name "tether", our identifier) and dyld loads fine, but every helper (GPU, network,
 *     renderer) dies on start: the helper sandbox is written against the main bundle's path, and the helpers
 *     really live under Electron.app. Only `--no-sandbox` revives them, which is not acceptable.
 *   - `exec -a` below runs clean, but the OS still attributes the process to Electron.app (Dock and menu
 *     say "Electron"); app.setName / app.dock.setIcon in app/main/main.ts fix the menu name and the Dock icon.
 *   - copying the binary is out: the Electron Framework resolves through @rpath relative to the real bundle.
 * Launched from the Finder the PATH is minimal, so the node that ran the install (plus the usual Homebrew
 * dirs) is put in front: the main process finds tetherd's node on PATH.
 */
export function launcherScript({ electron, repo, nodeDir }) {
  return `#!/bin/sh
# tether: generated by app/install.mjs. Never builds; run \`npm run app:build\` in the repo after code changes.
cd ${sh(repo)} || exit 1
export PATH=${sh(nodeDir)}:/opt/homebrew/bin:/usr/local/bin:"$PATH"
exec -a "$0" ${sh(electron)} ${sh(join(repo, 'app', 'dist', 'main.cjs'))} "$@"
`
}

/** The CFBundleIdentifier declared in a bundle, or undefined when there is no readable Info.plist. */
export function bundleIdentifier(bundleDir) {
  let text
  try { text = readFileSync(join(bundleDir, 'Contents', 'Info.plist'), 'utf8') } catch { return undefined }
  const m = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]*)<\/string>/.exec(text)
  return m ? m[1] : undefined
}

/** Thrown when <prefix>/Tether.app exists but was not made by us: the install must not overwrite it. */
export class ForeignBundleError extends Error {
  constructor(bundleDir, identifier) {
    super(`já existe um ${bundleDir} que não é o nosso (identificador ${identifier ?? 'desconhecido'}): remova-o antes de instalar`)
    this.name = 'ForeignBundleError'
  }
}

function assertOursOrAbsent(bundleDir) {
  if (!existsSync(bundleDir)) return false
  const id = bundleIdentifier(bundleDir)
  if (id !== AUMID) throw new ForeignBundleError(bundleDir, id)
  return true
}

/**
 * Writes <prefix>/Tether.app from the pieces (electron binary path, repo root, dist dir with main.cjs and
 * tether.icns). Idempotent: the bundle is assembled in a sibling temp dir and swapped in. Returns the bundle path.
 */
export function installMacBundle({ prefix, repo, electron, dist, version, nodeDir }) {
  const bundleDir = join(prefix, BUNDLE_NAME)
  const main = join(dist, 'main.cjs')
  const icns = join(dist, 'tether.icns')
  for (const f of [main, icns]) if (!existsSync(f)) throw new Error(`falta ${f}: rode npm run app:build`)
  const existed = assertOursOrAbsent(bundleDir)
  mkdirSync(prefix, { recursive: true })
  const tmp = join(prefix, `.${BUNDLE_NAME}.tmp-${process.pid}`)
  rmSync(tmp, { recursive: true, force: true })
  try {
    mkdirSync(join(tmp, 'Contents', 'MacOS'), { recursive: true })
    mkdirSync(join(tmp, 'Contents', 'Resources'), { recursive: true })
    writeFileSync(join(tmp, 'Contents', 'Info.plist'), infoPlist({ version }))
    writeFileSync(join(tmp, 'Contents', 'PkgInfo'), 'APPL????')
    const launcher = join(tmp, 'Contents', 'MacOS', 'tether')
    writeFileSync(launcher, launcherScript({ electron, repo, nodeDir }))
    chmodSync(launcher, 0o755)
    copyFileSync(icns, join(tmp, 'Contents', 'Resources', 'tether.icns'))
    if (existed) rmSync(bundleDir, { recursive: true, force: true })
    renameSync(tmp, bundleDir)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  return bundleDir
}

/** Removes <prefix>/Tether.app when it is ours; returns whether something was removed. */
export function uninstallMacBundle({ prefix }) {
  const bundleDir = join(prefix, BUNDLE_NAME)
  if (!assertOursOrAbsent(bundleDir)) return false
  rmSync(bundleDir, { recursive: true, force: true })
  return true
}

/**
 * Removes our Tether.app from every prefix in `prefixes` (default: both macOS folders), so no orphan copy is
 * left when the default prefix changes. Returns the bundle paths removed. A foreign bundle throws, as in
 * uninstallMacBundle, after the ones before it were removed.
 */
export function uninstallMacBundles({ prefixes = macPrefixes() } = {}) {
  const removed = []
  for (const prefix of prefixes) if (uninstallMacBundle({ prefix })) removed.push(join(prefix, BUNDLE_NAME))
  return removed
}

/** readMacBundle over every prefix in `prefixes` (default: both macOS folders), in that order. */
export function readMacBundles({ prefixes = macPrefixes() } = {}) {
  return prefixes.map((prefix) => readMacBundle({ prefix }))
}

/**
 * Tells LaunchServices about a bundle just written (or removed, with `remove`): the icon and Spotlight update
 * without a re-login. Never fatal: returns undefined on success, else the failure's text for a warning.
 */
export function registerMacBundle(bundleDir, { remove = false, exec = spawnSync } = {}) {
  try {
    const r = exec(LSREGISTER, [remove ? '-u' : '-f', bundleDir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    if (r.error) return r.error.message
    if (r.status !== 0) return `código ${r.status}${r.stderr ? `: ${String(r.stderr).trim()}` : ''}`
    return undefined
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

/** What is installed at <prefix>: { installed, bundleDir, identifier, launcher } (launcher: the script's text). */
export function readMacBundle({ prefix }) {
  const bundleDir = join(prefix, BUNDLE_NAME)
  const identifier = bundleIdentifier(bundleDir)
  let launcher
  try { launcher = readFileSync(join(bundleDir, 'Contents', 'MacOS', 'tether'), 'utf8') } catch { /* absent */ }
  return { installed: identifier === AUMID, bundleDir, identifier, launcher }
}

// ---------- CLI ----------

function run(cmd, args, what) {
  const r = spawnSync(cmd, args, { stdio: 'inherit' })
  if (r.error) throw r.error
  if (r.status !== 0) { process.stderr.write(`${what}: código ${r.status}\n`); process.exit(r.status ?? 1) }
}

function cliWindows(action) {
  const ps = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'shortcut.ps1'), '-Action', action]
  if (action === 'install') {
    run(process.execPath, [join(here, 'build.mjs')], 'build do app')
    ps.push(
      '-Target', require('electron'), // the package's main export is the path to electron.exe
      '-Arguments', '"app\\dist\\main.cjs"',
      '-WorkingDirectory', root,
      '-Icon', join(root, 'app', 'dist', 'tether.ico'),
      '-Aumid', AUMID,
      '-Description', 'tether: terminais para agentes (Claude Code e soul)',
    )
  }
  run('powershell.exe', ps, 'atalho')
}

/** Prints the lsregister failure as a warning: the install/uninstall itself already succeeded. */
function warnRegister(failure, bundleDir) {
  if (failure) process.stderr.write(`aviso: não consegui registrar ${bundleDir} no LaunchServices (${failure}); o ícone pode demorar a aparecer\n`)
}

/** `prefix` is the --prefix given, or undefined: then install picks the default and uninstall/read look in both folders. */
function cliMac(action, prefix) {
  const dist = join(root, 'app', 'dist')
  try {
    if (action === 'install') {
      let reason
      if (!prefix) ({ prefix, reason } = defaultMacPrefix())
      assertOursOrAbsent(join(prefix, BUNDLE_NAME)) // refuse before spending a build on it
      run(process.execPath, [join(here, 'build.mjs')], 'build do app')
      const bundleDir = installMacBundle({
        prefix, repo: root, dist, electron: require('electron'), // the package's main export is the Electron binary's path
        version: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
        nodeDir: dirname(process.execPath),
      })
      warnRegister(registerMacBundle(bundleDir), bundleDir)
      process.stdout.write(`instalado: ${bundleDir}${reason ? ` (${reason})` : ''}\n`
        + `abra pelo Launchpad, Spotlight ou Finder (${prefix}). O app roda deste repositório: o atalho nunca builda;\n`
        + 'depois de mudar o código rode `npm run app:build` (ou `npm run app:install`).\n')
    } else if (action === 'uninstall') {
      const prefixes = prefix ? [prefix] : macPrefixes()
      const removed = uninstallMacBundles({ prefixes })
      for (const bundleDir of removed) warnRegister(registerMacBundle(bundleDir, { remove: true }), bundleDir)
      if (removed.length === 0) process.stdout.write(`nada instalado em ${prefixes.join(' nem ')}\n`)
      else process.stdout.write(`removido (${removed.length}): ${removed.join(', ')}\n`)
    } else {
      const prefixes = prefix ? [prefix] : macPrefixes()
      const found = readMacBundles({ prefixes })
      for (const r of found) {
        if (!r.installed) process.stdout.write(`nada instalado em ${r.bundleDir}${r.identifier ? ` (há um bundle alheio: ${r.identifier})` : ''}\n`)
        else process.stdout.write(`instalado: ${r.bundleDir}\n${r.launcher}`)
      }
    }
  } catch (e) {
    if (e instanceof ForeignBundleError) { process.stderr.write(`${e.message}\n`); process.exit(1) }
    throw e
  }
}

function cli(argv) {
  const action = argv[0]
  const flag = argv.indexOf('--prefix')
  const prefix = flag >= 0 ? resolve(argv[flag + 1] ?? '') : undefined
  if (!['install', 'uninstall', 'read'].includes(action) || (flag >= 0 && !argv[flag + 1])) {
    process.stderr.write('uso: node app/install.mjs install | uninstall | read [--prefix <dir>]\n')
    process.exit(2)
  }
  if (process.platform === 'win32') cliWindows(action)
  else if (process.platform === 'darwin') cliMac(action, prefix)
  else { process.stderr.write('o atalho só existe no Windows (Menu Iniciar) e no macOS (Tether.app em /Applications ou ~/Applications)\n'); process.exit(1) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) cli(process.argv.slice(2))
