// Shared bits for the daemon tests: a temp home, a unique pipe, a client that records events, pid checks.
import { after } from 'node:test'
import { DaemonClient } from '../../src/daemon/client.ts'
import { ProcHost } from '../../src/procd/host.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { removeHome, sleep, tempHome, uniquePipe, waitUntil } from './daemon.basics.ts'

export { pidAlive, removeHome, sleep, tempHome, uniquePipe, waitUntil } from './daemon.basics.ts'

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

  /** `direct`: the client says it reads hosted panes from the host (tetherd sends it no output of them). */
  static async connect(pipe: string, how: { direct?: boolean } = {}): Promise<Recorder> {
    return new Recorder(await DaemonClient.open(pipe, 'test', how))
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

/**
 * Panel host on (the default; TETHER_PANEL_HOST=0 turns it off): the daemons these tests start launch their panes in a terminal-pane host running in this process
 * (TETHER_PTYD_PIPE points at it, so the daemon's own connector finds it and never launches tether-ptyd). It closes after
 * the file's tests. Always a private host: an inherited TETHER_PTYD_PIPE is replaced.
 */
if (process.env.TETHER_PANEL_HOST?.trim() !== '0') {
  const home = tempHome()
  const pipe = uniquePipe(home)
  const host = new ProcHost({ home, pipe, persist: false })
  await host.listen()
  process.env.TETHER_PTYD_PIPE = pipe
  after(async () => { await host.close(); await removeHome(home) })
}
