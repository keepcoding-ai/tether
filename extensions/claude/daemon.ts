// The claude extension in tetherd (and in the CLI/main through src/agents/load.ts): registers the agent and its checks.
// The adapter's code stays in src/agents/claude.ts (tests and the e2e read its transcript helpers from there).
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { claudeAdapter } from '../../src/agents/claude.ts'
import { withClaudePlugin } from '../../src/agents/claude-plugin.ts'
import { withMcpConfigFlag } from '../../src/agents/mcp.ts'
import { UNSAFE_ARG } from '../../src/core/profile.ts'
import type { AgentContribution, TetherDaemon } from '../../src/daemon/ext-api.ts'
import { checkClaudeEnv, probeClaude, probeHookCheck } from '../../src/doctor.ts'
export { manifest } from './manifest.ts'

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
  // `claude --mcp-config <file>`: added to the project's own .mcp.json servers (the default; --strict-mcp-config would drop them).
  mcp: { inject: withMcpConfigFlag },
  // The composed features (src/agents/claude-plugin.ts): the servers as `--mcp-config <share>/claude.mcp.json` (tool names
  // unchanged), the skills as a session-only plugin `--plugin-dir <share>/claude-plugin` (`/tether:<name>`).
  share: { inject: withClaudePlugin },
}

export function activate(api: TetherDaemon): IDisposable[] {
  return [
    api.agents.register(claudeAgent),
    api.doctor.register(async () => probeClaude()),
    api.doctor.register(async () => probeHookCheck()),
    api.doctor.register(async () => checkClaudeEnv(process.env)),
  ]
}
