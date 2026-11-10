// The everyday launch's hand-off to the cookie-fuse runtime (app/shared/cookie-runtime.ts). Runs first thing in main,
// before the single-instance lock: when the shortcut's flag is there and the copy is valid (private, every file as the
// manifest says: review N-M3), the copy is started with the
// same arguments and cwd, and this process exits; otherwise the reason goes to the app log and this launch goes on.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { cookieRuntimeDir, handoffArgs, hashTree, RUNTIME_MANIFEST, runtimeExe, runtimeVerdict, wantsHandoff } from '../shared/cookie-runtime.ts'
import { isPrivateDir } from '../../extensions/browser/private-dir.ts'

const readOrUndefined = (path: string): string | undefined => { try { return readFileSync(path, 'utf8') } catch { return undefined } }

/** True when the launch was handed to the copy (the caller exits at once). */
export function handOffToCookieRuntime(opts: { home: string, argv: readonly string[], execPath: string, electronVersion: string, log: (msg: string) => void }): boolean {
  if (process.platform !== 'win32') return false
  const dir = cookieRuntimeDir(opts.home, opts.electronVersion)
  const exe = runtimeExe(dir)
  if (!wantsHandoff(opts.argv, opts.execPath, exe)) return false
  const verdict = runtimeVerdict({
    manifestText: readOrUndefined(join(dir, RUNTIME_MANIFEST)),
    runningVersion: opts.electronVersion,
    // <home>/runtime protected and its owner's alone; the copy's folder owner-only (its entries inherited from it).
    privateDir: () => isPrivateDir(dirname(dir)) && isPrivateDir(dir, { inherited: true }),
    files: () => { try { return hashTree(dir) } catch { return undefined } },
  })
  if (!verdict.ok) {
    opts.log(`runtime com o fuse de cookies: ${verdict.reason}; seguindo no Electron de node_modules (navegador sem logins guardados). Rode npm run app:install para refazer.`)
    return false
  }
  try {
    const child = spawn(exe, handoffArgs(opts.argv), { cwd: process.cwd(), detached: true, stdio: 'ignore', env: process.env, windowsHide: false })
    child.on('error', () => {})
    if (child.pid === undefined) throw new Error('o processo não nasceu')
    child.unref()
    opts.log(`passando para o runtime com o fuse de cookies (pid ${child.pid})`)
    return true
  } catch (e) {
    opts.log(`runtime com o fuse de cookies não abriu (${e instanceof Error ? e.message : String(e)}); seguindo no Electron de node_modules`)
    return false
  }
}
