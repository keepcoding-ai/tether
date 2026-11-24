// One pseudo-terminal owned by the daemon: spawn, write, resize, kill the whole tree, release the console.
// Wraps node-pty 1.1 with the Windows workarounds the E2E harness proved (test/e2e/harness.ts).
import * as pty from 'node-pty'
import { agentExecutor } from '../agents/agent-exec.ts'
import type { LaunchPlan } from '../agents/types.ts'

export interface PtyExit {
  exitCode: number
  signal?: number
}

export interface PtyHandle {
  readonly pid: number
  readonly exited: Promise<PtyExit>
  /** undefined while the process runs. */
  readonly exit: PtyExit | undefined
  write(data: string): void
  resize(cols: number, rows: number): void
  /** Kills the process and every descendant, then releases the console. Resolves once the exit was observed (or after `timeoutMs`). */
  kill(timeoutMs?: number): Promise<void>
  /** Releases the ConPTY and handles WITHOUT killing the process tree. Idempotent. */
  release(): void
  /** Bytes written to the conin pipe and not yet flushed by Node (socket writableLength); 0 when unavailable. */
  pendingInput(): number
}

/**
 * What spawnPty runs: a LaunchPlan whose args may also be ONE raw string. On Windows node-pty passes a string
 * through without re-quoting it, which is the only way to hand `cmd.exe /d /s /c "<line>"` a line with inner quotes.
 */
export type PtyPlan = Omit<LaunchPlan, 'args'> & { args: string[] | string }

export interface SpawnOptions {
  cols: number
  rows: number
  onData(data: string): void
  onExit(exit: PtyExit): void
}

/** Kills a process tree by pid (taskkill /T /F on Windows). The executor creates the child, never this loop; never rejects. */
export function killTree(pid: number): Promise<void> {
  return agentExecutor().run('killTree', [pid]).then(() => undefined, () => undefined)
}

/**
 * Releases the ConPTY (closes the pseudo console, its reader thread and pipes). node-pty 1.1 leaves these open
 * after the child exits, which keeps the Node event loop alive; its kill() releases them but forks a helper
 * that fails noisily ("AttachConsole failed") once the console is gone.
 */
function dispose(p: pty.IPty): void {
  const agent = (p as unknown as { _agent?: Record<string, any> })._agent
  if (!agent || process.platform !== 'win32') {
    try { p.kill() } catch { /* already gone */ }
    return
  }
  const noop = (): void => {}
  const steps: (() => void)[] = [
    () => { for (const s of [agent._inSocket, agent._outSocket]) { s?.on('error', noop); if (s) s.readable = false } },
    () => agent._conoutSocketWorker?._worker?.on('error', noop),
    () => agent._ptyNative?.kill(agent._pty, agent._useConptyDll),
    () => agent._conoutSocketWorker?.dispose(),
    () => agent._inSocket?.destroy(),
  ]
  for (const s of steps) { try { s() } catch { /* best effort, in order */ } }
}

/**
 * Returns `env` with a UTF-8 locale guaranteed (non-Windows). An app launched from Finder has no LANG/LC_*, so its
 * children run in the C locale and tools like pbcopy read UTF-8 bytes as Mac Roman (mojibake). An explicit LC_ALL or
 * LC_CTYPE is never touched; a LANG without UTF-8 keeps its language part (pt_BR -> pt_BR.UTF-8). Pure: never mutates.
 */
export function withUtf8Locale(env: Record<string, string>, platform: NodeJS.Platform = process.platform): Record<string, string> {
  if (platform === 'win32' || env.LC_ALL || env.LC_CTYPE) return env
  const lang = env.LANG ?? ''
  if (/utf-?8/i.test(lang)) return env
  const base = lang.split(/[.@]/)[0]
  const language = base && base !== 'C' && base !== 'POSIX' ? base : 'en_US'
  return { ...env, LANG: `${language}.UTF-8` }
}

export function spawnPty(plan: PtyPlan, opts: SpawnOptions): PtyHandle {
  const p = pty.spawn(plan.command, plan.args, {
    cols: opts.cols,
    rows: opts.rows,
    cwd: plan.cwd,
    env: withUtf8Locale(plan.env),
    useConpty: true,
    name: 'xterm-256color',
  })
  let exit: PtyExit | undefined
  let disposed = false
  const release = (): void => {
    if (disposed) return
    disposed = true
    dispose(p)
  }
  const exited = new Promise<PtyExit>((resolve) => {
    p.onExit((e) => {
      exit = { exitCode: e.exitCode ?? -1, signal: e.signal } // killed trees report no code on Windows
      opts.onExit(exit)
      resolve(exit)
      setTimeout(release, 1_100).unref() // after node-pty's own 1 s flush window
    })
  })
  p.onData(opts.onData)
  return {
    pid: p.pid,
    exited,
    get exit() { return exit },
    write(data) { if (!exit) p.write(data) },
    resize(cols, rows) {
      if (exit || cols < 1 || rows < 1) return
      try { p.resize(cols, rows) } catch { /* process may be dying */ }
    },
    release,
    pendingInput() {
      const sock = (p as unknown as { _agent?: { _inSocket?: { writableLength?: number } } })._agent?._inSocket
      return sock?.writableLength ?? 0
    },
    async kill(timeoutMs = 10_000) {
      if (!exit) await killTree(p.pid)
      release()
      let timer: NodeJS.Timeout | undefined
      await Promise.race([exited, new Promise<void>((r) => { timer = setTimeout(r, timeoutMs) })])
      clearTimeout(timer)
      if (!exit) {
        exit = { exitCode: -1 }
        opts.onExit(exit)
      }
    },
  }
}
