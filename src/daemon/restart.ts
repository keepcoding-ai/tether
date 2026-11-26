// Restart of tetherd with the code on disk: ask the running one to shut down (it stops every agent; slots keep
// their binding on disk), wait for the pipe to go quiet, then start a new one. Apps connected to the pipe
// notice the close and reconnect on their own (the Electron app also reloads its renderer).
import { setTimeout as sleep } from 'node:timers/promises'
import { ENV_SLOT } from '../agents/types.ts'
import { DaemonClient, pingDaemon, type Hello, type SpawnOptions } from './client.ts'
import { KILL_WAIT_CAP_MS } from './protocol.ts'

/** The old daemon may wait up to KILL_WAIT_CAP_MS for a young Claude before killing it, then stop the rest. */
const STOP_TIMEOUT_MS = KILL_WAIT_CAP_MS + 15_000

export interface RestartResult {
  /** The daemon that was replaced (undefined: none was running, a new one was just started). */
  previous: Hello | undefined
  /** The new daemon. */
  current: Hello
}

export interface RestartOptions extends SpawnOptions {
  /** Max wait for the old daemon to go down (ms). It stops every agent first (a young Claude is waited for). Default STOP_TIMEOUT_MS (45 000). */
  stopTimeoutMs?: number
  /** Max wait for the new daemon to answer (ms). Default 15 000. */
  startTimeoutMs?: number
}

export async function restartDaemon(opts: RestartOptions): Promise<RestartResult> {
  const previous = await pingDaemon(opts.pipe, opts.home)
  if (previous) {
    // `legacy`: a tetherd older than this code (protocol 1) is exactly what a restart after an upgrade replaces.
    const client = await DaemonClient.open(opts.pipe, 'cli', { home: opts.home, legacy: true })
    try { await client.request({ t: 'shutdown' }) } finally { client.close() }
    const stopTimeoutMs = opts.stopTimeoutMs ?? STOP_TIMEOUT_MS
    const deadline = Date.now() + stopTimeoutMs
    while (await pingDaemon(opts.pipe, opts.home)) {
      if (Date.now() > deadline) throw new Error(`o tetherd (pid ${previous.pid}) não encerrou em ${stopTimeoutMs / 1000} s`)
      await sleep(150)
    }
  }
  // An app watching the pipe may start the new daemon first; connect() then simply joins it (the pipe is the lock).
  const client = await DaemonClient.connect({ ...opts, client: 'cli', startTimeoutMs: opts.startTimeoutMs ?? 15_000 })
  const current = client.hello
  client.close()
  return { previous, current }
}

/**
 * The slot this process runs in, when it is one of the target daemon's: agents launched by tetherd carry
 * TETHER_SLOT_ID, and a shutdown of the daemon that owns that slot would end the very session asking for it.
 * Undefined outside a slot, or inside a slot of some other daemon (another home / pipe).
 */
export function ownSlotOf(slots: ReadonlyArray<{ slotId: string }>, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const slotId = env[ENV_SLOT]?.trim()
  if (!slotId) return undefined
  return slots.some((s) => s.slotId === slotId) ? slotId : undefined
}

/** Why the shutdown is refused, for the person reading the terminal. */
export function selfShutdownMessage(action: 'restart' | 'stop', slotId: string): string {
  const verb = action === 'restart' ? 'reiniciar' : 'parar'
  return `recusado: este terminal roda dentro do slot ${slotId.slice(0, 8)} do próprio tetherd que você quer ${verb}.
`
    + `  ${action === 'restart' ? 'Reiniciar' : 'Parar'} o tetherd encerraria esta sessão e todos os outros agentes dele.
`
    + `  Rode o comando de um terminal fora do tether, ou passe --force se for isso mesmo que você quer.
`
}
