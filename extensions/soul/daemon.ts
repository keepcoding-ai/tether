// The soul extension in tetherd (and in the CLI/main through src/agents/load.ts): registers the agent and its check.
// The adapter's code stays in src/agents/soul.ts (the CLI and tests use its command resolution from there).
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { withMcpConfigFlag } from '../../src/agents/mcp.ts'
import { soulSkills } from '../../src/agents/skills.ts'
import { soulAdapter } from '../../src/agents/soul.ts'
import type { LaunchPlan } from '../../src/agents/types.ts'
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
  // `soul --mcp-config <file|json>` (repeatable). In process the servers join the session; over -H the soul-cli
  // runs the stdio ones here and lends them to the remote agent as hands grouped by server name
  // (soul-cli src/hands/localMcp.ts), so the agent still sees them.
  // `http`: soul loads `{ "type": "http" }` servers in process (the agent door's `tether`, the browser). Over -H only stdio
  // servers are lent to the remote agent, so a remote soul gets no HTTP server.
  mcp: { inject: withMcpConfigFlag, http: true, httpFor: (plan) => !isRemoteSoul(plan) },
  // The door's channel: `--channels tether` lets the server's `notifications/claude/channel` open a turn (without it soul drops
  // them, though it declares the capability). No `channel`: the ronda is not offered to soul.
  channelPlan: soulChannelPlan,
  // The tether's skills as a shared folder (SOUL_CLI_SHARED_FOLDERS, like `-S`): `<dir>/skills/<skill>/SKILL.md`.
  skills: soulSkills,
}

/** soul's options for a remote engine; next to them `--channels` is a usage error and soul does not start. */
const REMOTE_FLAGS = new Set(['-H', '--host', '--target'])

/** The command line points soul at a remote engine (-H, --host, --target, with or without `=`). */
export function isRemoteSoul(plan: LaunchPlan): boolean {
  return plan.args.some((a) => REMOTE_FLAGS.has(a) || /^--(host|target)=/.test(a))
}

/**
 * `--channels <a,b>` appended at the end (soul's `--mcp-config` takes one value, so nothing is swallowed, and the plan may start
 * with the script node runs). Undefined, so no channel, when the command line points soul at a remote engine (-H, --host,
 * --target, with or without `=`): `--channels` only works in process.
 */
export function soulChannelPlan(plan: LaunchPlan, servers: readonly string[]): LaunchPlan | undefined {
  if (servers.length === 0) return undefined
  if (isRemoteSoul(plan)) return undefined
  return { ...plan, args: [...plan.args, '--channels', servers.join(',')] }
}

export function activate(api: TetherDaemon): IDisposable[] {
  return [
    api.agents.register(soulAgent),
    api.doctor.register(async () => probeSoul()),
  ]
}
