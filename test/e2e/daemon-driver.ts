// Drives a tetherd slot with the harness: the daemon owns the PTY; this transport feeds the slot's `data`
// events into the harness Screen and sends keystrokes with `input`. Exit = the daemon's `state` for the
// slot losing its pid after the process was seen running; kill = the daemon's `stop`.
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DaemonClient } from '../../src/daemon/client.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { awaitReady, Terminal, type ExitInfo, type StartOptions, type Transport } from './harness.ts'

const DAEMON_MAIN = resolve(import.meta.dirname, '../../src/daemon/main.ts')

export class DaemonSlotTransport implements Transport {
  pid = 0
  private started = false
  private done = false
  private readonly dataCbs: ((d: string) => void)[] = []
  private readonly exitCbs: ((e: ExitInfo) => void)[] = []
  private readonly onData_ = (slotId: string, data: string): void => { if (slotId === this.slotId) for (const cb of this.dataCbs) cb(data) }
  private readonly onState_ = (s: SlotState): void => { this.observe(s) }
  private readonly onClose_ = (): void => { this.finish({ exitCode: -1 }) } // daemon gone: the agent died with it

  readonly client: DaemonClient
  readonly slotId: string

  constructor(client: DaemonClient, slotId: string) {
    this.client = client; this.slotId = slotId
    client.on('data', this.onData_)
    client.on('state', this.onState_)
    client.on('close', this.onClose_)
  }

  /** Feeds a slot state (from an event or a reply): tracks the pid and detects the exit. */
  observe(s: SlotState): void {
    if (s.slotId !== this.slotId) return
    if (s.pid) { this.pid = s.pid; this.started = true; return }
    // The protocol carries no exit code; a normal exit is reported as 0, a kill as -1 by kill() itself.
    if (this.started && (s.status === 'exited' || s.status === 'unconfirmed' || s.status === 'error')) this.finish({ exitCode: 0 })
  }

  private finish(e: ExitInfo): void {
    if (this.done) return
    this.done = true
    for (const cb of this.exitCbs) cb(e)
  }

  write(data: string): void { this.client.input(this.slotId, data) }
  onData(cb: (data: string) => void): void { this.dataCbs.push(cb) }
  onExit(cb: (e: ExitInfo) => void): void { this.exitCbs.push(cb) }
  async kill(): Promise<void> { await this.client.request({ t: 'stop', slotId: this.slotId }) }

  dispose(): void {
    this.client.off('data', this.onData_)
    this.client.off('state', this.onState_)
    this.client.off('close', this.onClose_)
  }
}

export interface OpenOptions extends StartOptions {
  choice?: 'resume' | 'new'
}

/** Attaches to the slot, starts it (resume by default) and returns the Terminal once the TUI is idle at its prompt.
 *  A start refused by the daemon rejects with the DaemonError (slot left attached, nothing running). */
export async function openSlot(client: DaemonClient, slotId: string, opts: OpenOptions = {}): Promise<Terminal> {
  const cols = opts.cols ?? 120, rows = opts.rows ?? 40
  const attached = await client.request({ t: 'attach', slotId, cols, rows })
  const transport = new DaemonSlotTransport(client, slotId)
  const t = new Terminal(transport, opts)
  if (attached.scrollback) t.screenBuf.write(attached.scrollback)
  try {
    const started = await client.request({ t: 'start', slotId, choice: opts.choice })
    transport.observe(started.slot!)
  } catch (e) {
    transport.dispose()
    throw e
  }
  return awaitReady(t)
}

/** A tetherd of its own (unique home and pipe), spawned detached the way the app does it. */
export class SuiteDaemon {
  client!: DaemonClient
  pid = 0
  /** The daemon's identity (pid + creation time), claimed at connect: the only thing a kill may act on. */
  owned: Owned | undefined
  readonly home: string
  readonly pipe: string

  constructor(home: string, pipe: string) { this.home = home; this.pipe = pipe }

  /** Connects, spawning the daemon when nothing answers on the pipe. */
  async connect(): Promise<DaemonClient> {
    this.client = await DaemonClient.connect({ home: this.home, pipe: this.pipe, client: 'test' })
    this.pid = this.client.hello.pid
    this.owned = await claim(this.pid, { cmdIncludes: DAEMON_MAIN, what: 'tetherd' })
    return this.client
  }

  /** Asks the daemon to exit and waits until its pid is gone (kills it by identity as a last resort). */
  async shutdown(timeoutMs = 20_000): Promise<void> {
    if (!this.pid) return
    try { await this.client.request({ t: 'shutdown' }) } catch { /* already gone */ }
    const deadline = Date.now() + timeoutMs
    while (pidAlive(this.pid) && Date.now() < deadline) await new Promise(r => setTimeout(r, 100))
    if (pidAlive(this.pid)) {
      const outcome = this.owned ? await killOwned(this.owned, { tree: true }) : 'not-ours'
      throw new Error(`tetherd ${this.pid} did not exit on shutdown; ${outcome}`)
    }
    this.pid = 0
    this.owned = undefined
    this.client.close()
  }

  /** The daemon's log, for diagnostics. */
  log(): string {
    const p = join(this.home, 'tetherd.log')
    return existsSync(p) ? readFileSync(p, 'utf8') : ''
  }
}

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}
