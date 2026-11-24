// Shared bits of the app E2E tests: how the Electron main process and the daemon are killed, by identity only.
import { spawnSync } from 'node:child_process'
import { _electron, type ElectronApplication } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { guardAppEnv } from './app-env.ts'

// The single point of every test app launch: every app E2E imports this module (arch guard: app-env.guard.test.ts), and
// playwright's `_electron` is one shared object, so its launch passes through `guardAppEnv` whoever calls it.
const launchable = _electron as unknown as { launch: (o: { env?: Record<string, string> } & Record<string, unknown>) => Promise<ElectronApplication>; __guarded?: boolean }
if (!launchable.__guarded) {
  const original = launchable.launch.bind(_electron)
  launchable.launch = o => original({ ...o, env: guardAppEnv(o.env ?? { ...process.env } as Record<string, string>) })
  launchable.__guarded = true
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/** How long a hung main gets to answer `process.pid` before the launcher we own is torn down instead. */
const EVALUATE_TIMEOUT_MS = 10_000
/** How long the dead main's helpers (GPU, renderer, network) get to leave: they hold Chromium's single-instance lock. */
const HELPERS_EXIT_MS = 15_000

/** The app's main process, claimed by identity (its command line names this checkout's app bundle). */
export async function claimElectron(app: ElectronApplication, root: string): Promise<Owned> {
  const mainPid = await Promise.race([
    app.evaluate(() => process.pid),
    sleep(EVALUATE_TIMEOUT_MS).then(() => { throw new Error(`electron main did not answer in ${EVALUATE_TIMEOUT_MS} ms (hung before its window?)`) }),
  ])
  return claim(mainPid, { cmdIncludes: root, what: 'electron main' })
}

/**
 * Kills the Electron main process by identity. On Windows the process Playwright spawns is a launcher whose
 * child is the real main process (the one with the window and the pipe connection), so the PID is read from
 * inside Electron and claimed before the kill; the launcher is killed through its own ChildProcess handle
 * (never by pid) when it does not leave on its own. `tree` = `taskkill /T`, what "End task" does: the daemon
 * must survive it (test/e2e/app.tree.test.ts). Also used for the final cleanup: `app.close()` would wait for
 * the whole process tree, and a daemon that had inherited Playwright's CDP pipe used to keep it open.
 *
 * A main that never answers (hung before creating its window) cannot be claimed: then the launcher, which is
 * ours (Playwright spawned it and still holds the handle), is killed with its tree so nothing lingers.
 *
 * After the kill the dead main's helpers are given time to exit: they keep Chromium's single-instance lock
 * file open for several seconds, and a relaunch in that window makes the new main wait for the lock
 * (app/main/main.ts, acquireSingleInstance), which is slow at best and has hung the launch in E2E.
 */
export async function killElectron(app: ElectronApplication, root: string, opts: { tree?: boolean } = {}): Promise<void> {
  const launcher = app.process()
  let main: Owned
  try {
    main = await claimElectron(app, root)
  } catch (err) {
    if (launcher.pid && launcher.exitCode === null) spawnSync('taskkill', ['/PID', String(launcher.pid), '/T', '/F'], { stdio: 'ignore' })
    await waitForExit(launcher)
    throw err
  }
  const outcome = await killOwned(main, { tree: opts.tree })
  if (outcome === 'not-ours') throw new Error(`electron main pid ${main.pid} changed identity before the kill; nothing killed`)
  if (launcher.pid && launcher.pid !== main.pid) {
    const exited = waitForExit(launcher)
    await Promise.race([exited, sleep(3000)])
    if (launcher.exitCode === null) launcher.kill()
  }
  await waitForExit(launcher)
  if (!opts.tree) await waitForChildrenExit(main.pid, HELPERS_EXIT_MS)
}

function waitForExit(child: { exitCode: number | null; once(event: 'exit', cb: () => void): unknown }): Promise<void> {
  return new Promise(res => { if (child.exitCode !== null) res(); else child.once('exit', () => res()) })
}

/** Waits (never kills) until no process lists `parentPid` as its parent; gives up quietly after `timeoutMs`. */
async function waitForChildrenExit(parentPid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const r = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${parentPid}" | Measure-Object).Count`], { encoding: 'utf8' })
    if (r.status === 0 && r.stdout.trim() === '0') return
    await sleep(500)
  }
}
