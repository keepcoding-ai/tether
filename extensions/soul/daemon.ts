// The soul extension in tetherd (and in the CLI/main through src/agents/load.ts): registers the agent and its check.
// The adapter's code stays in src/agents/soul.ts (the CLI and tests use its command resolution from there).
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { soulAdapter } from '../../src/agents/soul.ts'
import type { AgentContribution, TetherDaemon } from '../../src/daemon/ext-api.ts'
import { probeSoul } from '../../src/doctor.ts'
export { manifest } from './manifest.ts'

const RESUME_REASON = 'o tether escolhe a sessão que o slot retoma'

export const soulAgent: AgentContribution = {
  name: 'soul',
  adapter: soulAdapter,
  attention: { idle: true, bel: true },
  defaultProfiles: () => [{ id: 'soul', name: 'soul', agent: 'soul', args: ['-g'], default: true }],
  reservedArgs: {
    '--resume': RESUME_REASON,
    '-r': RESUME_REASON,
    '--continue': RESUME_REASON,
    '-c': RESUME_REASON,
    '--session-id': 'o tether identifica a sessão pelo evento do soul',
    '--fork-session': 'bifurcar é uma ação por retomada, não uma propriedade do perfil (o slot perderia a sessão a cada reinício)',
  },
  envArgsVar: 'TETHER_SOUL_ARGS',
}

export function activate(api: TetherDaemon): IDisposable[] {
  return [
    api.agents.register(soulAgent),
    api.doctor.register(async () => probeSoul()),
  ]
}
