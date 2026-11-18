// The main process' executor: the one door to blocking disk work (log, layout, settings, notes). main.ts creates it
// at boot and registers it here; the modules that write (note-files.ts, extensions) reach it through `mainExecutor()`,
// so no Electron or bundle detail leaks into them. Tests register an inline executor. Free of node:fs on purpose.
import type { Executor } from '../../src/exec/executor.ts'

let current: Executor | undefined

export function setMainExecutor(ex: Executor | undefined): void { current = ex }

export function mainExecutor(): Executor {
  if (!current) throw new Error('main executor not set: main.ts (or the test) must call setMainExecutor first')
  return current
}

export const isNotFound = (e: unknown): boolean => (e as { code?: unknown } | null)?.code === 'ENOENT'
