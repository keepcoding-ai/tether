// The browser process mirrors the app's agents. The list in its `hello` and any `agentChange` posted before it registered its
// handlers (it does so after the app is ready) can be lost; it announces `ready` only once every handler exists, so the app
// replays the current list at that moment and the mirror ends up right whatever was dropped before.
import type { AgentInfo } from '../../app/shared/agent-info.ts'

interface Line {
  handle(name: string, fn: (...args: unknown[]) => unknown): void
  post(name: string, ...args: unknown[]): void
}

/** Serves the process's `ready`: replays every current agent (the mirror's `change` is idempotent), then calls `done`. */
export function serveChildReady(w: Line, agents: () => AgentInfo[], done: () => void): void {
  w.handle('ready', () => {
    for (const a of agents()) w.post('agentChange', a, false)
    done()
  })
}
