// The hands extension in tetherd (and in the CLI/main through src/agents/load.ts): registers the agent and its checks.
// The adapter's code stays in src/agents/hands.ts; its doctor checks in src/doctor-hands.ts.
//
// What the hands honors (0.1.188: src/entrypoints/hands.tsx and the code it shares): the session report with its `turn`
// (busy|idle) and `context` lines, the shared folders (HANDS_SHARED_FOLDERS, lent to the remote agent as the `shared-skills`
// MCP) and -r/-c/--session-id/--fork-session. What it does not: `--mcp-config` (an operator-only flag: "unknown option"), so
// this agent has no `mcp` and the extensions' MCP servers (bridge, browser, ronda) leave its plan alone; the polite pause
// (its request is read only by the in-process engine; the hands is always remote); `-g`.
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { handsAdapter, handsSkills } from '../../src/agents/hands.ts'
import type { AgentContribution, TetherDaemon } from '../../src/daemon/ext-api.ts'
import { probeHands, probeHandsExe } from '../../src/doctor-hands.ts'
export { manifest } from './manifest.ts'

const RESUME_REASON = 'o tether escolhe a sessão que o slot retoma'

export const handsAgent: AgentContribution = {
  name: 'hands',
  adapter: handsAdapter,
  // The client's own `turn` lines say busy/idle; before the first one, Enter + output quiet, and a bare BEL is a wait.
  attention: { idle: true, bel: true },
  // Not a default profile; no args (the hands has no -g: its config is ~/.hands).
  defaultProfiles: () => [{ id: 'hands', name: 'hands', agent: 'hands', args: [] }],
  reservedArgs: {
    '--resume': RESUME_REASON,
    '-r': RESUME_REASON,
    '--continue': RESUME_REASON,
    '-c': RESUME_REASON,
    '--session-id': 'o tether identifica a sessão pelo evento do hands',
    '--fork-session': 'bifurcar é uma ação por retomada, não uma propriedade do perfil (o slot perderia a sessão a cada reinício)',
  },
  envArgsVar: 'TETHER_HANDS_ARGS',
  skills: handsSkills,
}

export function activate(api: TetherDaemon): IDisposable[] {
  return [
    api.agents.register(handsAgent),
    api.doctor.register(async () => probeHands()),
    api.doctor.register(async () => probeHandsExe()),
  ]
}
