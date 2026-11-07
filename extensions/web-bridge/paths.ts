// Where the Tether Bridge lives on this machine, as pure rules shared by main (the installer), the daemon side (C2) and
// the tests. Everything hangs off TETHER_HOME, so a test with its own home never touches the person's installation:
//   <home>/bridge/              the bridge's home (ATRIUM_BRIDGE_HOME of everything tether launches): config.json, api.key, daemon.pid, daemon.log
//   <home>/web-bridge/current/  the extension folder the person loads in the browser; a FIXED path, so an update is a copy
//                               over it and never a second "Load unpacked" (design §1.3)
//   <home>/web-bridge/share/    the content of the feature `bridge` (src/core/features.ts): mcps/<server name>/mcp.json,
//                               the MCP the agents receive through the launch's composed share folder; paths and env
//                               only, never a secret. It used to be <home>/mcp/tether-bridge.json (removed at setup)
// With the default home (%LOCALAPPDATA%\tether) these are %LOCALAPPDATA%\tether\bridge and %LOCALAPPDATA%\tether\web-bridge\current.
import { join, resolve } from 'node:path'
import { BRAND } from '../../app/shared/brand.ts'
import { tetherHome } from '../../src/core/paths.ts'

/** The daemon's port: the bridge's default is 47821 (the Atrium installation); tether's own installation sits ten above it (D9). */
export const BRIDGE_PORT = 47831

export const bridgeHomeOf = (home: string): string => join(home, 'bridge')
export const extensionDirOf = (home: string): string => join(home, 'web-bridge', 'current')

/** The MCP server's name, the prefix of the agents' tools (`mcp__tether-bridge__*`): ATRIUM_BRIDGE_SERVER_NAME of the shell. */
export const MCP_SERVER_NAME = `${BRAND.slug}-bridge`

export const bridgeShareDirOf = (home: string): string => join(home, 'web-bridge', 'share')
/** The MCP connection inside the feature's folder (the Soul shared-folder layout: mcps/<slug>/mcp.json, keyed by the slug). */
export const mcpConfigPathOf = (home: string, serverName: string = MCP_SERVER_NAME): string => join(bridgeShareDirOf(home), 'mcps', serverName, 'mcp.json')
/** Where the MCP file lived before the features: removed at setup so nothing stale is left behind. */
export const legacyMcpConfigPathOf = (home: string): string => join(home, 'mcp', `${MCP_SERVER_NAME}.json`)

/** The port in force: `TETHER_BRIDGE_PORT` (a development or test knob, never a setting) or the fixed one. */
export function bridgePortOf(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.TETHER_BRIDGE_PORT)
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : BRIDGE_PORT
}

/**
 * Whether this tetherd may START the bridge daemon. On the default home (no TETHER_HOME, or the default path), yes: the
 * installation is the person's. On another home, only with an explicit TETHER_BRIDGE_PORT other than the default port: a
 * second home (a test's, a trial's) must never take the default port with its own keys while the person's daemon happens
 * to be down. The files (config, api.key, the MCP file) are written either way; they stay inside the home.
 */
export function warmupAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const port = bridgePortOf(env)
  if (env.TETHER_BRIDGE_PORT !== undefined && Number(env.TETHER_BRIDGE_PORT) === port && port !== BRIDGE_PORT) return true
  const home = env.TETHER_HOME?.trim()
  if (!home) return true
  const norm = (p: string): string => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p))
  return norm(home) === norm(tetherHome({ ...env, TETHER_HOME: undefined }))
}

export const healthUrl = (port: number): string => `http://127.0.0.1:${port}/health`
export const browsersUrl = (port: number): string => `http://127.0.0.1:${port}/browsers`
