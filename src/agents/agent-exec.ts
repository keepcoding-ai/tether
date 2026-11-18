// The executor the agent adapters use when a caller does not hand one over (the CLI, the doctor, the context readers, the
// launch middlewares). tetherd registers its own at start, so the adapters' disk and process work runs on its workers;
// a process without one gets a lazily made inline executor (same operations, run in its own loop through setImmediate).
import { createExecutor, type Executor } from '../exec/executor.ts'

let current: Executor | undefined
let fallback: Executor | undefined

/** The process-wide executor of the adapters; `undefined` goes back to the inline fallback. */
export function setAgentExecutor(ex: Executor | undefined): void { current = ex }

/** True when `ex` is the registered executor (so its owner unregisters only its own). */
export function isAgentExecutor(ex: Executor): boolean { return current === ex }

export function agentExecutor(): Executor {
  return current ?? (fallback ??= createExecutor({ mode: 'inline' }))
}

/** A copy of an environment as a plain object (process.env itself does not cross a worker boundary). */
export function plainEnv(env: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  return { ...env }
}
