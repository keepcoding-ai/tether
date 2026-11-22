// The codex extension in tetherd (and in the CLI/main through src/agents/load.ts): registers the agent and its checks.
// The adapter's code stays in src/agents/codex.ts.
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { codexAdapter, codexSkills, withCodexMcpOverrides } from '../../src/agents/codex.ts'
import type { AgentContribution, TetherDaemon } from '../../src/daemon/ext-api.ts'
import { probeCodex, probeCodexNotify } from '../../src/doctor.ts'
import { codexTyping } from './typing.ts'
export { manifest } from './manifest.ts'

const RESUME_REASON = 'o tether escolhe a sessão que o slot retoma'

/** The flag of the "dev" profile, as claude-dev's --dangerously-skip-permissions. */
export const CODEX_UNSAFE_ARG = '--dangerously-bypass-approvals-and-sandbox'

export const codexAgent: AgentContribution = {
  name: 'codex',
  adapter: codexAdapter,
  // The notify reporter says when a turn ends ('done') or a prompt waits ('waiting'); it has no "turn began", so Enter
  // followed by output marks the turn busy (soul's heuristic), and a bare BEL is a wait too.
  attention: { idle: true, bel: true },
  defaultProfiles: () => [
    { id: 'codex', name: 'Codex', agent: 'codex', args: [], default: true },
    { id: 'codex-dev', name: 'Codex modo dev', agent: 'codex', args: [CODEX_UNSAFE_ARG] },
  ],
  reservedArgs: {
    resume: RESUME_REASON,
    '--last': RESUME_REASON,
    fork: 'bifurcar é uma ação por retomada, não uma propriedade do perfil (o slot perderia a sessão a cada reinício)',
  },
  envArgsVar: 'TETHER_CODEX_ARGS',
  // Codex has no --mcp-config: each server of the file becomes `-c mcp_servers.<name>.*`; HTTP servers carry the bearer as
  // `bearer_token_env_var`, so the daemon's HTTP servers reach it with no process per pane.
  mcp: { inject: withCodexMcpOverrides, http: true },
  // No per-launch skills folder in Codex: the skills' text goes in `developer_instructions` (src/agents/codex.ts).
  skills: codexSkills,
  // No channel notifications in Codex: the ronda is unavailable to it.
  // Codex 0.169 takes text and an Enter less than ~170 ms apart as one paste and does not submit (130 and 150 ms fail).
  typing: codexTyping(),
}

export function activate(api: TetherDaemon): IDisposable[] {
  return [
    api.agents.register(codexAgent),
    api.doctor.register(async () => probeCodex()),
    api.doctor.register(async () => probeCodexNotify()),
  ]
}
