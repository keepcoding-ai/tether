// `npm run app:install` / `npm run app:uninstall`: the Start Menu shortcut "tether" for the current user.
// Nothing else is installed; the app runs from this repo. The shortcut launches Electron's own exe with
// app/dist/main.cjs (no npm, no console window), so a build happens here first and must be redone by hand
// (`npm run app:build` or `npm run app:install`) after code changes: the shortcut never builds.
//   node app/install.mjs install | uninstall | read
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const require = createRequire(import.meta.url)
/** Must match APP_USER_MODEL_ID in app/main/main.ts. */
const AUMID = 'studio.codr.tether'

const action = process.argv[2]
if (!['install', 'uninstall', 'read'].includes(action)) {
  process.stderr.write('uso: node app/install.mjs install | uninstall | read\n')
  process.exit(2)
}
if (process.platform !== 'win32') {
  process.stderr.write('o atalho do Menu Iniciar só existe no Windows\n')
  process.exit(1)
}

function run(cmd, args, what) {
  const r = spawnSync(cmd, args, { stdio: 'inherit' })
  if (r.error) throw r.error
  if (r.status !== 0) { process.stderr.write(`${what}: código ${r.status}\n`); process.exit(r.status ?? 1) }
}

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
