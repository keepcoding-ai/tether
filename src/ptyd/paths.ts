// Where tether-ptyd (the terminal-pane host) keeps its pipe, pid file and log.
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HostTarget } from '../procd/client.ts'
import { procdPipePath } from '../procd/protocol.ts'

/** TETHER_PTYD_PIPE, else the procd pipe rule with a `-ptyd` suffix: `<procd pipe>-ptyd` (Windows), `<home>/tether-ptyd.sock` elsewhere. */
export function ptydPipePath(tetherPipe: string, home: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const fromEnv = env.TETHER_PTYD_PIPE?.trim()
  if (fromEnv) return fromEnv
  return platform === 'win32' ? `${procdPipePath(tetherPipe, home, { ...env, TETHER_PTYD_PIPE: undefined }, platform)}-ptyd` : join(home, 'tether-ptyd.sock')
}

/**
 * The home that holds the key of the host on ptydPipePath (pipe-key.ts hostKeyPath): TETHER_PTYD_HOME when TETHER_PTYD_PIPE
 * points at a host that runs with another home (a test's shared in-process host), else `home`.
 */
export function ptydKeyHome(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const other = env.TETHER_PTYD_HOME?.trim()
  return env.TETHER_PTYD_PIPE?.trim() && other ? other : home
}

export function ptydPidPath(home: string): string {
  return join(home, 'tether-ptyd.pid')
}

export function ptydLogPath(home: string): string {
  return join(home, 'tether-ptyd.log')
}

/** For HostClient.ensure: launches tether-ptyd, handing it the pipe through TETHER_PTYD_PIPE. */
export const PTYD_TARGET: HostTarget = {
  exe: 'tether-ptyd',
  what: 'o anfitrião de terminais (tether-ptyd)',
  // Lazy: the app bundles this module as CJS, where import.meta.url is empty and evaluating it at load would throw.
  get main() { return fileURLToPath(new URL('./main.ts', import.meta.url)) },
  pipeEnv: 'TETHER_PTYD_PIPE',
}
