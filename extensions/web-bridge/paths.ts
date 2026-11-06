// Where the Tether Bridge lives on this machine, as pure rules shared by main (the installer), the daemon side (C2) and
// the tests. Everything hangs off TETHER_HOME, so a test with its own home never touches the person's installation:
//   <home>/bridge/              the bridge's home (ATRIUM_BRIDGE_HOME of everything tether launches): config.json, api.key, daemon.pid, daemon.log
//   <home>/web-bridge/current/  the extension folder the person loads in the browser; a FIXED path, so an update is a copy
//                               over it and never a second "Load unpacked" (design §1.3)
// With the default home (%LOCALAPPDATA%\tether) these are %LOCALAPPDATA%\tether\bridge and %LOCALAPPDATA%\tether\web-bridge\current.
import { join } from 'node:path'

/** The daemon's port: the bridge's default is 47821 (the Atrium installation); tether's own installation sits ten above it (D9). */
export const BRIDGE_PORT = 47831

export const bridgeHomeOf = (home: string): string => join(home, 'bridge')
export const extensionDirOf = (home: string): string => join(home, 'web-bridge', 'current')

/** The port in force: `TETHER_BRIDGE_PORT` (a development or test knob, never a setting) or the fixed one. */
export function bridgePortOf(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.TETHER_BRIDGE_PORT)
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : BRIDGE_PORT
}

export const healthUrl = (port: number): string => `http://127.0.0.1:${port}/health`
export const browsersUrl = (port: number): string => `http://127.0.0.1:${port}/browsers`
