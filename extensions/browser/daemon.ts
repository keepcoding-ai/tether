// The browser extension in tetherd (E1, skeleton): nothing to do yet. The agents' MCP hand-off (`browser.serveToAgents`)
// comes in a later slice.
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { TetherDaemon } from '../../src/daemon/ext-api.ts'

export { manifest } from './manifest.ts'

export function activate(_api: TetherDaemon): IDisposable[] {
  return []
}
