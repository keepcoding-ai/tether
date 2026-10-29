// Shared bits for the daemon tests: a temp home, a unique pipe, a client that records events, pid checks.
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonClient } from '../../src/daemon/client.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'

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

/** A connected client that keeps every `state` and `data` it received, per slot. */
export class Recorder {
  readonly states: SlotState[] = []
  readonly removed: string[] = []
  readonly output = new Map<string, string>()
  readonly client: DaemonClient

  private constructor(client: DaemonClient) {
    this.client = client
    client.on('state', (s) => this.states.push(s))
    client.on('removed', (id) => this.removed.push(id))
    client.on('data', (id, data) => this.output.set(id, (this.output.get(id) ?? '') + data))
  }

  static async connect(pipe: string): Promise<Recorder> {
    return new Recorder(await DaemonClient.open(pipe, 'test'))
  }

  text(slotId: string): string {
    return this.output.get(slotId) ?? ''
  }

  /** Waits for a `state` of the slot matching `pred` (past ones count). */
  async state(slotId: string, pred: (s: SlotState) => boolean, timeoutMs = 10_000, what = 'state'): Promise<SlotState> {
    let found: SlotState | undefined
    await waitUntil(() => {
      found = this.states.find((s) => s.slotId === slotId && pred(s))
      return found !== undefined
    }, timeoutMs, `${what} of slot ${slotId}`)
    return found!
  }

  /** Waits for the slot's output to match `re`; returns the match. */
  async see(slotId: string, re: RegExp, timeoutMs = 30_000): Promise<RegExpExecArray> {
    let m: RegExpExecArray | null = null
    await waitUntil(() => { m = re.exec(this.text(slotId)); return m !== null }, timeoutMs, `${re} in output of ${slotId}\n--- output ---\n${this.text(slotId).slice(-2000)}`)
    return m!
  }

  close(): void {
    this.client.close()
  }
}
