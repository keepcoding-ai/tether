// The agents the core ships with, registered in the agent registry like any extension's (F9 slice 0c). Their
// code stays in src/agents until slice 4 moves each into extensions/<name>/. Imported for its side effect by
// everything that reads profiles or launches slots (profile.ts, the daemon, the CLI), so the registry is never
// empty where the built-ins are expected.
import { claudeAdapter } from './claude.ts'
import { soulAdapter } from './soul.ts'
import { agentRegistry, type AgentContribution } from './registry.ts'
import { UNSAFE_ARG } from '../core/profile.ts'

const RESUME_REASON = 'o tether escolhe a sessão que o slot retoma'
const FORK_REASON = 'bifurcar é uma ação por retomada, não uma propriedade do perfil (o slot perderia a sessão a cada reinício)'

export const claudeAgent: AgentContribution = {
  name: 'claude',
  adapter: claudeAdapter,
  attention: { idle: false, bel: false },
  defaultProfiles: () => [
    { id: 'claude', name: 'Claude', agent: 'claude', args: [], default: true },
    { id: 'claude-dev', name: 'Claude modo dev', agent: 'claude', args: [UNSAFE_ARG] },
  ],
  reservedArgs: {
    '--resume': RESUME_REASON,
    '-r': RESUME_REASON,
    '--continue': RESUME_REASON,
    '-c': RESUME_REASON,
    '--session-id': 'o tether gera o id de cada sessão nova',
    '--settings': 'o tether injeta as configurações com os hooks que registram a sessão',
    '--fork-session': FORK_REASON,
  },
  envArgsVar: 'TETHER_CLAUDE_ARGS',
}

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
    '--fork-session': FORK_REASON,
  },
  envArgsVar: 'TETHER_SOUL_ARGS',
}

for (const agent of [claudeAgent, soulAgent]) {
  if (!agentRegistry.has(agent.name)) agentRegistry.register(agent)
}
