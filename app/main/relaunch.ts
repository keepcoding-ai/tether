// "Reiniciar o app": the pieces of the hand-off from the leaving main process to the next one, free of Electron
// so the unit tests can run them. The leaving process starts the next one itself (app/main/main.ts
// relaunchApp): Electron's app.relaunch() goes through a helper that opens this process with PROCESS_ALL_ACCESS
// and, when that fails, starts the next instance at once, while this one is still alive and still answering
// `second-instance`; the next instance then reads that answer as "a live window took over" and leaves quietly.
// Starting it here keeps the order explicit: the lock is released first, the next process is told who it
// replaces, and a spawn failure is known in this process, where it can be shown.

/** The next instance is told which pid it replaces; its ack is then never read as a live window. */
export const RELAUNCHED_FROM_FLAG = '--relaunched-from='

/** The pid this process replaces, when it was started by "Reiniciar o app". */
export function relaunchedFrom(argv: readonly string[]): number | undefined {
  for (const a of argv) {
    if (!a.startsWith(RELAUNCHED_FROM_FLAG)) continue
    const pid = Number(a.slice(RELAUNCHED_FROM_FLAG.length))
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  }
  return undefined
}

/**
 * The arguments of the next instance: this process' own (after the executable) with the hand-off flag of this
 * pid, replacing any flag inherited from an earlier relaunch. Relative paths (the Start Menu shortcut passes
 * `app\dist\main.cjs`) stay relative: the next process gets the same cwd.
 */
export function relaunchArgs(argv: readonly string[], pid: number): string[] {
  return [...argv.slice(1).filter(a => !a.startsWith(RELAUNCHED_FROM_FLAG)), `${RELAUNCHED_FROM_FLAG}${pid}`]
}

export interface SecondInstanceAck { at?: unknown; pid?: unknown }

/**
 * Whether an ack (app/main/main.ts bringToFront writes it on `second-instance`) proves a live window answered
 * this launch: written after this process started, by a process other than the one this launch replaces. The
 * leaving process may still answer a poke during its last moments; that is not a window to defer to.
 */
export function ackFromLiveInstance(ack: SecondInstanceAck, startedAt: number, replacedPid: number | undefined): boolean {
  if (typeof ack.at !== 'number' || ack.at < startedAt) return false
  return replacedPid === undefined || ack.pid !== replacedPid
}
