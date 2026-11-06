// How an agent is handed an MCP config file (F7 C3): the daemon extensions that serve MCP servers to the panes (web-bridge)
// never know the agents one by one; each agent contribution says how its CLI loads a `{ "mcpServers": {...} }` file
// (AgentContribution.mcp.inject). Claude Code and soul-cli share the flag: `--mcp-config <file>`. It goes LAST on the
// command line: Claude's option is variadic (`--mcp-config <configs...>`), so a positional argument after it would be
// read as a second file; after the slot's own args nothing follows. The env the servers read (identity, home) is not
// the agent's business: the middleware sets it on the plan, like any other variable.
import type { LaunchPlan } from './types.ts'

export const MCP_CONFIG_FLAG = '--mcp-config'

/** `plan` with `--mcp-config <file>` appended (a copy; the plan given is never mutated). */
export function withMcpConfigFlag(plan: LaunchPlan, configFile: string): LaunchPlan {
  return { ...plan, args: [...plan.args, MCP_CONFIG_FLAG, configFile] }
}
