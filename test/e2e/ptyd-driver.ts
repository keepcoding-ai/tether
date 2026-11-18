// What the app E2E tests need around tether-ptyd (the terminal-pane host the tetherd of a test starts on its own):
// whether this run hosts panels there, and stopping the host (and the shells under it) of a test home by identity.
import { readFileSync } from 'node:fs'
import { readUserSettings } from '../../src/core/user-settings-sync.ts'
import { panelHostEnabled } from '../../src/daemon/server.ts'
import { ptydPidPath } from '../../src/ptyd/paths.ts'
import { findProcesses, identify, killOwned, type Owned } from '../kill.ts'

/** True when a tetherd of `home` launches NEW panels in tether-ptyd (TETHER_PANEL_HOST, else the default: on). */
export function panelHostOn(home: string): boolean {
  return panelHostEnabled(readUserSettings(home))
}

/** The environment a test hands the app so the tetherd and the app's PanelLink share one private ptyd pipe. */
export function ptydEnv(env: Record<string, string>, pipe: string | undefined): void {
  if (pipe) env.TETHER_PTYD_PIPE = pipe
  else delete env.TETHER_PTYD_PIPE // derived from the test's own tetherd pipe: private to the test
}

/**
 * Kills the tether-ptyd of `home` and its whole tree (the hosted shells/agents). A ptyd runs as
 * `<home>/bin/tether-ptyd.exe`, so its command line names the test home: that is the identity checked, with the pid
 * file as the first lead and a scan by home as the net. Never touches a process whose command line lacks `home`.
 */
export async function stopPtyd(home: string): Promise<Owned[]> {
  const found = new Map<number, Owned>()
  try {
    const pid = Number(readFileSync(ptydPidPath(home), 'utf8').trim())
    const p = await identify(pid)
    if (p && (p.cmd ?? '').toLowerCase().includes(home.toLowerCase())) found.set(p.pid, p)
  } catch { /* no pid file: the scan below decides */ }
  for (const name of process.platform === 'win32' ? ['tether-ptyd.exe', 'node.exe'] : ['node']) {
    for (const p of await findProcesses({ name, cmdIncludes: home }).catch(() => [])) found.set(p.pid, p)
  }
  const killed: Owned[] = []
  for (const p of found.values()) if (await killOwned(p, { tree: true }) === 'killed') killed.push(p)
  return killed
}
