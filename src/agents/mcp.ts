// How an agent is handed an MCP config file (F7 C3): the daemon extensions that serve MCP servers to the panes (web-bridge, ...)
// never know the agents one by one; each agent contribution says how its CLI loads a `{ "mcpServers": {...} }` file
// (AgentContribution.mcp.inject). Claude Code and soul-cli share the flag: `--mcp-config <file>`, REPEATED once per file
// (soul only accepts the repeated form; Claude accepts both). Each injection appends `--mcp-config <file>` at the END of the
// command line, so the flags land in registration order. They go last because Claude's option is variadic
// (`--mcp-config <configs...>`): a positional argument after it would be read as one more file; after the slot's own args
// nothing follows. With one file the command line is the same as it always was. The env the servers read (identity, home)
// is not the agent's business: the middleware sets it on the plan, like any other variable.
//
// Two files declaring the same server name overwrite each other silently in both CLIs (the last wins), so an extension may
// DECLARE the names its file holds; the plan remembers them and a second file with a taken name is refused.
import type { LaunchPlan } from './types.ts'

export const MCP_CONFIG_FLAG = '--mcp-config'

/** Two injections into one plan claimed the same MCP server name. The launch host logs it and keeps the plan as it was. */
export class McpNameCollisionError extends Error {
  readonly server: string
  constructor(server: string, takenBy: string, refused: string) {
    super(`servidor MCP "${server}" já injetado por ${takenBy}; ${refused} recusado (nomes de servidor devem ser únicos entre extensões)`)
    this.name = 'McpNameCollisionError'
    this.server = server
  }
}

/** A server reached over Streamable HTTP (src/daemon/mcp-http.ts), for agents whose contribution says `mcp.http`. */
export interface HttpMcpServer {
  type: 'http'
  url: string
  headers: Record<string, string>
}

/**
 * The `--mcp-config` file of one HTTP server: the bearer is `${keyEnvVar}`, expanded by the CLI from its own env (the launch
 * plan carries the key), so the file holds no secret. Claude Code expands `${VAR}` in a server's headers (checked against
 * 2.1.322: the bearer arrives expanded).
 */
export function httpMcpConfigOf(server: string, url: string, keyEnvVar: string): { mcpServers: Record<string, HttpMcpServer> } {
  return { mcpServers: { [server]: { type: 'http', url, headers: { Authorization: `Bearer \${${keyEnvVar}}` } } } }
}

/**
 * `plan` with `--mcp-config <file>` appended (a copy; the plan given is never mutated). `servers`, when given, are the
 * server names of `configFile`: a name already taken by another file throws McpNameCollisionError.
 */
export function withMcpConfigFlag(plan: LaunchPlan, configFile: string, servers?: readonly string[]): LaunchPlan {
  const next: LaunchPlan = { ...plan, args: [...plan.args, MCP_CONFIG_FLAG, configFile] }
  if (!servers) return next
  const taken = plan.mcpServers ?? {}
  for (const name of servers) {
    if (taken[name] !== undefined && taken[name] !== configFile) throw new McpNameCollisionError(name, taken[name], configFile)
  }
  next.mcpServers = { ...taken, ...Object.fromEntries(servers.map(n => [n, configFile])) }
  return next
}
