// Plain helpers for the daemon tests (temp home, unique pipe, pid checks, waits): no side effects on import.
// daemon.helpers.ts re-exports these and adds the in-process panel host; tests that run the CLI with spawnSync
// (which blocks this process's event loop, and with it an in-process host) import from here and own a real tether-ptyd.
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'tether-daemon-'))
}

export function uniquePipe(home: string): string {
  const tag = randomBytes(4).toString('hex')
  return process.platform === 'win32' ? `\\\\.\\pipe\\tether-test-${tag}` : join(home, `d-${tag}.sock`)
}

export async function removeHome(home: string): Promise<void> {
  for (let i = 0; i < 5; i++) {
    try { rmSync(home, { recursive: true, force: true }); return } catch { await sleep(300) }
  }
}

/** True when a process with this pid exists right now (pid-only; fine for short-lived tests). */
export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

export async function waitUntil(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timeout (${timeoutMs} ms) waiting for ${what}`)
    await sleep(50)
  }
}
